package main

import "fmt"

// CompiledPlan is the stable boundary between AI business intent and runtime.
type CompiledPlan struct {
	Version    int                 `json:"version"`
	Operations []BusinessOperation `json:"operations"`
}

func CheckPlanCapability(plan BusinessPlan, caps CapabilityRegistry) error {
	for _, op := range plan.Operations {
		found := false
		for _, c := range caps.DataOperations {
			if c.Name != op.Action {
				continue
			}
			found = true
			switch op.Action {
			case "filter":
				operator, _ := op.Condition["operator"].(string)
				if !containsString(c.Operators, operator) {
					return fmt.Errorf("filter operator not supported: %s", operator)
				}
			case "aggregate", "groupAggregate":
				if !containsString(c.Methods, op.Method) {
					return fmt.Errorf("aggregate method not supported: %s", op.Method)
				}
			}
		}
		if !found {
			return fmt.Errorf("operation not supported: %s", op.Action)
		}
	}
	return nil
}

func CompileBusinessPlanV2(plan BusinessPlan, caps CapabilityRegistry) (CompiledPlan, error) {
	if err := CheckPlanCapability(plan, caps); err != nil {
		return CompiledPlan{}, err
	}
	return CompiledPlan{
		Version:    1,
		Operations: plan.Operations,
	}, nil
}

func containsString(list []string, target string) bool {
	for _, v := range list {
		if v == target {
			return true
		}
	}
	return false
}
