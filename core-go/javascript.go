package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime/debug"
	"strings"
	"time"

	"github.com/dop251/goja"
)

const maxScriptBytes = 64 * 1024
const maxScriptResult = 2 * 1024 * 1024

var scriptSlots = make(chan struct{}, 4)

type scriptRequest struct {
	Code  string `json:"code"`
	Stage string `json:"stage"`
	Input any    `json:"input"`
}
type scriptResponse struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// The isolated worker starts before the HTTP server (also usable by test binaries).
func init() {
	if len(os.Args) != 2 || os.Args[1] != "--ra-js-worker" {
		return
	}
	debug.SetMemoryLimit(128 << 20) // soft GC budget; process timeout is enforced by parent
	var request scriptRequest
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 6<<20)).Decode(&request); err != nil {
		json.NewEncoder(os.Stdout).Encode(scriptResponse{Error: err.Error()})
		os.Exit(0)
	}
	response := executeScriptWorker(request)
	json.NewEncoder(os.Stdout).Encode(response)
	os.Exit(0)
}
func isJavaScript(spec map[string]any) bool { return spec["language"] == "javascript" }
func normalizeJavaScript(spec map[string]any) (map[string]any, error) {
	code, _ := spec["code"].(string)
	if strings.TrimSpace(code) == "" || len(code) > maxScriptBytes {
		return nil, fmt.Errorf("JavaScript 代码为空或超过 64KB")
	}
	if _, err := goja.Compile("user-script.js", "(function(rows, columns, variable, target){\"use strict\";\n"+code+"\n})", true); err != nil {
		return nil, fmt.Errorf("JavaScript 语法错误：%w", err)
	}
	result := cloneJSON(spec)
	result["version"] = float64(1)
	result["language"] = "javascript"
	return result, nil
}
func executeScriptWorker(request scriptRequest) (response scriptResponse) {
	defer func() {
		if p := recover(); p != nil {
			response = scriptResponse{Error: fmt.Sprint(p)}
		}
	}()
	if len(request.Code) > maxScriptBytes {
		return scriptResponse{Error: "脚本过长"}
	}
	vm := goja.New()
	vm.SetMaxCallStackSize(256)
	timer := time.AfterFunc(1500*time.Millisecond, func() { vm.Interrupt("脚本超过执行时限") })
	defer timer.Stop()
	input, _ := json.Marshal(request.Input)
	vm.Set("__inputJSON", string(input))
	// No Go objects, WPS, filesystem, network, process or module functions exposed.
	setup := `var input=JSON.parse(__inputJSON); delete globalThis.__inputJSON;
 var columns=input.columns, variable=input.variable, target=input.target;
 var rows=input.rows;
 if(Array.isArray(rows)&&Array.isArray(columns)) rows=rows.map(function(row){var ordered={};columns.forEach(function(key){if(Object.prototype.hasOwnProperty.call(row,key))Object.defineProperty(ordered,key,{value:row[key],enumerable:true,writable:true,configurable:true});});return ordered;});
 globalThis.Date=undefined; Math.random=function(){throw new Error("脚本不允许随机结果")};`
	if _, err := vm.RunString(setup); err != nil {
		return scriptResponse{Error: err.Error()}
	}
	value, err := vm.RunScript("user-script.js", "(function(rows,columns,variable,target){\"use strict\";\n"+request.Code+"\n})(rows,columns,variable,target)")
	if err != nil {
		return scriptResponse{Error: err.Error()}
	}
	vm.Set("__result", value)
	var normalize string
	if request.Stage == "transform" {
		normalize = `if(Array.isArray(__result)) { __result={valueType:"table",columns:__result.length?Object.keys(__result[0]):columns,value:__result}; }
 else if(typeof __result==="number"||typeof __result==="string") { __result={valueType:typeof __result,columns:[],value:__result}; }`
	}
	serialized, err := vm.RunString(normalize + `
 JSON.stringify(__result,function(k,v){if(typeof v==="number"&&!Number.isFinite(v))throw new Error("结果包含非有限数值");if(v===undefined||typeof v==="function"||typeof v==="symbol")throw new Error("结果包含不能保存的值");return v;});`)
	if err != nil {
		return scriptResponse{Error: err.Error()}
	}
	encoded := serialized.String()
	if len(encoded) > maxScriptResult {
		return scriptResponse{Error: "脚本结果超过 2MB，请缩小数据范围"}
	}
	if !json.Valid([]byte(encoded)) {
		return scriptResponse{Error: "脚本必须 return 有效结果"}
	}
	return scriptResponse{Result: json.RawMessage(encoded)}
}

type boundedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, fmt.Errorf("脚本输出超过限制")
	}
	return b.Buffer.Write(p)
}
func runJavaScript(stage string, spec map[string]any, input any) (json.RawMessage, error) {
	norm, err := normalizeJavaScript(spec)
	if err != nil {
		return nil, err
	}
	request, _ := json.Marshal(scriptRequest{Code: norm["code"].(string), Stage: stage, Input: input})
	if len(request) > 5<<20 {
		return nil, fmt.Errorf("脚本输入超过 5MB")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	select {
	case scriptSlots <- struct{}{}:
		defer func() { <-scriptSlots }()
	case <-ctx.Done():
		return nil, fmt.Errorf("脚本执行繁忙，请重试")
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, exe, "--ra-js-worker")
	configureScriptProcess(cmd)
	cmd.Stdin = bytes.NewReader(request)
	output := &boundedBuffer{limit: maxScriptResult + 65536}
	stderr := &boundedBuffer{limit: 65536}
	cmd.Stdout = output
	cmd.Stderr = stderr
	if err = cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("脚本超过执行时限，已停止")
		}
		return nil, fmt.Errorf("JavaScript 执行进程失败：%v", err)
	}
	var response scriptResponse
	if err = json.Unmarshal(output.Bytes(), &response); err != nil {
		return nil, fmt.Errorf("脚本返回结果无效：%w", err)
	}
	if response.Error != "" {
		return nil, fmt.Errorf("JavaScript：%s", response.Error)
	}
	return response.Result, nil
}
func executeJavaScriptTransform(values any, spec map[string]any) (TransformResult, error) {
	hm, _ := spec["headersMode"].(string)
	if hm == "" {
		hm = "first-row"
	}
	columns, rows := matrixToRows(values, hm)
	data, err := runJavaScript("transform", spec, map[string]any{"rows": rows, "columns": columns})
	if err != nil {
		return TransformResult{}, err
	}
	var result TransformResult
	if err = json.Unmarshal(data, &result); err != nil {
		return result, fmt.Errorf("脚本结果结构错误：%w", err)
	}
	switch result.ValueType {
	case "number":
		if _, ok := result.Value.(float64); !ok {
			return result, fmt.Errorf("number 结果必须为数值")
		}
	case "string":
		if _, ok := result.Value.(string); !ok {
			return result, fmt.Errorf("string 结果必须为文本")
		}
	case "table":
		data, ok := result.Value.([]any)
		if !ok || len(data) > 5000 || len(result.Columns) > 200 {
			return result, fmt.Errorf("表格结果必须是至多5000行、200列的对象数组")
		}
		seen := map[string]bool{}
		for _, col := range result.Columns {
			if col == "" || seen[col] {
				return result, fmt.Errorf("结果列名不能为空或重复")
			}
			seen[col] = true
		}
		for _, row := range data {
			m, ok := row.(map[string]any)
			if !ok {
				return result, fmt.Errorf("表格的每行必须为字段对象")
			}
			for _, col := range result.Columns {
				v, exists := m[col]
				if !exists {
					return result, fmt.Errorf("结果行缺少字段：%s", col)
				}
				switch v.(type) {
				case nil, string, float64, bool:
				default:
					return result, fmt.Errorf("单元格必须是文本、数值或布尔值：%s", col)
				}
			}
		}
	default:
		return result, fmt.Errorf("脚本须返回数值、文本、对象数组或 {valueType,columns,value}")
	}
	return result, nil
}
func executeJavaScriptRenderer(variable Variable, spec map[string]any) (map[string]any, error) {
	data, err := runJavaScript("render", spec, map[string]any{"variable": variable, "target": spec["target"]})
	if err != nil {
		return nil, err
	}
	var plan map[string]any
	if err = json.Unmarshal(data, &plan); err != nil {
		return nil, err
	}
	kind, _ := plan["kind"].(string)
	if expected, _ := spec["kind"].(string); expected != "" && expected != kind {
		return nil, fmt.Errorf("输出类型应为 %s，脚本返回 %s", expected, kind)
	}
	switch kind {
	case "text":
		text, ok := plan["text"].(string)
		if !ok || len([]rune(text)) > 30000 {
			return nil, fmt.Errorf("输出文本必须是至多30000字的字符串")
		}
		return map[string]any{"kind": "text", "text": text}, nil
	case "table":
		rows, ok := plan["rows"].([]any)
		if !ok || len(rows) > 2000 {
			return nil, fmt.Errorf("输出表格必须包含 rows 数组")
		}
		count := 0
		width := -1
		validateRow := func(value any) ([]any, error) {
			row, ok := value.([]any)
			if !ok {
				return nil, fmt.Errorf("表格行必须为数组")
			}
			if width < 0 {
				width = len(row)
			}
			if len(row) != width {
				return nil, fmt.Errorf("表格各行列数不一致")
			}
			for i, v := range row {
				switch v.(type) {
				case nil:
					row[i] = ""
				case string, float64, bool:
					row[i] = fmt.Sprint(v)
				default:
					return nil, fmt.Errorf("表格包含非标量单元格")
				}
			}
			count += len(row)
			return row, nil
		}
		out := map[string]any{"kind": "table", "rows": []any{}, "resizeRows": false}
		if header, exists := plan["header"]; exists {
			row, e := validateRow(header)
			if e != nil {
				return nil, e
			}
			out["header"] = row
		}
		clean := []any{}
		for _, raw := range rows {
			row, e := validateRow(raw)
			if e != nil {
				return nil, e
			}
			clean = append(clean, row)
		}
		if count > 2000 {
			return nil, fmt.Errorf("输出表格超过2000个单元格")
		}
		out["rows"] = clean
		return out, nil
	default:
		return nil, fmt.Errorf("脚本须返回 {kind:'text',text} 或 {kind:'table',header,rows}")
	}
}
