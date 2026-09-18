package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

type CapabilityGap struct {
	Required bool   `json:"required"`
	Stage    string `json:"stage,omitempty"`
	Need     string `json:"need,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

type SemanticReview struct {
	Passed            bool          `json:"passed"`
	Issues            []string      `json:"issues,omitempty"`
	RepairInstruction string        `json:"repairInstruction,omitempty"`
	CapabilityGap     CapabilityGap `json:"capabilityGap"`
	Via               string        `json:"via,omitempty"`
}

const criticSystem = `你是“结果审查器”，不是生成器。你的任务是比较用户的自然语言要求与已经实际执行出来的结果，判断结果是否完整满足用户意图。
不要因为 JSON 合法、字段存在、程序执行成功就判定通过；这些已经由确定性校验器负责。
你只负责语义一致性，例如：是否漏掉用户明确要求、是否选错业务字段、排序方向是否错误、展示结构是否违背用户要求、已有目标模板中需要保留的结构是否被破坏。
不要把用户语义固化为固定规则；逐条阅读当前用户要求并与实际结果比较。
如果当前内置能力无法表达用户要求，capabilityGap.required=true，并说明缺少的是怎样的“行为能力”，不要编造一个不存在的能力名。
只输出 JSON：
{"passed":true|false,"issues":["..."],"repairInstruction":"...","capabilityGap":{"required":true|false,"stage":"transform|render","need":"...","reason":"..."}}
如果完全满足要求，issues 为空、repairInstruction 为空、capabilityGap.required=false。`

const dynamicTransformSystem = `你正在为数据报告助手编写一个“临时沙箱数据能力”。只输出 JSON，不输出解释。
这不是固定业务 DSL，而是一个通用、无文件/网络/进程/WPS 权限的表达式程序。它只处理显式传入的表格行。
输出必须是：
{"language":"ra-cap-v1","stage":"transform","steps":[...]}
允许 steps：
1) filter: {"op":"filter","expr":EXPR}
2) map: {"op":"map","keepExisting":true|false,"columns":[{"name":"新列","expr":EXPR}]}
3) sort: {"op":"sort","expr":EXPR,"direction":"asc|desc"}
4) limit: {"op":"limit","count":N}
5) reduce: {"op":"reduce","fn":"sum|avg|min|max|count","expr":EXPR?}
EXPR 可以是常量，或 {"field":"字段"}，或 {"var":"index|rowNumber|rowCount"}，或 {"op":"add|sub|mul|div|mod|round|concat|eq|neq|gt|gte|lt|lte|and|or|not|if|contains","args":[EXPR,...],"digits"?:N,"separator"?:""}。
程序必须直接完成用户要求，并且只能引用输入字段。优先短小。`

const dynamicRenderSystem = `你正在为数据报告助手编写一个“临时沙箱展示能力”。只输出 JSON，不输出解释。
程序没有文件/网络/进程/COM/WPS 权限；它只能把变量计算成一个 text 或 table RenderPlan，随后由受控 WPS 执行器写入目标对象。
输出必须是以下之一：
表格：{"language":"ra-cap-v1","stage":"render","kind":"table","includeHeader":true,"resizeRows":true,"maxRows"?:N,"columns":[{"label":"列名","expr":EXPR,"format"?:{"numberFormat":"0|0.0|0.00|percent0|percent1","divideBy"?:number,"scale"?:number}}]}
文本：{"language":"ra-cap-v1","stage":"render","kind":"text","expr":EXPR,"prefix"?:"","suffix"?:""}
EXPR 可以是常量，或 {"field":"字段"}，或 {"var":"index|rowNumber|rowCount"}，或 {"op":"add|sub|mul|div|mod|round|concat|eq|neq|gt|gte|lt|lte|and|or|not|if|contains","args":[EXPR,...],"digits"?:N,"separator"?:""}。
例如“从10开始的序号”可由 index 与常量 10 相加表达；这只是语言示例，不代表必须生成序号。
必须根据当前用户要求与目标模板生成程序，不要擅自增加列。`

func aiUsable(settings Settings) bool {
	return settings.AI.Enabled && strings.TrimSpace(settings.AI.APIKey) != "" && strings.TrimSpace(settings.AI.BaseURL) != "" && strings.TrimSpace(settings.AI.Model) != ""
}

func parseReview(out map[string]any) SemanticReview {
	r := SemanticReview{Via: "ai"}
	if b, ok := out["passed"].(bool); ok {
		r.Passed = b
	}
	if xs, ok := out["issues"].([]any); ok {
		for _, x := range xs {
			if s := strings.TrimSpace(fmt.Sprint(x)); s != "" {
				r.Issues = append(r.Issues, s)
			}
		}
	}
	r.RepairInstruction, _ = out["repairInstruction"].(string)
	if g, ok := out["capabilityGap"].(map[string]any); ok {
		r.CapabilityGap.Required, _ = g["required"].(bool)
		r.CapabilityGap.Stage, _ = g["stage"].(string)
		r.CapabilityGap.Need, _ = g["need"].(string)
		r.CapabilityGap.Reason, _ = g["reason"].(string)
	}
	if !r.Passed && len(r.Issues) == 0 && strings.TrimSpace(r.RepairInstruction) == "" {
		r.Issues = []string{"语义审查未通过，但模型没有给出具体原因"}
	}
	return r
}

func ReviewTransformSemantic(settings Settings, values any, description string, spec map[string]any, result TransformResult, graph GraphValidation) (SemanticReview, AITrace, error) {
	if !settings.Agent.CriticEnabled || !aiUsable(settings) {
		return SemanticReview{Passed: true, Via: "skipped"}, AITrace{}, nil
	}
	headers, _ := matrixToRows(values, "first-row")
	payload := map[string]any{
		"stage": "transform", "userRequest": description, "inputFields": headers, "inputSample": sampleForAI(values, 8),
		"executionGraph": graph.Graph, "transform": spec,
		"actualResult":          map[string]any{"valueType": result.ValueType, "columns": result.Columns, "sample": sampleForAI(result.Value, 8)},
		"availableCapabilities": RuntimeCapabilities(),
	}
	b, _ := json.MarshalIndent(payload, "", "  ")
	out, tr, err := chatJSON(settings, criticSystem, string(b))
	if err != nil {
		return SemanticReview{}, tr, err
	}
	return parseReview(out), tr, nil
}

func ReviewBindingSemantic(settings Settings, v Variable, target map[string]any, description string, renderer map[string]any, plan map[string]any, graph GraphValidation) (SemanticReview, AITrace, error) {
	if !settings.Agent.CriticEnabled || !aiUsable(settings) {
		return SemanticReview{Passed: true, Via: "skipped"}, AITrace{}, nil
	}
	payload := map[string]any{
		"stage": "render", "userRequest": description, "target": target,
		"variable":       map[string]any{"valueType": v.ValueType, "columns": v.Columns, "sample": sampleForAI(v.Value, 8)},
		"executionGraph": graph.Graph, "renderer": renderer, "actualRenderPlan": plan,
		"availableCapabilities": RuntimeCapabilities(),
	}
	b, _ := json.MarshalIndent(payload, "", "  ")
	out, tr, err := chatJSON(settings, criticSystem, string(b))
	if err != nil {
		return SemanticReview{}, tr, err
	}
	return parseReview(out), tr, nil
}

func GenerateDynamicTransformCapability(settings Settings, values any, description, reason string) (map[string]any, AITrace, error) {
	headers, _ := matrixToRows(values, "first-row")
	payload := map[string]any{"userRequest": description, "capabilityGap": reason, "inputFields": headers, "sample": sampleForAI(values, 10)}
	b, _ := json.MarshalIndent(payload, "", "  ")
	return chatJSON(settings, dynamicTransformSystem, string(b))
}

func GenerateDynamicRenderCapability(settings Settings, v Variable, target map[string]any, description, reason string) (map[string]any, AITrace, error) {
	payload := map[string]any{"userRequest": description, "capabilityGap": reason, "target": target, "variable": map[string]any{"valueType": v.ValueType, "columns": v.Columns, "sample": sampleForAI(v.Value, 8)}}
	b, _ := json.MarshalIndent(payload, "", "  ")
	return chatJSON(settings, dynamicRenderSystem, string(b))
}
