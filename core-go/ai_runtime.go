package main

import (
	"fmt"
	"time"
)

// AI Runtime v1 foundation.
// This layer intentionally separates AI planning from executable runtime specs.

type BusinessPlan struct {
	Goal       string              `json:"goal"`
	Operations []BusinessOperation `json:"operations"`
}

type BusinessOperation struct {
	Action    string         `json:"action"`
	Condition map[string]any `json:"condition,omitempty"`
	Field     string         `json:"field,omitempty"`
	Method    string         `json:"method,omitempty"`
}

type CapabilityRegistry struct {
	DataOperations []CapabilityOperation `json:"dataOperations"`
	Renderers      []CapabilityRenderer  `json:"renderers"`
}

type CapabilityOperation struct {
	Name      string   `json:"name"`
	Operators []string `json:"operators,omitempty"`
	Methods   []string `json:"methods,omitempty"`
}

type CapabilityRenderer struct {
	Name     string   `json:"name"`
	Features []string `json:"features"`
}

// DefaultCapabilities describes what the runtime can execute.
// AI should consume this instead of guessing implementation details.
func DefaultCapabilities() CapabilityRegistry {
	return CapabilityRegistry{
		DataOperations: []CapabilityOperation{
			{Name: "filter", Operators: []string{"equals", "contains"}},
			{Name: "aggregate", Methods: []string{"sum", "avg", "count"}},
			{Name: "groupAggregate", Methods: []string{"sum", "avg", "count"}},
		},
		Renderers: []CapabilityRenderer{
			{Name: "text", Features: []string{"numberFormat", "unitConvert"}},
			{Name: "table", Features: []string{"insertRows", "keepStyle"}},
		},
	}
}

// CompileBusinessPlan converts business language into the current runtime boundary.
// The existing transform/render engines remain unchanged in v0.5 migration.
func CompileBusinessPlan(plan BusinessPlan) (map[string]any, error) {
	if plan.Goal == "" {
		return nil, fmt.Errorf("business plan goal is empty")
	}
	return map[string]any{
		"version":    1,
		"compiledAt": time.Now().Format(time.RFC3339),
		"operations": plan.Operations,
	}, nil
}

// ValidationResult is the common validation contract.
type ValidationResult struct {
	Passed  bool              `json:"passed"`
	Checks  []ValidationCheck `json:"checks"`
	Message string            `json:"message,omitempty"`
}

type ValidationCheck struct {
	Name string `json:"name"`
	Pass bool   `json:"pass"`
}

func ValidateExecution(result any) ValidationResult {
	return ValidationResult{
		Passed: true,
		Checks: []ValidationCheck{
			{Name: "result_exists", Pass: result != nil},
		},
	}
}
