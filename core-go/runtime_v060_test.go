package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestFallbackTransformHandlesFilterAndAggregate(t *testing.T) {
	values := []any{
		[]any{"状态", "预算金额"},
		[]any{"正式", 100.0},
		[]any{"草稿", 50.0},
		[]any{"正式", 200.0},
	}
	b, err := BuildTransform(defaultSettings(), values, "只保留状态为正式的数据，计算预算金额合计")
	if err != nil {
		t.Fatal(err)
	}
	if b.Result.ValueType != "number" || num(b.Result.Value) != 300 {
		t.Fatalf("unexpected fallback result: %#v", b.Result)
	}
	steps, _ := b.Spec["steps"].([]any)
	if len(steps) != 2 {
		t.Fatalf("expected filter + aggregate, got %#v", b.Spec)
	}
}

func aiTestServer(t *testing.T, contents []string, count *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		i := int(atomic.AddInt32(count, 1)) - 1
		if i >= len(contents) {
			i = len(contents) - 1
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": contents[i]}}},
		})
	}))
}

func TestLegacyBuildTransformRepairsUnknownField(t *testing.T) {
	var count int32
	ts := aiTestServer(t, []string{
		`{"version":1,"headersMode":"first-row","steps":[{"op":"aggregate","fn":"sum","field":"不存在"}],"output":{"type":"number"}}`,
		`{"version":1,"headersMode":"first-row","steps":[{"op":"filter","field":"状态","operator":"eq","value":"正式"},{"op":"aggregate","fn":"sum","field":"预算金额"}],"output":{"type":"number"}}`,
	}, &count)
	defer ts.Close()
	settings := defaultSettings()
	settings.AI = AISettings{Enabled: true, BaseURL: ts.URL, APIKey: "test", Model: "test-model", Temperature: 0}
	settings.Agent.CriticEnabled = false
	values := []any{[]any{"状态", "预算金额"}, []any{"正式", 100.0}, []any{"草稿", 50.0}, []any{"正式", 200.0}}
	b, err := buildLegacyTransform(settings, values, "只保留状态为正式的数据，计算预算金额合计")
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Attempts) != 2 || atomic.LoadInt32(&count) != 2 {
		t.Fatalf("expected one repair, attempts=%d calls=%d", len(b.Attempts), count)
	}
	if b.Attempts[0].Validation.Passed || !b.Attempts[1].Validation.Passed {
		t.Fatalf("unexpected validation history: %#v", b.Attempts)
	}
	if num(b.Result.Value) != 300 {
		t.Fatalf("unexpected result: %#v", b.Result.Value)
	}
}

func TestLegacyBuildBindingRepairsBadValuePath(t *testing.T) {
	var count int32
	ts := aiTestServer(t, []string{
		`{"kind":"text","valuePath":"$[0].不存在","template":"{{value}}","format":{"numberFormat":"0.00"}}`,
		`{"kind":"text","valuePath":"$[0].金额","template":"{{value}}","format":{"numberFormat":"0.00"}}`,
	}, &count)
	defer ts.Close()
	settings := defaultSettings()
	settings.AI = AISettings{Enabled: true, BaseURL: ts.URL, APIKey: "test", Model: "test-model", Temperature: 0}
	settings.Agent.CriticEnabled = false
	v := Variable{Name: "预算", ValueType: "table", Columns: []string{"金额"}, Value: []any{map[string]any{"金额": 123.0}}}
	b, err := buildLegacyBinding(settings, v, map[string]any{"kind": "text"}, "显示第一行金额")
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Attempts) != 2 || atomic.LoadInt32(&count) != 2 {
		t.Fatalf("expected one repair, attempts=%d calls=%d", len(b.Attempts), count)
	}
	if b.Plan["text"] != "123.00" {
		t.Fatalf("unexpected plan: %#v", b.Plan)
	}
}

func TestValidateTransformRejectsAggregateFollowedBySort(t *testing.T) {
	values := []any{[]any{"金额"}, []any{1.0}}
	spec := map[string]any{
		"version": 1,
		"steps": []any{
			map[string]any{"op": "aggregate", "fn": "sum", "field": "金额"},
			map[string]any{"op": "sort", "field": "金额", "direction": "desc"},
		},
		"output": map[string]any{"type": "number"},
	}
	v := ValidateTransformContract(values, spec)
	if v.Passed {
		t.Fatalf("expected validation failure: %#v", v)
	}
}

func doJSON(t *testing.T, h http.Handler, method, path string, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestPreviewApplyAPIHasNoPreConfirmMutation(t *testing.T) {
	dataDir := t.TempDir()
	store, err := NewStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := store.CreateProject("测试")
	et, _ := store.RegisterDocument(p.ID, map[string]any{"key": `C:\test.xlsx`, "name": "test.xlsx", "kind": "et"})
	wpp, _ := store.RegisterDocument(p.ID, map[string]any{"key": `C:\test.pptx`, "name": "test.pptx", "kind": "wpp"})
	s := &Server{store: store, drafts: NewDraftStore(), diag: NewDiagnostics(filepath.Join(dataDir, "diag")), assetDir: t.TempDir(), host: "127.0.0.1", port: 17891}

	values := []any{[]any{"状态", "预算金额"}, []any{"正式", 100.0}, []any{"草稿", 50.0}, []any{"正式", 200.0}}
	code, preview := doJSON(t, s, "POST", "/api/projects/"+p.ID+"/variables/preview", map[string]any{
		"documentId": et.ID, "sheetName": "本年预算", "address": "$A$1:$B$4", "values": values,
		"headersMode": "first-row", "name": "正式预算合计", "description": "只保留状态为正式的数据，计算预算金额合计",
	})
	if code != 200 {
		t.Fatalf("preview failed %d: %#v", code, preview)
	}
	before, _ := store.GetProject(p.ID)
	if len(before.Sources) != 0 || len(before.Variables) != 0 {
		t.Fatalf("preview mutated project: %#v", before)
	}
	code, applied := doJSON(t, s, "POST", "/api/projects/"+p.ID+"/variables/apply", map[string]any{"draftId": preview["draftId"]})
	if code != 201 {
		t.Fatalf("apply failed %d: %#v", code, applied)
	}
	after, _ := store.GetProject(p.ID)
	if len(after.Sources) != 1 || len(after.Variables) != 1 {
		t.Fatalf("apply did not atomically create source+variable: sources=%d vars=%d", len(after.Sources), len(after.Variables))
	}
	vid := after.Variables[0].ID

	code, bp := doJSON(t, s, "POST", "/api/projects/"+p.ID+"/bindings/preview", map[string]any{
		"variableId": vid, "documentId": wpp.ID,
		"target":      map[string]any{"kind": "text", "slideIndex": 2.0, "shapeId": 10.0, "shapeName": "金额"},
		"description": "按亿元显示，保留2位小数，后缀为亿元",
	})
	if code != 200 {
		t.Fatalf("binding preview failed %d: %#v", code, bp)
	}
	mid, _ := store.GetProject(p.ID)
	if len(mid.Bindings) != 0 {
		t.Fatalf("binding preview mutated project")
	}
	code, ba := doJSON(t, s, "POST", "/api/projects/"+p.ID+"/bindings/apply", map[string]any{"draftId": bp["draftId"]})
	if code != 201 {
		t.Fatalf("binding apply failed %d: %#v", code, ba)
	}
	final, _ := store.GetProject(p.ID)
	if len(final.Bindings) != 1 {
		t.Fatalf("binding apply did not persist")
	}
}

func TestLegacyBuildBindingCriticRepairsWrongUnitSemantics(t *testing.T) {
	var count int32
	ts := aiTestServer(t, []string{
		`{"kind":"text","valuePath":"$","template":"{{value}}","format":{"divideBy":10000,"numberFormat":"0.0","suffix":"万元"}}`,
		`{"passed":false,"issues":["用户要求亿元且保留2位，但当前结果按万元显示"],"repairInstruction":"改为除以100000000，保留2位并使用亿元后缀","capabilityGap":{"required":false}}`,
		`{"kind":"text","valuePath":"$","template":"{{value}}","format":{"divideBy":100000000,"numberFormat":"0.00","suffix":"亿元"}}`,
		`{"passed":true,"issues":[],"repairInstruction":"","capabilityGap":{"required":false}}`,
	}, &count)
	defer ts.Close()
	settings := defaultSettings()
	settings.AI = AISettings{Enabled: true, BaseURL: ts.URL, APIKey: "test", Model: "test-model", Temperature: 0}
	v := Variable{Name: "正式预算合计", ValueType: "number", Value: 66600000.0}
	b, err := buildLegacyBinding(settings, v, map[string]any{"kind": "text"}, "按亿元显示，保留2位小数，后缀为亿元")
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Attempts) != 2 || atomic.LoadInt32(&count) != 4 {
		t.Fatalf("expected critic repair, attempts=%d calls=%d", len(b.Attempts), count)
	}
	if b.Plan["text"] != "0.67亿元" {
		t.Fatalf("unexpected plan: %#v", b.Plan)
	}
}

func TestLegacyBuildTransformCriticRepairsSemanticallyWrongExistingField(t *testing.T) {
	var count int32
	ts := aiTestServer(t, []string{
		`{"version":1,"headersMode":"first-row","steps":[{"op":"filter","field":"状态","operator":"eq","value":"正式"},{"op":"aggregate","fn":"sum","field":"实际金额"}],"output":{"type":"number"}}`,
		`{"passed":false,"issues":["用户要求预算金额合计，但实际计算了实际金额"],"repairInstruction":"将聚合字段改为预算金额","capabilityGap":{"required":false}}`,
		`{"version":1,"headersMode":"first-row","steps":[{"op":"filter","field":"状态","operator":"eq","value":"正式"},{"op":"aggregate","fn":"sum","field":"预算金额"}],"output":{"type":"number"}}`,
		`{"passed":true,"issues":[],"repairInstruction":"","capabilityGap":{"required":false}}`,
	}, &count)
	defer ts.Close()
	settings := defaultSettings()
	settings.AI = AISettings{Enabled: true, BaseURL: ts.URL, APIKey: "test", Model: "test-model", Temperature: 0}
	values := []any{
		[]any{"状态", "预算金额", "实际金额"},
		[]any{"正式", 100.0, 80.0}, []any{"草稿", 50.0, 40.0}, []any{"正式", 200.0, 150.0},
	}
	b, err := buildLegacyTransform(settings, values, "只保留状态为正式的数据，计算预算金额合计")
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Attempts) != 2 || atomic.LoadInt32(&count) != 4 {
		t.Fatalf("expected semantic repair, attempts=%d calls=%d", len(b.Attempts), count)
	}
	if b.Attempts[0].Critic.Passed || !b.Attempts[1].Critic.Passed {
		t.Fatalf("unexpected critic history: %#v", b.Attempts)
	}
	if num(b.Result.Value) != 300 {
		t.Fatalf("unexpected result: %#v", b.Result.Value)
	}
}

func TestApplyBindingDescriptionHintsHardensTableUnits(t *testing.T) {
	r := map[string]any{
		"kind": "table",
		"columns": []any{
			map[string]any{"field": "部门", "label": "部门"},
			map[string]any{"field": "预算金额", "label": "预算金额", "divideBy": 100000000.0},
		},
	}
	h := ApplyBindingDescriptionHints(r, "金额按万元显示，不要改变列数")
	cols := h["columns"].([]any)
	amount := cols[1].(map[string]any)
	if got, _ := asFloat(amount["divideBy"]); got != 10000 {
		t.Fatalf("expected table divisor hardened to 万元, got %#v", amount)
	}
	v := Variable{ValueType: "table", Columns: []string{"部门", "预算金额"}, Value: []any{map[string]any{"部门": "技术部", "预算金额": 19000000.0}}}
	plan, err := RenderPlan(v, h)
	if err != nil {
		t.Fatal(err)
	}
	rows := plan["rows"].([][]string)
	if rows[0][1] != "1900" {
		t.Fatalf("unexpected table amount: %#v", rows)
	}
}

func TestLegacyDynamicRenderCapabilityHandlesTop5SequenceGap(t *testing.T) {
	var count int32
	ts := aiTestServer(t, []string{
		`{"kind":"table","includeHeader":true,"columns":[{"field":"部门","label":"部门"},{"field":"预算金额","label":"预算金额"}],"maxRows":5,"resizeRows":true}`,
		`{"passed":false,"issues":["用户明确要求第一列是序号，但当前表格第一列是部门"],"repairInstruction":"需要生成序号列并保留部门、预算金额","capabilityGap":{"required":true,"stage":"render","need":"根据行位置生成计算列，并与变量字段组合成表格","reason":"内置 table renderer 只能投影变量已有字段"}}`,
		`{"language":"ra-cap-v1","stage":"render","kind":"table","includeHeader":true,"resizeRows":true,"maxRows":5,"columns":[{"label":"序号","expr":{"var":"rowNumber"}},{"label":"部门","expr":{"field":"部门"}},{"label":"预算金额","expr":{"field":"预算金额"}}]}`,
		`{"passed":true,"issues":[],"repairInstruction":"","capabilityGap":{"required":false}}`,
	}, &count)
	defer ts.Close()
	settings := defaultSettings()
	settings.AI = AISettings{Enabled: true, BaseURL: ts.URL, APIKey: "test", Model: "test-model"}
	settings.Agent.DynamicCapabilitiesEnabled = true
	v := Variable{Name: "Top5预算部门", ValueType: "table", Columns: []string{"部门", "预算金额"}, Value: []any{
		map[string]any{"部门": "客服部", "预算金额": 3332600000.0}, map[string]any{"部门": "技术部", "预算金额": 19000000.0}, map[string]any{"部门": "产品部", "预算金额": 8600000.0}, map[string]any{"部门": "市场部", "预算金额": 6100000.0}, map[string]any{"部门": "运营部", "预算金额": 5100000.0},
	}}
	target := map[string]any{"kind": "table", "snapshot": map[string]any{"rows": 6.0, "columns": 3.0, "header": []any{"序号", "部门", "预算金额"}}}
	b, err := buildLegacyBinding(settings, v, target, "第一列是序号，后面按字段名称填入")
	if err != nil {
		t.Fatal(err)
	}
	if !b.DynamicCapability || b.Generation != "ai-dynamic" {
		t.Fatalf("expected dynamic capability: %#v", b)
	}
	if atomic.LoadInt32(&count) != 4 {
		t.Fatalf("expected 4 AI calls, got %d", count)
	}
	header := b.Plan["header"].([]string)
	if len(header) != 3 || header[0] != "序号" || header[1] != "部门" {
		t.Fatalf("bad header: %#v", header)
	}
	rows := b.Plan["rows"].([][]string)
	if rows[0][0] != "1" || rows[4][0] != "5" {
		t.Fatalf("bad sequence: %#v", rows)
	}
	if !b.Graph.Passed || !b.Critic.Passed {
		t.Fatalf("expected graph+critic pass: %#v %#v", b.Graph, b.Critic)
	}
}

func TestDynamicRenderSequenceCanStartAtTenWithoutNewBuiltin(t *testing.T) {
	v := Variable{ValueType: "table", Columns: []string{"部门"}, Value: []any{map[string]any{"部门": "A"}, map[string]any{"部门": "B"}}}
	program := map[string]any{"language": "ra-cap-v1", "stage": "render", "kind": "table", "columns": []any{
		map[string]any{"label": "序号", "expr": map[string]any{"op": "add", "args": []any{map[string]any{"var": "index"}, 10.0}}},
		map[string]any{"label": "部门", "expr": map[string]any{"field": "部门"}},
	}}
	r := map[string]any{"kind": "dynamic", "program": program}
	g := QuickValidateRendererGraph(v, r)
	if !g.Passed {
		t.Fatalf("graph failed: %#v", g)
	}
	plan, err := RenderPlan(v, r)
	if err != nil {
		t.Fatal(err)
	}
	rows := plan["rows"].([][]string)
	if rows[0][0] != "10" || rows[1][0] != "11" {
		t.Fatalf("unexpected rows: %#v", rows)
	}
}

func TestDynamicTransformSandboxQuickValidationAndExecution(t *testing.T) {
	values := []any{[]any{"金额"}, []any{10.0}, []any{20.0}}
	program := map[string]any{"language": "ra-cap-v1", "stage": "transform", "steps": []any{
		map[string]any{"op": "map", "keepExisting": true, "columns": []any{map[string]any{"name": "双倍金额", "expr": map[string]any{"op": "mul", "args": []any{map[string]any{"field": "金额"}, 2.0}}}}},
	}}
	spec := map[string]any{"version": 1, "headersMode": "first-row", "steps": []any{map[string]any{"op": "dynamic", "program": program}}, "output": map[string]any{"type": "table", "fields": []any{"金额", "双倍金额"}}}
	g := QuickValidateTransformGraph(values, spec)
	if !g.Passed {
		t.Fatalf("quick validation failed: %#v", g)
	}
	r, err := ExecuteTransform(values, spec)
	if err != nil {
		t.Fatal(err)
	}
	rows := mapRows(r.Value)
	if num(rows[1]["双倍金额"]) != 40 {
		t.Fatalf("unexpected result: %#v", r)
	}
}

func TestValidateTransformIntentAcceptsAggregateAliasForSort(t *testing.T) {
	values := []any{
		[]any{"部门", "状态", "预算金额", "实际金额"},
		[]any{"技术部", "正式", 100.0, 80.0},
	}
	spec := map[string]any{
		"version": 1, "headersMode": "first-row",
		"steps": []any{
			map[string]any{"op": "filter", "field": "状态", "operator": "eq", "value": "正式"},
			map[string]any{"op": "groupAggregate", "by": []any{"部门"}, "aggregates": []any{
				map[string]any{"fn": "sum", "field": "预算金额", "as": "预算金额合计"},
				map[string]any{"fn": "sum", "field": "实际金额", "as": "实际金额合计"},
			}},
			map[string]any{"op": "sort", "field": "预算金额合计", "direction": "desc"},
		},
		"output": map[string]any{"type": "table", "fields": []any{"部门", "预算金额合计", "实际金额合计"}},
	}
	cv := ValidateTransformContract(values, spec)
	cv = ValidateTransformIntent("只保留状态为正式的数据，按部门汇总预算金额和实际金额，按预算金额降序。", spec, cv)
	if !cv.Passed {
		t.Fatalf("semantically equivalent aggregate alias should pass: %#v", cv)
	}
}

func TestDynamicDraftRequiresExplicitApproval(t *testing.T) {
	dataDir := t.TempDir()
	store, err := NewStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := store.CreateProject("测试")
	et, _ := store.RegisterDocument(p.ID, map[string]any{"key": `C:\d.xlsx`, "name": "d.xlsx", "kind": "et"})
	wpp, _ := store.RegisterDocument(p.ID, map[string]any{"key": `C:\d.pptx`, "name": "d.pptx", "kind": "wpp"})
	src, err := store.AddSource(p.ID, map[string]any{"documentId": et.ID, "sheetName": "Sheet1", "address": "A1:A2", "headersMode": "first-row", "values": []any{[]any{"部门"}, []any{"A"}}})
	if err != nil {
		t.Fatal(err)
	}
	v, err := store.AddVariable(p.ID, map[string]any{"name": "v", "displayName": "v", "sourceId": src.ID, "description": "", "transform": map[string]any{}, "value": []any{map[string]any{"部门": "A"}}, "valueType": "table", "columns": []any{"部门"}})
	if err != nil {
		t.Fatal(err)
	}
	srv := &Server{store: store, drafts: NewDraftStore(), diag: NewDiagnostics(filepath.Join(dataDir, "diag")), assetDir: t.TempDir(), host: "127.0.0.1", port: 17891}
	d := srv.drafts.PutBinding(BindingDraft{ProjectID: p.ID, VariableID: v.ID, DocumentID: wpp.ID, Target: map[string]any{"kind": "table"}, Description: "x", Renderer: map[string]any{"kind": "dynamic", "program": map[string]any{"language": "ra-cap-v1", "stage": "render", "kind": "table", "columns": []any{map[string]any{"label": "部门", "expr": map[string]any{"field": "部门"}}}}}, Plan: map[string]any{"kind": "table", "header": []string{"部门"}, "rows": [][]string{{"A"}}}, Generation: "ai-dynamic", DynamicCapability: true})
	code, out := doJSON(t, srv, "POST", "/api/projects/"+p.ID+"/bindings/apply", map[string]any{"draftId": d.ID})
	if code != 412 {
		t.Fatalf("expected 412 without approval, got %d %#v", code, out)
	}
	code, out = doJSON(t, srv, "POST", "/api/projects/"+p.ID+"/bindings/apply", map[string]any{"draftId": d.ID, "approveDynamicCapability": true})
	if code != 201 {
		t.Fatalf("expected success after approval, got %d %#v", code, out)
	}
}

func TestDynamicVariableDraftRequiresExplicitApproval(t *testing.T) {
	dataDir := t.TempDir()
	store, err := NewStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := store.CreateProject("测试")
	et, _ := store.RegisterDocument(p.ID, map[string]any{"key": `C:\d.xlsx`, "name": "d.xlsx", "kind": "et"})
	srv := &Server{store: store, drafts: NewDraftStore(), diag: NewDiagnostics(filepath.Join(dataDir, "diag")), assetDir: t.TempDir(), host: "127.0.0.1", port: 17891}
	d := srv.drafts.PutVariable(VariableDraft{
		ProjectID: p.ID, DocumentID: et.ID, SheetName: "Sheet1", Address: "A1:A2", HeadersMode: "first-row",
		Values: []any{[]any{"金额"}, []any{10.0}}, Name: "v", DisplayName: "v", Description: "双倍金额",
		Transform:  map[string]any{"version": 1, "headersMode": "first-row", "steps": []any{map[string]any{"op": "dynamic", "program": map[string]any{"language": "ra-cap-v1", "stage": "transform", "steps": []any{map[string]any{"op": "map", "keepExisting": true, "columns": []any{map[string]any{"name": "双倍金额", "expr": map[string]any{"op": "mul", "args": []any{map[string]any{"field": "金额"}, 2.0}}}}}}}}}, "output": map[string]any{"type": "table", "fields": []any{"金额", "双倍金额"}}},
		Result:     TransformResult{ValueType: "table", Columns: []string{"金额", "双倍金额"}, Value: []any{map[string]any{"金额": 10.0, "双倍金额": 20.0}}},
		Validation: ContractValidation{Passed: true, OutputType: "table", OutputColumns: []string{"金额", "双倍金额"}},
		Generation: "ai-dynamic", DynamicCapability: true,
	})
	code, out := doJSON(t, srv, "POST", "/api/projects/"+p.ID+"/variables/apply", map[string]any{"draftId": d.ID})
	if code != 412 {
		t.Fatalf("expected 412 without approval, got %d %#v", code, out)
	}
	code, out = doJSON(t, srv, "POST", "/api/projects/"+p.ID+"/variables/apply", map[string]any{"draftId": d.ID, "approveDynamicCapability": true})
	if code != 201 {
		t.Fatalf("expected success after approval, got %d %#v", code, out)
	}
}

func TestDynamicSandboxSortDescending(t *testing.T) {
	rows := []map[string]any{{"金额": 2.0}, {"金额": 10.0}, {"金额": 5.0}}
	program := map[string]any{
		"language": "ra-cap-v1", "stage": "transform",
		"steps": []any{map[string]any{"op": "sort", "expr": map[string]any{"field": "金额"}, "direction": "desc"}},
	}
	out, _, _, _, err := executeDynamicTransform(rows, []string{"金额"}, program)
	if err != nil {
		t.Fatal(err)
	}
	if num(out[0]["金额"]) != 10 || num(out[1]["金额"]) != 5 || num(out[2]["金额"]) != 2 {
		t.Fatalf("unexpected order: %#v", out)
	}
}

func TestDynamicRenderQuickValidationRejectsMissingField(t *testing.T) {
	v := Variable{Name: "x", ValueType: "table", Columns: []string{"部门"}, Value: []any{map[string]any{"部门": "A"}}}
	r := map[string]any{"kind": "dynamic", "program": map[string]any{
		"language": "ra-cap-v1", "stage": "render", "kind": "table",
		"columns": []any{map[string]any{"label": "错误", "expr": map[string]any{"field": "不存在"}}},
	}}
	gv := QuickValidateRendererGraph(v, r)
	if gv.Passed || len(gv.Errors) == 0 {
		t.Fatalf("expected quick validation failure: %#v", gv)
	}
}
