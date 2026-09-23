import { SessionRegistry } from "../agent/session-registry.js";
import type { ChatMessage, ChatReference, Conversation, RecordData, TaskDraft } from "../../../shared/contracts/index.js";
import { AppError, fail } from "../../../shared/contracts/index.js";
import { Store, entity, id, now, project } from "./store.js";
import { validateTaskGraph } from "../agent/task-graph.js";
import { COMPACTION_INSTRUCTIONS, type AgentRuntime } from "../agent/pi-runtime.js";

export function assertReferenceBelongsToProject(state: any, projectId: string, reference: any) {
  const p = project(state, projectId);
  switch (reference?.type) {
    case "variable":
      entity(p.variables, reference.variableId);
      return;
    case "document":
    case "selection":
      entity(p.documents, reference.documentId);
      if (reference.sourceId) entity(p.sources, reference.sourceId);
      if (reference.target?.documentId && reference.target.documentId !== reference.documentId)
        fail("INVALID_REFERENCE", "选区目标与引用文件不一致", 403);
      return;
    case "render-record":
      if (!Object.values(state.renderIndex || {}).some((record: any) => record.projectId === projectId && record.id === reference.renderId))
        fail("NOT_FOUND", "Render 记录不属于当前项目", 404);
      return;
    default:
      fail("INVALID_REFERENCE", "引用类型无效或未冻结", 400);
  }
}

export function resolveReferences(state: any, projectId: string, raw: any[]): ChatReference[] {
  if (!Array.isArray(raw)) return [];
  const currentProject = project(state, projectId);
  return raw.map((reference) => {
    if (reference?.type === "ephemeral-selection") {
      if (!reference.documentId || !reference.fingerprint) fail("SELECTION_NOT_FROZEN", "当前选区必须在发送前冻结", 409);
      return {
        type: "selection",
        documentId: reference.documentId,
        sheet: reference.sheet,
        address: reference.address,
        fingerprint: reference.fingerprint,
        capturedAt: reference.capturedAt || now(),
        displayName: reference.displayName || "当前选区",
      } as ChatReference;
    }
    assertReferenceBelongsToProject(state, projectId, reference);
    if (reference.type === "variable") {
      const variable = entity(currentProject.variables, reference.variableId);
      return { type: "variable", variableId: variable.id, revisionAtSend: variable.revision, displayName: variable.displayName || variable.name || reference.displayName };
    }
    if (reference.type === "document") {
      const document = entity(currentProject.documents, reference.documentId);
      return { type: "document", documentId: document.id, revisionAtSend: document.revision, displayName: document.name || reference.displayName };
    }
    if (reference.type === "selection") return {
      type: "selection", documentId: reference.documentId,
      sheet: reference.sheet, address: reference.address,
      fingerprint: reference.fingerprint, capturedAt: reference.capturedAt,
      displayName: reference.displayName, sourceId: reference.sourceId,
      target: reference.target ? structuredClone(reference.target) : undefined,
    };
    const render: any = state.renderIndex[reference.renderId];
    return { type: "render-record", renderId: reference.renderId, displayName: render?.displayName || reference.displayName || reference.renderId };
  });
}

export class ConversationService {
  private sessions: SessionRegistry;
  constructor(private store: Store, private runtime?: AgentRuntime) {
    this.sessions = new SessionRegistry(store.dir);
  }
  list(projectId: string) {
    return this.store.snapshot().conversations.filter((item) => item.projectId === projectId && item.status === "active").reverse();
  }
  get(projectId: string, conversationId: string) {
    const state = this.store.snapshot();
    const conversation = entity(state.conversations, conversationId) as Conversation;
    if (conversation.projectId !== projectId) fail("NOT_FOUND", "会话不存在", 404);
    const p = project(state, projectId);
    return {
      conversation,
      messages: state.chatMessages.filter((message) => message.conversationId === conversationId).map((message) => ({
        ...message,
        references: message.references.map((reference: any) => {
          if (reference.type === "variable") {
            const variable = p.variables.find((item) => item.id === reference.variableId);
            return { ...reference, currentRevision: variable?.revision, freshness: variable && variable.revision === reference.revisionAtSend ? "fresh" : "stale" };
          }
          if (reference.type === "document") {
            const document = p.documents.find((item) => item.id === reference.documentId);
            return { ...reference, currentRevision: document?.revision, freshness: document && (reference.revisionAtSend === undefined || document.revision === reference.revisionAtSend) ? "fresh" : "stale" };
          }
          if (reference.type === "render-record") {
            const render: any = state.renderIndex[reference.renderId];
            return { ...reference, status: render?.status, displayName: render?.displayName || reference.displayName };
          }
          return reference;
        }),
      })),
      tasks: state.tasks.filter((task) => task.conversationId === conversationId),
    };
  }
  async create(projectId: string, title = "新会话") {
    const conversation = await this.store.transaction((state) => {
      project(state, projectId);
      const item: Conversation = {
        id: id(),
        projectId,
        sessionId: id(),
        title: title.trim() || "新会话",
        createdAt: now(),
        updatedAt: now(),
        status: "active",
      };
      state.conversations.push(item);
      return item;
    });
    await this.sessions.resume(conversation.sessionId);
    return conversation;
  }
  async update(projectId: string, conversationId: string, input: RecordData) {
    return this.store.transaction((state) => {
      const conversation = entity(state.conversations, conversationId) as Conversation;
      if (conversation.projectId !== projectId) fail("NOT_FOUND", "会话不存在", 404);
      if (typeof input.title === "string" && input.title.trim()) conversation.title = input.title.trim();
      if (input.archived === true) {
        conversation.status = "archived";
        conversation.archivedAt = now();
      } else if (input.archived === false) {
        conversation.status = "active";
        delete conversation.archivedAt;
      }
      conversation.updatedAt = now();
      return conversation;
    });
  }
  async send(projectId: string, conversationId: string, input: RecordData) {
    const result = await this.store.transaction((state) => {
      const conversation = entity(state.conversations, conversationId) as Conversation;
      if (conversation.projectId !== projectId) fail("NOT_FOUND", "会话不存在", 404);
      if (!String(input.text || "").trim()) fail("INVALID_INPUT", "消息不能为空", 400);
      const rawReferences = Array.isArray(input.references) ? input.references : [];
      const normalizedReferences = rawReferences.map((reference: any) => {
        if (reference?.type !== "ephemeral-selection") return reference;
        const p = project(state, projectId);
        const document = entity(p.documents, reference.documentId);
        const target = structuredClone(reference.target);
        if (!reference.fingerprint || !Array.isArray(reference.values) || !reference.values.length || !Array.isArray(reference.values[0]))
          fail("SELECTION_NOT_FROZEN", "当前选区必须包含冻结指纹和数据", 409);
        if (!target || target.documentId !== document.id || !target.capabilityId || !target.locator)
          fail("SELECTION_TARGET_INVALID", "选区目标定位信息不完整", 400);
        const sourceId = id();
        p.sources.push({
          id: sourceId,
          revision: 1,
          documentId: document.id,
          values: structuredClone(reference.values),
          capabilityId: target.capabilityId,
          locator: target.locator,
          label: target.label || reference.displayName,
          sheetName: target.locator.sheetName,
          requestedAddress: target.locator.address,
          effectiveAddress: target.locator.address,
          fingerprint: reference.fingerprint,
          capturedAt: reference.capturedAt || now(),
        } as any);
        p.revision++;
        document.revision = (document.revision || 1) + 1;
        return { ...reference, type: "selection", target, sourceId };
      });
      const references = resolveReferences(state, projectId, normalizedReferences);
      const userTurnId = id();
      const message: ChatMessage = {
        id: userTurnId,
        conversationId,
        role: "user",
        text: String(input.text).trim(),
        references,
        richBlocks: input.richBlocks,
        createdAt: now(),
      };
      state.chatMessages.push(message);
      const task: TaskDraft = {
        id: id(),
        projectId,
        conversationId,
        userTurnId,
        status: "planning",
        references,
        operations: [],
        createdAt: now(),
        updatedAt: now(),
      };
      const graph = validateTaskGraph(task);
      if (!graph.valid) fail("INVALID_TASK_GRAPH", graph.errors.join("；"), 400);
      state.tasks.push(task);
      conversation.updatedAt = now();
      return { message, task, conversation };
    });
    const session = await this.sessions.resume(result.conversation.sessionId);
    session.appendCustomEntry("report-assistant-user-turn", {
      userTurnId: result.message.id,
      taskId: result.task.id,
      text: result.message.text,
      references: result.message.references,
    });
    return result;
  }
  async compact(projectId: string, conversationId: string) {
    const state = this.store.snapshot();
    const conversation = entity(state.conversations, conversationId) as Conversation;
    if (conversation.projectId !== projectId) fail("NOT_FOUND", "会话不存在", 404);
    const runtime = this.runtime;
    if (!runtime || typeof runtime.compact !== "function")
      throw new AppError("COMPACTION_UNAVAILABLE", "当前 Pi Runtime 不支持压缩", 422);
    if (state.tasks.some((task) => task.conversationId === conversationId && ["planning", "running", "validating", "rendering", "verifying"].includes(task.status)))
      fail("CONVERSATION_BUSY", "该会话仍有任务运行，暂时不能压缩", 409);
    const compacted = await runtime.compact(conversation.sessionId, COMPACTION_INSTRUCTIONS);
    const updated = compacted ? await this.store.transaction((currentState) => {
      const current = entity(currentState.conversations, conversationId) as Conversation;
      current.lastCompactedAt = now();
      current.updatedAt = now();
      return current;
    }) : conversation;
    return { conversation: updated, compacted };
  }
  searchReferences(projectId: string, query = "") {
    const state = this.store.snapshot();
    const p = project(state, projectId);
    const q = query.trim().toLocaleLowerCase();
    const rank = (name: string, id = "") => {
      const label = name.toLocaleLowerCase();
      if (!q) return 0;
      if (label === q) return 0;
      if (label.startsWith(q)) return 1;
      if (label.includes(q)) return 2;
      if (id.toLocaleLowerCase() === q) return 3;
      if (id.toLocaleLowerCase().startsWith(q)) return 4;
      return Infinity;
    };
    const sort = <T extends { displayName: string; id?: string; variableId?: string; documentId?: string; updatedAt?: string; createdAt?: string }>(items: T[]) => items
      .map((item) => ({ item, rank: rank(item.displayName, item.id || item.variableId || item.documentId) }))
      .filter((value) => Number.isFinite(value.rank))
      .sort((a, b) => a.rank - b.rank || String(b.item.updatedAt || b.item.createdAt || "").localeCompare(String(a.item.updatedAt || a.item.createdAt || "")))
      .slice(0, 20).map((value) => value.item);
    const variables = sort(p.variables.map((v: any) => ({ type: "variable", variableId: v.id, id: v.id, revisionAtSend: v.revision, displayName: v.displayName || v.name || "未命名变量", updatedAt: v.updatedAt })));
    const documents = sort(p.documents.map((d: any) => ({ type: "document", documentId: d.id, id: d.id, displayName: d.name || "未命名文档", updatedAt: d.lastSeenAt })));
    const renders = sort(Object.values(state.renderIndex || {}).filter((r: any) => r.projectId === projectId).map((r: any) => ({
      ...r,
      displayName: r.displayName || r.summary || (r.target && r.target.label) || "文档修改",
    })) as any[]);
    return {
      variables, documents, renders,
    };
  }
}
