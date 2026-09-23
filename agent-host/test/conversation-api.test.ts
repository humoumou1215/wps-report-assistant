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
  assert.equal(messages[0].role, "user");
  assert.equal((await api(`/api/projects/${p.id}/references?q=api`)).documents.length, 1);
  assert.equal((await api(`/api/projects/${p.id}/documents/${doc.id}/index`)).documentId, doc.id);
  assert.deepEqual((await api(`/api/projects/${p.id}/render-records`)).records, []);
});
