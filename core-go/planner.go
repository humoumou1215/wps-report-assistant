package main

import "fmt"

// Planner creates business plans. It intentionally stays separate from runtime DSL.
type PlannerInput struct {
	Description string
	Context     map[string]any
}

func PlanFromIntent(input PlannerInput) (BusinessPlan, error) {
	if input.Description == "" {
		return BusinessPlan{}, fmt.Errorf("empty intent")
	}
	// v0.5.1 bootstrap planner. The AI adapter will replace this rule planner.
	if contains(input.Description, "正式") && contains(input.Description, "预算") && contains(input.Description, "合计") {
		return BusinessPlan{Goal: "正式预算合计", Operations: []BusinessOperation{
			{Action: "filter", Condition: map[string]any{"field": "状态", "operator": "equals", "value": "正式"}},
			{Action: "aggregate", Field: "预算金额", Method: "sum"},
		}}, nil
	}
	return BusinessPlan{Goal: input.Description}, nil
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i <= len(s)-len(sub); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
