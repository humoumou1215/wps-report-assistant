package main

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

type TransformResult struct {
	ValueType string   `json:"valueType"`
	Value     any      `json:"value"`
	Columns   []string `json:"columns"`
}

func isTransformStepKind(v string) bool {
	switch v {
	case "filter", "derive", "select", "sort", "limit", "aggregate", "groupAggregate", "dynamic":
		return true
	}
	return false
}

func isFilterOperator(v string) bool {
	switch v {
	case "eq", "neq", "gt", "gte", "lt", "lte", "contains", "notContains", "empty", "notEmpty":
		return true
	}
	return false
}

func isAggregateFunction(v string) bool {
	switch v {
	case "sum", "avg", "min", "max", "count", "countNonEmpty":
		return true
	}
	return false
}

// NormalizeTransformSpec accepts both the canonical TransformSpec used by the
// executor and the compact shape that LLMs commonly produce.  The canonical
// shape deliberately separates a step kind from the operation inside that
// step, e.g. filter uses {op:"filter", operator:"eq"} and aggregate uses
// {op:"aggregate", fn:"sum"}.  Older v0.4.0 prompts allowed the ambiguous
// {type:"filter", op:"eq"} / {type:"aggregate", op:"sum"} form.  Keeping the
// normalization here makes persisted specs deterministic and lets old AI
// responses remain executable.
func NormalizeTransformSpec(spec map[string]any) (map[string]any, error) {
	if isJavaScript(spec) {
		return normalizeJavaScript(spec)
	}
	if spec == nil {
		return nil, fmt.Errorf("TransformSpec 不能为空")
	}
	out := cloneJSON(spec)
	rawSteps, _ := out["steps"].([]any)
	normalized := make([]any, 0, len(rawSteps))
	for i, raw := range rawSteps {
		step, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("TransformSpec 第 %d 个步骤无效", i+1)
		}
		typeValue, _ := step["type"].(string)
		opValue, _ := step["op"].(string)
		kind := ""
		if isTransformStepKind(typeValue) {
			kind = typeValue
		} else if isTransformStepKind(opValue) {
			kind = opValue
		}
		if kind == "" {
			return nil, fmt.Errorf("TransformSpec 第 %d 个步骤类型无效: type=%q op=%q", i+1, typeValue, opValue)
		}

		step["op"] = kind
		delete(step, "type")
		switch kind {
		case "filter":
			operator, _ := step["operator"].(string)
			if operator == "" && opValue != "" && opValue != "filter" {
				operator = opValue
				step["operator"] = operator
			}
			if !isFilterOperator(operator) {
				return nil, fmt.Errorf("TransformSpec 第 %d 个 filter operator 无效: %q", i+1, operator)
			}
		case "aggregate":
			fn, _ := step["fn"].(string)
			if fn == "" && opValue != "" && opValue != "aggregate" {
				fn = opValue
				step["fn"] = fn
			}
			if !isAggregateFunction(fn) {
				return nil, fmt.Errorf("TransformSpec 第 %d 个 aggregate fn 无效: %q", i+1, fn)
			}
		case "groupAggregate":
			aggs, _ := step["aggregates"].([]any)
			for j, aRaw := range aggs {
				a, ok := aRaw.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("TransformSpec 第 %d 个 groupAggregate 的第 %d 个聚合无效", i+1, j+1)
				}
				fn, _ := a["fn"].(string)
				if fn == "" {
					if alt, _ := a["op"].(string); alt != "" {
						fn = alt
						a["fn"] = alt
					}
				}
				if !isAggregateFunction(fn) {
					return nil, fmt.Errorf("TransformSpec 第 %d 个 groupAggregate 的第 %d 个 fn 无效: %q", i+1, j+1, fn)
				}
				delete(a, "op")
			}
		}
		normalized = append(normalized, step)
	}
	out["steps"] = normalized
	return out, nil
}

func asMatrix(values any) [][]any {
	arr, ok := values.([]any)
	if !ok {
		if m, ok := values.([][]any); ok {
			return m
		}
		return [][]any{{values}}
	}
	if len(arr) == 0 {
		return [][]any{}
	}
	out := make([][]any, 0, len(arr))
	for _, r := range arr {
		if rr, ok := r.([]any); ok {
			out = append(out, rr)
		} else {
			out = append(out, []any{r})
		}
	}
	return out
}
func matrixToRows(values any, headersMode string) ([]string, []map[string]any) {
	m := asMatrix(values)
	if len(m) == 0 {
		return []string{}, []map[string]any{}
	}
	width := 0
	for _, r := range m {
		if len(r) > width {
			width = len(r)
		}
	}
	norm := make([][]any, len(m))
	for i, r := range m {
		norm[i] = make([]any, width)
		copy(norm[i], r)
	}
	headers := make([]string, width)
	body := norm
	if headersMode == "none" {
		for i := 0; i < width; i++ {
			headers[i] = fmt.Sprintf("列%d", i+1)
		}
	} else {
		for i, h := range norm[0] {
			s := strings.TrimSpace(fmt.Sprint(h))
			if h == nil || s == "<nil>" || s == "" {
				s = fmt.Sprintf("列%d", i+1)
			}
			headers[i] = s
		}
		body = norm[1:]
	}
	used := map[string]bool{}
	for i, h := range headers {
		base := strings.TrimSpace(h)
		if base == "" {
			base = fmt.Sprintf("列%d", i+1)
		}
		candidate := base
		for n := 2; used[candidate] || candidate == "__row"; n++ {
			candidate = fmt.Sprintf("%s_%d", base, n)
		}
		headers[i] = candidate
		used[candidate] = true
	}
	rows := make([]map[string]any, 0, len(body))
	for ri, r := range body {
		row := map[string]any{}
		for i, h := range headers {
			row[h] = r[i]
		}
		row["__row"] = ri + 1
		rows = append(rows, row)
	}
	return headers, rows
}
func num(v any) float64 {
	if v == nil {
		return 0
	}
	switch x := v.(type) {
	case float64:
		if !math.IsNaN(x) && !math.IsInf(x, 0) {
			return x
		}
		return 0
	case float32:
		return float64(x)
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case json.Number:
		f, _ := x.Float64()
		return f
	}
	s := strings.TrimSpace(fmt.Sprint(v))
	s = strings.NewReplacer(",", "", "%", "", "￥", "", "¥", "").Replace(s)
	f, _ := strconv.ParseFloat(s, 64)
	return f
}
func isEmpty(v any) bool {
	return v == nil || strings.TrimSpace(fmt.Sprint(v)) == "" || fmt.Sprint(v) == "<nil>"
}
func compare(a any, op string, b any) (bool, error) {
	switch op {
	case "eq":
		return fmt.Sprint(a) == fmt.Sprint(b), nil
	case "neq":
		return fmt.Sprint(a) != fmt.Sprint(b), nil
	case "gt":
		return num(a) > num(b), nil
	case "gte":
		return num(a) >= num(b), nil
	case "lt":
		return num(a) < num(b), nil
	case "lte":
		return num(a) <= num(b), nil
	case "contains":
		return strings.Contains(fmt.Sprint(a), fmt.Sprint(b)), nil
	case "notContains":
		return !strings.Contains(fmt.Sprint(a), fmt.Sprint(b)), nil
	case "empty":
		return isEmpty(a), nil
	case "notEmpty":
		return !isEmpty(a), nil
	}
	return false, fmt.Errorf("不支持的过滤操作: %s", op)
}
func evalExpr(expr any, row map[string]any) (any, error) {
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
	fn, _ := m["fn"].(string)
	argsAny, _ := m["args"].([]any)
	args := make([]any, len(argsAny))
	for i, a := range argsAny {
		v, err := evalExpr(a, row)
		if err != nil {
			return nil, err
		}
		args[i] = v
	}
	switch fn {
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
	case "percent":
		if len(args) < 2 || num(args[1]) == 0 {
			return nil, nil
		}
		return num(args[0]) / num(args[1]) * 100, nil
	case "concat":
		sep, _ := m["separator"].(string)
		ss := make([]string, len(args))
		for i, a := range args {
			if a != nil {
				ss[i] = fmt.Sprint(a)
			}
		}
		return strings.Join(ss, sep), nil
	case "round":
		if len(args) < 1 {
			return nil, nil
		}
		d := 2
		if x, ok := asFloat(m["digits"]); ok {
			d = int(x)
		}
		pow := math.Pow10(d)
		return math.Round(num(args[0])*pow) / pow, nil
	}
	return nil, fmt.Errorf("不支持的表达式函数: %s", fn)
}
func aggregate(rows []map[string]any, fn, field string) (any, error) {
	vals := make([]float64, 0, len(rows))
	if field != "" {
		for _, r := range rows {
			vals = append(vals, num(r[field]))
		}
	}
	switch fn {
	case "sum":
		t := 0.0
		for _, v := range vals {
			t += v
		}
		return t, nil
	case "avg":
		if len(vals) == 0 {
			return float64(0), nil
		}
		t := 0.0
		for _, v := range vals {
			t += v
		}
		return t / float64(len(vals)), nil
	case "min":
		if len(vals) == 0 {
			return nil, nil
		}
		m := vals[0]
		for _, v := range vals[1:] {
			if v < m {
				m = v
			}
		}
		return m, nil
	case "max":
		if len(vals) == 0 {
			return nil, nil
		}
		m := vals[0]
		for _, v := range vals[1:] {
			if v > m {
				m = v
			}
		}
		return m, nil
	case "count":
		return len(rows), nil
	case "countNonEmpty":
		c := 0
		for _, r := range rows {
			if !isEmpty(r[field]) {
				c++
			}
		}
		return c, nil
	}
	return nil, fmt.Errorf("不支持的聚合函数: %s", fn)
}
func ExecuteTransform(values any, spec map[string]any) (TransformResult, error) {
	if isJavaScript(spec) {
		return executeJavaScriptTransform(values, spec)
	}
	normalized, err := NormalizeTransformSpec(spec)
	if err != nil {
		return TransformResult{}, err
	}
	spec = normalized
	ver, _ := asFloat(spec["version"])
	if int(ver) != 1 {
		return TransformResult{}, fmt.Errorf("TransformSpec 版本无效")
	}
	hm, _ := spec["headersMode"].(string)
	if hm == "" {
		hm = "first-row"
	}
	headers, rows := matrixToRows(values, hm)
	var scalar any
	hasScalar := false
	steps, _ := spec["steps"].([]any)
	for _, raw := range steps {
		step, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		op, _ := step["op"].(string)
		switch op {
		case "filter":
			field, _ := step["field"].(string)
			oper, _ := step["operator"].(string)
			out := rows[:0]
			for _, r := range rows {
				yes, err := compare(r[field], oper, step["value"])
				if err != nil {
					return TransformResult{}, err
				}
				if yes {
					out = append(out, r)
				}
			}
			rows = out
		case "derive":
			as, _ := step["as"].(string)
			for _, r := range rows {
				v, err := evalExpr(step["expr"], r)
				if err != nil {
					return TransformResult{}, err
				}
				r[as] = v
			}
			found := false
			for _, h := range headers {
				if h == as {
					found = true
				}
			}
			if !found {
				headers = append(headers, as)
			}
		case "select":
			fields, _ := step["fields"].([]any)
			newH := []string{}
			newRows := make([]map[string]any, 0, len(rows))
			for _, r := range rows {
				nr := map[string]any{}
				for _, f := range fields {
					switch x := f.(type) {
					case string:
						newH = appendUnique(newH, x)
						nr[x] = r[x]
					case map[string]any:
						from, _ := x["from"].(string)
						as, _ := x["as"].(string)
						if as == "" {
							as = from
						}
						newH = appendUnique(newH, as)
						nr[as] = r[from]
					}
				}
				newRows = append(newRows, nr)
			}
			headers = newH
			rows = newRows
		case "sort":
			field, _ := step["field"].(string)
			dir := 1
			if step["direction"] == "desc" {
				dir = -1
			}
			sort.SliceStable(rows, func(i, j int) bool {
				a, b := rows[i][field], rows[j][field]
				_, aNum := a.(float64)
				_, bNum := b.(float64)
				if aNum || bNum {
					if dir > 0 {
						return num(a) < num(b)
					}
					return num(a) > num(b)
				}
				if dir > 0 {
					return fmt.Sprint(a) < fmt.Sprint(b)
				}
				return fmt.Sprint(a) > fmt.Sprint(b)
			})
		case "limit":
			n, _ := asFloat(step["count"])
			nn := int(n)
			if nn < 0 {
				nn = 0
			}
			if nn < len(rows) {
				rows = rows[:nn]
			}
		case "groupAggregate":
			by := toStringSlice(step["by"])
			aggs, _ := step["aggregates"].([]any)
			type group struct {
				key  string
				rows []map[string]any
			}
			gm := map[string]*group{}
			order := []string{}
			for _, r := range rows {
				parts := make([]string, len(by))
				for i, f := range by {
					parts[i] = fmt.Sprint(r[f])
				}
				k := strings.Join(parts, "\x1f")
				if gm[k] == nil {
					gm[k] = &group{key: k}
					order = append(order, k)
				}
				gm[k].rows = append(gm[k].rows, r)
			}
			out := []map[string]any{}
			newH := append([]string{}, by...)
			for _, aRaw := range aggs {
				if a, ok := aRaw.(map[string]any); ok {
					fn, _ := a["fn"].(string)
					field, _ := a["field"].(string)
					as, _ := a["as"].(string)
					if as == "" {
						as = fn + "_" + field
					}
					newH = append(newH, as)
				}
			}
			for _, k := range order {
				g := gm[k]
				o := map[string]any{}
				if len(g.rows) > 0 {
					for _, f := range by {
						o[f] = g.rows[0][f]
					}
				}
				for _, aRaw := range aggs {
					a, _ := aRaw.(map[string]any)
					fn, _ := a["fn"].(string)
					field, _ := a["field"].(string)
					as, _ := a["as"].(string)
					if as == "" {
						as = fn + "_" + field
					}
					v, err := aggregate(g.rows, fn, field)
					if err != nil {
						return TransformResult{}, err
					}
					o[as] = v
				}
				out = append(out, o)
			}
			rows = out
			headers = newH
		case "aggregate":
			fn, _ := step["fn"].(string)
			field, _ := step["field"].(string)
			v, err := aggregate(rows, fn, field)
			if err != nil {
				return TransformResult{}, err
			}
			scalar = v
			hasScalar = true
		case "dynamic":
			program, _ := step["program"].(map[string]any)
			nextRows, nextHeaders, dynScalar, dynHasScalar, err := executeDynamicTransform(rows, headers, program)
			if err != nil {
				return TransformResult{}, err
			}
			rows, headers = nextRows, nextHeaders
			if dynHasScalar {
				scalar, hasScalar = dynScalar, true
			}
		default:
			return TransformResult{}, fmt.Errorf("不支持的步骤: %s", op)
		}
	}
	output, _ := spec["output"].(map[string]any)
	typ, _ := output["type"].(string)
	if typ == "" {
		if hasScalar {
			typ = "number"
		} else {
			typ = "table"
		}
	}
	if typ == "number" {
		if !hasScalar {
			field, _ := output["field"].(string)
			if field != "" && len(rows) > 0 {
				scalar = num(rows[0][field])
			} else {
				scalar = float64(0)
			}
		}
		return TransformResult{ValueType: "number", Value: scalar, Columns: []string{}}, nil
	}
	if typ == "string" {
		field, _ := output["field"].(string)
		var v any = ""
		if field != "" && len(rows) > 0 {
			v = rows[0][field]
		} else if hasScalar {
			v = scalar
		}
		return TransformResult{ValueType: "string", Value: fmt.Sprint(v), Columns: []string{}}, nil
	}
	cols := toStringSlice(output["fields"])
	if len(cols) == 0 {
		cols = headers
	}
	clean := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		o := map[string]any{}
		for _, c := range cols {
			o[c] = r[c]
		}
		clean = append(clean, o)
	}
	return TransformResult{ValueType: "table", Value: clean, Columns: cols}, nil
}
func appendUnique(xs []string, s string) []string {
	for _, x := range xs {
		if x == s {
			return xs
		}
	}
	return append(xs, s)
}
func extractEqFilter(description, field string) (any, bool) {
	markers := []string{field + "为", field + "等于", field + "="}
	for _, marker := range markers {
		i := strings.Index(description, marker)
		if i < 0 {
			continue
		}
		rest := strings.TrimSpace(description[i+len(marker):])
		rest = strings.TrimLeft(rest, "：:『』「」【】[]()（）\"' ")
		if rest == "" {
			continue
		}
		cut := len(rest)
		for _, d := range []string{"的数据", "的记录", "，", ",", "。", ";", "；", "并且", "然后", "再", "按"} {
			if j := strings.Index(rest, d); j >= 0 && j < cut {
				cut = j
			}
		}
		value := strings.TrimSpace(strings.Trim(rest[:cut], "『』「」【】[]()（）\"' "))
		if value != "" {
			return value, true
		}
	}
	return nil, false
}

func GuessTransform(values any, description string) map[string]any {
	m := asMatrix(values)
	if len(m) == 0 {
		return map[string]any{"version": 1, "headersMode": "first-row", "steps": []any{}, "output": map[string]any{"type": "table", "fields": []string{}}}
	}
	headers, rows := matrixToRows(values, "first-row")
	numeric := []string{}
	for _, h := range headers {
		for _, r := range rows {
			v := r[h]
			if _, ok := v.(float64); ok {
				numeric = append(numeric, h)
				break
			}
			s := strings.TrimSpace(fmt.Sprint(v))
			if s != "" {
				if _, err := strconv.ParseFloat(strings.ReplaceAll(strings.ReplaceAll(s, ",", ""), "%", ""), 64); err == nil {
					numeric = append(numeric, h)
					break
				}
			}
		}
	}
	steps := []any{}
	for _, h := range headers {
		if value, ok := extractEqFilter(description, h); ok {
			steps = append(steps, map[string]any{"op": "filter", "field": h, "operator": "eq", "value": value})
			break
		}
	}
	field := ""
	// Aggregation should prefer a numeric field explicitly named by the user;
	// the old fallback accidentally picked the first mentioned field (often 状态).
	for _, h := range numeric {
		if strings.Contains(description, h) {
			field = h
			break
		}
	}
	if field == "" && len(numeric) > 0 {
		field = numeric[0]
	}
	if field == "" && len(headers) > 0 {
		field = headers[0]
	}
	fn := ""
	switch {
	case strings.Contains(description, "平均") || strings.Contains(description, "均值"):
		fn = "avg"
	case strings.Contains(description, "最大"):
		fn = "max"
	case strings.Contains(description, "最小"):
		fn = "min"
	case strings.Contains(description, "求和") || strings.Contains(description, "合计") || strings.Contains(description, "总计") || strings.Contains(description, "总额"):
		fn = "sum"
	}
	if fn != "" {
		steps = append(steps, map[string]any{"op": "aggregate", "fn": fn, "field": field})
		return map[string]any{"version": 1, "headersMode": "first-row", "steps": steps, "output": map[string]any{"type": "number"}}
	}
	return map[string]any{"version": 1, "headersMode": "first-row", "steps": steps, "output": map[string]any{"type": "table", "fields": stringSliceAny(headers)}}
}
func stringSliceAny(s []string) []any {
	o := make([]any, len(s))
	for i, v := range s {
		o[i] = v
	}
	return o
}
