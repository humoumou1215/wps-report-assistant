package main

import (
	"archive/zip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProjectIsolation(t *testing.T) {
	s, err := NewStore(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	p1, _ := s.CreateProject("项目1")
	p2, _ := s.CreateProject("项目2")
	d1, err := s.RegisterDocument(p1.ID, map[string]any{"key": "C:/a/1.xlsx", "name": "1.xlsx", "kind": "et"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.RegisterDocument(p2.ID, map[string]any{"key": "C:/a/1.xlsx", "name": "1.xlsx", "kind": "et"}); err == nil {
		t.Fatal("expected cross-project conflict")
	}
	s1, err := s.AddSource(p1.ID, map[string]any{"documentId": d1.ID, "sheetName": "S", "address": "A1:B3", "values": []any{[]any{"部门", "金额"}, []any{"A", 10.0}, []any{"B", 20.0}}})
	if err != nil {
		t.Fatal(err)
	}
	spec := GuessTransform(s1.Values, "金额合计")
	res, err := ExecuteTransform(s1.Values, spec)
	if err != nil {
		t.Fatal(err)
	}
	v1, err := s.AddVariable(p1.ID, map[string]any{"sourceId": s1.ID, "name": "same", "transform": spec, "value": res.Value, "valueType": res.ValueType, "columns": res.Columns})
	if err != nil {
		t.Fatal(err)
	}
	if v1.ValueType != "number" {
		t.Fatalf("got %s", v1.ValueType)
	}
	d2, err := s.RegisterDocument(p2.ID, map[string]any{"key": "C:/a/2.xlsx", "name": "2.xlsx", "kind": "et"})
	if err != nil {
		t.Fatal(err)
	}
	s2, err := s.AddSource(p2.ID, map[string]any{"documentId": d2.ID, "sheetName": "S", "address": "A1:A2", "values": []any{[]any{"金额"}, []any{5.0}}})
	if err != nil {
		t.Fatal(err)
	}
	res2, _ := ExecuteTransform(s2.Values, GuessTransform(s2.Values, "金额合计"))
	if _, err := s.AddVariable(p2.ID, map[string]any{"sourceId": s2.ID, "name": "same", "transform": GuessTransform(s2.Values, "金额合计"), "value": res2.Value, "valueType": res2.ValueType, "columns": res2.Columns}); err != nil {
		t.Fatal("same variable name should be allowed across projects", err)
	}
}

func TestGroupAggregateAndRender(t *testing.T) {
	vals := []any{[]any{"部门", "金额"}, []any{"A", 10.0}, []any{"B", 20.0}, []any{"A", 5.0}}
	spec := map[string]any{"version": 1.0, "headersMode": "first-row", "steps": []any{map[string]any{"op": "groupAggregate", "by": []any{"部门"}, "aggregates": []any{map[string]any{"fn": "sum", "field": "金额", "as": "合计"}}}, map[string]any{"op": "sort", "field": "合计", "direction": "desc"}}, "output": map[string]any{"type": "table", "fields": []any{"部门", "合计"}}}
	r, err := ExecuteTransform(vals, spec)
	if err != nil {
		t.Fatal(err)
	}
	rows := r.Value.([]map[string]any)
	if len(rows) != 2 || rows[0]["部门"] != "B" {
		t.Fatalf("unexpected %#v", rows)
	}
	v := Variable{ValueType: r.ValueType, Value: r.Value, Columns: r.Columns}
	plan, err := RenderPlan(v, map[string]any{"kind": "table", "includeHeader": true, "columns": []any{map[string]any{"field": "部门", "label": "部门"}, map[string]any{"field": "合计", "label": "金额", "numberFormat": "0.0"}}, "resizeRows": true})
	if err != nil {
		t.Fatal(err)
	}
	if plan["kind"] != "table" {
		t.Fatal(plan)
	}
}

func TestDebugSettingsAndDiagnosticExport(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.UpdateDebug(map[string]any{"enabled": true, "includeSourceData": false, "maxEvents": float64(300)}); err != nil {
		t.Fatal(err)
	}
	if !s.GetSettings().Debug.Enabled || s.GetSettings().Debug.MaxEvents != 300 {
		t.Fatalf("debug settings not saved: %+v", s.GetSettings().Debug)
	}
	p, _ := s.CreateProject("诊断测试")
	d, _ := s.RegisterDocument(p.ID, map[string]any{"key": "C:/demo/a.xlsx", "name": "a.xlsx", "kind": "et"})
	src, _ := s.AddSource(p.ID, map[string]any{"documentId": d.ID, "sheetName": "Sheet1", "address": "A1:B2", "values": []any{[]any{"部门", "预算"}, []any{"技术", float64(100)}}})
	v, _ := s.AddVariable(p.ID, map[string]any{"sourceId": src.ID, "name": "budget", "displayName": "预算", "transform": map[string]any{"version": float64(1), "headersMode": "first-row", "steps": []any{}, "output": map[string]any{"type": "table"}}, "value": []any{map[string]any{"部门": "技术", "预算": float64(100)}}, "valueType": "table", "columns": []any{"部门", "预算"}})
	if v.ID == "" {
		t.Fatal("variable missing")
	}
	diag := NewDiagnostics(dir)
	diag.Record(DiagnosticEvent{TraceID: "trace_1", ProjectID: p.ID, Component: "test", Stage: "selection", Action: "capture", Status: "ok", Sensitive: true, Data: map[string]any{"values": []any{[]any{"部门", "预算"}, []any{"技术", float64(100)}}}})
	path, err := diag.Export(s, p.ID, false, 100)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(path); err != nil {
		t.Fatal(err)
	}
}

func TestDiagnosticExportRedactsSecretsAndBusinessData(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.UpdateAI(map[string]any{
		"enabled": true,
		"baseUrl": "http://127.0.0.1:9999/v1",
		"model":   "test-model",
		"apiKey":  "super-secret-key",
	}); err != nil {
		t.Fatal(err)
	}
	p, _ := s.CreateProject("脱敏测试")
	d, _ := s.RegisterDocument(p.ID, map[string]any{"key": `C:\\secret\\真实预算.xlsx`, "name": "真实预算.xlsx", "kind": "et"})
	src, _ := s.AddSource(p.ID, map[string]any{
		"documentId": d.ID,
		"sheetName":  "Sheet1",
		"address":    "A1:B2",
		"values":     []any{[]any{"部门", "预算"}, []any{"机密部门", float64(123456)}},
	})
	_, _ = s.AddVariable(p.ID, map[string]any{
		"sourceId":    src.ID,
		"name":        "secret_budget",
		"displayName": "机密预算",
		"transform":   map[string]any{"version": float64(1), "headersMode": "first-row", "steps": []any{}, "output": map[string]any{"type": "table"}},
		"value":       []any{map[string]any{"部门": "机密部门", "预算": float64(123456)}},
		"valueType":   "table",
		"columns":     []any{"部门", "预算"},
	})
	diag := NewDiagnostics(dir)
	diag.Record(DiagnosticEvent{
		TraceID: "trace_secret", ProjectID: p.ID, Component: "test", Stage: "selection", Action: "capture", Status: "ok", Sensitive: true,
		Data: map[string]any{"values": []any{[]any{"部门", "预算"}, []any{"机密部门", float64(123456)}}},
	})
	zpath, err := diag.Export(s, p.ID, false, 100)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.OpenReader(zpath)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	files := map[string][]byte{}
	for _, f := range zr.File {
		rc, e := f.Open()
		if e != nil {
			t.Fatal(e)
		}
		b, e := io.ReadAll(rc)
		rc.Close()
		if e != nil {
			t.Fatal(e)
		}
		files[f.Name] = b
	}
	if strings.Contains(string(files["settings.safe.json"]), "super-secret-key") {
		t.Fatal("API key leaked into diagnostics")
	}
	var safeSettings Settings
	if err := json.Unmarshal(files["settings.safe.json"], &safeSettings); err != nil {
		t.Fatal(err)
	}
	if safeSettings.AI.APIKey != "<redacted>" {
		t.Fatalf("API key redaction marker missing: %q", safeSettings.AI.APIKey)
	}
	if strings.Contains(string(files["project.json"]), "机密部门") || strings.Contains(string(files["events.jsonl"]), "机密部门") {
		t.Fatal("business data leaked while includeData=false")
	}
	var project map[string]any
	if err := json.Unmarshal(files["project.json"], &project); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(files["project.json"]), `"redacted": true`) {
		t.Fatal("redacted data shape missing")
	}
	if strings.Contains(string(files["project.json"]), `C:\\secret\\`) {
		t.Fatal("full document path leaked")
	}
}

func TestNormalizeAICompactFilterAggregateSpec(t *testing.T) {
	vals := []any{
		[]any{"部门", "状态", "预算金额"},
		[]any{"技术部", "正式", float64(100)},
		[]any{"产品部", "草稿", float64(200)},
		[]any{"销售部", "正式", float64(300)},
	}
	// This is the exact compact shape returned by the AI in the v0.4.0
	// diagnostic package: step kind in type, operation in op.
	spec := map[string]any{
		"version":     float64(1),
		"headersMode": "first-row",
		"steps": []any{
			map[string]any{"type": "filter", "field": "状态", "op": "eq", "value": "正式"},
			map[string]any{"type": "aggregate", "field": "预算金额", "op": "sum", "as": "预算金额合计"},
		},
		"output": map[string]any{"type": "number", "field": "预算金额合计"},
	}
	norm, err := NormalizeTransformSpec(spec)
	if err != nil {
		t.Fatal(err)
	}
	steps := norm["steps"].([]any)
	f := steps[0].(map[string]any)
	a := steps[1].(map[string]any)
	if f["op"] != "filter" || f["operator"] != "eq" {
		t.Fatalf("filter not normalized: %#v", f)
	}
	if a["op"] != "aggregate" || a["fn"] != "sum" {
		t.Fatalf("aggregate not normalized: %#v", a)
	}
	r, err := ExecuteTransform(vals, spec)
	if err != nil {
		t.Fatal(err)
	}
	if r.ValueType != "number" || r.Value != float64(400) {
		t.Fatalf("unexpected result: %#v", r)
	}
}

func TestStandardCaseARegression(t *testing.T) {
	vals := []any{
		[]any{"部门", "产品组", "状态", "预算金额", "实际金额", "人数", "负责人"},
		[]any{"技术部", "平台", "正式", float64(12800000), float64(10350000), float64(32), "张三"},
		[]any{"技术部", "远程能力", "正式", float64(6200000), float64(5100000), float64(14), "李四"},
		[]any{"产品部", "零售", "正式", float64(8600000), float64(7900000), float64(18), "王五"},
		[]any{"产品部", "企业", "草稿", float64(2300000), float64(0), float64(6), "赵六"},
		[]any{"运营部", "增长", "正式", float64(5100000), float64(4980000), float64(12), "钱七"},
		[]any{"数据部", "数据平台", "正式", float64(4200000), float64(3900000), float64(11), "孙八"},
		[]any{"平台部", "基础设施", "正式", float64(3800000), float64(4010000), float64(9), "周九"},
		[]any{"销售部", "企业", "正式", float64(7200000), float64(6840000), float64(20), "吴十"},
		[]any{"销售部", "零售", "正式", float64(4700000), float64(4520000), float64(16), "郑一"},
		[]any{"客服部", "客户成功", "正式", float64(2600000), float64(2410000), float64(15), "冯二"},
		[]any{"财务部", "共享服务", "正式", float64(1800000), float64(1650000), float64(7), "陈三"},
		[]any{"市场部", "品牌", "正式", float64(3200000), float64(2780000), float64(8), "褚四"},
		[]any{"市场部", "增长", "正式", float64(2900000), float64(3050000), float64(9), "卫五"},
		[]any{"研发效能部", "研发工具", "正式", float64(3500000), float64(3220000), float64(10), "蒋六"},
	}
	spec := map[string]any{
		"version": float64(1), "headersMode": "first-row",
		"steps": []any{
			map[string]any{"type": "filter", "field": "状态", "op": "eq", "value": "正式"},
			map[string]any{"type": "aggregate", "field": "预算金额", "op": "sum", "as": "预算金额合计"},
		},
		"output": map[string]any{"type": "number", "field": "预算金额合计"},
	}
	r, err := ExecuteTransform(vals, spec)
	if err != nil {
		t.Fatal(err)
	}
	if r.Value != float64(66600000) {
		t.Fatalf("Case A regression: got %v want 66600000", r.Value)
	}
}

func TestNormalizeNestedRendererAndUnitConversion(t *testing.T) {
	// Exact renderer shape observed in the second diagnostic package: the AI
	// wrapped the renderer object and only emitted an 亿 suffix without a scale.
	aiOutput := map[string]any{
		"renderer": map[string]any{
			"kind":      "text",
			"valuePath": "$",
			"template":  "{{value}}",
			"format": map[string]any{
				"numberFormat": "0.00",
				"suffix":       "亿元",
			},
		},
	}
	norm, err := NormalizeRendererSpec(aiOutput)
	if err != nil {
		t.Fatal(err)
	}
	norm = ApplyBindingDescriptionHints(norm, "按亿元显示，保留2位小数，后缀为“亿元”。")
	v := Variable{ValueType: "number", Value: float64(66600000)}
	plan, err := RenderPlan(v, norm)
	if err != nil {
		t.Fatal(err)
	}
	if got := plan["text"]; got != "0.67亿元" {
		t.Fatalf("Case A PPT render regression: got %v want 0.67亿元; renderer=%#v", got, norm)
	}
}

func TestRendererMigrationRepairsPersistedWrapper(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := s.CreateProject("迁移测试")
	doc, _ := s.RegisterDocument(p.ID, map[string]any{"key": "C:/demo/demo.pptx", "name": "demo.pptx", "kind": "wpp"})
	// Seed a legacy binding directly into state to reproduce the v0.4.1 broken
	// persisted renderer shape.
	s.mu.Lock()
	pi := s.projectIndexLocked(p.ID)
	s.State.Projects[pi].Bindings = append(s.State.Projects[pi].Bindings, Binding{
		ID:          "bnd_legacy",
		VariableID:  "var_unused",
		DocumentID:  doc.ID,
		DocumentKey: doc.Key,
		Description: "按亿元显示，保留2位小数，后缀为“亿元”。",
		Renderer: map[string]any{"renderer": map[string]any{
			"kind": "text", "valuePath": "$", "template": "{{value}}",
			"format": map[string]any{"numberFormat": "0.00", "suffix": "亿元"},
		}},
		CreatedAt: nowISO(), UpdatedAt: nowISO(),
	})
	if err := s.saveLocked(); err != nil {
		s.mu.Unlock()
		t.Fatal(err)
	}
	s.mu.Unlock()

	s2, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	p2, err := s2.GetProject(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(p2.Bindings) != 1 || p2.Bindings[0].Renderer["kind"] != "text" {
		t.Fatalf("legacy renderer not migrated: %#v", p2.Bindings)
	}
	f, _ := p2.Bindings[0].Renderer["format"].(map[string]any)
	if d, ok := asFloat(f["divideBy"]); !ok || d != 100000000 {
		t.Fatalf("legacy 亿 conversion not recovered: %#v", f)
	}
}
