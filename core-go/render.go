package main

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

func formatNumber(v any, fmtStr string) string {
	n := num(v)
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return fmt.Sprint(v)
	}
	switch fmtStr {
	case "0":
		return strconv.FormatFloat(n, 'f', 0, 64)
	case "0.0":
		return strconv.FormatFloat(n, 'f', 1, 64)
	case "0.00":
		return strconv.FormatFloat(n, 'f', 2, 64)
	case "percent0":
		return strconv.FormatFloat(n*100, 'f', 0, 64) + "%"
	case "percent1":
		return strconv.FormatFloat(n*100, 'f', 1, 64) + "%"
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}

func isNumber(v any) bool {
	switch v.(type) {
	case float64, float32, int, int64, int32, jsonNumber:
		return true
	}
	return false
}

type jsonNumber interface{ String() string }

func mapRows(v any) []map[string]any {
	switch x := v.(type) {
	case []map[string]any:
		return x
	case []any:
		o := []map[string]any{}
		for _, e := range x {
			if m, ok := e.(map[string]any); ok {
				o = append(o, m)
			}
		}
		return o
	}
	return nil
}

func pathValue(v any, path string) any {
	if path == "" || path == "$" {
		return v
	}
	if strings.HasPrefix(path, "$[") {
		close := strings.Index(path, "]")
		if close > 2 && close+2 <= len(path) && path[close+1] == '.' {
			idx, _ := strconv.Atoi(path[2:close])
			field := path[close+2:]
			rows := mapRows(v)
			if idx >= 0 && idx < len(rows) {
				return rows[idx][field]
			}
		}
	}
	return nil
}

// NormalizeRendererSpec accepts both the canonical renderer object and the common
// AI wrapper shape {"renderer": {...}}. It also accepts type as an alias of kind
// for compatibility with older diagnostics/rules.
func NormalizeRendererSpec(input map[string]any) (map[string]any, error) {
	if input == nil {
		return nil, fmt.Errorf("renderer 为空")
	}
	r := cloneJSON(input)
	if _, ok := r["kind"]; !ok {
		if nested, ok := r["renderer"].(map[string]any); ok {
			r = cloneJSON(nested)
		}
	}
	if _, ok := r["kind"]; !ok {
		if t, ok := r["type"].(string); ok && t != "" {
			r["kind"] = t
		}
	}
	kind, _ := r["kind"].(string)
	kind = strings.ToLower(strings.TrimSpace(kind))
	if kind != "text" && kind != "table" {
		return nil, fmt.Errorf("不支持的 renderer: %s", kind)
	}
	r["kind"] = kind

	if kind == "text" {
		if vp, _ := r["valuePath"].(string); strings.TrimSpace(vp) == "" {
			r["valuePath"] = "$"
		}
		if tpl, _ := r["template"].(string); tpl == "" {
			r["template"] = "{{value}}"
		}
		format, _ := r["format"].(map[string]any)
		if format == nil {
			format = map[string]any{}
		}
		// Compatibility: tolerate formatting keys emitted at renderer top level.
		for _, k := range []string{"numberFormat", "prefix", "suffix", "divideBy", "scale"} {
			if _, exists := format[k]; !exists {
				if v, exists := r[k]; exists {
					format[k] = v
				}
			}
		}
		r["format"] = format
	}
	return r, nil
}

// ApplyBindingDescriptionHints enforces deterministic unit/precision semantics
// explicitly requested by the user. These fields are part of the user contract,
// so they intentionally override conflicting AI output instead of merely filling
// missing fields. This prevents combinations such as divideBy=10000 + suffix=亿元.
func ApplyBindingDescriptionHints(renderer map[string]any, description string) map[string]any {
	r, err := NormalizeRendererSpec(renderer)
	if err != nil {
		return renderer
	}
	desc := strings.ReplaceAll(strings.TrimSpace(description), " ", "")

	var divisor float64
	var suffix string
	switch {
	case strings.Contains(desc, "亿元") || strings.Contains(desc, "单位为亿") || strings.Contains(desc, "单位亿"):
		divisor, suffix = 100000000, "亿元"
	case strings.Contains(desc, "百万元"):
		divisor, suffix = 1000000, "百万元"
	case strings.Contains(desc, "万元") || strings.Contains(desc, "单位为万") || strings.Contains(desc, "单位万"):
		divisor, suffix = 10000, "万元"
	case strings.Contains(desc, "千元"):
		divisor, suffix = 1000, "千元"
	}

	numberFormat := ""
	switch {
	case strings.Contains(desc, "保留2位小数") || strings.Contains(desc, "保留两位小数"):
		numberFormat = "0.00"
	case strings.Contains(desc, "保留1位小数") || strings.Contains(desc, "保留一位小数"):
		numberFormat = "0.0"
	case strings.Contains(desc, "不保留小数") || strings.Contains(desc, "保留0位小数"):
		numberFormat = "0"
	}

	kind, _ := r["kind"].(string)
	if kind == "text" {
		format, _ := r["format"].(map[string]any)
		if format == nil {
			format = map[string]any{}
		}
		if divisor != 0 {
			format["divideBy"] = divisor
			format["suffix"] = suffix
		}
		if numberFormat != "" {
			format["numberFormat"] = numberFormat
		}
		r["format"] = format
		return r
	}

	if kind == "table" && (divisor != 0 || numberFormat != "") {
		cols, _ := r["columns"].([]any)
		for _, raw := range cols {
			c, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			field, _ := c["field"].(string)
			label, _ := c["label"].(string)
			fieldCompact := strings.ReplaceAll(field, " ", "")
			labelCompact := strings.ReplaceAll(label, " ", "")
			explicitColumn := (fieldCompact != "" && strings.Contains(desc, fieldCompact)) || (labelCompact != "" && strings.Contains(desc, labelCompact))
			amountColumn := strings.Contains(desc, "金额") && (strings.Contains(fieldCompact, "金额") || strings.Contains(labelCompact, "金额"))
			_, alreadyDivide := c["divideBy"]
			_, alreadyScale := c["scale"]
			_, alreadyNumber := c["numberFormat"]
			// Be conservative for tables: only override a column that the user named,
			// a column clearly named 金额, or a column the renderer already marked numeric.
			// This avoids accidentally scaling unrelated numeric fields such as 人数.
			if !explicitColumn && !amountColumn && !alreadyDivide && !alreadyScale && !alreadyNumber {
				continue
			}
			if divisor != 0 {
				c["divideBy"] = divisor
				delete(c, "scale")
			}
			if numberFormat != "" {
				c["numberFormat"] = numberFormat
			}
		}
		r["columns"] = cols
	}
	return r
}

func applyNumericFormat(v any, format map[string]any) any {
	if !isNumber(v) {
		return v
	}
	n := num(v)
	if d, ok := asFloat(format["divideBy"]); ok && d != 0 {
		n /= d
	} else if s, ok := asFloat(format["scale"]); ok {
		n *= s
	}
	nf, _ := format["numberFormat"].(string)
	return formatNumber(n, nf)
}

func RenderPlan(variable Variable, renderer map[string]any) (map[string]any, error) {
	var err error
	renderer, err = NormalizeRendererSpec(renderer)
	if err != nil {
		return nil, err
	}
	kind, _ := renderer["kind"].(string)
	if kind == "text" {
		vp, _ := renderer["valuePath"].(string)
		v := pathValue(variable.Value, vp)
		format, _ := renderer["format"].(map[string]any)
		if format == nil {
			format = map[string]any{}
		}
		v = applyNumericFormat(v, format)
		prefix, _ := format["prefix"].(string)
		suffix, _ := format["suffix"].(string)
		val := prefix + fmt.Sprint(v) + suffix
		if v == nil {
			val = prefix + suffix
		}
		tpl, _ := renderer["template"].(string)
		if tpl == "" {
			tpl = "{{value}}"
		}
		return map[string]any{"kind": "text", "text": strings.ReplaceAll(tpl, "{{value}}", val)}, nil
	}
	if kind == "table" {
		rows := mapRows(variable.Value)
		colsAny, _ := renderer["columns"].([]any)
		if colsAny == nil {
			if c2, ok := renderer["columns"].([]map[string]any); ok {
				for _, c := range c2 {
					colsAny = append(colsAny, c)
				}
			}
		}
		max := len(rows)
		if x, ok := asFloat(renderer["maxRows"]); ok && int(x) < max {
			max = int(x)
		}
		body := make([][]string, 0, max)
		for _, row := range rows[:max] {
			line := []string{}
			for _, cRaw := range colsAny {
				c, _ := cRaw.(map[string]any)
				field, _ := c["field"].(string)
				val := row[field]
				if isNumber(val) {
					format := map[string]any{}
					for _, k := range []string{"numberFormat", "divideBy", "scale"} {
						if x, ok := c[k]; ok {
							format[k] = x
						}
					}
					line = append(line, fmt.Sprint(applyNumericFormat(val, format)))
				} else if val == nil {
					line = append(line, "")
				} else {
					line = append(line, fmt.Sprint(val))
				}
			}
			body = append(body, line)
		}
		include := true
		if b, ok := renderer["includeHeader"].(bool); ok {
			include = b
		}
		var header any = nil
		if include {
			h := []string{}
			for _, cRaw := range colsAny {
				c, _ := cRaw.(map[string]any)
				label, _ := c["label"].(string)
				if label == "" {
					label, _ = c["field"].(string)
				}
				h = append(h, label)
			}
			header = h
		}
		resize := true
		if b, ok := renderer["resizeRows"].(bool); ok {
			resize = b
		}
		return map[string]any{"kind": "table", "header": header, "rows": body, "resizeRows": resize}, nil
	}
	return nil, fmt.Errorf("不支持的 renderer: %s", kind)
}
