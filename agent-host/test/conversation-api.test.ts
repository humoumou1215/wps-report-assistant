import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/project/store.js";
import { Settings } from "../src/model/settings.js";
import { createHost } from "../src/server/http-server.js";
import { ConversationAgent } from "../src/agent/conversation-agent.js";
import { CapabilityRegistry } from "../src/render/capabilities.js";
import { RenderGateway } from "../src/render/gateway.js";
import { WpsBridge } from "../src/render/wps-bridge.js";

test("conversation, document index, variable and render timeline APIs are available", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-conversation-api-"));
  const store = await new Store(dir).open();
  const settings = await new Settings(dir).open();
  const gateway = new RenderGateway(store, new CapabilityRegistry());
  const bridge = new WpsBridge();
  const conversationAgent = new ConversationAgent(store, { async run() { return { sessionEntryId: null, tokenUsage: {}, assistantText: "已检查项目文件。" }; } }, gateway, bridge);
  const server = createHost(store, settings, dir, { version: "test", renderGateway: gateway, wpsBridge: bridge, conversationAgent });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const health = await (await fetch(base + "/api/health")).json() as any;
  const api = async (path: string, method = "GET", value?: any) => {
    const response = await fetch(base + path, {
      method,
      headers: { "X-RA-Token": health.token, "Content-Type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const data = await response.json() as any;
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };
  const p = (await api("/api/projects", "POST", { name: "API 项目" })).project;
  const doc = (await api(`/api/projects/${p.id}/documents`, "POST", { key: "/api.xlsx", kind: "et" })).document;
  const conversation = (await api(`/api/projects/${p.id}/conversations`, "POST", { title: "API 会话" })).conversation;
  assert.equal((await fetch(`${base}/api/projects/${p.id}/events`)).status, 401);
  const stream = await fetch(`${base}/api/projects/${p.id}/events`, { headers: { "X-RA-Token": health.token, Accept: "text/event-stream" } });
  assert.equal(stream.headers.get("content-type")?.startsWith("text/event-stream"), true);
  const reader = stream.body!.getReader(), decoder = new TextDecoder();
  let eventText = "";
  await store.transaction((state) => {
    const timestamp = new Date().toISOString();
    state.projects[0].variables.push({ id: "event-variable", projectId: p.id, revision: 1, name: "事件变量", displayName: "事件变量", value: "PRIVATE_VALUE", valueType: "string", columns: [], inputs: [], transform: {} } as any);
    state.projects[0].bindings.push({ id: "event-binding", variableId: "event-variable", documentId: doc.id, revision: 1, target: { label: "事件输出" }, lastRenderedVariableRevision: 1 } as any);
    state.tasks.push({ id: "event-task", projectId: p.id, conversationId: conversation.id, userTurnId: "event-user", status: "running", references: [], operations: [], createdAt: timestamp, updatedAt: timestamp } as any);
    state.chatMessages.push({ id: "event-message", conversationId: conversation.id, role: "assistant", text: "event payload must stay minimal", references: [], createdAt: timestamp } as any);
    state.renderIndex["event-render"] = { id: "event-render", projectId: p.id, documentId: doc.id, status: "verifying", displayName: "PRIVATE_RENDER_LABEL" } as any;
  });
  while (!eventText.includes("event: render.verifying")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    eventText += decoder.decode(chunk.value, { stream: true });
  }
  assert.ok(eventText.includes("event: task.created"));
  assert.ok(eventText.includes("event: conversation.message.created"));
  assert.ok(eventText.includes("event: render.verifying"));
  assert.ok(eventText.includes("event: variable.created"));
  assert.ok(eventText.indexOf("event: task.created") < eventText.indexOf("event: conversation.message.created"));
  assert.ok(!eventText.includes("event payload must stay minimal") && !eventText.includes("PRIVATE_VALUE") && !eventText.includes("PRIVATE_RENDER_LABEL"), "SSE events must not contain business/chat payloads or values");
  await store.transaction((state) => { (state.renderIndex["event-render"] as any).status = "verified"; });
  while (!eventText.includes("event: render.verified")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    eventText += decoder.decode(chunk.value, { stream: true });
  }
  assert.ok(eventText.indexOf("event: render.verifying") < eventText.indexOf("event: render.verified"));
  await store.transaction((state) => { state.projects[0].variables[0].revision++; });
  while (!eventText.includes("event: binding.stale")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    eventText += decoder.decode(chunk.value, { stream: true });
  }
  assert.ok(eventText.includes("event: variable.updated"));
  assert.ok(eventText.includes("event: binding.stale"));
  await reader.cancel();
  const sent = await api(`/api/projects/${p.id}/conversations/${conversation.id}/messages`, "POST", { text: "检查文件", references: [{ type: "document", documentId: doc.id, displayName: doc.name }] });
  assert.equal(sent.task.projectId, p.id);
  let taskStatus = "planning";
  for (let attempt = 0; attempt < 100 && ["planning", "running"].includes(taskStatus); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const current = await api(`/api/projects/${p.id}/conversations/${conversation.id}`);
    taskStatus = current.tasks.find((item: any) => item.id === sent.task.id)?.status || "failed";
  }
  assert.equal(taskStatus, "completed", "Conversation Agent should finish the task");
  const messages = (await api(`/api/projects/${p.id}/conversations/${conversation.id}`)).messages;
  assert.ok(messages.some((message: any) => message.role === "user"));
  assert.equal((await api(`/api/projects/${p.id}/references?q=api`)).documents.length, 1);
  assert.equal((await api(`/api/projects/${p.id}/documents/${doc.id}/index`)).documentId, doc.id);
  assert.deepEqual((await api(`/api/projects/${p.id}/render-records`)).records, []);
});
