package main

import "fmt"

// ValidateExecutionV2 performs runtime validation with task context.
func ValidateExecutionV2(task string, result ExecutionResult) ValidationResult {
	checks := []ValidationCheck{
		{Name: "execution_success", Pass: result.Status == "success"},
		{Name: "result_exists", Pass: result.Result != nil},
	}
	passed := true
	for _, c := range checks {
		if !c.Pass {
			passed = false
		}
	}
	msg := ""
	if !passed {
		msg = fmt.Sprintf("task %s validation failed", task)
	}
	return ValidationResult{Passed: passed, Checks: checks, Message: msg}
}

func ValidateNumberResult(task string, result ExecutionResult) ValidationResult {
	v := ValidateExecutionV2(task, result)
	if !v.Passed {
		return v
	}
	switch result.Result.(type) {
	case float64, float32, int, int64:
		v.Checks = append(v.Checks, ValidationCheck{Name: "numeric_result", Pass: true})
	default:
		v.Checks = append(v.Checks, ValidationCheck{Name: "numeric_result", Pass: false})
		v.Passed = false
	}
	return v
}
