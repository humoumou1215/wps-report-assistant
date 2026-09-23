import type { TaskDraft, TaskOperation } from "../../../shared/contracts/index.js";

export function runnableOperations(task: TaskDraft): TaskOperation[] {
  return task.operations.filter((operation) => {
    if (operation.status !== "pending") return false;
    return (operation.dependsOn || []).every((dependency) =>
      task.operations.some((candidate) => candidate.id === dependency && dependencySatisfied(candidate)),
    );
  });
}

function dependencySatisfied(operation: TaskOperation) {
  return operation.status === "validated" || operation.status === "applied";
}

export function validateTaskCompletion(
  task: TaskDraft,
  records?: Map<string, { status: string; recoveryRequired?: boolean }>,
): { valid: boolean; errors: string[] } {
  const errors = validateTaskGraph(task).errors;
  for (const operation of task.operations) {
    if (["pending", "running", "failed"].includes(operation.status))
      errors.push(`操作尚未完成：${operation.id} (${operation.status})`);
    if (!(operation.dependsOn || []).every((dependency) => {
      const prerequisite = task.operations.find((candidate) => candidate.id === dependency);
      return !!prerequisite && dependencySatisfied(prerequisite);
    })) errors.push(`操作依赖尚未满足：${operation.id}`);
    if (operation.type === "render") {
      if (operation.status === "applied") {
        const record = operation.renderRecordId ? records?.get(operation.renderRecordId) : undefined;
        if (!operation.renderRecordId || (records && (record?.status !== "verified" || record.recoveryRequired)))
          errors.push(`Render 尚未验证：${operation.id}`);
      }
      if (operation.status === "recovered") {
        const record = operation.recoveryRenderId ? records?.get(operation.recoveryRenderId) : undefined;
        if (!operation.recoveryRenderId || (records && (record?.status !== "verified" || record.recoveryRequired)))
          errors.push(`Recovery 尚未验证：${operation.id}`);
        const key = stableTarget(operation);
        const retried = task.operations.some((candidate) => candidate.type === "render" && candidate.id !== operation.id && candidate.documentId === operation.documentId && stableTarget(candidate) === key && candidate.status === "applied");
        if (!retried) errors.push(`Render 已安全恢复，但用户目标尚未重试完成：${operation.id}`);
      }
      if (operation.status === "superseded") {
        const replacement: any = task.operations.find((candidate) => candidate.id === operation.supersededByOperationId);
        if (!replacement || replacement.status !== "applied" || replacement.correctsOperationId !== operation.id)
          errors.push(`修正 Render 尚未验证：${operation.id}`);
      }
    }
    if (operation.status === "recovered" && !operation.recoveredByRenderId)
      errors.push(`Recovery 关系缺失：${operation.id}`);
    if (operation.status === "superseded" && !operation.supersededByOperationId)
      errors.push(`修正关系缺失：${operation.id}`);
  }
  return { valid: errors.length === 0, errors };
}
function stableTarget(operation: any) {
  const sort = (value: any): any => Array.isArray(value) ? value.map(sort) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value;
  return JSON.stringify(sort(operation.target || {}));
}
export function validateTaskGraph(task: TaskDraft): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const operation of task.operations) {
    if (ids.has(operation.id)) errors.push(`重复操作 ID：${operation.id}`);
    ids.add(operation.id);
    for (const dependency of operation.dependsOn || []) {
      if (!task.operations.some((candidate) => candidate.id === dependency))
        errors.push(`依赖操作不存在：${dependency}`);
      if (dependency === operation.id) errors.push(`操作不能依赖自身：${operation.id}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string) => {
    if (visiting.has(id)) {
      errors.push(`任务依赖存在循环：${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const operation = task.operations.find((item) => item.id === id);
    for (const dependency of operation?.dependsOn || []) walk(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const operation of task.operations) walk(operation.id);
  return { valid: errors.length === 0, errors };
}
