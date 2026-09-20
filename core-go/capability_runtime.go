package main

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// CapabilityDescriptor describes executable primitives available to the planner.
// It is intentionally about runtime I/O, not user-facing business semantics.
type CapabilityDescriptor struct {
	ID          string `json:"id"`
	Stage       string `json:"stage"`    // transform | render
	Executor    string `json:"executor"` // builtin | sandbox
	InputType   string `json:"inputType"`
	OutputType  string `json:"outputType"`
	Description string `json:"description"`
}

type ExecutionNode struct {
	ID         string         `json:"id"`
	Capability string         `json:"capability"`
	InputType  string         `json:"inputType"`
	OutputType string         `json:"outputType"`
	Config     map[string]any `json:"config,omitempty"`
}

type ExecutionGraph struct {
	Stage string          `json:"stage"`
	Nodes []ExecutionNode `json:"nodes"`
}

type GraphValidation struct {
	Passed       bool           `json:"passed"`
	Errors       []string       `json:"errors,omitempty"`
	Warnings     []string       `json:"warnings,omitempty"`
	Graph        ExecutionGraph `json:"graph"`
	DryRunType   string         `json:"dryRunType,omitempty"`
	DryRunFields []string       `json:"dryRunFields,omitempty"`
}

func RuntimeCapabilities() []CapabilityDescriptor {
	return []CapabilityDescriptor{
		{ID: "transform.filter", Stage: "transform", Executor: "builtin", InputType: "table", OutputType: "table", Description: "按字段条件筛选行"},
		{ID: "transform.derive", Stage: "transform", Executor: "builtin", InputType: "table", OutputType: "table", Description: "通过表达式计算新字段"},
		{ID: "transform.select", Stage: "transform", Executor: "builtin", InputType: "table", OutputType: "table", Description: "选择/重命名字段"},
		{ID: "transform.sort", Stage: "transform", Executor: "builtin", InputType: "table", OutputType: "table", Description: "排序"},
		{ID: "transform.limit", Stage: "transform", Executor: "builtin", InputType: "table", OutputType: "table", Description: "截取行"},
		{ID: "transform.aggregate", Stage: "transform", Executor: "builtin", InputType: "table", OutputType: "scalar", Description: "整体聚合"},
		{ID: "transform.groupAggregate", Stage: "transform", Executor: "builtin", InputType: "table", OutputType: "table", Description: "分组聚合"},
		{ID: "transform.sandbox", Stage: "transform", Executor: "sandbox", InputType: "table", OutputType: "dynamic", Description: "AI 临时生成的无文件/网络权限沙箱数据程序"},
		{ID: "render.text", Stage: "render", Executor: "builtin", InputType: "scalar|table", OutputType: "render-plan", Description: "文本渲染"},
		{ID: "render.table", Stage: "render", Executor: "builtin", InputType: "table", OutputType: "render-plan", Description: "表格字段投影"},
		{ID: "render.sandbox", Stage: "render", Executor: "sandbox", InputType: "scalar|table", OutputType: "render-plan", Description: "AI 临时生成的无文件/网络权限沙箱展示程序"},
	}
}

func capabilityByID(id string) (CapabilityDescriptor, bool) {
	for _, c := range RuntimeCapabilities() {
		if c.ID == id {
			return c, true
		}
	}
	return CapabilityDescriptor{}, false
}

func graphForTransform(spec map[string]any) ExecutionGraph {
	g := ExecutionGraph{Stage: "transform"}
	current := "table"
	for i, raw := range stepList(spec) {
		step, _ := raw.(map[string]any)
		op, _ := step["op"].(string)
		capID := "transform." + op
		out := "table"
		if op == "aggregate" {
			out = "scalar"
		}
		if op == "dynamic" {
			capID = "transform.sandbox"
			out = "dynamic"
		}
		g.Nodes = append(g.Nodes, ExecutionNode{ID: fmt.Sprintf("t%d", i+1), Capability: capID, InputType: current, OutputType: out, Config: cloneJSON(step)})
		current = out
	}
	return g
}

func graphForRenderer(v Variable, renderer map[string]any) ExecutionGraph {
	kind, _ := renderer["kind"].(string)
	capID := "render." + kind
	if kind == "dynamic" {
		capID = "render.sandbox"
	}
	return ExecutionGraph{Stage: "render", Nodes: []ExecutionNode{{ID: "r1", Capability: capID, InputType: v.ValueType, OutputType: "render-plan", Config: cloneJSON(renderer)}}}
}

func validateGraphCapabilities(g ExecutionGraph) []string {
	errs := []string{}
	for _, n := range g.Nodes {
		cap, ok := capabilityByID(n.Capability)
		if !ok {
			errs = append(errs, "运行时不存在能力："+n.Capability)
			continue
		}
		if cap.Stage != g.Stage {
			errs = append(errs, fmt.Sprintf("能力 %s 属于 %s 阶段，不能用于 %s", cap.ID, cap.Stage, g.Stage))
		}
		normalizedInput := n.InputType
		if normalizedInput == "number" || normalizedInput == "string" {
			normalizedInput = "scalar"
		}
		if strings.Contains(cap.InputType, "|") {
			okInput := false
			for _, x := range strings.Split(cap.InputType, "|") {
				if x == normalizedInput || normalizedInput == "dynamic" {
					okInput = true
				}
			}
			if !okInput {
				errs = append(errs, fmt.Sprintf("能力 %s 需要 %s，但收到 %s", cap.ID, cap.InputType, n.InputType))
			}
		} else if cap.InputType != normalizedInput && normalizedInput != "dynamic" {
			errs = append(errs, fmt.Sprintf("能力 %s 需要 %s，但收到 %s", cap.ID, cap.InputType, n.InputType))
		}
	}
	return errs
}

// QuickValidateTransformGraph compiles the capability graph and immediately dry-runs it.
// This is the fast validation boundary requested before a variable is ever committed.
func QuickValidateTransformGraph(values any, spec map[string]any) GraphValidation {
	if isJavaScript(spec) {
		r, e := ExecuteTransform(values, spec)
		v := GraphValidation{Passed: e == nil, DryRunType: r.ValueType, DryRunFields: r.Columns}
		if e != nil {
			v.Errors = []string{e.Error()}
		}
		return v
	}
	g := graphForTransform(spec)
	v := GraphValidation{Passed: true, Graph: g}
	v.Errors = append(v.Errors, validateGraphCapabilities(g)...)
	if len(v.Errors) == 0 {
		r, err := ExecuteTransform(values, spec)
		if err != nil {
			v.Errors = append(v.Errors, "快速试跑失败："+err.Error())
		} else {
			v.DryRunType = r.ValueType
			v.DryRunFields = append([]string(nil), r.Columns...)
		}
	}
	v.Passed = len(v.Errors) == 0
	return v
}

func QuickValidateRendererGraph(variable Variable, renderer map[string]any) GraphValidation {
	if isJavaScript(renderer) {
		_, e := RenderPlan(variable, renderer)
		v := GraphValidation{Passed: e == nil}
		if e != nil {
			v.Errors = []string{e.Error()}
		}
		return v
	}
	g := graphForRenderer(variable, renderer)
	v := GraphValidation{Passed: true, Graph: g}
	v.Errors = append(v.Errors, validateGraphCapabilities(g)...)
	if len(v.Errors) == 0 {
		p, err := RenderPlan(variable, renderer)
		if err != nil {
			v.Errors = append(v.Errors, "快速试跑失败："+err.Error())
		} else {
			if k, _ := p["kind"].(string); k != "" {
				v.DryRunType = k
			}
		}
	}
	v.Passed = len(v.Errors) == 0
	return v
}

// ---- sandbox expression/program runtime ----
// ra-cap-v1 is deliberately data-only. It has no file, process, network, registry,
// COM or WPS object access. The AI can write computation/shape programs, but the
// program can only see the explicit row/index/variable values passed here.

func capTruthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case nil:
		return false
	case string:
		return strings.TrimSpace(x) != "" && x != "0" && strings.ToLower(x) != "false"
	default:
		return num(v) != 0
	}
}

func evalCapExpr(expr any, row map[string]any, index int, rows []map[string]any) (any, error) {
	m, ok := expr.(map[string]any)
	if !ok {
		return expr, nil
	}
	if f, ok := m["field"].(string); ok {
		return row[f], nil
	}
	if v, ok := m["value"]; ok {
		return v, nil
	}
	if vr, ok := m["var"].(string); ok {
		switch vr {
		case "index":
			return index, nil
		case "rowNumber":
			return index + 1, nil
		case "rowCount":
			return len(rows), nil
		}
		return nil, fmt.Errorf("未知沙箱变量: %s", vr)
	}
	op, _ := m["op"].(string)
	argsAny, _ := m["args"].([]any)
	args := make([]any, len(argsAny))
	for i, a := range argsAny {
		x, e := evalCapExpr(a, row, index, rows)
		if e != nil {
			return nil, e
		}
		args[i] = x
	}
	switch op {
	case "add":
		t := 0.0
		for _, a := range args {
			t += num(a)
		}
		return t, nil
	case "sub":
		if len(args) < 2 {
			return nil, nil
		}
		return num(args[0]) - num(args[1]), nil
	case "mul":
		t := 1.0
		for _, a := range args {
			t *= num(a)
		}
		return t, nil
	case "div":
		if len(args) < 2 || num(args[1]) == 0 {
			return nil, nil
		}
		return num(args[0]) / num(args[1]), nil
	case "mod":
		if len(args) < 2 || num(args[1]) == 0 {
			return nil, nil
		}
		return math.Mod(num(args[0]), num(args[1])), nil
	case "round":
		if len(args) < 1 {
			return nil, nil
		}
		digits := 0
		if d, ok := asFloat(m["digits"]); ok {
			digits = int(d)
		}
		p := math.Pow10(digits)
		return math.Round(num(args[0])*p) / p, nil
	case "concat":
		sep, _ := m["separator"].(string)
		ss := make([]string, len(args))
		for i, a := range args {
			ss[i] = fmt.Sprint(a)
		}
		return strings.Join(ss, sep), nil
	case "eq":
		if len(args) < 2 {
			return false, nil
		}
		return fmt.Sprint(args[0]) == fmt.Sprint(args[1]), nil
	case "neq":
		if len(args) < 2 {
			return false, nil
		}
		return fmt.Sprint(args[0]) != fmt.Sprint(args[1]), nil
	case "gt":
		if len(args) < 2 {
			return false, nil
		}
		return num(args[0]) > num(args[1]), nil
	case "gte":
		if len(args) < 2 {
			return false, nil
		}
		return num(args[0]) >= num(args[1]), nil
	case "lt":
		if len(args) < 2 {
			return false, nil
		}
		return num(args[0]) < num(args[1]), nil
	case "lte":
		if len(args) < 2 {
			return false, nil
		}
		return num(args[0]) <= num(args[1]), nil
	case "and":
		for _, a := range args {
			if !capTruthy(a) {
				return false, nil
			}
		}
		return true, nil
	case "or":
		for _, a := range args {
			if capTruthy(a) {
				return true, nil
			}
		}
		return false, nil
	case "not":
		if len(args) < 1 {
			return true, nil
		}
		return !capTruthy(args[0]), nil
	case "if":
		if len(args) < 3 {
			return nil, nil
		}
		if capTruthy(args[0]) {
			return args[1], nil
		}
		return args[2], nil
	case "contains":
		if len(args) < 2 {
			return false, nil
		}
		return strings.Contains(fmt.Sprint(args[0]), fmt.Sprint(args[1])), nil
	}
	return nil, fmt.Errorf("不支持的沙箱表达式 op: %s", op)
}

func validateCapExpr(expr any, fields []string) error {
	m, ok := expr.(map[string]any)
	if !ok {
		return nil
	}
	if f, ok := m["field"].(string); ok && !fieldExists(fields, f) {
		return fmt.Errorf("沙箱表达式引用不存在字段“%s”", f)
	}
	if vr, ok := m["var"].(string); ok {
		if vr != "index" && vr != "rowNumber" && vr != "rowCount" {
			return fmt.Errorf("沙箱表达式使用未知变量“%s”", vr)
		}
	}
	if op, ok := m["op"].(string); ok {
		allowed := map[string]bool{"add": true, "sub": true, "mul": true, "div": true, "mod": true, "round": true, "concat": true, "eq": true, "neq": true, "gt": true, "gte": true, "lt": true, "lte": true, "and": true, "or": true, "not": true, "if": true, "contains": true}
		if !allowed[op] {
			return fmt.Errorf("沙箱表达式 op 不允许: %s", op)
		}
	}
	if a, ok := m["args"].([]any); ok {
		for _, x := range a {
			if e := validateCapExpr(x, fields); e != nil {
				return e
			}
		}
	}
	return nil
}

func validateDynamicProgram(program map[string]any, stage string, fields []string) error {
	if program == nil {
		return fmt.Errorf("动态能力 program 为空")
	}
	if lang, _ := program["language"].(string); lang != "ra-cap-v1" {
		return fmt.Errorf("动态能力仅支持 ra-cap-v1")
	}
	if st, _ := program["stage"].(string); st != stage {
		return fmt.Errorf("动态能力 stage=%s，期望 %s", st, stage)
	}
	switch stage {
	case "render":
		kind, _ := program["kind"].(string)
		if kind != "table" && kind != "text" {
			return fmt.Errorf("render 沙箱输出仅支持 table/text plan")
		}
		if kind == "table" {
			cols, _ := program["columns"].([]any)
			if len(cols) == 0 {
				return fmt.Errorf("动态表格能力 columns 不能为空")
			}
			if n, ok := asFloat(program["maxRows"]); ok && (n < 0 || math.Trunc(n) != n) {
				return fmt.Errorf("动态表格 maxRows 必须是非负整数")
			}
			for i, craw := range cols {
				c, ok := craw.(map[string]any)
				if !ok {
					return fmt.Errorf("columns[%d] 无效", i)
				}
				if strings.TrimSpace(fmt.Sprint(c["label"])) == "" {
					return fmt.Errorf("columns[%d] 缺少 label", i)
				}
				if e := validateCapExpr(c["expr"], fields); e != nil {
					return e
				}
				if fm, ok := c["format"].(map[string]any); ok {
					if nf, _ := fm["numberFormat"].(string); !validNumberFormat(nf) {
						return fmt.Errorf("columns[%d].format.numberFormat 不支持: %s", i, nf)
					}
					if d, ok := asFloat(fm["divideBy"]); ok && (d == 0 || math.IsNaN(d) || math.IsInf(d, 0)) {
						return fmt.Errorf("columns[%d].format.divideBy 必须是有限非零数", i)
					}
					if scale, ok := asFloat(fm["scale"]); ok && (math.IsNaN(scale) || math.IsInf(scale, 0)) {
						return fmt.Errorf("columns[%d].format.scale 必须是有限数", i)
					}
				}
			}
		} else {
			if e := validateCapExpr(program["expr"], fields); e != nil {
				return e
			}
		}
	case "transform":
		steps, _ := program["steps"].([]any)
		if len(steps) == 0 {
			return fmt.Errorf("动态 transform steps 不能为空")
		}
		current := append([]string(nil), fields...)
		for i, sraw := range steps {
			s, ok := sraw.(map[string]any)
			if !ok {
				return fmt.Errorf("sandbox steps[%d] 无效", i)
			}
			op, _ := s["op"].(string)
			switch op {
			case "filter", "sort":
				if e := validateCapExpr(s["expr"], current); e != nil {
					return e
				}
			case "map":
				cols, _ := s["columns"].([]any)
				if len(cols) == 0 {
					return fmt.Errorf("sandbox map.columns 不能为空")
				}
				next := []string{}
				keep, _ := s["keepExisting"].(bool)
				if keep {
					next = append(next, current...)
				}
				for _, craw := range cols {
					c, ok := craw.(map[string]any)
					if !ok {
						return fmt.Errorf("sandbox map column 无效")
					}
					name, _ := c["name"].(string)
					if strings.TrimSpace(name) == "" {
						return fmt.Errorf("sandbox map column 缺少 name")
					}
					if e := validateCapExpr(c["expr"], current); e != nil {
						return e
					}
					next = appendUnique(next, name)
				}
				current = next
			case "limit":
				n, ok := asFloat(s["count"])
				if !ok || n < 0 {
					return fmt.Errorf("sandbox limit.count 无效")
				}
			case "reduce":
				fn, _ := s["fn"].(string)
				if fn != "sum" && fn != "avg" && fn != "min" && fn != "max" && fn != "count" {
					return fmt.Errorf("sandbox reduce.fn 不允许: %s", fn)
				}
				if fn != "count" {
					if e := validateCapExpr(s["expr"], current); e != nil {
						return e
					}
				}
			default:
				return fmt.Errorf("sandbox transform op 不允许: %s", op)
			}
		}
	}
	return nil
}

func executeDynamicTransform(rows []map[string]any, headers []string, program map[string]any) ([]map[string]any, []string, any, bool, error) {
	if err := validateDynamicProgram(program, "transform", headers); err != nil {
		return nil, nil, nil, false, err
	}
	current := make([]map[string]any, len(rows))
	for i, r := range rows {
		current[i] = cloneJSON(r)
	}
	fields := append([]string(nil), headers...)
	for _, sraw := range program["steps"].([]any) {
		s := sraw.(map[string]any)
		op, _ := s["op"].(string)
		switch op {
		case "filter":
			out := []map[string]any{}
			for i, r := range current {
				v, e := evalCapExpr(s["expr"], r, i, current)
				if e != nil {
					return nil, nil, nil, false, e
				}
				if capTruthy(v) {
					out = append(out, r)
				}
			}
			current = out
		case "map":
			keep, _ := s["keepExisting"].(bool)
			cols := s["columns"].([]any)
			nextFields := []string{}
			if keep {
				nextFields = append(nextFields, fields...)
			}
			out := make([]map[string]any, 0, len(current))
			for i, r := range current {
				nr := map[string]any{}
				if keep {
					for k, v := range r {
						if k != "__row" {
							nr[k] = v
						}
					}
				}
				for _, craw := range cols {
					c := craw.(map[string]any)
					name := c["name"].(string)
					v, e := evalCapExpr(c["expr"], r, i, current)
					if e != nil {
						return nil, nil, nil, false, e
					}
					nr[name] = v
					nextFields = appendUnique(nextFields, name)
				}
				out = append(out, nr)
			}
			current = out
			fields = nextFields
		case "sort":
			dir, _ := s["direction"].(string)
			type pair struct {
				r   map[string]any
				key any
				idx int
			}
			pairs := make([]pair, len(current))
			for i, r := range current {
				k, e := evalCapExpr(s["expr"], r, i, current)
				if e != nil {
					return nil, nil, nil, false, e
				}
				pairs[i] = pair{r: r, key: k, idx: i}
			}
			sort.SliceStable(pairs, func(i, j int) bool {
				a, b := pairs[i].key, pairs[j].key
				if isNumber(a) || isNumber(b) {
					if dir == "desc" {
						return num(a) > num(b)
					}
					return num(a) < num(b)
				}
				as, bs := fmt.Sprint(a), fmt.Sprint(b)
				if dir == "desc" {
					return as > bs
				}
				return as < bs
			})
			for i, p := range pairs {
				current[i] = p.r
			}
		case "limit":
			n, _ := asFloat(s["count"])
			if int(n) < len(current) {
				current = current[:int(n)]
			}
		case "reduce":
			fn := s["fn"].(string)
			vals := []float64{}
			if fn != "count" {
				for i, r := range current {
					v, e := evalCapExpr(s["expr"], r, i, current)
					if e != nil {
						return nil, nil, nil, false, e
					}
					vals = append(vals, num(v))
				}
			}
			var scalar any
			switch fn {
			case "count":
				scalar = len(current)
			case "sum":
				t := 0.0
				for _, v := range vals {
					t += v
				}
				scalar = t
			case "avg":
				t := 0.0
				for _, v := range vals {
					t += v
				}
				if len(vals) > 0 {
					scalar = t / float64(len(vals))
				} else {
					scalar = 0.0
				}
			case "min":
				if len(vals) > 0 {
					m := vals[0]
					for _, v := range vals[1:] {
						if v < m {
							m = v
						}
					}
					scalar = m
				}
			case "max":
				if len(vals) > 0 {
					m := vals[0]
					for _, v := range vals[1:] {
						if v > m {
							m = v
						}
					}
					scalar = m
				}
			}
			return current, fields, scalar, true, nil
		}
	}
	return current, fields, nil, false, nil
}

func executeDynamicRenderer(variable Variable, program map[string]any) (map[string]any, error) {
	if err := validateDynamicProgram(program, "render", variable.Columns); err != nil {
		return nil, err
	}
	kind := program["kind"].(string)
	rows := mapRows(variable.Value)
	if kind == "text" {
		row := map[string]any{}
		if len(rows) > 0 {
			row = rows[0]
		}
		v, e := evalCapExpr(program["expr"], row, 0, rows)
		if e != nil {
			return nil, e
		}
		prefix, _ := program["prefix"].(string)
		suffix, _ := program["suffix"].(string)
		return map[string]any{"kind": "text", "text": prefix + fmt.Sprint(v) + suffix}, nil
	}
	cols := program["columns"].([]any)
	max := len(rows)
	if n, ok := asFloat(program["maxRows"]); ok && int(n) < max {
		max = int(n)
	}
	header := []string{}
	for _, craw := range cols {
		c := craw.(map[string]any)
		header = append(header, fmt.Sprint(c["label"]))
	}
	body := make([][]string, 0, max)
	for i, r := range rows[:max] {
		line := []string{}
		for _, craw := range cols {
			c := craw.(map[string]any)
			v, e := evalCapExpr(c["expr"], r, i, rows)
			if e != nil {
				return nil, e
			}
			if fmtSpec, ok := c["format"].(map[string]any); ok {
				v = applyNumericFormat(v, fmtSpec)
			}
			line = append(line, fmt.Sprint(v))
		}
		body = append(body, line)
	}
	include := true
	if b, ok := program["includeHeader"].(bool); ok {
		include = b
	}
	var h any = nil
	if include {
		h = header
	}
	resize := true
	if b, ok := program["resizeRows"].(bool); ok {
		resize = b
	}
	return map[string]any{"kind": "table", "header": h, "rows": body, "resizeRows": resize}, nil
}

func inferDynamicTransformShape(program map[string]any, fields []string) ([]string, bool) {
	current := append([]string(nil), fields...)
	scalar := false
	steps, _ := program["steps"].([]any)
	for _, sraw := range steps {
		s, _ := sraw.(map[string]any)
		op, _ := s["op"].(string)
		switch op {
		case "map":
			next := []string{}
			keep, _ := s["keepExisting"].(bool)
			if keep {
				next = append(next, current...)
			}
			cols, _ := s["columns"].([]any)
			for _, craw := range cols {
				c, _ := craw.(map[string]any)
				name, _ := c["name"].(string)
				if name != "" {
					next = appendUnique(next, name)
				}
			}
			current = next
		case "reduce":
			scalar = true
		}
	}
	return current, scalar
}
