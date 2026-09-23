import type { State } from "../../../shared/contracts/index.js";
import { fingerprint } from "../project/store.js";
import type { Store } from "../project/store.js";

export interface ProjectEvent {
  id: string;
  projectId: string;
  type: string;
  entityId?: string;
  status?: string;
  revision?: number;
  conversationId?: string;
  role?: string;
  displayName?: string;
  createdAt: string;
}

export class ProjectEventBus {
  private listeners = new Map<string, Set<(event: ProjectEvent) => void>>();
  private sequence = 0;
  subscribe(projectId: string, listener: (event: ProjectEvent) => void) {
    const group = this.listeners.get(projectId) || new Set();
    group.add(listener);
    this.listeners.set(projectId, group);
    return () => {
      group.delete(listener);
      if (!group.size) this.listeners.delete(projectId);
    };
  }
  publish(event: Omit<ProjectEvent, "id" | "createdAt">) {
    const value = { ...event, id: String(++this.sequence), createdAt: new Date().toISOString() };
    for (const listener of this.listeners.get(event.projectId) || []) {
      try { listener(value); } catch { /* subscribers cannot affect writers */ }
    }
  }
}

function changed(before: any, after: any) {
  return fingerprint(before) !== fingerprint(after);
}

export function attachStoreEventPublishing(store: Store, bus: ProjectEventBus) {
  return store.subscribe((before: State, after: State) => {
    const priorProjects = new Map(before.projects.map((item) => [item.id, item]));
    for (const current of after.projects) {
      const prior: any = priorProjects.get(current.id);
      if (!prior || changed(prior, current)) bus.publish({ projectId: current.id, type: "project.updated", entityId: current.id, revision: current.revision });
      const collections: Array<[string, any[], any[], (item: any, old?: any) => string]> = [
        ["variable", prior?.variables || [], current.variables, (item) => item.status === "needs-ai-repair" ? "variable.error" : "variable.updated"],
        ["source", prior?.sources || [], current.sources, () => "source.updated"],
        ["binding", prior?.bindings || [], current.bindings, () => "binding.updated"],
      ];
      for (const [prefix, oldItems, newItems, eventType] of collections) {
        const oldById = new Map(oldItems.map((item: any) => [item.id, item]));
        for (const item of newItems) if (!oldById.has(item.id) || changed(oldById.get(item.id), item)) {
          bus.publish({ projectId: current.id, type: !oldById.has(item.id) ? `${prefix}.created` : eventType(item), entityId: item.id, revision: item.revision });
        }
      }
      if (prior) {
        const priorVariables = new Map(prior.variables.map((item: any) => [item.id, item]));
        for (const binding of current.bindings) {
          const variable: any = current.variables.find((item) => item.id === binding.variableId);
          const oldBinding: any = prior.bindings.find((item: any) => item.id === binding.id);
          const oldVariable: any = priorVariables.get(binding.variableId);
          const wasFresh = !!oldBinding && !!oldVariable && oldBinding.lastRenderedVariableRevision === oldVariable.revision;
          const isStale = !!variable && binding.lastRenderedVariableRevision !== variable.revision;
          if (isStale && (!oldBinding || wasFresh || changed(oldBinding, binding) || oldVariable?.revision !== variable.revision))
            bus.publish({ projectId: current.id, type: "binding.stale", entityId: binding.id, revision: binding.revision });
        }
      }
    }
    const oldTasks = new Map(before.tasks.map((item) => [item.id, item]));
    for (const task of after.tasks) if (!oldTasks.has(task.id) || changed(oldTasks.get(task.id), task)) {
      const type = !oldTasks.has(task.id) ? "task.created" : task.status === "completed" ? "task.completed" : task.status === "failed" ? "task.failed" : "task.updated";
      bus.publish({ projectId: task.projectId, type, entityId: task.id, status: task.status });
    }
    const oldMessages = new Set(before.chatMessages.map((item) => item.id));
    const conversations = new Map(after.conversations.map((item) => [item.id, item.projectId]));
    for (const message of after.chatMessages) if (!oldMessages.has(message.id)) {
      const projectId = conversations.get(message.conversationId);
      if (projectId) bus.publish({ projectId, type: "conversation.message.created", entityId: message.id, conversationId: message.conversationId, role: message.role });
    }
    const oldRenders = before.renderIndex || {}, newRenders = after.renderIndex || {};
    for (const [renderId, value] of Object.entries(newRenders) as Array<[string, any]>) {
      const prior: any = oldRenders[renderId];
      if (!prior || changed(prior, value)) {
        const statusTypes: Record<string, string> = { prepared: "render.prepared", applied: "render.applied", verifying: "render.verifying", verified: "render.verified", verify_failed: "render.failed", recovered: "render.recovered", failed: "render.failed" };
        const type = prior && prior.status === value.status ? "timeline.updated" : statusTypes[value.status] || "render.updated";
        bus.publish({ projectId: value.projectId, type, entityId: renderId, status: value.status });
      }
    }
  });
}
