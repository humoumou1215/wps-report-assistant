package main

import "testing"

func TestRuntimeV056Budget(t *testing.T) {
	plan, _ := PlanFromIntent(PlannerInput{Description: "只保留状态为正式的数据，计算预算金额合计"})
	cp, err := CompileBusinessPlanV2(plan, DefaultCapabilities())
	if err != nil {
		t.Fatal(err)
	}
	values := []any{
		[]any{"状态", "预算金额"},
		[]any{"正式", 100},
		[]any{"草稿", 50},
		[]any{"正式", 200},
	}
	res, err := ExecuteCompiledPlan(cp, values)
	if err != nil {
		t.Fatal(err)
	}
	if !ValidateExecutionV1("预算合计", res).Passed {
		t.Fatal("validation failed")
	}
}
