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

func TestBuildTransformRepairsUnknownField(t *testing.T) {
	var count int32
	ts := aiTestServer(t, []string{
		`{"version":1,"headersMode":"first-row","steps":[{"op":"aggregate","fn":"sum","field":"不存在"}],"output":{"type":"number"}}`,
		`{"version":1,"headersMode":"first-row","steps":[{"op":"filter","field":"状态","operator":"eq","value":"正式"},{"op":"aggregate","fn":"sum","field":"预算金额"}],"output":{"type":"number"}}`,
	}, &count)
	defer ts.Close()
	settings := defaultSettings()
	settings.AI = AISettings{Enabled: true, BaseURL: ts.URL, APIKey: "test", Model: "test-model", Temperature: 0}
	values := []any{[]any{"状态", "预算金额"}, []any{"正式", 100.0}, []any{"草稿", 50.0}, []any{"正式", 200.0}}
	b, err := BuildTransform(settings, values, "只保留状态为正式的数据，计算预算金额合计")
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

func TestBuildBindingRepairsBadValuePath(t *testing.T) {
	var count int32
	ts := aiTestServer(t, []string{
		`{"kind":"text","valuePath":"$[0].不存在","template":"{{value}}","format":{"numberFormat":"0.00"}}`,
		`{"kind":"text","valuePath":"$[0].金额","template":"{{value}}","format":{"numberFormat":"0.00"}}`,
	}, &count)
	defer ts.Close()
	settings := defaultSettings()
	settings.AI = AISettings{Enabled: true, BaseURL: ts.URL, APIKey: "test", Model: "test-model", Temperature: 0}
	v := Variable{Name: "预算", ValueType: "table", Columns: []string{"金额"}, Value: []any{map[string]any{"金额": 123.0}}}
	b, err := BuildBinding(settings, v, map[string]any{"kind": "text"}, "显示第一行金额")
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

func TestBuildBindingUserUnitOverridesConflictingAIFormat(t *testing.T) {
	var count int32
	ts := aiTestServer(t, []string{
		`{"kind":"text","valuePath":"$","template":"{{value}}","format":{"divideBy":10000,"numberFormat":"0.0","suffix":"万元"}}`,
	}, &count)
	defer ts.Close()
	settings := defaultSettings()
	settings.AI = AISettings{Enabled: true, BaseURL: ts.URL, APIKey: "test", Model: "test-model", Temperature: 0}
	v := Variable{Name: "正式预算合计", ValueType: "number", Value: 66600000.0}
	b, err := BuildBinding(settings, v, map[string]any{"kind": "text"}, "按亿元显示，保留2位小数，后缀为亿元")
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Attempts) != 1 || atomic.LoadInt32(&count) != 1 {
		t.Fatalf("semantic hardening should resolve conflict deterministically, attempts=%d calls=%d", len(b.Attempts), count)
	}
	format, _ := b.Renderer["format"].(map[string]any)
	if got, _ := asFloat(format["divideBy"]); got != 100000000 {
		t.Fatalf("expected forced 亿元 divisor, got %#v", format)
	}
	if format["numberFormat"] != "0.00" || format["suffix"] != "亿元" {
		t.Fatalf("expected forced precision/suffix, got %#v", format)
	}
	if b.Plan["text"] != "0.67亿元" {
		t.Fatalf("unexpected plan: %#v", b.Plan)
	}
}

func TestBuildTransformRepairsSemanticallyWrongExistingField(t *testing.T) {
	var count int32
	ts := aiTestServer(t, []string{
		`{"version":1,"headersMode":"first-row","steps":[{"op":"filter","field":"状态","operator":"eq","value":"正式"},{"op":"aggregate","fn":"sum","field":"实际金额"}],"output":{"type":"number"}}`,
		`{"version":1,"headersMode":"first-row","steps":[{"op":"filter","field":"状态","operator":"eq","value":"正式"},{"op":"aggregate","fn":"sum","field":"预算金额"}],"output":{"type":"number"}}`,
	}, &count)
	defer ts.Close()
	settings := defaultSettings()
	settings.AI = AISettings{Enabled: true, BaseURL: ts.URL, APIKey: "test", Model: "test-model", Temperature: 0}
	values := []any{
		[]any{"状态", "预算金额", "实际金额"},
		[]any{"正式", 100.0, 80.0},
		[]any{"草稿", 50.0, 40.0},
		[]any{"正式", 200.0, 150.0},
	}
	b, err := BuildTransform(settings, values, "只保留状态为正式的数据，计算预算金额合计")
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Attempts) != 2 || atomic.LoadInt32(&count) != 2 {
		t.Fatalf("expected semantic repair, attempts=%d calls=%d", len(b.Attempts), count)
	}
	if b.Attempts[0].Validation.Passed || !b.Attempts[1].Validation.Passed {
		t.Fatalf("unexpected validation history: %#v", b.Attempts)
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
