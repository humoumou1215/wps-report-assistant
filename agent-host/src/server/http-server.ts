import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep, join } from "node:path";
import { AppError, fail } from "../../../shared/contracts/index.js";
import { Store, project, entity, now, atomic, id } from "../project/store.js";
import { Settings } from "../model/settings.js";
import { AgentService } from "../agent/runtime.js";
import { prepareSamples } from "../project/samples.js";
import { Changes } from "../project/changes.js";
import { refreshSource, restoreVariable } from "../project/operations.js";
import { render } from "../legacy/execute.js";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
async function body(req: IncomingMessage) {
  if (!String(req.headers["content-type"]).startsWith("application/json"))
    fail("CONTENT_TYPE", "仅接受 application/json", 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 6 * 1024 * 1024) fail("INPUT_TOO_LARGE", "请求过大", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    fail("INVALID_JSON", "JSON 格式错误", 400);
  }
}
export function createHost(
  store: Store,
  settings: Settings,
  agents: AgentService,
  assetDir: string,
  appVersion = "development",
) {
  const token = randomBytes(32).toString("hex"),
    changes = new Changes(store);
  const server = createServer(async (req, res) => {
    const send = (value: any, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const port = (server.address() as any)?.port;
      if (
        ![`127.0.0.1:${port}`, `localhost:${port}`].includes(
          req.headers.host || "",
        )
      )
        fail("INVALID_HOST", "无效 Host", 403);
      const origin = req.headers.origin;
      if (
        origin &&
        !["http://127.0.0.1:" + port, "http://localhost:" + port].includes(
          origin,
        )
      )
        fail("ORIGIN_DENIED", "来源不允许", 403);
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Headers":
            "Content-Type, X-RA-Token, Last-Event-ID",
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
        });
        res.end();
        return;
      }
      const url = new URL(req.url || "/", "http://127.0.0.1"),
        parts = url.pathname.split("/").filter(Boolean),
        method = req.method;
      if (url.pathname === "/api/health" && method === "GET") {
        send({ ok: true, version: appVersion, runtime: "node", token });
        return;
      }
      if (parts[0] !== "api") {
        const rel =
          decodeURIComponent(url.pathname).replace(/^\/(?:addins\/)?/, "") ||
          "workspace/taskpane.html";
        const root = resolve(assetDir),
          file = resolve(root, rel);
        if (!file.startsWith(root + sep)) fail("NOT_FOUND", "文件不存在", 404);
        try {
          const data = await readFile(file);
          res.writeHead(200, {
            "Content-Type": MIME[extname(file)] || "application/octet-stream",
          });
          res.end(data);
        } catch {
          fail("NOT_FOUND", "文件不存在", 404);
        }
        return;
      }
      const supplied = Buffer.from(String(req.headers["x-ra-token"] || ""));
      if (
        supplied.length !== token.length ||
        !timingSafeEqual(supplied, Buffer.from(token))
      )
        fail("UNAUTHORIZED", "本地令牌无效", 401);
      if (url.pathname === "/api/settings" && method === "GET") {
        send(settings.public());
        return;
      }
      if (
        ["/api/settings", "/api/settings/ai"].includes(url.pathname) &&
        method === "POST"
      ) {
        const b = await body(req);
        await settings.update(url.pathname.endsWith("/ai") ? { ai: b } : b);
        send({ ok: true });
        return;
      }
      if (parts[1] === "agent" && parts[2] === "runs") {
        const run = entity(store.snapshot().runs, parts[3]);
        if (parts[4] === "events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });
          res.flushHeaders();
          let seq = 0;
          const from = Number(req.headers["last-event-id"] || 0);
          const write = (event: any) => {
            seq++;
            if (seq > from)
              res.write(
                `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              );
          };
          for (const event of run.events || []) write(event);
          if (
            ["preview_ready", "failed", "cancelled", "interrupted"].includes(
              run.status,
            )
          ) {
            res.end();
            return;
          }
          const listener = (event: any) => {
            write(event);
            if (["preview_ready", "failed", "cancelled"].includes(event.type))
              res.end();
          };
          agents.events.on(run.id, listener);
          const heartbeat = setInterval(
            () => res.write(": heartbeat\n\n"),
            15000,
          );
          res.on("close", () => {
            clearInterval(heartbeat);
            agents.events.off(run.id, listener);
          });
          return;
        }
        send(run);
        return;
      }
      if (url.pathname === "/api/projects") {
        if (method === "GET") {
          send({
            projects: store.snapshot().projects.map((p) =>
              url.searchParams.get("full") === "1"
                ? p
                : {
                    id: p.id,
                    name: p.name,
                    updatedAt: p.updatedAt,
                    documentCount: p.documents.length,
                    variableCount: p.variables.length,
                    bindingCount: p.bindings.length,
                  },
            ),
          });
          return;
        }
        if (method === "POST") {
          send(
            { project: await store.createProject((await body(req)).name) },
            201,
          );
          return;
        }
      }
      if (url.pathname === "/api/resolve-project" && method === "POST") {
        const b = await body(req),
          p = store
            .snapshot()
            .projects.find((p) =>
              p.documents.some((d) => d.key === b.documentKey),
            );
        send({
          project: p || null,
          document: p?.documents.find((d) => d.key === b.documentKey) || null,
        });
        return;
      }
      if (url.pathname === "/api/debug/prepare-sample" && method === "POST") {
        await body(req);
        send(await prepareSamples(store, assetDir));
        return;
      }
      if (url.pathname === "/api/debug/events" && method === "POST") {
        await body(req);
        send({ ok: true });
        return;
      }
      if (url.pathname === "/api/debug/recent") {
        send({ events: store.snapshot().runs });
        return;
      }
      if (url.pathname === "/api/debug/clear" && method === "POST") {
        await store.transaction((s) => {
          s.runs = s.runs.filter(
            (r) =>
              !["preview_ready", "failed", "cancelled", "interrupted"].includes(
                r.status,
              ),
          );
        });
        send({ ok: true });
        return;
      }
      if (url.pathname === "/api/diagnostics/export" && method === "POST") {
        const b = await body(req);
        const p = store.getProject(b.projectId);
        const data = {
          projectId: p.id,
          runs: store.snapshot().runs.filter((r) => r.projectId === p.id),
          ...(b.includeSourceData === true ? { project: p } : {}),
        };
        const filename = "diagnostics-" + id() + ".json",
          path = join(store.dir, "diagnostics", filename);
        await atomic(path, settings.redact(JSON.stringify(data, null, 2)));
        send({ filename, path });
        return;
      }
      if (parts[1] === "projects") {
        const pid = parts[2];
        store.getProject(pid);
        if (parts.length === 3) {
          if (method === "GET") {
            send({ project: store.getProject(pid) });
            return;
          }
          if (method === "PATCH") {
            const b = await body(req);
            send({
              project: await store.transaction((s) => {
                const p = project(s, pid);
                if (b.name?.trim()) p.name = b.name.trim();
                p.revision++;
                p.updatedAt = now();
                return p;
              }),
            });
            return;
          }
          if (method === "DELETE") {
            await store.transaction((s) => {
              if (
                s.runs.some(
                  (r) =>
                    r.projectId === pid &&
                    ["running", "reviewing", "waiting_tool"].includes(r.status),
                )
              )
                fail("AGENT_BUSY", "项目任务运行中", 409);
              s.projects = s.projects.filter((p) => p.id !== pid);
              s.drafts = s.drafts.filter((d) => d.projectId !== pid);
              s.pptChanges = s.pptChanges.filter((c) => c.projectId !== pid);
              s.variableRevisions = s.variableRevisions.filter(
                (r) => r.projectId !== pid,
              );
            });
            send({ ok: true });
            return;
          }
        }
        if (parts[3] === "documents" && method === "POST") {
          send(
            { document: await store.registerDocument(pid, await body(req)) },
            201,
          );
          return;
        }
        if (
          ["variables", "bindings"].includes(parts[3]) &&
          parts[4] === "preview" &&
          method === "POST"
        ) {
          const b = await body(req);
          const d = await agents.createDraft(
            pid,
            parts[3] === "variables" ? "transform" : "render",
            b,
          );
          if (b.async === true) {
            send(await agents.start(pid, d.id), 202);
          } else send(await agents.run(pid, d.id));
          return;
        }
        if (parts[3] === "drafts") {
          if (parts.length === 4 && method === "GET") {
            send({
              drafts: store
                .snapshot()
                .drafts.filter(
                  (d) =>
                    d.projectId === pid &&
                    d.input.documentId === url.searchParams.get("documentId") &&
                    [
                      "pending",
                      "running",
                      "preview_ready",
                      "failed",
                      "interrupted",
                    ].includes(d.status),
                )
                .map((d) => ({
                  id: d.id,
                  kind: d.kind,
                  status: d.status,
                  createdAt: d.createdAt,
                  name: d.input.name || d.input.description,
                })),
            });
            return;
          }
          const did = parts[4];
          if (method === "DELETE") {
            await agents.cancel(pid, did);
            send({ ok: true });
            return;
          }
          if (parts[5] === "resume" && method === "POST") {
            await body(req);
            send(await agents.start(pid, did), 202);
            return;
          }
          if (method === "GET") {
            const d = agents.draft(pid, did);
            send({ ...agents.preview(pid, did), kind: d.kind, input: d.input });
            return;
          }
        }
        if (
          parts[3] === "variables" &&
          parts[4] === "apply" &&
          method === "POST"
        ) {
          const b = await body(req);
          send(
            await agents.commitVariable(pid, b.draftId, b.acceptRisk === true),
            201,
          );
          return;
        }
        if (parts[3] === "sources" && method === "PATCH") {
          send(await refreshSource(store, pid, parts[4], await body(req)));
          return;
        }
        if (parts[3] === "variables" && parts[5] === "revisions") {
          if (method === "GET") {
            send({
              revisions: store
                .snapshot()
                .variableRevisions.filter(
                  (r) => r.projectId === pid && r.variableId === parts[4],
                )
                .reverse(),
            });
            return;
          }
          if (method === "POST") {
            send(await restoreVariable(store, pid, parts[4], await body(req)));
            return;
          }
        }
        if (
          parts[3] === "bindings" &&
          parts[5] === "plan" &&
          method === "GET"
        ) {
          const p = store.getProject(pid),
            binding = entity(p.bindings, parts[4]),
            v = entity(p.variables, binding.variableId);
          send({
            binding,
            plan: await render(v, binding.renderer, binding.target),
          });
          return;
        }
        if (
          ["variables", "bindings"].includes(parts[3]) &&
          parts.length === 5 &&
          method === "DELETE"
        ) {
          const key = parts[3] as "variables" | "bindings",
            eid = parts[4];
          await store.transaction((s) => {
            const p = project(s, pid);
            entity<any>(p[key], eid);
            if (
              key === "variables" &&
              p.bindings.some((b) => b.variableId === eid)
            )
              fail("IN_USE", "变量仍被输出引用", 409);
            if (
              s.pptChanges.some(
                (c) =>
                  c.projectId === pid &&
                  c.entries.some(
                    (e: any) =>
                      ["applied", "prepared", "undoing"].includes(e.status) &&
                      (e.afterBinding.id === eid ||
                        e.afterBinding.variableId === eid ||
                        e.beforeBinding?.variableId === eid),
                  ),
              )
            )
              fail("IN_USE", "请先撤销关联修改", 409);
            if (key === "variables")
              p.variables = p.variables.filter((v) => v.id !== eid);
            else p.bindings = p.bindings.filter((b) => b.id !== eid);
            p.revision++;
          });
          send({ ok: true });
          return;
        }
        if (parts[3] === "changes") {
          if (parts.length === 4 && method === "GET") {
            send({
              changes: changes.list(
                pid,
                url.searchParams.get("documentId") || "",
              ),
            });
            return;
          }
          if (parts.length === 4 && method === "POST") {
            send({ change: await changes.prepare(pid, await body(req)) }, 201);
            return;
          }
          if (parts[5] === "entries" && method === "POST") {
            send({
              change: await changes.transition(
                pid,
                parts[4],
                Number(parts[6]),
                await body(req),
              ),
            });
            return;
          }
        }
      }
      fail("NOT_FOUND", "接口不存在", 404);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const e =
        error instanceof AppError
          ? error
          : new AppError("INTERNAL_ERROR", "服务执行失败", 500);
      send(
        { error: settings.redact(e.message), code: e.code, hint: e.hint },
        e.status,
      );
    }
  });
  return server;
}
