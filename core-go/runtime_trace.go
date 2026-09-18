package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type RuntimeTrace struct {
	Task         any `json:"task,omitempty"`
	BusinessPlan any `json:"businessPlan,omitempty"`
	Capability   any `json:"capability,omitempty"`
	CompiledPlan any `json:"compiledPlan,omitempty"`
	Execution    any `json:"execution,omitempty"`
	Validation   any `json:"validation,omitempty"`
}

func SaveRuntimeTrace(dir string, trace RuntimeTrace) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	files := map[string]any{
		"task.json":          trace.Task,
		"business-plan.json": trace.BusinessPlan,
		"capability.json":    trace.Capability,
		"compiled-plan.json": trace.CompiledPlan,
		"execution.json":     trace.Execution,
		"validation.json":    trace.Validation,
	}
	for n, v := range files {
		b, _ := json.MarshalIndent(v, "", "  ")
		if err := os.WriteFile(filepath.Join(dir, n), b, 0644); err != nil {
			return err
		}
	}
	return nil
}
