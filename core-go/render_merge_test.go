package main

import "testing"

func TestRenderPlanMergeByBuildsVerticalMergeRanges(t *testing.T) {
	v := Variable{
		ValueType: "table",
		Columns:   []string{"部门", "金额"},
		Value: []any{
			map[string]any{"部门": "研发", "金额": 10.0},
			map[string]any{"部门": "研发", "金额": 20.0},
			map[string]any{"部门": "销售", "金额": 30.0},
		},
	}
	plan, err := RenderPlan(v, map[string]any{
		"kind":          "table",
		"includeHeader": true,
		"mergeBy":       []any{"部门"},
		"columns": []any{
			map[string]any{"field": "部门"},
			map[string]any{"field": "金额"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	merges, ok := plan["mergeCells"].([]any)
	if !ok || len(merges) != 1 {
		t.Fatalf("expected one merge range, got %#v", plan["mergeCells"])
	}
	merge := merges[0].(map[string]any)
	if merge["row"] != 2 || merge["column"] != 1 || merge["rowSpan"] != 2 || merge["colSpan"] != 1 {
		t.Fatalf("unexpected merge range: %#v", merge)
	}
}

func TestValidateRendererContractRequiresMergeByOutputColumns(t *testing.T) {
	v := Variable{ValueType: "table", Columns: []string{"部门", "金额"}, Value: []any{}}
	result := ValidateRendererContract(v, map[string]any{"kind": "table"}, map[string]any{
		"kind":    "table",
		"mergeBy": []any{"部门"},
		"columns": []any{map[string]any{"field": "金额"}},
	})
	if result.Passed {
		t.Fatalf("mergeBy field omitted from output columns should fail: %#v", result)
	}
}
