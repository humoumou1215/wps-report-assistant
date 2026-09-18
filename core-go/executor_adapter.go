package main

import (
	"fmt"
	"time"
)

// ExecutionResult is the unified runtime result returned by executors.
type ExecutionResult struct {
	ExecutionID string         `json:"executionId"`
	Status      string         `json:"status"`
	Result      any            `json:"result"`
	Statistics  map[string]any `json:"statistics,omitempty"`
	Errors      []string       `json:"errors,omitempty"`
	CreatedAt   string         `json:"createdAt"`
}

// ExecuteCompiledPlan is the v0.5.6 boundary between AI Runtime and legacy engines.
// The adapter keeps BusinessPlan/CompiledPlan independent from TransformSpec.
func ExecuteCompiledPlan(plan CompiledPlan, values any) (ExecutionResult, error) {
	exec := ExecutionResult{
		ExecutionID: newID("exec"),
		Status:      "success",
		CreatedAt:   time.Now().Format(time.RFC3339),
		Statistics:  map[string]any{},
	}
	current := values
	for _, op := range plan.Operations {
		switch op.Action {
		case "filter":
			spec := map[string]any{
				"version": 1,
				"steps": []any{map[string]any{
					"op":       "filter",
					"field":    op.Condition["field"],
					"operator": "eq",
					"value":    op.Condition["value"],
				}},
			}
			r, err := ExecuteTransform(current, spec)
			if err != nil {
				return execFail(exec, err)
			}
			current = r.Value
		case "groupAggregate":
			return execFail(exec, fmt.Errorf("groupAggregate adapter pending: use v0.5.6 table runtime"))
		case "aggregate":
			spec := map[string]any{
				"version": 1,
				"steps": []any{map[string]any{
					"op":    "aggregate",
					"fn":    op.Method,
					"field": op.Field,
				}},
			}
			r, err := ExecuteTransform(current, spec)
			if err != nil {
				return execFail(exec, err)
			}
			current = r.Value
		default:
			return execFail(exec, fmt.Errorf("unsupported runtime operation: %s", op.Action))
		}
	}
	exec.Result = current
	exec.Statistics["finished"] = true
	return exec, nil
}

func execFail(e ExecutionResult, err error) (ExecutionResult, error) {
	e.Status = "failed"
	e.Errors = []string{err.Error()}
	return e, err
}
