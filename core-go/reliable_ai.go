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
	Graph       GraphValidation    `json:"graphValidation"`
	Critic      SemanticReview     `json:"critic"`
	Error       string             `json:"error,omitempty"`
}

type TransformBuild struct {
	Spec              map[string]any      `json:"transform"`
	Result            TransformResult     `json:"result"`
	Generation        string              `json:"generation"`
	Attempts          []GenerationAttempt `json:"attempts"`
	Validation        ContractValidation  `json:"validation"`
	Graph             GraphValidation     `json:"graphValidation"`
	Critic            SemanticReview      `json:"critic"`
	DynamicCapability bool                `json:"dynamicCapability"`
	AITrace           AITrace             `json:"-"`
}

type BindingBuild struct {
	Renderer          map[string]any      `json:"renderer"`
	Plan              map[string]any      `json:"plan"`
	Generation        string              `json:"generation"`
	Attempts          []GenerationAttempt `json:"attempts"`
	Validation        ContractValidation  `json:"validation"`
	Graph             GraphValidation     `json:"graphValidation"`
	Critic            SemanticReview      `json:"critic"`
	DynamicCapability bool                `json:"dynamicCapability"`
	AITrace           AITrace             `json:"-"`
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
		"capabilities":    RuntimeCapabilities(),
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
			"columns": v.Columns, "sample": sampleForAI(v.Value, 8),
		},
		"validationError": reason,
		"previousOutput":  previous,
		"capabilities":    RuntimeCapabilities(),
	}
	if strings.TrimSpace(raw) != "" && previous == nil {
		payload["previousRawResponse"] = raw
	}
	b, _ := json.MarshalIndent(payload, "", "  ")
	return string(b)
}

func reviewReason(r SemanticReview) string {
	parts := append([]string{}, r.Issues...)
	if strings.TrimSpace(r.RepairInstruction) != "" {
		parts = append(parts, r.RepairInstruction)
	}
	if r.CapabilityGap.Required {
		gap := strings.TrimSpace(r.CapabilityGap.Need)
		if gap == "" {
			gap = strings.TrimSpace(r.CapabilityGap.Reason)
		}
		if gap != "" {
			parts = append(parts, "能力缺口："+gap)
		}
	}
	if len(parts) == 0 {
		return "语义审查未通过"
	}
	return strings.Join(parts, "; ")
}

func buildDynamicTransform(settings Settings, values any, description, reason string, attemptNo int) (TransformBuild, GenerationAttempt, error) {
	program, tr, err := GenerateDynamicTransformCapability(settings, values, description, reason)
	a := GenerationAttempt{Number: attemptNo, Via: "ai-dynamic", DurationMs: tr.DurationMs, RawResponse: tr.RawResponse, Output: program}
	if err != nil {
		a.Error = err.Error()
		a.Validation = ContractValidation{Passed: false, Errors: []string{err.Error()}}
		return TransformBuild{}, a, err
	}
	headers, _ := matrixToRows(values, "first-row")
	if err := validateDynamicProgram(program, "transform", headers); err != nil {
		a.Error = err.Error()
		a.Validation = ContractValidation{Passed: false, Errors: []string{err.Error()}}
		return TransformBuild{}, a, err
	}
	fields, scalar := inferDynamicTransformShape(program, headers)
	out := map[string]any{"type": "table", "fields": stringSliceAny(fields)}
	if scalar {
		out = map[string]any{"type": "number"}
	}
	spec := map[string]any{"version": 1, "headersMode": "first-row", "steps": []any{map[string]any{"op": "dynamic", "program": program}}, "output": out}
	cv := ValidateTransformContract(values, spec)
	a.Validation = cv
	gv := QuickValidateTransformGraph(values, spec)
	a.Graph = gv
	if !cv.Passed || !gv.Passed {
		reason := strings.Join(append(append([]string{}, cv.Errors...), gv.Errors...), "; ")
		a.Error = reason
		return TransformBuild{}, a, fmt.Errorf("动态能力快速校验失败：%s", reason)
	}
	result, err := ExecuteTransform(values, spec)
	if err != nil {
		a.Error = err.Error()
		return TransformBuild{}, a, err
	}
	cv = ValidateTransformExecution(result, cv)
	a.Validation = cv
	if !cv.Passed {
		a.Error = strings.Join(cv.Errors, "; ")
		return TransformBuild{}, a, fmt.Errorf("动态能力执行结构校验失败：%s", a.Error)
	}
	review, _, err := ReviewTransformSemantic(settings, values, description, spec, result, gv)
	a.Critic = review
	if err != nil {
		a.Error = "语义审查失败：" + err.Error()
		return TransformBuild{}, a, fmt.Errorf("%s", a.Error)
	}
	if !review.Passed {
		a.Error = reviewReason(review)
		return TransformBuild{}, a, fmt.Errorf("动态能力仍未满足用户语义：%s", a.Error)
	}
	return TransformBuild{Spec: spec, Result: result, Generation: "ai-dynamic", Validation: cv, Graph: gv, Critic: review, DynamicCapability: true, AITrace: tr}, a, nil
}

func buildDynamicBinding(settings Settings, v Variable, target map[string]any, description, reason string, attemptNo int) (BindingBuild, GenerationAttempt, error) {
	program, tr, err := GenerateDynamicRenderCapability(settings, v, target, description, reason)
	renderer := map[string]any{"kind": "dynamic", "program": program}
	a := GenerationAttempt{Number: attemptNo, Via: "ai-dynamic", DurationMs: tr.DurationMs, RawResponse: tr.RawResponse, Output: renderer}
	if err != nil {
		a.Error = err.Error()
		a.Validation = ContractValidation{Passed: false, Errors: []string{err.Error()}}
		return BindingBuild{}, a, err
	}
	cv := ValidateRendererContract(v, target, renderer)
	a.Validation = cv
	gv := QuickValidateRendererGraph(v, renderer)
	a.Graph = gv
	if !cv.Passed || !gv.Passed {
		reason := strings.Join(append(append([]string{}, cv.Errors...), gv.Errors...), "; ")
		a.Error = reason
		return BindingBuild{}, a, fmt.Errorf("动态展示能力快速校验失败：%s", reason)
	}
	plan, err := RenderPlan(v, renderer)
	if err != nil {
		a.Error = err.Error()
		return BindingBuild{}, a, err
	}
	review, _, err := ReviewBindingSemantic(settings, v, target, description, renderer, plan, gv)
	a.Critic = review
	if err != nil {
		a.Error = "语义审查失败：" + err.Error()
		return BindingBuild{}, a, fmt.Errorf("%s", a.Error)
	}
	if !review.Passed {
		a.Error = reviewReason(review)
		return BindingBuild{}, a, fmt.Errorf("动态展示能力仍未满足用户语义：%s", a.Error)
	}
	return BindingBuild{Renderer: renderer, Plan: plan, Generation: "ai-dynamic", Validation: cv, Graph: gv, Critic: review, DynamicCapability: true, AITrace: tr}, a, nil
}

func BuildTransform(settings Settings, values any, description string) (TransformBuild, error) {
	// AI disabled/unconfigured intentionally uses the deterministic fallback path.
	if !aiUsable(settings) {
		spec := GuessTransform(values, description)
		norm, err := NormalizeTransformSpec(spec)
		if err != nil {
			return TransformBuild{}, err
		}
		cv := ValidateTransformContract(values, norm)
		gv := QuickValidateTransformGraph(values, norm)
		attempt := GenerationAttempt{Number: 1, Via: "fallback", Output: norm, Validation: cv, Graph: gv, Critic: SemanticReview{Passed: true, Via: "skipped"}}
		if !cv.Passed || !gv.Passed {
			attempt.Error = strings.Join(append(append([]string{}, cv.Errors...), gv.Errors...), "; ")
			return TransformBuild{Spec: norm, Generation: "fallback", Attempts: []GenerationAttempt{attempt}, Validation: cv, Graph: gv}, fmt.Errorf("内置规则无法生成有效转换：%s", attempt.Error)
		}
		result, err := ExecuteTransform(values, norm)
		if err != nil {
			attempt.Error = err.Error()
			return TransformBuild{}, err
		}
		cv = ValidateTransformExecution(result, cv)
		attempt.Validation = cv
		if !cv.Passed {
			attempt.Error = strings.Join(cv.Errors, "; ")
			return TransformBuild{Spec: norm, Result: result, Generation: "fallback", Attempts: []GenerationAttempt{attempt}, Validation: cv, Graph: gv}, fmt.Errorf("转换执行校验失败：%s", attempt.Error)
		}
		return TransformBuild{Spec: norm, Result: result, Generation: "fallback", Attempts: []GenerationAttempt{attempt}, Validation: cv, Graph: gv, Critic: attempt.Critic}, nil
	}

	original, _ := json.MarshalIndent(map[string]any{"description": description, "sample": sampleForAI(values, 12), "capabilities": RuntimeCapabilities()}, "", "  ")
	user := string(original)
	attempts := []GenerationAttempt{}
	var lastTrace AITrace
	var lastReason string
	var lastOut map[string]any
	var lastRaw string
	dynamicTried := false
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
			lastReason = a.Error
		} else {
			norm, err := NormalizeTransformSpec(out)
			if err != nil {
				a.Error = err.Error()
				a.Validation = ContractValidation{Passed: false, Errors: []string{err.Error()}}
				attempts = append(attempts, a)
				lastReason = a.Error
			} else {
				a.Output = norm
				lastOut = norm
				cv := ValidateTransformContract(values, norm)
				a.Validation = cv
				gv := QuickValidateTransformGraph(values, norm)
				a.Graph = gv
				if !cv.Passed || !gv.Passed {
					a.Error = strings.Join(append(append([]string{}, cv.Errors...), gv.Errors...), "; ")
					attempts = append(attempts, a)
					lastReason = a.Error
				} else {
					result, err := ExecuteTransform(values, norm)
					if err != nil {
						a.Error = err.Error()
						a.Validation.Passed = false
						a.Validation.Errors = append(a.Validation.Errors, err.Error())
						attempts = append(attempts, a)
						lastReason = a.Error
					} else {
						cv = ValidateTransformExecution(result, cv)
						a.Validation = cv
						if !cv.Passed {
							a.Error = strings.Join(cv.Errors, "; ")
							attempts = append(attempts, a)
							lastReason = a.Error
						} else {
							review, _, rerr := ReviewTransformSemantic(settings, values, description, norm, result, gv)
							a.Critic = review
							if rerr != nil {
								a.Error = "语义审查失败：" + rerr.Error()
								attempts = append(attempts, a)
								lastReason = a.Error
							} else if review.Passed {
								attempts = append(attempts, a)
								return TransformBuild{Spec: norm, Result: result, Generation: "ai", Attempts: attempts, Validation: cv, Graph: gv, Critic: review, AITrace: tr}, nil
							} else {
								a.Error = reviewReason(review)
								attempts = append(attempts, a)
								lastReason = a.Error
								if settings.Agent.DynamicCapabilitiesEnabled && review.CapabilityGap.Required && !dynamicTried {
									dynamicTried = true
									db, da, derr := buildDynamicTransform(settings, values, description, lastReason, len(attempts)+1)
									attempts = append(attempts, da)
									if derr == nil {
										db.Attempts = attempts
										return db, nil
									}
									lastReason = derr.Error()
								}
							}
						}
					}
				}
			}
		}
		if i < maxGenerationAttempts {
			user = transformRepairUser(values, description, lastOut, lastRaw, lastReason)
		}
	}
	if settings.Agent.DynamicCapabilitiesEnabled && !dynamicTried {
		db, da, derr := buildDynamicTransform(settings, values, description, lastReason, len(attempts)+1)
		attempts = append(attempts, da)
		if derr == nil {
			db.Attempts = attempts
			return db, nil
		}
		lastReason = derr.Error()
	}
	return TransformBuild{Spec: lastOut, Generation: "ai", Attempts: attempts, Validation: ContractValidation{Passed: false, Errors: []string{lastReason}}, AITrace: lastTrace}, fmt.Errorf("AI 未生成可执行且满足语义的转换方案：%s", lastReason)
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
	if !aiUsable(settings) {
		renderer := ApplyBindingDescriptionHints(fallback(), description)
		norm, err := NormalizeRendererSpec(renderer)
		if err != nil {
			return BindingBuild{}, err
		}
		cv := ValidateRendererContract(v, target, norm)
		gv := QuickValidateRendererGraph(v, norm)
		a := GenerationAttempt{Number: 1, Via: "fallback", Output: norm, Validation: cv, Graph: gv, Critic: SemanticReview{Passed: true, Via: "skipped"}}
		if !cv.Passed || !gv.Passed {
			a.Error = strings.Join(append(append([]string{}, cv.Errors...), gv.Errors...), "; ")
			return BindingBuild{Renderer: norm, Generation: "fallback", Attempts: []GenerationAttempt{a}, Validation: cv, Graph: gv}, fmt.Errorf("内置绑定规则不适用于当前目标：%s", a.Error)
		}
		plan, err := RenderPlan(v, norm)
		if err != nil {
			return BindingBuild{}, err
		}
		return BindingBuild{Renderer: norm, Plan: plan, Generation: "fallback", Attempts: []GenerationAttempt{a}, Validation: cv, Graph: gv, Critic: a.Critic}, nil
	}
	firstPayload, _ := json.MarshalIndent(map[string]any{"description": description, "target": target, "variable": map[string]any{"name": v.Name, "displayName": v.DisplayName, "valueType": v.ValueType, "columns": v.Columns, "sample": sampleForAI(v.Value, 8)}, "capabilities": RuntimeCapabilities()}, "", "  ")
	user := string(firstPayload)
	attempts := []GenerationAttempt{}
	var lastTrace AITrace
	var lastReason string
	var lastOut map[string]any
	var lastRaw string
	dynamicTried := false
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
			lastReason = a.Error
		} else {
			norm, err := NormalizeRendererSpec(out)
			if err != nil {
				a.Error = err.Error()
				a.Validation = ContractValidation{Passed: false, Errors: []string{err.Error()}}
				attempts = append(attempts, a)
				lastReason = a.Error
			} else {
				a.Output = norm
				lastOut = norm
				cv := ValidateRendererContract(v, target, norm)
				a.Validation = cv
				gv := QuickValidateRendererGraph(v, norm)
				a.Graph = gv
				if !cv.Passed || !gv.Passed {
					a.Error = strings.Join(append(append([]string{}, cv.Errors...), gv.Errors...), "; ")
					attempts = append(attempts, a)
					lastReason = a.Error
				} else {
					plan, err := RenderPlan(v, norm)
					if err != nil {
						a.Error = err.Error()
						attempts = append(attempts, a)
						lastReason = a.Error
					} else {
						review, _, rerr := ReviewBindingSemantic(settings, v, target, description, norm, plan, gv)
						a.Critic = review
						if rerr != nil {
							a.Error = "语义审查失败：" + rerr.Error()
							attempts = append(attempts, a)
							lastReason = a.Error
						} else if review.Passed {
							attempts = append(attempts, a)
							return BindingBuild{Renderer: norm, Plan: plan, Generation: "ai", Attempts: attempts, Validation: cv, Graph: gv, Critic: review, AITrace: tr}, nil
						} else {
							a.Error = reviewReason(review)
							attempts = append(attempts, a)
							lastReason = a.Error
							if settings.Agent.DynamicCapabilitiesEnabled && review.CapabilityGap.Required && !dynamicTried {
								dynamicTried = true
								db, da, derr := buildDynamicBinding(settings, v, target, description, lastReason, len(attempts)+1)
								attempts = append(attempts, da)
								if derr == nil {
									db.Attempts = attempts
									return db, nil
								}
								lastReason = derr.Error()
							}
						}
					}
				}
			}
		}
		if i < maxGenerationAttempts {
			user = bindingRepairUser(v, target, description, lastOut, lastRaw, lastReason)
		}
	}
	if settings.Agent.DynamicCapabilitiesEnabled && !dynamicTried {
		db, da, derr := buildDynamicBinding(settings, v, target, description, lastReason, len(attempts)+1)
		attempts = append(attempts, da)
		if derr == nil {
			db.Attempts = attempts
			return db, nil
		}
		lastReason = derr.Error()
	}
	return BindingBuild{Renderer: lastOut, Generation: "ai", Attempts: attempts, Validation: ContractValidation{Passed: false, Errors: []string{lastReason}}, AITrace: lastTrace}, fmt.Errorf("AI 未生成可执行且满足语义的绑定方案：%s", lastReason)
}
