package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

const maxGenerationAttempts = 3

type GenerationAttempt struct {
	Number      int                `json:"number"`
	Via         string             `json:"via"`
	DurationMs  int64              `json:"durationMs,omitempty"`
	RawResponse string             `json:"rawResponse,omitempty"`
	Output      map[string]any     `json:"output,omitempty"`
	Validation  ContractValidation `json:"validation"`
	Error       string             `json:"error,omitempty"`
}

type TransformBuild struct {
	Spec       map[string]any      `json:"transform"`
	Result     TransformResult     `json:"result"`
	Generation string              `json:"generation"`
	Attempts   []GenerationAttempt `json:"attempts"`
	Validation ContractValidation  `json:"validation"`
	AITrace    AITrace             `json:"-"`
}

type BindingBuild struct {
	Renderer   map[string]any      `json:"renderer"`
	Plan       map[string]any      `json:"plan"`
	Generation string              `json:"generation"`
	Attempts   []GenerationAttempt `json:"attempts"`
	Validation ContractValidation  `json:"validation"`
	AITrace    AITrace             `json:"-"`
}

func sampleForAI(values any, maxRows int) any {
	if arr, ok := values.([]any); ok && len(arr) > maxRows {
		return arr[:maxRows]
	}
	return values
}

func transformRepairUser(values any, description string, previous map[string]any, raw string, reason string) string {
	headers, _ := matrixToRows(values, "first-row")
	payload := map[string]any{
		"task":            "修复上一版 TransformSpec。必须返回完整、可执行的 canonical TransformSpec JSON。",
		"description":     description,
		"availableFields": headers,
		"sample":          sampleForAI(values, 12),
		"validationError": reason,
		"previousOutput":  previous,
	}
	if strings.TrimSpace(raw) != "" && previous == nil {
		payload["previousRawResponse"] = raw
	}
	b, _ := json.MarshalIndent(payload, "", "  ")
	return string(b)
}

func bindingRepairUser(v Variable, target map[string]any, description string, previous map[string]any, raw string, reason string) string {
	payload := map[string]any{
		"task":        "修复上一版 renderer。必须直接返回完整 renderer JSON，不要包 renderer 外层。",
		"description": description,
		"target":      target,
		"variable": map[string]any{
			"name": v.Name, "displayName": v.DisplayName, "valueType": v.ValueType,
			"columns": v.Columns, "sample": sampleForAI(v.Value, 5),
		},
		"validationError": reason,
		"previousOutput":  previous,
	}
	if strings.TrimSpace(raw) != "" && previous == nil {
		payload["previousRawResponse"] = raw
	}
	b, _ := json.MarshalIndent(payload, "", "  ")
	return string(b)
}

func BuildTransform(settings Settings, values any, description string) (TransformBuild, error) {
	// AI disabled/unconfigured intentionally uses the deterministic fallback path.
	if !settings.AI.Enabled || strings.TrimSpace(settings.AI.APIKey) == "" || strings.TrimSpace(settings.AI.BaseURL) == "" || strings.TrimSpace(settings.AI.Model) == "" {
		spec := GuessTransform(values, description)
		norm, err := NormalizeTransformSpec(spec)
		if err != nil {
			return TransformBuild{}, err
		}
		cv := ValidateTransformContract(values, norm)
		cv = ValidateTransformIntent(description, norm, cv)
		attempt := GenerationAttempt{Number: 1, Via: "fallback", Output: norm, Validation: cv}
		if !cv.Passed {
			attempt.Error = strings.Join(cv.Errors, "; ")
			return TransformBuild{Spec: norm, Generation: "fallback", Attempts: []GenerationAttempt{attempt}, Validation: cv}, fmt.Errorf("内置规则无法生成有效转换：%s", attempt.Error)
		}
		result, err := ExecuteTransform(values, norm)
		if err != nil {
			attempt.Error = err.Error()
			return TransformBuild{Spec: norm, Generation: "fallback", Attempts: []GenerationAttempt{attempt}, Validation: cv}, err
		}
		cv = ValidateTransformExecution(result, cv)
		attempt.Validation = cv
		if !cv.Passed {
			attempt.Error = strings.Join(cv.Errors, "; ")
			return TransformBuild{Spec: norm, Result: result, Generation: "fallback", Attempts: []GenerationAttempt{attempt}, Validation: cv}, fmt.Errorf("转换执行校验失败：%s", attempt.Error)
		}
		return TransformBuild{Spec: norm, Result: result, Generation: "fallback", Attempts: []GenerationAttempt{attempt}, Validation: cv}, nil
	}

	original, _ := json.MarshalIndent(map[string]any{"description": description, "sample": sampleForAI(values, 12)}, "", "  ")
	user := string(original)
	attempts := []GenerationAttempt{}
	var lastTrace AITrace
	var lastReason string
	var lastOut map[string]any
	var lastRaw string

	for i := 1; i <= maxGenerationAttempts; i++ {
		out, tr, callErr := chatJSON(settings, transformSystem, user)
		lastTrace = tr
		lastOut = out
		lastRaw = tr.RawResponse
		a := GenerationAttempt{Number: i, Via: "ai", DurationMs: tr.DurationMs, RawResponse: tr.RawResponse, Output: out}
		if callErr != nil {
			a.Error = callErr.Error()
			a.Validation = ContractValidation{Passed: false, Errors: []string{callErr.Error()}}
			attempts = append(attempts, a)
			lastReason = callErr.Error()
		} else {
			norm, err := NormalizeTransformSpec(out)
			if err != nil {
				a.Error = err.Error()
				a.Validation = ContractValidation{Passed: false, Errors: []string{err.Error()}}
				attempts = append(attempts, a)
				lastReason = err.Error()
			} else {
				a.Output = norm
				lastOut = norm
				cv := ValidateTransformContract(values, norm)
				cv = ValidateTransformIntent(description, norm, cv)
				a.Validation = cv
				if !cv.Passed {
					a.Error = strings.Join(cv.Errors, "; ")
					attempts = append(attempts, a)
					lastReason = a.Error
				} else {
					result, err := ExecuteTransform(values, norm)
					if err != nil {
						a.Error = err.Error()
						a.Validation.Passed = false
						a.Validation.Errors = append(a.Validation.Errors, err.Error())
						attempts = append(attempts, a)
						lastReason = err.Error()
					} else {
						cv = ValidateTransformExecution(result, cv)
						a.Validation = cv
						if !cv.Passed {
							a.Error = strings.Join(cv.Errors, "; ")
							attempts = append(attempts, a)
							lastReason = a.Error
						} else {
							attempts = append(attempts, a)
							return TransformBuild{Spec: norm, Result: result, Generation: "ai", Attempts: attempts, Validation: cv, AITrace: tr}, nil
						}
					}
				}
			}
		}
		if i < maxGenerationAttempts {
			user = transformRepairUser(values, description, lastOut, lastRaw, lastReason)
		}
	}
	return TransformBuild{Spec: lastOut, Generation: "ai", Attempts: attempts, Validation: ContractValidation{Passed: false, Errors: []string{lastReason}}, AITrace: lastTrace}, fmt.Errorf("AI 连续 %d 次未生成可执行转换规则：%s", maxGenerationAttempts, lastReason)
}

func BuildBinding(settings Settings, v Variable, target map[string]any, description string) (BindingBuild, error) {
	fallback := func() map[string]any {
		kind, _ := target["kind"].(string)
		if v.ValueType == "table" && kind == "table" {
			cols := []any{}
			for _, f := range v.Columns {
				cols = append(cols, map[string]any{"field": f, "label": f})
			}
			return map[string]any{"kind": "table", "includeHeader": true, "columns": cols, "resizeRows": true}
		}
		vp := "$"
		if v.ValueType == "table" && len(v.Columns) > 0 {
			vp = "$[0]." + v.Columns[0]
		}
		return map[string]any{"kind": "text", "valuePath": vp, "template": "{{value}}", "format": map[string]any{"numberFormat": "0.00"}}
	}

	if !settings.AI.Enabled || strings.TrimSpace(settings.AI.APIKey) == "" || strings.TrimSpace(settings.AI.BaseURL) == "" || strings.TrimSpace(settings.AI.Model) == "" {
		renderer := ApplyBindingDescriptionHints(fallback(), description)
		norm, err := NormalizeRendererSpec(renderer)
		if err != nil {
			return BindingBuild{}, err
		}
		cv := ValidateRendererContract(v, target, norm)
		a := GenerationAttempt{Number: 1, Via: "fallback", Output: norm, Validation: cv}
		if !cv.Passed {
			a.Error = strings.Join(cv.Errors, "; ")
			return BindingBuild{Renderer: norm, Generation: "fallback", Attempts: []GenerationAttempt{a}, Validation: cv}, fmt.Errorf("内置绑定规则不适用于当前目标：%s", a.Error)
		}
		plan, err := RenderPlan(v, norm)
		if err != nil {
			a.Error = err.Error()
			return BindingBuild{Renderer: norm, Generation: "fallback", Attempts: []GenerationAttempt{a}, Validation: cv}, err
		}
		return BindingBuild{Renderer: norm, Plan: plan, Generation: "fallback", Attempts: []GenerationAttempt{a}, Validation: cv}, nil
	}

	firstPayload, _ := json.MarshalIndent(map[string]any{
		"description": description,
		"target":      target,
		"variable":    map[string]any{"name": v.Name, "displayName": v.DisplayName, "valueType": v.ValueType, "columns": v.Columns, "sample": sampleForAI(v.Value, 5)},
	}, "", "  ")
	user := string(firstPayload)
	attempts := []GenerationAttempt{}
	var lastTrace AITrace
	var lastReason string
	var lastOut map[string]any
	var lastRaw string

	for i := 1; i <= maxGenerationAttempts; i++ {
		out, tr, callErr := chatJSON(settings, bindingSystem, user)
		lastTrace = tr
		lastOut = out
		lastRaw = tr.RawResponse
		a := GenerationAttempt{Number: i, Via: "ai", DurationMs: tr.DurationMs, RawResponse: tr.RawResponse, Output: out}
		if callErr != nil {
			a.Error = callErr.Error()
			a.Validation = ContractValidation{Passed: false, Errors: []string{callErr.Error()}}
			attempts = append(attempts, a)
			lastReason = callErr.Error()
		} else {
			norm, err := NormalizeRendererSpec(out)
			if err != nil {
				a.Error = err.Error()
				a.Validation = ContractValidation{Passed: false, Errors: []string{err.Error()}}
				attempts = append(attempts, a)
				lastReason = err.Error()
			} else {
				norm = ApplyBindingDescriptionHints(norm, description)
				a.Output = norm
				lastOut = norm
				cv := ValidateRendererContract(v, target, norm)
				a.Validation = cv
				if !cv.Passed {
					a.Error = strings.Join(cv.Errors, "; ")
					attempts = append(attempts, a)
					lastReason = a.Error
				} else {
					plan, err := RenderPlan(v, norm)
					if err != nil {
						a.Error = err.Error()
						a.Validation.Passed = false
						a.Validation.Errors = append(a.Validation.Errors, err.Error())
						attempts = append(attempts, a)
						lastReason = err.Error()
					} else {
						attempts = append(attempts, a)
						return BindingBuild{Renderer: norm, Plan: plan, Generation: "ai", Attempts: attempts, Validation: cv, AITrace: tr}, nil
					}
				}
			}
		}
		if i < maxGenerationAttempts {
			user = bindingRepairUser(v, target, description, lastOut, lastRaw, lastReason)
		}
	}
	return BindingBuild{Renderer: lastOut, Generation: "ai", Attempts: attempts, Validation: ContractValidation{Passed: false, Errors: []string{lastReason}}, AITrace: lastTrace}, fmt.Errorf("AI 连续 %d 次未生成可执行绑定规则：%s", maxGenerationAttempts, lastReason)
}
