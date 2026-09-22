package main

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// ContractValidation is returned to both the UI and diagnostics.  It is deliberately
// deterministic: the AI never decides whether its own output is valid.
type ContractValidation struct {
	Passed        bool     `json:"passed"`
	Errors        []string `json:"errors,omitempty"`
	Warnings      []string `json:"warnings,omitempty"`
	InputColumns  []string `json:"inputColumns,omitempty"`
	OutputType    string   `json:"outputType,omitempty"`
	OutputColumns []string `json:"outputColumns,omitempty"`
}

func validationOK(v ContractValidation) ContractValidation {
	v.Passed = len(v.Errors) == 0
	return v
}

func fieldExists(cols []string, f string) bool {
	for _, c := range cols {
		if c == f {
			return true
		}
	}
	return false
}

func exprFields(expr any, out *[]string) {
	m, ok := expr.(map[string]any)
	if !ok {
		return
	}
	if f, ok := m["field"].(string); ok && strings.TrimSpace(f) != "" {
		*out = append(*out, f)
	}
	if args, ok := m["args"].([]any); ok {
		for _, a := range args {
			exprFields(a, out)
		}
	}
}

func stepList(spec map[string]any) []any {
	if a, ok := spec["steps"].([]any); ok {
		return a
	}
	return nil
}

// ValidateTransformContract validates schema semantics against the *actual* selected
// range.  This catches the most expensive AI failure mode: syntactically-valid JSON
// that references columns which do not exist.
func ValidateTransformContract(values any, spec map[string]any) ContractValidation {
	if isJavaScript(spec) {
		v := ContractValidation{}
		if _, err := normalizeJavaScript(spec); err != nil {
			v.Errors = []string{err.Error()}
		}
		return validationOK(v)
	}
	v := ContractValidation{}
	normalized, err := NormalizeTransformSpec(spec)
	if err != nil {
		v.Errors = append(v.Errors, err.Error())
		return validationOK(v)
	}
	spec = normalized
	ver, ok := asFloat(spec["version"])
	if !ok || int(ver) != 1 {
		v.Errors = append(v.Errors, "TransformSpec.version 必须为 1")
	}
	hm, _ := spec["headersMode"].(string)
	if hm == "" {
		hm = "first-row"
	}
	if hm != "first-row" && hm != "none" {
		v.Errors = append(v.Errors, "headersMode 仅支持 first-row 或 none")
	}
	headers, _ := matrixToRows(values, hm)
	v.InputColumns = append([]string(nil), headers...)
	cols := append([]string(nil), headers...)
	scalarProduced := false

	steps := stepList(spec)
	for i, raw := range steps {
		step, ok := raw.(map[string]any)
		if !ok {
			v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个步骤不是对象", i+1))
			continue
		}
		op, _ := step["op"].(string)
		if scalarProduced {
			v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个步骤 %s 位于 aggregate 之后；标量聚合必须是最后一个步骤", i+1, op))
			continue
		}
		require := func(field, label string) {
			field = strings.TrimSpace(field)
			if field == "" {
				v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个步骤缺少%s字段", i+1, label))
				return
			}
			if !fieldExists(cols, field) {
				v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个步骤引用不存在的字段“%s”；可用字段：%s", i+1, field, strings.Join(cols, "、")))
			}
		}
		switch op {
		case "filter", "sort":
			f, _ := step["field"].(string)
			require(f, "")
			if op == "sort" {
				if d, _ := step["direction"].(string); d != "" && d != "asc" && d != "desc" {
					v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个 sort.direction 仅支持 asc/desc", i+1))
				}
			}
		case "derive":
			as, _ := step["as"].(string)
			as = strings.TrimSpace(as)
			if as == "" {
				v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个 derive 缺少 as", i+1))
			}
			fs := []string{}
			exprFields(step["expr"], &fs)
			for _, f := range fs {
				require(f, "表达式")
			}
			if as != "" && !fieldExists(cols, as) {
				cols = append(cols, as)
			}
		case "select":
			fields, _ := step["fields"].([]any)
			if len(fields) == 0 {
				v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个 select.fields 不能为空", i+1))
				break
			}
			next := []string{}
			for _, fr := range fields {
				switch x := fr.(type) {
				case string:
					require(x, "")
					if strings.TrimSpace(x) != "" {
						next = appendUnique(next, x)
					}
				case map[string]any:
					from, _ := x["from"].(string)
					require(from, "")
					as, _ := x["as"].(string)
					if strings.TrimSpace(as) == "" {
						as = from
					}
					if strings.TrimSpace(as) == "" {
						v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个 select 重命名项缺少 as/from", i+1))
					} else {
						next = appendUnique(next, as)
					}
				default:
					v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个 select.fields 包含无效项", i+1))
				}
			}
			cols = next
		case "limit":
			n, ok := asFloat(step["count"])
			if !ok || n < 0 || math.Trunc(n) != n {
				v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个 limit.count 必须是非负整数", i+1))
			}
		case "aggregate":
			fn, _ := step["fn"].(string)
			f, _ := step["field"].(string)
			if fn != "count" {
				require(f, "")
			}
			scalarProduced = true
		case "dynamic":
			program, _ := step["program"].(map[string]any)
			if err := validateDynamicProgram(program, "transform", cols); err != nil {
				v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个 dynamic 能力无效：%s", i+1, err.Error()))
			} else {
				var dynScalar bool
				cols, dynScalar = inferDynamicTransformShape(program, cols)
				if dynScalar {
					scalarProduced = true
				}
			}
		case "groupAggregate":
			by := toStringSlice(step["by"])
			if len(by) == 0 {
				v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个 groupAggregate.by 不能为空", i+1))
			}
			for _, f := range by {
				require(f, "分组")
			}
			aggs, _ := step["aggregates"].([]any)
			if len(aggs) == 0 {
				v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个 groupAggregate.aggregates 不能为空", i+1))
			}
			next := append([]string(nil), by...)
			for j, ar := range aggs {
				a, ok := ar.(map[string]any)
				if !ok {
					v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个 groupAggregate 的第 %d 个聚合无效", i+1, j+1))
					continue
				}
				fn, _ := a["fn"].(string)
				f, _ := a["field"].(string)
				if fn != "count" {
					require(f, "聚合")
				}
				as, _ := a["as"].(string)
				if strings.TrimSpace(as) == "" {
					as = fn + "_" + f
				}
				if strings.TrimSpace(as) == "" {
					v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个 groupAggregate 的第 %d 个聚合缺少输出字段名", i+1, j+1))
				} else {
					next = appendUnique(next, as)
				}
			}
			cols = next
		default:
			v.Errors = append(v.Errors, fmt.Sprintf("第 %d 个步骤类型不受支持：%s", i+1, op))
		}
	}

	output, _ := spec["output"].(map[string]any)
	typ, _ := output["type"].(string)
	if typ == "" {
		if scalarProduced {
			typ = "number"
		} else {
			typ = "table"
		}
	}
	if typ != "table" && typ != "number" && typ != "string" {
		v.Errors = append(v.Errors, "output.type 仅支持 table/number/string")
	}
	if scalarProduced && typ == "table" {
		v.Errors = append(v.Errors, "aggregate 已生成标量结果，output.type 不能再声明为 table")
	}
	switch typ {
	case "table":
		outCols := toStringSlice(output["fields"])
		if len(outCols) == 0 {
			outCols = append([]string(nil), cols...)
		}
		for _, f := range outCols {
			if !fieldExists(cols, f) {
				v.Errors = append(v.Errors, fmt.Sprintf("output.fields 引用不存在的字段“%s”", f))
			}
		}
		v.OutputColumns = outCols
	case "number", "string":
		if !scalarProduced {
			f, _ := output["field"].(string)
			if strings.TrimSpace(f) == "" {
				v.Errors = append(v.Errors, fmt.Sprintf("output.type=%s 且没有 aggregate 时，必须指定 output.field", typ))
			} else if !fieldExists(cols, f) {
				v.Errors = append(v.Errors, fmt.Sprintf("output.field 引用不存在的字段“%s”", f))
			}
		}
	}
	v.OutputType = typ
	return validationOK(v)
}

func validNumberFormat(s string) bool {
	switch s {
	case "", "0", "0.0", "0.00", "percent0", "percent1":
		return true
	}
	return false
}

func parseValuePath(path string) (idx int, field string, ok bool) {
	if path == "$" || path == "" {
		return 0, "", true
	}
	if !strings.HasPrefix(path, "$[") {
		return 0, "", false
	}
	close := strings.Index(path, "]")
	if close <= 2 || close+2 > len(path) || path[close+1] != '.' {
		return 0, "", false
	}
	n, err := strconv.Atoi(path[2:close])
	if err != nil || n < 0 {
		return 0, "", false
	}
	f := strings.TrimSpace(path[close+2:])
	if f == "" {
		return 0, "", false
	}
	return n, f, true
}

// ValidateRendererContract validates renderer semantics against the selected target
// and the concrete variable shape before RenderPlan is allowed to run.
func ValidateRendererContract(variable Variable, target map[string]any, renderer map[string]any) ContractValidation {
	if isJavaScript(renderer) {
		v := ContractValidation{}
		if _, err := normalizeJavaScript(renderer); err != nil {
			v.Errors = []string{err.Error()}
		}
		if target["kind"] != nil && target["kind"] != renderer["kind"] {
			v.Errors = append(v.Errors, "脚本输出类型与目标不一致")
		}
		return validationOK(v)
	}
	v := ContractValidation{InputColumns: append([]string(nil), variable.Columns...)}
	r, err := NormalizeRendererSpec(renderer)
	if err != nil {
		v.Errors = append(v.Errors, err.Error())
		return validationOK(v)
	}
	kind, _ := r["kind"].(string)
	targetKind, _ := target["kind"].(string)
	effectiveKind := kind
	if kind == "dynamic" {
		if program, ok := r["program"].(map[string]any); ok {
			if k, ok := program["kind"].(string); ok && k != "" {
				effectiveKind = k
			}
		}
	}
	if targetKind != "" && targetKind != effectiveKind {
		v.Errors = append(v.Errors, fmt.Sprintf("目标对象类型是 %s，但 renderer 实际输出=%s", targetKind, effectiveKind))
	}
	switch kind {
	case "text":
		if variable.ValueType == "table" {
			path, _ := r["valuePath"].(string)
			idx, field, ok := parseValuePath(path)
			if !ok || field == "" {
				v.Errors = append(v.Errors, "表格变量绑定到文本框时，valuePath 必须类似 $[0].字段名")
			} else {
				if !fieldExists(variable.Columns, field) {
					v.Errors = append(v.Errors, fmt.Sprintf("valuePath 引用了不存在的字段“%s”；可用字段：%s", field, strings.Join(variable.Columns, "、")))
				}
				rows := mapRows(variable.Value)
				if idx >= len(rows) {
					v.Errors = append(v.Errors, fmt.Sprintf("valuePath 请求第 %d 行，但当前变量只有 %d 行", idx+1, len(rows)))
				}
			}
		} else {
			path, _ := r["valuePath"].(string)
			if path != "" && path != "$" {
				v.Errors = append(v.Errors, "标量变量的 text renderer.valuePath 只能是 $")
			}
		}
		format, _ := r["format"].(map[string]any)
		if nf, _ := format["numberFormat"].(string); !validNumberFormat(nf) {
			v.Errors = append(v.Errors, "numberFormat 仅支持 0/0.0/0.00/percent0/percent1")
		}
		if d, ok := asFloat(format["divideBy"]); ok && (d == 0 || math.IsNaN(d) || math.IsInf(d, 0)) {
			v.Errors = append(v.Errors, "divideBy 必须是非 0 的有限数字")
		}
		if s, ok := asFloat(format["scale"]); ok && (math.IsNaN(s) || math.IsInf(s, 0)) {
			v.Errors = append(v.Errors, "scale 必须是有限数字")
		}
	case "dynamic":
		program, _ := r["program"].(map[string]any)
		if err := validateDynamicProgram(program, "render", variable.Columns); err != nil {
			v.Errors = append(v.Errors, "动态 renderer 无效："+err.Error())
		}
	case "table":
		if variable.ValueType != "table" {
			v.Errors = append(v.Errors, "只有 table 类型变量可以使用 table renderer")
		}
		cols, _ := r["columns"].([]any)
		if len(cols) == 0 {
			v.Errors = append(v.Errors, "table renderer.columns 不能为空")
		}
		for i, cr := range cols {
			c, ok := cr.(map[string]any)
			if !ok {
				v.Errors = append(v.Errors, fmt.Sprintf("columns[%d] 无效", i))
				continue
			}
			f, _ := c["field"].(string)
			if !fieldExists(variable.Columns, f) {
				v.Errors = append(v.Errors, fmt.Sprintf("columns[%d] 引用了不存在的字段“%s”", i, f))
			}
			nf, _ := c["numberFormat"].(string)
			if !validNumberFormat(nf) {
				v.Errors = append(v.Errors, fmt.Sprintf("columns[%d].numberFormat 不受支持", i))
			}
			if d, ok := asFloat(c["divideBy"]); ok && (d == 0 || math.IsNaN(d) || math.IsInf(d, 0)) {
				v.Errors = append(v.Errors, fmt.Sprintf("columns[%d].divideBy 必须是非 0 的有限数字", i))
			}
		}
		if n, ok := asFloat(r["maxRows"]); ok && (n < 0 || math.Trunc(n) != n) {
			v.Errors = append(v.Errors, "maxRows 必须是非负整数")
		}
		if raw, exists := r["mergeBy"]; exists {
			fields := toStringSlice(raw)
			if len(fields) == 0 {
				v.Errors = append(v.Errors, "mergeBy 必须是非空字段数组")
			} else {
				outputFields := map[string]bool{}
				for _, cr := range cols {
					if c, ok := cr.(map[string]any); ok {
						if f, ok := c["field"].(string); ok { outputFields[f] = true }
					}
				}
				seen := map[string]bool{}
				for _, field := range fields {
					if seen[field] { continue }
					seen[field] = true
					if !fieldExists(variable.Columns, field) {
						v.Errors = append(v.Errors, fmt.Sprintf("mergeBy 引用了不存在的字段“%s”", field))
					} else if !outputFields[field] {
						v.Errors = append(v.Errors, fmt.Sprintf("mergeBy 字段“%s”必须出现在输出列中", field))
					}
				}
			}
		}
	}
	v.OutputType = kind
	return validationOK(v)
}

func ValidateTransformExecution(result TransformResult, contract ContractValidation) ContractValidation {
	v := contract
	if result.Value == nil {
		v.Errors = append(v.Errors, "执行结果为空")
	}
	if contract.OutputType != "" && result.ValueType != contract.OutputType {
		v.Errors = append(v.Errors, fmt.Sprintf("执行结果类型为 %s，但契约要求 %s", result.ValueType, contract.OutputType))
	}
	if result.ValueType == "table" && len(contract.OutputColumns) > 0 {
		for _, f := range contract.OutputColumns {
			if !fieldExists(result.Columns, f) {
				v.Errors = append(v.Errors, fmt.Sprintf("执行结果缺少输出字段“%s”", f))
			}
		}
	}
	return validationOK(v)
}

func transformReferences(spec map[string]any) (filters []map[string]any, aggregateFields map[string]string, groupBy []string, sorts map[string]string, limits []int) {
	aggregateFields = map[string]string{}
	sorts = map[string]string{}
	for _, raw := range stepList(spec) {
		step, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		op, _ := step["op"].(string)
		switch op {
		case "filter":
			filters = append(filters, step)
		case "aggregate":
			f, _ := step["field"].(string)
			fn, _ := step["fn"].(string)
			if f != "" {
				aggregateFields[f] = fn
			}
		case "groupAggregate":
			groupBy = append(groupBy, toStringSlice(step["by"])...)
			if aggs, ok := step["aggregates"].([]any); ok {
				for _, ar := range aggs {
					a, _ := ar.(map[string]any)
					f, _ := a["field"].(string)
					fn, _ := a["fn"].(string)
					if f != "" {
						aggregateFields[f] = fn
					}
				}
			}
		case "sort":
			f, _ := step["field"].(string)
			d, _ := step["direction"].(string)
			if f != "" {
				sorts[f] = d
			}
		case "limit":
			if n, ok := asFloat(step["count"]); ok {
				limits = append(limits, int(n))
			}
		}
	}
	return
}

func compactDescription(s string) string {
	r := strings.NewReplacer(" ", "", "\t", "", "\r", "", "\n", "", "“", "", "”", "", "‘", "", "’", "", `"`, "", "'", "")
	return strings.ToLower(r.Replace(strings.TrimSpace(s)))
}

func containsExactString(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func sortMatchesAggregateField(spec map[string]any, field, direction string) bool {
	aliases := map[string]bool{field: true}
	for _, raw := range stepList(spec) {
		step, _ := raw.(map[string]any)
		if step["op"] != "groupAggregate" {
			continue
		}
		aggs, _ := step["aggregates"].([]any)
		for _, ar := range aggs {
			a, _ := ar.(map[string]any)
			f, _ := a["field"].(string)
			if f != field {
				continue
			}
			as, _ := a["as"].(string)
			if strings.TrimSpace(as) != "" {
				aliases[as] = true
			}
		}
	}
	for _, raw := range stepList(spec) {
		step, _ := raw.(map[string]any)
		if step["op"] != "sort" {
			continue
		}
		f, _ := step["field"].(string)
		d, _ := step["direction"].(string)
		if aliases[f] && d == direction {
			return true
		}
	}
	return false
}

func filterHasEq(filters []map[string]any, field, expected string) bool {
	for _, f := range filters {
		ff, _ := f["field"].(string)
		op, _ := f["operator"].(string)
		if ff == field && op == "eq" && compactDescription(fmt.Sprint(f["value"])) == compactDescription(expected) {
			return true
		}
	}
	return false
}

func cutoffValue(s string) string {
	cuts := []string{"的数据", "的记录", "记录", "数据", "，", ",", "。", ";", "；", "然后", "并且", "并", "且", "计算"}
	end := len(s)
	for _, c := range cuts {
		if i := strings.Index(s, c); i >= 0 && i < end {
			end = i
		}
	}
	return strings.TrimSpace(s[:end])
}

// ValidateTransformIntent checks only explicit, mechanically recognizable user
// requirements. It intentionally avoids fuzzy semantic scoring: when wording is
// ambiguous we leave the decision to the preview/user rather than guessing.
func ValidateTransformIntent(description string, spec map[string]any, base ContractValidation) ContractValidation {
	if len(base.Errors) > 0 || strings.TrimSpace(description) == "" {
		return validationOK(base)
	}
	desc := compactDescription(description)
	filters, aggregateFields, groupBy, _, limits := transformReferences(spec)

	// Explicit single-field sum/total requirements.
	for _, h := range base.InputColumns {
		hc := compactDescription(h)
		if hc == "" {
			continue
		}
		explicitSum := strings.Contains(desc, hc+"合计") || strings.Contains(desc, hc+"总计") || strings.Contains(desc, hc+"求和") ||
			strings.Contains(desc, "合计"+hc) || strings.Contains(desc, "总计"+hc) || strings.Contains(desc, "求和"+hc)
		if explicitSum && aggregateFields[h] != "sum" {
			base.Errors = append(base.Errors, fmt.Sprintf("描述明确要求“%s”合计/求和，但 TransformSpec 未对该字段执行 sum", h))
		}
	}

	// “按X汇总/分组” is an explicit group-by requirement.
	for _, h := range base.InputColumns {
		hc := compactDescription(h)
		if strings.Contains(desc, "按"+hc+"汇总") || strings.Contains(desc, "按"+hc+"分组") {
			if !containsExactString(groupBy, h) {
				base.Errors = append(base.Errors, fmt.Sprintf("描述明确要求按“%s”汇总/分组，但 groupAggregate.by 未包含该字段", h))
			}
		}
	}

	// In wording such as “按部门汇总预算金额和实际金额，按预算金额降序”,
	// fields after the first 汇总 and before the next ordering clause are explicit
	// aggregate targets.
	if i := strings.Index(desc, "汇总"); i >= 0 {
		seg := desc[i+len("汇总"):]
		end := len(seg)
		for _, c := range []string{"，按", ",按", "。", ";", "；", "取前", "top"} {
			if j := strings.Index(seg, c); j >= 0 && j < end {
				end = j
			}
		}
		seg = seg[:end]
		for _, h := range base.InputColumns {
			if strings.Contains(seg, compactDescription(h)) && aggregateFields[h] != "sum" {
				base.Errors = append(base.Errors, fmt.Sprintf("描述明确要求汇总“%s”，但 groupAggregate 未对该字段执行 sum", h))
			}
		}
	}

	// Explicit sort direction.
	for _, h := range base.InputColumns {
		hc := compactDescription(h)
		if strings.Contains(desc, "按"+hc+"降序") && !sortMatchesAggregateField(spec, h, "desc") {
			base.Errors = append(base.Errors, fmt.Sprintf("描述明确要求按“%s”降序，但 TransformSpec 未包含对应 desc sort", h))
		}
		if strings.Contains(desc, "按"+hc+"升序") && !sortMatchesAggregateField(spec, h, "asc") {
			base.Errors = append(base.Errors, fmt.Sprintf("描述明确要求按“%s”升序，但 TransformSpec 未包含对应 asc sort", h))
		}
	}

	// Explicit Top/前 N.
	reTop := regexp.MustCompile(`(?:top|前)([0-9]+)`)
	if m := reTop.FindStringSubmatch(desc); len(m) == 2 {
		n, _ := strconv.Atoi(m[1])
		found := false
		for _, x := range limits {
			if x == n {
				found = true
				break
			}
		}
		if !found {
			base.Errors = append(base.Errors, fmt.Sprintf("描述明确要求前/Top %d，但 TransformSpec 未包含 limit=%d", n, n))
		}
	}

	// Explicit equality filter, but only when a filter cue is present. This avoids
	// mistaking output wording such as “单位为亿元” for a data filter.
	if strings.Contains(desc, "只保留") || strings.Contains(desc, "筛选") || strings.Contains(desc, "过滤") {
		for _, h := range base.InputColumns {
			hc := compactDescription(h)
			needle := hc + "为"
			if i := strings.Index(desc, needle); i >= 0 {
				expected := cutoffValue(desc[i+len(needle):])
				if expected != "" && !filterHasEq(filters, h, expected) {
					base.Errors = append(base.Errors, fmt.Sprintf("描述明确要求筛选“%s=%s”，但 TransformSpec 未包含对应 eq filter", h, expected))
				}
			}
		}
	}

	return validationOK(base)
}
