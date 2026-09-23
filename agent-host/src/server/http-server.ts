import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { AppError, fail } from "../../../shared/contracts/index.js";
import { Store, project, entity, now } from "../project/store.js";
import { Settings } from "../model/settings.js";
import { refreshSource, restoreVariable } from "../project/operations.js";
import { ConversationService } from "../project/conversations.js";
import { RenderLedger } from "../render/ledger.js";
import type { RenderGateway } from "../render/gateway.js";
import { lineage } from "../project/variable-knowledge.js";
import { inspectDocument, searchDocument } from "../project/document-index.js";
import type { WpsBridge } from "../render/wps-bridge.js";
import type { ConversationAgent } from "../agent/conversation-agent.js";
import { attachStoreEventPublishing, ProjectEventBus } from "./event-bus.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".xml": "application/xml", ".png": "image/png", ".svg": "image/svg+xml",
};

async function body(req: IncomingMessage) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json"))
    fail("CONTENT_TYPE", "仅接受 application/json", 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 6 * 1024 * 1024) fail("INPUT_TOO_LARGE", "请求过大", 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail("INVALID_JSON", "JSON 格式错误", 400); }
}

interface HostOptions {
  version?: string;
  conversationService?: ConversationService;
  renderGateway?: RenderGateway;
  wpsBridge?: WpsBridge;
  conversationAgent?: ConversationAgent;
}

export function createHost(store: Store, settings: Settings, assetDir: string, options: HostOptions = {}) {
  const token = randomBytes(32).toString("hex");
  const events = new ProjectEventBus();
  const detachEvents = attachStoreEventPublishing(store, events);
  const conversations = options.conversationService || new ConversationService(store);
  const server = createServer(async (req, res) => {
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    try {
      const port = (server.address() as any)?.port;
      if (!["127.0.0.1:" + port, "localhost:" + port].includes(req.headers.host || ""))
        fail("INVALID_HOST", "无效 Host", 403);
      const origin = req.headers.origin;
      if (origin && !["http://127.0.0.1:" + port, "http://localhost:" + port].includes(origin))
        fail("ORIGIN_DENIED", "来源不允许", 403);
      if (origin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Headers": "Content-Type, X-RA-Token",
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
        });
        res.end();
        return;
      }

      const url = new URL(req.url || "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean), method = req.method || "GET";
      if (url.pathname === "/api/health" && method === "GET") {
        send({ ok: true, version: options.version || "development", runtime: "node", token });
        return;
      }
      if (parts[0] !== "api") {
        const relative = decodeURIComponent(url.pathname).replace(/^\/(?:addins\/)?/, "") || "workspace/taskpane.html";
        const root = resolve(assetDir), file = resolve(root, relative);
        if (!file.startsWith(root + sep)) fail("NOT_FOUND", "文件不存在", 404);
        try {
          const data = await readFile(file);
          res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
          res.end(data);
        } catch { fail("NOT_FOUND", "文件不存在", 404); }
        return;
      }

      const supplied = Buffer.from(String(req.headers["x-ra-token"] || ""));
      if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token)))
        fail("UNAUTHORIZED", "本地令牌无效", 401);
      if (url.pathname === "/api/settings" && method === "GET") { send(settings.public()); return; }
      if (url.pathname === "/api/settings" && method === "POST") {
        await settings.update(await body(req)); send({ ok: true }); return;
      }

      if (url.pathname === "/api/wps/bridge/register" && method === "POST") {
        const bridge = requireBridge(options.wpsBridge), input = await body(req);
        const document = entity(store.getProject(input.projectId).documents, input.documentId);
        if (document.key !== input.documentKey) fail("DOCUMENT_CHANGED", "当前 WPS 文件不匹配", 409);
        const registration = bridge.register(document.id, document.key, input.capabilities || []);
        send(registration);
        if (options.renderGateway)
          setTimeout(() => void (options.conversationAgent
            ? options.conversationAgent.reconcileDocument(input.projectId, input.documentId)
            : options.renderGateway!.recoverInterrupted(input.projectId, input.documentId)
          ).catch((error) => console.error("Render lifecycle reconciliation failed:", error instanceof Error ? error.message : String(error))), 25);
        return;
      }
      if (url.pathname === "/api/wps/bridge/next" && method === "GET") {
        send({ command: await requireBridge(options.wpsBridge).next(url.searchParams.get("documentId") || "") }); return;
      }
      if (url.pathname === "/api/wps/bridge/result" && method === "POST") {
        const input = await body(req);
        send(requireBridge(options.wpsBridge).respond(input.documentId, input.requestId, input.result, input.error)); return;
      }
      if (url.pathname === "/api/projects" && method === "GET") {
        send({ projects: store.snapshot().projects.map((item) => ({
          id: item.id, name: item.name, updatedAt: item.updatedAt,
          documentCount: item.documents.length, variableCount: item.variables.length,
          bindingCount: item.bindings.length,
        })) }); return;
      }
      if (url.pathname === "/api/projects" && method === "POST") {
        send({ project: await store.createProject((await body(req)).name) }, 201); return;
      }
      if (url.pathname === "/api/resolve-project" && method === "POST") {
        const input = await body(req);
        const item = store.snapshot().projects.find((candidate) => candidate.documents.some((document) => document.key === input.documentKey));
        send({ project: item || null, document: item?.documents.find((document) => document.key === input.documentKey) || null }); return;
      }

      if (parts[1] !== "projects" || !parts[2]) fail("NOT_FOUND", "接口不存在", 404);
      const projectId = parts[2];
      store.getProject(projectId);
      if (parts[3] === "events" && parts.length === 4 && method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("retry: 3000\n: connected\n\n");
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
        };
        const unsubscribe = events.subscribe(projectId, (event) => {
          if (!closed) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => { if (!closed) res.write(": keepalive\n\n"); }, 20000);
        res.on("close", close);
        return;
      }
      if (parts.length === 3) {
        if (method === "GET") { send({ project: store.getProject(projectId) }); return; }
        if (method === "PATCH") {
          const input = await body(req);
          send({ project: await store.transaction((state) => {
            const item = project(state, projectId);
            if (typeof input.name === "string" && input.name.trim()) item.name = input.name.trim();
            item.revision++; item.updatedAt = now(); return item;
          }) }); return;
        }
        if (method === "DELETE") {
          await store.transaction((state) => {
            if (state.tasks.some((task) => task.projectId === projectId && ["planning", "running", "validating", "rendering", "verifying"].includes(task.status)))
              fail("AGENT_BUSY", "项目任务运行中", 409);
            const conversationIds = new Set(state.conversations.filter((item) => item.projectId === projectId).map((item) => item.id));
            state.projects = state.projects.filter((item) => item.id !== projectId);
            state.conversations = state.conversations.filter((item) => item.projectId !== projectId);
            state.chatMessages = state.chatMessages.filter((message) => !conversationIds.has(message.conversationId));
            state.tasks = state.tasks.filter((task) => task.projectId !== projectId);
            state.variableRevisions = state.variableRevisions.filter((revision) => revision.projectId !== projectId);
            for (const [renderId, record] of Object.entries(state.renderIndex))
              if ((record as any).projectId === projectId) delete state.renderIndex[renderId];
          });
          send({ ok: true }); return;
        }
      }

      if (parts[3] === "documents" && parts.length === 4 && method === "POST") {
        send({ document: await store.registerDocument(projectId, await body(req)) }, 201); return;
      }
      if (parts[3] === "documents" && parts[4] && method === "GET") {
        const current = store.getProject(projectId);
        if (parts[5] === "index") { send(inspectDocument(current, parts[4]).index); return; }
        if (parts[5] === "search") { send(searchDocument(current, parts[4], url.searchParams.get("q") || "")); return; }
        send(inspectDocument(current, parts[4])); return;
      }
      if (parts[3] === "conversations") {
        if (parts.length === 4 && method === "GET") { send({ conversations: conversations.list(projectId) }); return; }
        if (parts.length === 4 && method === "POST") {
          send({ conversation: await conversations.create(projectId, (await body(req)).title) }, 201); return;
        }
        const conversationId = parts[4];
        if (parts[5] === "messages" && method === "POST") {
          const agent = requireConversationAgent(options.conversationAgent);
          const result = await conversations.send(projectId, conversationId, await body(req));
          send(result, 202);
          void agent.run(projectId, conversationId, result.task.id).catch((error) => console.error("Conversation Agent failed:", error instanceof Error ? error.message : String(error)));
          return;
        }
        if (parts[5] === "compact" && method === "POST") {
          await body(req); send(await conversations.compact(projectId, conversationId)); return;
        }
        if (parts.length === 5 && method === "GET") { send(conversations.get(projectId, conversationId)); return; }
        if (parts.length === 5 && method === "PATCH") {
          send({ conversation: await conversations.update(projectId, conversationId, await body(req)) }); return;
        }
      }
      if (parts[3] === "references" && method === "GET") {
        send(conversations.searchReferences(projectId, url.searchParams.get("q") || "")); return;
      }
      if (parts[3] === "tasks") {
        const taskId = parts[4];
        if (parts.length === 5 && method === "GET") {
          const task = entity(store.snapshot().tasks, taskId);
          if (task.projectId !== projectId) fail("NOT_FOUND", "任务不存在", 404);
          send({ task }); return;
        }
        if (parts[5] === "operations" && parts[7] === "confirm" && method === "POST") {
          await body(req);
          send(await requireConversationAgent(options.conversationAgent).confirmRender(projectId, taskId, parts[6]), 201); return;
        }
        if (parts[5] === "operations" && parts[7] === "cancel" && method === "POST") {
          await body(req);
          send(await requireConversationAgent(options.conversationAgent).cancelRender(projectId, taskId, parts[6])); return;
        }
      }
      if (parts[3] === "variables" && parts.length === 4 && method === "GET") {
        const item = store.getProject(projectId);
        send({ variables: item.variables.map((variable) => ({
          ...variable,
          explanationStatus: variable.explanation ? variable.explanation.revision === variable.revision ? "current" : "stale" : "missing",
          usageCount: item.bindings.filter((binding) => binding.variableId === variable.id).length,
        })) }); return;
      }
      if (parts[3] === "variables" && parts[4] && parts.length === 5 && method === "GET") {
        const item = store.getProject(projectId), variable = entity(item.variables, parts[4]);
        send({ variable, lineage: lineage(item, variable.id) }); return;
      }
      if (parts[3] === "variables" && parts[5] === "lineage" && method === "GET") {
        send(lineage(store.getProject(projectId), parts[4])); return;
      }
      if (parts[3] === "variables" && parts[5] === "render-history" && method === "GET") {
        const records = await new RenderLedger(store.dir, projectId).list();
        send({ records: records.filter((record) => record.variableIds.includes(parts[4])).reverse() }); return;
      }
      if (parts[3] === "variables" && parts[5] === "revisions") {
        if (method === "GET") {
          send({ revisions: store.snapshot().variableRevisions.filter((revision) => revision.projectId === projectId && revision.variableId === parts[4]).reverse() }); return;
        }
        if (method === "POST") { send(await restoreVariable(store, projectId, parts[4], await body(req))); return; }
      }
      if (parts[3] === "sources" && parts[4] && method === "PATCH") {
        send(await refreshSource(store, projectId, parts[4], await body(req))); return;
      }
      if (parts[3] === "render-records") {
        const ledger = new RenderLedger(store.dir, projectId);
        if (parts.length === 4 && method === "GET") {
          let records = await ledger.list();
          const documentId = url.searchParams.get("documentId");
          if (documentId) records = records.filter((record) => record.documentId === documentId);
          const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 30)));
          const page = records.reverse().slice(0, limit);
          send({ records: page.map((record) => ({ ...record,
            relationships: {
              recoveryRecords: records.filter((item) => item.action === "recovery" && item.correctsRenderId === record.id).map((item) => item.id),
              correctedBy: records.filter((item) => item.correctsRenderId === record.id && item.action === "correction").map((item) => item.id),
              undoRecords: records.filter((item) => item.undoOfRenderId === record.id).map((item) => item.id),
            },
          })), integrity: await ledger.verifyHashChain() }); return;
        }
        const renderId = parts[4];
        if (parts.length === 5 && method === "GET") {
          const record = await ledger.get(renderId), records = await ledger.list();
          send({ record: { ...record, relationships: {
            recoveryRecords: records.filter((item) => item.action === "recovery" && item.correctsRenderId === record.id).map((item) => item.id),
            correctedBy: records.filter((item) => item.correctsRenderId === record.id && item.action === "correction").map((item) => item.id),
            undoRecords: records.filter((item) => item.undoOfRenderId === record.id).map((item) => item.id),
          } } }); return;
        }
        if (parts[5] === "undo" && method === "POST") {
          await body(req);
          const gateway = requireGateway(options.renderGateway), agent = requireConversationAgent(options.conversationAgent);
          let record = await gateway.undo(projectId, renderId, { type: "user" });
          if (record.status === "verifying") {
            try { record = await agent.finalizeRender(projectId, record.id, `撤销 ${renderId}，恢复到修改前的文档内容`); }
            catch { record = await ledger.get(record.id); }
          }
          send({ record }, 201); return;
        }
        if (parts[5] === "recover" && method === "POST") {
          const input = await body(req), gateway = requireGateway(options.renderGateway), agent = requireConversationAgent(options.conversationAgent);
          const record = await ledger.get(renderId);
          if ((record as any).recoveryRequired !== true || input.confirm !== true)
            fail("RECOVERY_CONFIRMATION_REQUIRED", "请检查目标文档并明确确认后再恢复", 412);
          let recovery = await gateway.recover(renderId, projectId);
          if (recovery.status === "verifying") {
            try { recovery = await agent.finalizeRender(projectId, recovery.id, `将文档恢复到 ${renderId} 修改前的状态`); }
            catch { recovery = await ledger.get(recovery.id); }
          }
          send({ record: recovery }, 201); return;
        }
      }
      if (["variables", "bindings"].includes(parts[3]) && parts.length === 5 && method === "DELETE") {
        const key = parts[3] as "variables" | "bindings", entityId = parts[4];
        await store.transaction((state) => {
          const current = project(state, projectId);
          entity<any>(current[key], entityId);
          if (key === "variables" && current.bindings.some((binding) => binding.variableId === entityId))
            fail("IN_USE", "变量仍被输出引用", 409);
          if (key === "variables") current.variables = current.variables.filter((item) => item.id !== entityId);
          else current.bindings = current.bindings.filter((item) => item.id !== entityId);
          current.revision++; current.updatedAt = now();
        });
        send({ ok: true }); return;
      }
      fail("NOT_FOUND", "接口不存在", 404);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const e = error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "服务执行失败", 500);
      send({ error: settings.redact(e.message), code: e.code, hint: e.hint }, e.status);
    }
  });
  server.on("close", detachEvents);
  return server;
}

function requireBridge(bridge?: WpsBridge) {
  if (!bridge) fail("WPS_BRIDGE_UNAVAILABLE", "WPS 桥接未启动", 503);
  return bridge!;
}
function requireGateway(gateway?: RenderGateway) {
  if (!gateway) fail("RENDER_GATEWAY_UNAVAILABLE", "Render Gateway 未启动", 503);
  return gateway!;
}
function requireConversationAgent(agent?: ConversationAgent) {
  if (!agent) fail("CONVERSATION_AGENT_UNAVAILABLE", "Conversation Agent 尚未启动", 503);
  return agent!;
}
