import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, now } from "../src/project/store.js";
import { ConversationService } from "../src/project/conversations.js";
import { ConversationAgent } from "../src/agent/conversation-agent.js";
import type { AgentRuntime } from "../src/agent/pi-runtime.js";
import { CapabilityRegistry } from "../src/render/capabilities.js";
import { RenderGateway } from "../src/render/gateway.js";
import { RenderLedger } from "../src/render/ledger.js";

test("Conversation Agent computes a variable in Sandbox and completes a verified reversible render", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-agent-e2e-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).open();
  const project = await store.createProject("端到端项目");
  const document = await store.registerDocument(project.id, { key: "report.pptx", kind: "wpp" });
  const target: any = { capabilityId: "test.text", documentId: document.id, kind: "text", label: "第 2 页 · 总预算", locator: { id: "shape-2" } };
  const source = { id: "source-budget", projectId: project.id, documentId: document.id, revision: 1, values: [["Amount"], [2], [3]], createdAt: now() };
  await store.transaction((state) => {
    const p = state.projects[0];
    p.sources.push(source as any);
  });
  const live = { text: "尚未填写" };
  const capabilities = new CapabilityRegistry();
  capabilities.register({
    id: "test.text",
    reversible: true,
    async capture() { return { version: 1, kind: "text", adapterId: "test.text", text: { text: live.text }, comparison: { text: live.text } }; },
    async apply(_target, plan: any) { live.text = plan.text; },
    async restore(_target, snapshot: any) { live.text = snapshot.text.text; },
  });
  const gateway = new RenderGateway(store, capabilities);
  const runtime: AgentRuntime = {
    async run(input) {
      input.onTurn();
      const call = async (name: string, args: any = {}) => {
        const tool = input.tools.find((item) => item.name === name)!;
        const result = await tool.execute("e2e-call", args, undefined, undefined, {} as any);
        return JSON.parse((result.content[0] as any).text);
      };
      await call("get_project_context");
      await call("inspect_document", { documentId: document.id });
      const candidate = await call("run_transform_candidate", {
        inputs: [{ type: "source", sourceId: source.id }],
        code: 'function transform(rows,columns,sources){return {valueType:"number",columns:[],value:rows.reduce((sum,row)=>sum+row.Amount,0)}}',
      });
      assert.equal(candidate.ok, true);
      const staged = await call("stage_variable", { resultRef: candidate.resultRef, name: "预算总额", description: "年度预算总额" });
      await call("propose_variable_knowledge", { variableId: staged.variable.id, purpose: "用于报告展示年度预算合计", calculationSummary: ["对 Amount 列求和"], assumptions: [], confirmedRules: ["仅使用项目中的预算源数据"] });
      const renderCandidate = await call("run_renderer_candidate", {
        variableId: staged.variable.id,
        documentId: document.id,
        target,
        code: 'function render(variable,target){return {kind:"text",text:"总预算："+variable.value+"万元"}}',
      });
      const rendered = await call("execute_render", { resultRef: renderCandidate.resultRef });
      assert.equal(rendered.status, "verifying");
      await call("inspect_render_record", { renderId: rendered.renderId });
      const verified = await call("verify_render_effect", { renderId: rendered.renderId, ok: true, confidence: "high", summary: "实际目标内容符合要求", issues: [] });
      assert.equal(verified.status, "verified");
      return { sessionEntryId: null, tokenUsage: {}, assistantText: "已计算预算并完成验证。" };
    },
  };
  const bridge: any = { async inspectDocument() { return { kind: "presentation", slides: [{ index: 2, objects: [] }], targets: [target] }; } };
  const reviews: any[] = [];
  const critic: any = { async review(evidence: any) { reviews.push(evidence); return { passed: true, issues: [], repairInstruction: "" }; } };
  const agent = new ConversationAgent(store, runtime, gateway, bridge, critic);
  const conversations = new ConversationService(store);
  const conversation = await conversations.create(project.id, "预算报告");
  const sent = await conversations.send(project.id, conversation.id, {
    text: "根据预算数据更新报告里的总预算。",
    references: [{ type: "document", documentId: document.id, displayName: document.name }],
  });

  const task = await agent.run(project.id, conversation.id, sent.task.id);
  assert.equal(task?.status, "completed");
  assert.equal(live.text, "总预算：5万元");
  const state = store.snapshot();
  assert.equal(state.chatMessages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(state.projects[0].variables[0].value, 5);
  assert.equal(state.projects[0].variables[0].explanation?.purpose, "用于报告展示年度预算合计");
  assert.equal(reviews.length, 2, "Transform and Renderer each receive independent semantic review");
  assert.equal(state.projects[0].bindings.length, 1);
  assert.equal(state.tasks[0].operations.find((operation) => operation.type === "render")?.status, "applied");
  const ledger = new RenderLedger(dir, project.id);
  const records = await ledger.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "verified");
  assert.equal(records[0].beforeFingerprint !== records[0].afterFingerprint, true);
  assert.equal((await ledger.verifyHashChain()).ok, true);
});

test("a failed Render is semantically recovered, corrected, and no longer blocks Task completion", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-agent-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).open(), project = await store.createProject("可恢复任务");
  const document = await store.registerDocument(project.id, { key: "retry.pptx", kind: "wpp" });
  const target: any = { capabilityId: "test.retry", documentId: document.id, kind: "text", label: "第 1 页 · 标题", locator: { slideId: 1, shapeId: 7 } };
  await store.transaction((state) => {
    const p = state.projects[0];
    p.variables.push({ id: "retry-variable", projectId: p.id, revision: 1, name: "标题", displayName: "标题", valueType: "string", columns: [], value: "正确标题", inputs: [], transform: {}, createdAt: now(), updatedAt: now() } as any);
  });
  const live = { text: "原始标题" }, registry = new CapabilityRegistry();
  registry.register({
    id: "test.retry", reversible: true,
    async capture() { return { version: 1, kind: "text", adapterId: "test.retry", text: { text: live.text }, comparison: { text: live.text } }; },
    async apply(_target, plan: any) { live.text = plan.text; },
    async restore(_target, snapshot: any) { live.text = snapshot.text.text; },
  });
  const gateway = new RenderGateway(store, registry);
  const runtime: AgentRuntime = {
    async run(input) {
      input.onTurn();
      const call = async (name: string, args: any = {}) => {
        const tool = input.tools.find((item) => item.name === name)!;
        const result = await tool.execute("retry-call", args, undefined, undefined, {} as any);
        return JSON.parse((result.content[0] as any).text);
      };
      await call("inspect_document", { documentId: document.id });
      const wrong = await call("run_renderer_candidate", {
        variableId: "retry-variable", documentId: document.id, target,
        code: 'function render(){return {kind:"text",text:"错误标题"}}',
      });
      const first = await call("execute_render", { resultRef: wrong.resultRef });
      const failed = await call("verify_render_effect", { renderId: first.renderId, ok: false, confidence: "high", summary: "内容错误", issues: [{ type: "wrong-content", message: "标题不正确" }] });
      assert.equal(failed.status, "recovered");
      assert.equal(live.text, "原始标题");

      const corrected = await call("run_renderer_candidate", {
        variableId: "retry-variable", documentId: document.id, target,
        code: 'function render(variable){return {kind:"text",text:variable.value}}',
      });
      const second = await call("execute_render", { resultRef: corrected.resultRef });
      const verified = await call("verify_render_effect", { renderId: second.renderId, ok: true, confidence: "high", summary: "修正后的标题正确", issues: [] });
      assert.equal(verified.status, "verified");
      return { sessionEntryId: null, tokenUsage: {}, assistantText: "错误内容已恢复并通过修正完成。" };
    },
  };
  const critic: any = { async review(evidence: any) { return { passed: true, issues: [], repairInstruction: "" }; } };
  const bridge: any = { async inspectDocument() { return { kind: "presentation", slides: [{ slideId: 1, index: 1, objects: [] }], targets: [target] }; } };
  const agent = new ConversationAgent(store, runtime, gateway, bridge, critic);
  const service = new ConversationService(store), conversation = await service.create(project.id, "恢复后重试");
  const sent = await service.send(project.id, conversation.id, { text: "请修正报告中错误的标题。", references: [{ type: "document", documentId: document.id, displayName: document.name }] });
  const task = await agent.run(project.id, conversation.id, sent.task.id);
  assert.equal(task?.status, "completed", JSON.stringify(task?.validation));
  assert.equal(task?.validation?.passed, true);
  assert.equal(live.text, "正确标题");
  const operations = task!.operations.filter((item) => item.type === "render");
  assert.equal(operations.length, 2);
  assert.equal(operations[0].status, "superseded");
  assert.equal(operations[0].recoveredByRenderId !== undefined, true);
  const records = await gateway.ledger(project.id).list();
  assert.deepEqual(records.map((record) => record.action), ["render", "recovery", "correction"]);
  assert.equal(records[1].status, "verified");
  assert.equal(records[2].status, "verified");
  assert.equal(records[2].correctsRenderId, records[0].id);
  assert.equal(records[2].correctsOperationId, operations[0].id);
});

test("review mode stages a ChangeSet, then user confirmation renders exactly once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-agent-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).open(), project = await store.createProject("审慎模式");
  const document = await store.registerDocument(project.id, { key: "review.pptx", kind: "wpp" });
  const target: any = { capabilityId: "test.review", documentId: document.id, kind: "text", label: "报告标题", locator: { id: "shape-review" } };
  const source = { id: "review-source", projectId: project.id, documentId: document.id, revision: 1, values: [["Amount"], [8]], createdAt: now() };
  await store.transaction((state) => { state.projects[0].sources.push(source as any); });
  const live = { text: "旧标题" }, registry = new CapabilityRegistry();
  registry.register({
    id: "test.review", reversible: true,
    async capture() { return { version: 1, kind: "text", text: { text: live.text } }; },
    async apply(_target, plan: any) { live.text = plan.text; },
    async restore(_target, snapshot: any) { live.text = snapshot.text.text; },
  });
  const gateway = new RenderGateway(store, registry);
  let operationId = "";
  const runtime: AgentRuntime = {
    async run(input) {
      input.onTurn();
      const call = async (name: string, args: any = {}) => {
        const tool = input.tools.find((item) => item.name === name)!;
        const result = await tool.execute("review-call", args, undefined, undefined, {} as any);
        return JSON.parse((result.content[0] as any).text);
      };
      await call("inspect_document", { documentId: document.id });
      const candidate = await call("run_transform_candidate", {
        inputs: [{ type: "source", sourceId: source.id }],
        code: 'function transform(rows){return {valueType:"number",columns:[],value:rows.reduce((sum,row)=>sum+row.Amount,0)}}',
      });
      const variable = await call("stage_variable", { resultRef: candidate.resultRef, name: "金额" });
      const rendered = await call("run_renderer_candidate", {
        variableId: variable.variable.id, documentId: document.id, target,
        code: 'function render(variable){return {kind:"text",text:"金额："+variable.value}}',
      });
      const pending = await call("execute_render", { resultRef: rendered.resultRef });
      assert.equal(pending.status, "awaiting_confirmation");
      const duplicate = await call("execute_render", { resultRef: rendered.resultRef });
      assert.deepEqual(duplicate, pending, "review-mode retries must return the same staged operation");
      assert.equal(store.snapshot().tasks[0].operations.filter((operation) => operation.type === "render").length, 1);
      operationId = pending.operationId;
      assert.equal(live.text, "旧标题", "review mode must not write before explicit confirmation");
      return { sessionEntryId: null, tokenUsage: {}, assistantText: "修改方案已准备，等待确认。" };
    },
  };
  const critic: any = { async review() { return { passed: true, issues: [], repairInstruction: "" }; } };
  const bridge: any = { async inspectDocument() { return { kind: "presentation", slides: [], targets: [target] }; } };
  const agent = new ConversationAgent(store, runtime, gateway, bridge, critic, undefined, () => ({ automation: { renderExecutionMode: "review" } }));
  const service = new ConversationService(store), conversation = await service.create(project.id, "审慎确认");
  const sent = await service.send(project.id, conversation.id, { text: "更新标题", references: [{ type: "document", documentId: document.id, displayName: document.name }] });
  const waiting = await agent.run(project.id, conversation.id, sent.task.id);
  assert.equal(waiting?.status, "waiting_user");
  assert.ok(operationId);

  const confirmed = await agent.confirmRender(project.id, sent.task.id, operationId);
  assert.equal(confirmed.record.status, "verified");
  assert.equal(confirmed.task.status, "completed");
  assert.equal(live.text, "金额：8");
  const retry = await agent.confirmRender(project.id, sent.task.id, operationId);
  assert.equal(retry.record.id, confirmed.record.id);
  assert.equal((await new RenderLedger(dir, project.id).list()).length, 1);
});

test("a rejected preflight Render is recorded as a failed operation without leaving a running Task", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-agent-preflight-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).open(), project = await store.createProject("版本冲突");
  const document = await store.registerDocument(project.id, { key: "stale.pptx", kind: "wpp" });
  const target: any = { capabilityId: "test.preflight", documentId: document.id, kind: "text", label: "标题", locator: { id: "shape-stale" } };
  await store.transaction((state) => { state.projects[0].variables.push({ id: "preflight-variable", projectId: project.id, revision: 1, name: "标题", valueType: "string", columns: [], value: "新标题", inputs: [], transform: {} } as any); });
  const live = { text: "旧标题" }, registry = new CapabilityRegistry();
  registry.register({
    id: "test.preflight", reversible: true,
    async capture() { return { version: 1, kind: "text", adapterId: "test.preflight", text: { text: live.text } }; },
    async apply(_target, plan: any) { live.text = plan.text; },
    async restore(_target, snapshot: any) { live.text = snapshot.text.text; },
  });
  const gateway = new RenderGateway(store, registry);
  const runtime: AgentRuntime = {
    async run(input) {
      input.onTurn();
      const call = async (name: string, args: any = {}) => {
        const tool = input.tools.find((item) => item.name === name)!;
        const result = await tool.execute("preflight-call", args, undefined, undefined, {} as any);
        return JSON.parse((result.content[0] as any).text);
      };
      await call("inspect_document", { documentId: document.id });
      const candidate = await call("run_renderer_candidate", {
        variableId: "preflight-variable", documentId: document.id, target,
        code: 'function render(variable){return {kind:"text",text:variable.value}}',
      });
      await store.transaction((state) => { state.projects[0].documents[0].revision++; });
      const result = await call("execute_render", { resultRef: candidate.resultRef });
      assert.equal(result.error.code, "STALE_DOCUMENT_REVISION");
      return { sessionEntryId: null, tokenUsage: {}, assistantText: "文档已变化，未执行修改。" };
    },
  };
  const critic: any = { async review() { return { passed: true, issues: [], repairInstruction: "" }; } };
  const bridge: any = { async inspectDocument() { return { kind: "presentation", slides: [], targets: [target] }; } };
  const agent = new ConversationAgent(store, runtime, gateway, bridge, critic);
  const service = new ConversationService(store), conversation = await service.create(project.id, "过期方案");
  const sent = await service.send(project.id, conversation.id, { text: "更新标题", references: [{ type: "document", documentId: document.id, displayName: document.name }] });
  const task = await agent.run(project.id, conversation.id, sent.task.id);
  assert.equal(task?.status, "failed");
  assert.equal(task?.operations[0].status, "failed");
  assert.equal((task?.operations[0] as any).failureCode, "STALE_DOCUMENT_REVISION");
  assert.equal((await gateway.ledger(project.id).list()).length, 0);
  assert.equal(live.text, "旧标题");
});
