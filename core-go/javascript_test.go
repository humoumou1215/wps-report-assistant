package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func jsSpec(code string) map[string]any {
	return map[string]any{"language": "javascript", "code": code, "version": float64(1)}
}
func jsFixture() []any {
	values := []any{[]any{"部门", "状态", "预算金额"}}
	amounts := []float64{12800000, 6200000, 8600000, 2300000, 5100000, 4200000, 3800000, 7200000, 4700000, 3332600000, 1800000, 3200000, 2900000, 3500000}
	for i, amount := range amounts {
		status := "正式"
		if i == 3 || i == 6 || i == 7 {
			status = "草稿"
		}
		values = append(values, []any{fmt.Sprintf("部门%d", i+1), status, amount})
	}
	return values
}

const jsTopFive = `return rows.filter(r=>r["状态"]==="正式").sort((a,b)=>b["预算金额"]-a["预算金额"]).slice(0,5).map((r,i)=>({序号:i+1,...r}));`

func TestJavaScriptTopFiveUsesAllRowsAndKeepsSequence(t *testing.T) {
	values := jsFixture()
	before := cloneJSON(values)
	r, err := ExecuteTransform(values, jsSpec(jsTopFive))
	if err != nil {
		t.Fatal(err)
	}
	rows := r.Value.([]any)
	if len(rows) != 5 || strings.Join(r.Columns, ",") != "序号,部门,状态,预算金额" {
		t.Fatal(r)
	}
	expected := []float64{3332600000, 12800000, 8600000, 6200000, 5100000}
	for i, row := range rows {
		m := row.(map[string]any)
		if m["序号"] != float64(i+1) || m["预算金额"] != expected[i] {
			t.Fatal(m)
		}
	}
	if !jsonEqual(values, before) {
		t.Fatal("modified source data")
	}
}
func TestJavaScriptFailuresAreBoundedAndNoHostAPIs(t *testing.T) {
	for _, code := range []string{`return process.env;`, `return require("fs");`, `return Application.ActiveDocument;`, `return fetch("http://localhost");`, `return 0/0;`, `return rows.map(r=>({x:r.missing}));`, `while(true){}`, `function f(){return f()};return f();`, `return {valueType:"table",columns:["missing"],value:[{x:1}]};`} {
		t.Run(code, func(t *testing.T) {
			start := time.Now()
			if _, err := ExecuteTransform(jsFixture(), jsSpec(code)); err == nil {
				t.Fatal("invalid script accepted")
			}
			if time.Since(start) > 7*time.Second {
				t.Fatal("execution not bounded")
			}
		})
	}
}
func TestJavaScriptAIRepairsExecutionErrorAndDoesNotGateOnCritic(t *testing.T) {
	var count int32
	good, _ := json.Marshal(map[string]any{"code": jsTopFive})
	ts := aiTestServer(t, []string{`{"code":"return missingRows.map(r=>r);"}`, string(good), `{"passed":false,"issues":["样本没有部门10"],"repairInstruction":"删除部门10"}`}, &count)
	defer ts.Close()
	settings := defaultSettings()
	settings.AI = AISettings{Enabled: true, BaseURL: ts.URL, APIKey: "test", Model: "test"}
	b, err := BuildTransform(settings, jsFixture(), "正式数据按预算降序前五行并增加序号")
	if err != nil {
		t.Fatal(err)
	}
	if !b.Validation.Passed || len(b.Attempts) != 2 || b.Generation != "ai-javascript" || len(b.Validation.Warnings) == 0 || b.Critic.Passed || atomic.LoadInt32(&count) != 3 {
		t.Fatal(b, count)
	}
	if b.Result.Value.([]any)[0].(map[string]any)["预算金额"] != 3332600000.0 {
		t.Fatal("critic changed computed result")
	}
}
func TestJavaScriptPersistRefreshAndRender(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	p, _ := s.CreateProject("js")
	d, _ := s.RegisterDocument(p.ID, map[string]any{"key": "C:/data.xlsx", "kind": "et"})
	spec := jsSpec(jsTopFive)
	result, err := ExecuteTransform(jsFixture(), spec)
	if err != nil {
		t.Fatal(err)
	}
	source, v, err := s.CommitVariableDraft(p.ID, VariableDraft{DocumentID: d.ID, Name: "top5", Values: jsFixture(), Transform: spec, Result: result, Validation: ContractValidation{Passed: true}})
	if err != nil {
		t.Fatal(err)
	}
	s, err = NewStore(s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	changed := jsFixture()
	changed[10].([]any)[2] = 100.0
	if _, err = s.UpdateSource(p.ID, source.ID, changed); err != nil {
		t.Fatal(err)
	}
	v, _ = s.VariableByID(p.ID, v.ID)
	if v.Value.([]any)[0].(map[string]any)["预算金额"] != 12800000.0 {
		t.Fatal(v.Value)
	}
	renderer := jsSpec(`return {kind:"table",header:["序号","部门","万元"],rows:variable.value.map(r=>[r["序号"],r["部门"],(r["预算金额"]/10000).toFixed(2)])};`)
	renderer["kind"] = "table"
	plan, err := RenderPlan(v, renderer)
	if err != nil {
		t.Fatal(err)
	}
	if plan["rows"].([]any)[0].([]any)[2] != "1280.00" {
		t.Fatal(plan)
	}
	if !jsonEqual(ApplyBindingDescriptionHints(renderer, "改为亿元"), renderer) {
		t.Fatal("migration rewrote JS rule")
	}
}
func TestJavaScriptRenderAIAndInvalidPlans(t *testing.T) {
	var count int32
	ts := aiTestServer(t, []string{`{"code":"return {kind:'text',text:(variable.value/100000000).toFixed(2)+'亿元'};"}`}, &count)
	defer ts.Close()
	settings := defaultSettings()
	settings.AI = AISettings{Enabled: true, BaseURL: ts.URL, APIKey: "test", Model: "test"}
	settings.Agent.CriticEnabled = false
	b, err := BuildBinding(settings, Variable{ValueType: "number", Value: 66600000.0}, map[string]any{"kind": "text"}, "亿元两位小数")
	if err != nil || b.Plan["text"] != "0.67亿元" || count != 1 {
		t.Fatal(b, err)
	}
	for _, code := range []string{`return {kind:'image'};`, `return {kind:'table',header:['a'],rows:[[1,2]]};`, `return {kind:'text',text:123};`} {
		if _, err := RenderPlan(Variable{}, jsSpec(code)); err == nil {
			t.Fatal(code)
		}
	}
}
func TestReviewEvidenceFullAndTruncatedAreExplicit(t *testing.T) {
	evidence := reviewEvidence(jsFixture())
	if evidence["complete"] != true || evidence["rowCount"] != 15 {
		t.Fatal(evidence)
	}
	large := []any{}
	for i := 0; i < 100; i++ {
		large = append(large, map[string]any{"data": strings.Repeat("x", 2000)})
	}
	evidence = reviewEvidence(large)
	if evidence["complete"] != false || evidence["rowCount"] != 100 {
		t.Fatal("missing coverage metadata")
	}
}
