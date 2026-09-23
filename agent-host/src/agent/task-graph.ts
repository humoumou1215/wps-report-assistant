import type { TaskDraft, TaskOperation } from "../../../shared/contracts/index.js";

export function runnableOperations(task: TaskDraft): TaskOperation[] {
  return task.operations.filter((operation) => {
    if (operation.status !== "pending") return false;
    return (operation.dependsOn || []).every((dependency) =>
      task.operations.some((candidate) => candidate.id === dependency && candidate.status === "validated"),
    );
  });
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
