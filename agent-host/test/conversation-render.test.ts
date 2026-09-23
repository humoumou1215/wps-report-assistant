import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, fingerprint } from "../src/project/store.js";
import { ConversationService } from "../src/project/conversations.js";
import { ConversationAgent } from "../src/agent/conversation-agent.js";
import { runnableOperations, validateTaskGraph } from "../src/agent/task-graph.js";
import { CapabilityRegistry } from "../src/render/capabilities.js";
import { RenderGateway } from "../src/render/gateway.js";
import { RenderLedger } from "../src/render/ledger.js";

async function setup(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "ra-conversation-render-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).open();
  const project = await store.createProject("预算项目");
  const document = await store.registerDocument(project.id, { key: "/report.pptx", kind: "wpp" });
  return { dir, store, project, document };
}

test("conversation references are project-scoped and selection references are frozen", async (t) => {
  const x = await setup(t);
  const service = new ConversationService(x.store);
  const conversation = await service.create(x.project.id, "年度预算");
  const variable = await x.store.transaction((state) => {
    const p = state.projects[0];
    const source = { id: "source", revision: 1, documentId: x.document.id, values: [["金额"], [1]] };
    const item: any = { id: "variable", projectId: p.id, inputs: [{ type: "source", sourceId: source.id }], revision: 1, valueType: "number", columns: [], value: 1, transform: {} };
    p.sources.push(source as any);
    p.variables.push(item);
    return item;
  });
  const result = await service.send(x.project.id, conversation.id, {
    text: "更新报告",
    references: [
      { type: "variable", variableId: variable.id, revisionAtSend: 1, displayName: "预算总额" },
      { type: "selection", documentId: x.document.id, address: "A1", fingerprint: fingerprint({ text: "old" }), capturedAt: new Date().toISOString(), displayName: "报告选区" },
    ],
  });
  assert.equal(result.task.conversationId, conversation.id);
  assert.equal(x.store.snapshot().chatMessages.length, 1);
  await x.store.transaction((state) => { state.projects[0].variables[0].revision = 2; });
  const liveReference = (service.get(x.project.id, conversation.id).messages[0] as any).references[0];
  assert.equal(liveReference.revisionAtSend, 1);
  assert.equal(liveReference.currentRevision, 2);
  assert.equal(liveReference.freshness, "stale");
  assert.equal("value" in liveReference, false, "live reference state must not expose business values");
  await assert.rejects(service.send(x.project.id, conversation.id, {
    text: "未冻结",
    references: [{ type: "ephemeral-selection", documentId: x.document.id }],
  }), { code: "SELECTION_NOT_FROZEN" });
  await assert.rejects(service.send(x.project.id, conversation.id, {
    text: "跨项目",
    references: [{ type: "document", documentId: "other" }],
  }), { code: "NOT_FOUND" });
});

test("manual compaction keeps the same conversation session and never mutates project facts", async (t) => {
  const x = await setup(t), calls: Array<{ sessionId: string; instructions?: string }> = [];
  let shouldCompact = true;
  const service = new ConversationService(x.store, {
    async run() { return { assistantText: "ok", sessionEntryId: null, tokenUsage: {} }; },
    async compact(sessionId: string, instructions?: string) { calls.push({ sessionId, instructions }); return shouldCompact; },
  });
  const conversation = await service.create(x.project.id, "压缩测试");
  const projectBefore = x.store.getProject(x.project.id);
  const result = await service.compact(x.project.id, conversation.id);
  assert.equal(result.compacted, true);
  assert.equal(result.conversation.sessionId, conversation.sessionId);
  assert.ok(result.conversation.lastCompactedAt);
  assert.equal(calls[0].sessionId, conversation.sessionId);
  assert.match(calls[0].instructions || "", /Task 结论/);
  assert.match(calls[0].instructions || "", /Render Record ID/);
  assert.deepEqual(x.store.getProject(x.project.id), projectBefore);
  shouldCompact = false;
  const unchanged = await service.compact(x.project.id, conversation.id);
  assert.equal(unchanged.compacted, false);
  assert.equal(unchanged.conversation.lastCompactedAt, result.conversation.lastCompactedAt);
  assert.equal((await new RenderLedger(x.dir, x.project.id).list()).length, 0);
});

test("task graph only exposes operations whose dependencies are validated", async () => {
  const task: any = {
    id: "task", projectId: "p", conversationId: "c", userTurnId: "u", status: "planning", references: [], createdAt: "", updatedAt: "",
    operations: [
      { id: "a", type: "create-variable", status: "validated", name: "A", inputs: [] },
      { id: "b", type: "render", status: "pending", dependsOn: ["a"], variableId: "a", documentId: "d", target: {} },
    ],
  };
  assert.equal(validateTaskGraph(task).valid, true);
  assert.deepEqual(runnableOperations(task).map((operation) => operation.id), ["b"]);
  task.operations[0].status = "pending";
  assert.deepEqual(runnableOperations(task).map((operation) => operation.id), ["a"]);
  task.operations[0].dependsOn = ["b"];
  assert.equal(validateTaskGraph(task).valid, false);
});

test("render gateway persists before evidence, verifies, is idempotent, and creates a ledger undo", async (t) => {
  const x = await setup(t);
  const object = { text: "12亿元" };
  const registry = new CapabilityRegistry();
  registry.register({
    id: "test.text",
    reversible: true,
    async capture() {
      return { version: 1, kind: "text", adapterId: "test.text", text: { text: object.text }, comparison: { text: object.text } };
    },
    async apply(_target, plan: any) { object.text = plan.text; },
    async restore(_target, snapshot: any) { object.text = snapshot.text.text; },
  });
  const gateway = new RenderGateway(x.store, registry);
  const target: any = { capabilityId: "test.text", documentId: x.document.id, kind: "text", locator: { id: "shape-1" } };
  const first = await gateway.execute({ projectId: x.project.id, documentId: x.document.id, target, plan: { kind: "text", text: "14亿元" }, initiatedBy: "agent", action: "render", taskOperationId: "operation-1", executionMode: "agent-auto" });
  assert.equal(first.status, "verifying");
  await gateway.verifyRenderEffect(x.project.id, first.id, { ok: true, confidence: "high", summary: "写入内容匹配用户要求", issues: [] });
  assert.equal((await new RenderLedger(x.dir, x.project.id).get(first.id)).status, "verified");
  assert.equal(object.text, "14亿元");
  const second = await gateway.execute({ projectId: x.project.id, documentId: x.document.id, target, plan: { kind: "text", text: "14亿元" }, initiatedBy: "agent", action: "render", taskOperationId: "operation-1", executionMode: "agent-auto" });
  assert.equal(second.id, first.id);
  const ledger = new RenderLedger(x.dir, x.project.id);
  assert.equal((await ledger.list()).length, 1);
  assert.equal((await ledger.verifyHashChain()).ok, true);
  const undone = await gateway.undo(x.project.id, first.id, { type: "user" });
  assert.equal(undone.action, "undo");
  assert.equal(object.text, "12亿元");
  assert.equal((await ledger.list()).length, 2);
  assert.equal((await ledger.verifyHashChain()).ok, true);
  object.text = "用户手改";
  await assert.rejects(gateway.undo(x.project.id, first.id, { type: "user" }), { code: "UNDO_TARGET_CHANGED" });
});

test("render gateway enforces reversibility and interrupted prepared records are detected", async (t) => {
  const x = await setup(t);
  const object = { text: "old" };
  const registry = new CapabilityRegistry();
  registry.register({
    id: "test.irreversible",
    reversible: false,
    async capture() { return { version: 1, kind: "text", text: { text: object.text } }; },
    async apply() { object.text = "new"; },
    async restore() { object.text = "old"; },
  });
  const gateway = new RenderGateway(x.store, registry);
  await assert.rejects(gateway.execute({ projectId: x.project.id, documentId: x.document.id, target: { capabilityId: "test.irreversible" }, plan: { kind: "text", text: "new" }, initiatedBy: "agent", action: "render", taskOperationId: "irreversible", executionMode: "auto-reversible" }), { code: "RENDER_NOT_REVERSIBLE" });
  const ledger = new RenderLedger(x.dir, x.project.id);
  const before: any = await registry.resolve({ capabilityId: "test.irreversible" }).capture({ capabilityId: "test.irreversible" });
  await ledger.appendPrepared({
    projectId: x.project.id, taskOperationId: "crashed", initiatedBy: "agent", action: "render", variableIds: [], documentId: x.document.id,
    target: { capabilityId: "test.irreversible" }, beforeSnapshot: before, beforeFingerprint: fingerprint(before), forwardPlan: { kind: "text", text: "new" }, inversePlan: { kind: "restore-snapshot", snapshot: before }, programVerification: { ok: false, checks: [] },
  });
  const recovered = await gateway.recoverInterrupted(x.project.id);
  assert.equal(recovered[0].status, "failed");

  const afterSnapshot = { version: 1, kind: "text", text: { text: "new" } };
  object.text = "new";
  const applied = await ledger.appendPrepared({
    projectId: x.project.id, taskOperationId: "crashed-after-evidence", initiatedBy: "agent", action: "render", variableIds: [], documentId: x.document.id,
    target: { capabilityId: "test.irreversible" }, beforeSnapshot: { version: 1, kind: "text", text: { text: "old" } }, beforeFingerprint: fingerprint({ version: 1, kind: "text", text: { text: "old" } }),
    forwardPlan: { kind: "text", text: "new" }, inversePlan: { kind: "restore-snapshot", snapshot: { version: 1, kind: "text", text: { text: "old" } } }, programVerification: { ok: true, checks: [] },
  });
  await ledger.transition(applied.id, "applying");
  await ledger.appendAppliedEvidence(applied.id, { actualAfterSnapshot: afterSnapshot, afterFingerprint: fingerprint(afterSnapshot) });
  const resumed = await gateway.recoverInterrupted(x.project.id);
  assert.equal(resumed[0].status, "verifying");
});

test("program verification failure creates a separate recovery record and hash tampering is detected", async (t) => {
  const x = await setup(t);
  const object = { text: "before" };
  const registry = new CapabilityRegistry();
  registry.register({
    id: "test.repair",
    reversible: true,
    async capture() { return { version: 1, kind: "text", text: { text: object.text } }; },
    async apply(_target, plan: any) { object.text = plan.text === "bad" ? "unexpected" : plan.text; },
    async restore(_target, snapshot: any) { object.text = snapshot.text.text; },
  });
  const gateway = new RenderGateway(x.store, registry);
  await assert.rejects(gateway.execute({ projectId: x.project.id, documentId: x.document.id, target: { capabilityId: "test.repair" }, plan: { kind: "text", text: "bad" }, initiatedBy: "agent", action: "render", taskOperationId: "bad-render", executionMode: "agent-auto" }), { code: "RENDER_VERIFY_FAILED" });
  assert.equal(object.text, "before");
  const ledger = new RenderLedger(x.dir, x.project.id);
  const records = await ledger.list();
  assert.equal(records.length, 2);
  assert.equal(records[0].status, "verify_failed");
  assert.equal(records[1].action, "recovery");
  const file = join(x.dir, "projects", x.project.id, "render-ledger.jsonl");
  const content = await readFile(file, "utf8");
  await writeFile(file, content.replace("entryHash", "tamperedHash"), "utf8");
  assert.equal((await ledger.verifyHashChain()).ok, false);
});

test("stale Document revision rejects a Render before Apply", async (t) => {
  const x = await setup(t), object = { text: "before" }, registry = new CapabilityRegistry();
  let applies = 0;
  registry.register({
    id: "test.document-revision", reversible: true,
    async capture() { return { version: 1, kind: "text", adapterId: "test.document-revision", text: { text: object.text } }; },
    async apply(_target, plan: any) { applies++; object.text = plan.text; },
    async restore(_target, snapshot: any) { object.text = snapshot.text.text; },
  });
  const gateway = new RenderGateway(x.store, registry), target: any = { capabilityId: "test.document-revision", documentId: x.document.id, locator: { id: "shape" } };
  await x.store.transaction((state) => { state.projects[0].documents[0].revision++; });
  await assert.rejects(gateway.execute({ projectId: x.project.id, documentId: x.document.id, target, plan: { kind: "text", text: "after" }, initiatedBy: "agent", action: "render", expectedDocumentRevision: x.document.revision, executionMode: "agent-auto" }), { code: "STALE_DOCUMENT_REVISION" });
  assert.equal(applies, 0);
  assert.equal(object.text, "before");
  assert.equal((await gateway.ledger(x.project.id).list()).length, 0);
});

test("Recovery semantic failure remains blocked and cannot trigger another automatic write", async (t) => {
  const x = await setup(t), object = { text: "before" }, registry = new CapabilityRegistry();
  let applies = 0;
  registry.register({
    id: "test.recovery-semantic", reversible: true,
    async capture() { return { version: 1, kind: "text", adapterId: "test.recovery-semantic", text: { text: object.text }, comparison: { text: object.text } }; },
    async apply(_target, plan: any) { applies++; object.text = plan.text; },
    async restore(_target, snapshot: any) { object.text = snapshot.text.text; },
  });
  const gateway = new RenderGateway(x.store, registry), target: any = { capabilityId: "test.recovery-semantic", documentId: x.document.id, locator: { id: "shape" } };
  const render = await gateway.execute({ projectId: x.project.id, documentId: x.document.id, target, plan: { kind: "text", text: "wrong" }, initiatedBy: "agent", action: "render", executionMode: "agent-auto" });
  const agent = new ConversationAgent(x.store, { async run() { return { sessionEntryId: null, tokenUsage: {}, assistantText: "" }; } } as any, gateway, {} as any, { async review() { return { passed: false, issues: ["恢复内容需人工检查"], repairInstruction: "" }; } } as any);
  const result = await agent.finalizeRender(x.project.id, render.id, "更新报告", { ok: false, confidence: "high", summary: "渲染不正确", issues: [] });
  assert.equal(result.recoveryRequired, true);
  const records = await gateway.ledger(x.project.id).list();
  assert.equal(records.length, 2);
  assert.equal(records[1].action, "recovery");
  assert.equal(records[1].recoveryRequired, true);
  const count = applies;
  await assert.rejects(gateway.execute({ projectId: x.project.id, documentId: x.document.id, target, plan: { kind: "text", text: "next" }, initiatedBy: "agent", action: "render", executionMode: "agent-auto" }), { code: "RENDER_RECOVERY_REQUIRED" });
  assert.equal(applies, count);
  assert.equal(object.text, "before");
});

test("reconnect resumes semantic verification of a verifying Render without reapplying", async (t) => {
  const x = await setup(t), object = { text: "before" }, registry = new CapabilityRegistry();
  let applies = 0;
  registry.register({
    id: "test.reconnect", reversible: true,
    async capture() { return { version: 1, kind: "text", adapterId: "test.reconnect", text: { text: object.text }, comparison: { text: object.text } }; },
    async apply(_target, plan: any) { applies++; object.text = plan.text; },
    async restore(_target, snapshot: any) { object.text = snapshot.text.text; },
  });
  const gateway = new RenderGateway(x.store, registry), service = new ConversationService(x.store), conversation = await service.create(x.project.id, "重连验证");
  const sent = await service.send(x.project.id, conversation.id, { text: "更新文本", references: [{ type: "document", documentId: x.document.id, displayName: x.document.name }] });
  const operationId = "reconnect-operation", target: any = { capabilityId: "test.reconnect", documentId: x.document.id, locator: { id: "shape" } };
  await x.store.transaction((state) => { state.tasks[0].operations.push({ id: operationId, type: "render", status: "running", variableId: "unused", documentId: x.document.id, target } as any); });
  const record = await gateway.execute({ projectId: x.project.id, conversationId: conversation.id, userTurnId: sent.task.userTurnId, taskId: sent.task.id, taskOperationId: `${sent.task.id}:${operationId}`, initiatedBy: "agent", action: "render", documentId: x.document.id, target, plan: { kind: "text", text: "after" }, executionMode: "agent-auto" });
  assert.equal(record.status, "verifying");
  assert.equal(applies, 1);

  const restartedGateway = new RenderGateway(x.store, registry);
  const restartedAgent = new ConversationAgent(x.store, { async run() { return { sessionEntryId: null, tokenUsage: {}, assistantText: "" }; } } as any, restartedGateway, {} as any, { async review() { return { passed: true, issues: [], repairInstruction: "" }; } } as any);
  await restartedAgent.reconcileAfterRestart();
  assert.equal(x.store.snapshot().tasks[0].status, "verifying");
  await restartedAgent.reconcileDocument(x.project.id, x.document.id);
  assert.equal(applies, 1, "reconnect must not invoke Apply a second time");
  assert.equal((await restartedGateway.ledger(x.project.id).get(record.id)).status, "verified");
  assert.equal(x.store.snapshot().tasks[0].status, "completed");
});

test("reconnect closes a prepared Render that never changed WPS instead of orphaning its Task operation", async (t) => {
  const x = await setup(t), object = { text: "before" }, registry = new CapabilityRegistry();
  registry.register({
    id: "test.prepared-reconcile", reversible: true,
    async capture() { return { version: 1, kind: "text", adapterId: "test.prepared-reconcile", text: { text: object.text } }; },
    async apply(_target, plan: any) { object.text = plan.text; },
    async restore(_target, snapshot: any) { object.text = snapshot.text.text; },
  });
  const gateway = new RenderGateway(x.store, registry), service = new ConversationService(x.store), conversation = await service.create(x.project.id, "中断闭合");
  const sent = await service.send(x.project.id, conversation.id, { text: "改标题", references: [{ type: "document", documentId: x.document.id, displayName: x.document.name }] });
  const target: any = { capabilityId: "test.prepared-reconcile", documentId: x.document.id, locator: { id: "shape" } };
  await x.store.transaction((state) => {
    state.tasks[0].status = "verifying";
    state.tasks[0].operations.push({ id: "interrupted-op", type: "render", status: "running", variableId: "missing", documentId: x.document.id, target } as any);
  });
  const before: any = await registry.resolve(target).capture(target);
  await gateway.ledger(x.project.id).appendPrepared({
    projectId: x.project.id, conversationId: conversation.id, userTurnId: sent.task.userTurnId, taskId: sent.task.id,
    taskOperationId: `${sent.task.id}:interrupted-op`, initiatedBy: "agent", action: "render", variableIds: [], documentId: x.document.id,
    target, beforeSnapshot: before, beforeFingerprint: fingerprint(before), forwardPlan: { kind: "text", text: "after" },
    inversePlan: { kind: "restore-snapshot", snapshot: before }, programVerification: { ok: false, checks: [] },
  });
  const agent = new ConversationAgent(x.store, { async run() { return { sessionEntryId: null, tokenUsage: {}, assistantText: "" }; } } as any, gateway, {} as any);
  await agent.reconcileDocument(x.project.id, x.document.id);
  const reconciled = x.store.snapshot().tasks[0];
  assert.equal(reconciled.status, "failed");
  assert.equal((reconciled.operations[0] as any).status, "failed");
  assert.equal((reconciled.operations[0] as any).failureCode, "INTERRUPTED_BEFORE_APPLY");
  assert.equal(object.text, "before");
});
