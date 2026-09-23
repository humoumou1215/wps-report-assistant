import type { Binding, Variable, VariableInput, VariableExplanation } from "../../../shared/contracts/index.js";
import { AppError, fail } from "../../../shared/contracts/index.js";
import type { Project } from "../../../shared/contracts/index.js";

export function resolveVariableInputs(variable: Variable): VariableInput[] {
  return variable.inputs;
}

export function explanationStatus(variable: Variable): "missing" | "stale" | "current" {
  if (!variable.explanation) return "missing";
  return variable.explanation.revision === variable.revision ? "current" : "stale";
}

export function bindingFreshness(binding: Binding, variable: Variable): "fresh" | "stale" {
  return binding.lastRenderedVariableRevision === variable.revision ? "fresh" : "stale";
}

export function lineage(project: Project, variableId: string): Record<string, any> {
  const variable = project.variables.find((item) => item.id === variableId)!;
  if (!variable) fail("NOT_FOUND", "变量不存在", 404);
  const inputs = resolveVariableInputs(variable);
  const sources = inputs
    .filter((input) => input.type === "source" && input.sourceId)
    .map((input) => project.sources.find((source) => source.id === input.sourceId))
    .filter(Boolean);
  const variables = inputs
    .filter((input) => input.type === "variable" && input.variableId)
    .map((input) => project.variables.find((item) => item.id === input.variableId))
    .filter(Boolean);
  const usages = project.bindings
    .filter((binding) => binding.variableId === variable.id)
    .map((binding) => ({
      binding,
      document: project.documents.find((document) => document.id === binding.documentId),
      freshness: bindingFreshness(binding, variable),
    }));
  return {
    variable,
    inputs,
    sources,
    variables,
    usages,
    explanationStatus: explanationStatus(variable),
  };
}

export function assertVariableInputs(project: Project, inputs: VariableInput[]) {
  if (!Array.isArray(inputs) || inputs.length === 0) fail("INVALID_INPUT", "变量至少需要一个输入", 400);
  for (const input of inputs) {
    if (input.type === "source" && input.sourceId) {
      if (!project.sources.some((source) => source.id === input.sourceId))
        fail("NOT_FOUND", "变量引用的源不存在", 404);
    } else if (input.type === "variable" && input.variableId) {
      if (!project.variables.some((variable) => variable.id === input.variableId))
        fail("NOT_FOUND", "变量引用的变量不存在", 404);
    } else {
      fail("INVALID_INPUT", "变量输入引用无效", 400);
    }
  }
}

export function makeExplanation(
  variable: Variable,
  input: Partial<VariableExplanation> = {},
): VariableExplanation {
  return {
    revision: variable.revision,
    purpose: input.purpose || variable.description || variable.name || "",
    calculationSummary: input.calculationSummary || [],
    assumptions: input.assumptions || [],
    confirmedRules: input.confirmedRules || [],
    units: input.units,
    generatedAt: input.generatedAt || new Date().toISOString(),
    generatedBy: input.generatedBy,
  };
}
