package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const transformSystem = `你是数据转换规则编译器。只输出 JSON，不输出解释。
目标：把用户中文描述编译为安全、确定性的 TransformSpec。严禁生成 JavaScript、SQL、shell 或任意可执行代码。

必须严格使用下面的 canonical schema。注意：步骤类型永远放在 op；filter 的比较符放在 operator；aggregate 的聚合函数放在 fn。不要使用 type 表示步骤类型。
TransformSpec: {version:1,headersMode:"first-row",steps:[...],output:{type:"table"|"number"|"string",fields?:string[],field?:string}}
允许步骤：
- filter: {"op":"filter","field":"状态","operator":"eq","value":"正式"}，operator 仅允许 eq/neq/gt/gte/lt/lte/contains/notContains/empty/notEmpty
- derive: {"op":"derive","as":"新字段","expr":...}
- select: {"op":"select","fields":["字段1",{"from":"字段2","as":"新名称"}]}
- sort: {"op":"sort","field":"金额","direction":"asc"|"desc"}
- limit: {"op":"limit","count":5}
- aggregate: {"op":"aggregate","fn":"sum"|"avg"|"min"|"max"|"count"|"countNonEmpty","field":"金额"}
- groupAggregate: {"op":"groupAggregate","by":["部门"],"aggregates":[{"fn":"sum","field":"金额","as":"合计"}]}
不要引用不存在的字段。优先保持规则简单。`
const bindingSystem = `你是 WPS 文件数据输出规则编译器。只输出 JSON，不输出解释。
必须直接输出 renderer 对象本身，不要再包一层 {"renderer":...}。
仅允许两种 renderer：
- 文本 {kind:"text",valuePath:"$"|"$[0].字段名",template:"{{value}}",format:{numberFormat?:"0"|"0.0"|"0.00"|"percent0"|"percent1",prefix?:string,suffix?:string,divideBy?:number}}
- 表格 {kind:"table",includeHeader:true,columns:[{field,label?,numberFormat?,divideBy?}],maxRows?:number,resizeRows:true}
如果用户要求把元换算成万元/亿元，必须使用 divideBy（万元=10000，亿元=100000000），不能只添加单位后缀。不要生成代码。`

type AITrace struct {
	Model       string         `json:"model,omitempty"`
	BaseURL     string         `json:"baseUrl,omitempty"`
	System      string         `json:"system,omitempty"`
	User        string         `json:"user,omitempty"`
	RawResponse string         `json:"rawResponse,omitempty"`
	Output      map[string]any `json:"output,omitempty"`
	DurationMs  int64          `json:"durationMs,omitempty"`
	Via         string         `json:"via,omitempty"`
	Error       string         `json:"error,omitempty"`
}

func stripJSON(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimSpace(strings.TrimPrefix(s, "```json"))
		s = strings.TrimSpace(strings.TrimPrefix(s, "```"))
		s = strings.TrimSpace(strings.TrimSuffix(s, "```"))
	}
	first := strings.Index(s, "{")
	last := strings.LastIndex(s, "}")
	if first >= 0 && last > first {
		return s[first : last+1]
	}
	return s
}

func chatJSON(settings Settings, system, user string) (out map[string]any, tr AITrace, err error) {
	c := settings.AI
	tr = AITrace{Model: c.Model, BaseURL: c.BaseURL, System: system, User: user, Via: "ai"}
	start := time.Now()
	defer func() { tr.DurationMs = time.Since(start).Milliseconds() }()
	if !c.Enabled || c.APIKey == "" || c.BaseURL == "" || c.Model == "" {
		err := appErr(412, "AI 未配置")
		tr.Error = err.Error()
		return nil, tr, err
	}
	body := map[string]any{"model": c.Model, "temperature": c.Temperature, "response_format": map[string]any{"type": "json_object"}, "messages": []any{map[string]any{"role": "system", "content": system}, map[string]any{"role": "user", "content": user}}}
	b, _ := json.Marshal(body)
	ctx := settings.Context
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.BaseURL, "/")+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		tr.Error = err.Error()
		return nil, tr, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	cli := &http.Client{Timeout: 60 * time.Second}
	res, err := cli.Do(req)
	if err != nil {
		tr.Error = err.Error()
		return nil, tr, err
	}
	defer res.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		err = fmt.Errorf("AI 请求失败 HTTP %d: %s", res.StatusCode, string(rb[:min(len(rb), 500)]))
		tr.RawResponse = string(rb[:min(len(rb), 2000)])
		tr.Error = err.Error()
		return nil, tr, err
	}
	var outer map[string]any
	if err = json.Unmarshal(rb, &outer); err != nil {
		err = fmt.Errorf("AI 返回不是合法 JSON 响应")
		tr.RawResponse = string(rb[:min(len(rb), 2000)])
		tr.Error = err.Error()
		return nil, tr, err
	}
	choices, _ := outer["choices"].([]any)
	if len(choices) == 0 {
		err = fmt.Errorf("AI 返回缺少 choices")
		tr.RawResponse = string(rb[:min(len(rb), 2000)])
		tr.Error = err.Error()
		return nil, tr, err
	}
	ch, _ := choices[0].(map[string]any)
	msg, _ := ch["message"].(map[string]any)
	text, _ := msg["content"].(string)
	tr.RawResponse = text
	if err = json.Unmarshal([]byte(stripJSON(text)), &out); err != nil {
		err = fmt.Errorf("AI 未返回合法 JSON：%s", text[:min(len(text), 500)])
		tr.Error = err.Error()
		return nil, tr, err
	}
	tr.Output = out
	return out, tr, nil
}

func GenerateTransform(settings Settings, values any, description string) (map[string]any, string, AITrace, error) {
	b, err := BuildTransform(settings, values, description)
	return b.Spec, b.Generation, b.AITrace, err
}

func GenerateBinding(settings Settings, v Variable, target map[string]any, description string) (map[string]any, string, AITrace, error) {
	b, err := BuildBinding(settings, v, target, description)
	return b.Renderer, b.Generation, b.AITrace, err
}
