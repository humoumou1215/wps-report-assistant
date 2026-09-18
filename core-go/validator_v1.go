package main

import "reflect"

// ValidateExecutionV1 performs deterministic checks after runtime execution.
func ValidateExecutionV1(task string, result ExecutionResult) ValidationResult {
	checks := []ValidationCheck{
		{Name: "execution_status", Pass: result.Status == "success"},
		{Name: "result_exists", Pass: result.Result != nil},
	}
	passed := true
	for _, c := range checks {
		if !c.Pass {
			passed = false
		}
	}
	return ValidationResult{
		Passed:  passed,
		Checks:  checks,
		Message: validationMessage(task, result),
	}
}

func validationMessage(task string, result ExecutionResult) string {
	if result.Status != "success" {
		return "execution failed"
	}
	if reflect.ValueOf(result.Result).Kind() == reflect.Invalid {
		return "empty result"
	}
	return "validated"
}
