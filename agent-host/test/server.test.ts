import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/project/store.js";
import { Settings } from "../src/model/settings.js";
import { createHost } from "../src/server/http-server.js";

test("HTTP authentication, origin checks, secret isolation and retired APIs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).open(), settings = await new Settings(dir).open();
  const server = createHost(store, settings, dir, { version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = "http://127.0.0.1:" + (server.address() as any).port;

  assert.equal((await fetch(base + "/api/projects")).status, 401);
  assert.equal((await fetch(base + "/api/health", { headers: { Origin: "https://evil.example" } })).status, 403);
  const token = ((await (await fetch(base + "/api/health")).json()) as any).token;
  const request = async (path: string, method = "GET", value?: any) => fetch(base + path, {
    method,
    headers: { "X-RA-Token": token, "Content-Type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const api = async (path: string, method = "GET", value?: any) => {
    const response = await request(path, method, value), data = await response.json() as any;
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };

  await api("/api/settings", "POST", { ai: { apiKey: "secret-sentinel", enabled: true, model: "test" } });
  const publicSettings = await api("/api/settings");
  assert.equal(publicSettings.ai.apiKeyConfigured, true);
  assert.equal(publicSettings.ai.apiKey, undefined);
  assert.equal(publicSettings.debug, undefined);
  assert.equal(publicSettings.agent, undefined);
  assert.ok(!(await readFile(join(dir, "settings.json"), "utf8")).includes("secret-sentinel"));

  const item = (await api("/api/projects", "POST", { name: "current workflow" })).project;
  const document = (await api(`/api/projects/${item.id}/documents`, "POST", { key: "/a.xlsx", kind: "et" })).document;
  assert.equal((await api(`/api/projects/${item.id}/documents/${document.id}/index`)).documentId, document.id);
  assert.equal((await api(`/api/projects/${item.id}/render-records`)).integrity.ok, true);

  for (const path of [
    `/api/projects/${item.id}/variables/preview`,
    `/api/projects/${item.id}/variables/apply`,
    `/api/projects/${item.id}/render-records`,
    `/api/projects/${item.id}/drafts`,
    `/api/agent/runs/old`,
    "/api/debug/recent",
    "/api/diagnostics/export",
  ]) assert.equal((await request(path, "POST", {})).status, 404, path);
});
