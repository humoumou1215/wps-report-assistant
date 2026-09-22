import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/project/store.js";
import { Settings } from "../src/model/settings.js";
import { AgentService } from "../src/agent/runtime.js";
import { createHost } from "../src/server/http-server.js";
test("HTTP token, hostile origin, secret isolation, preview and restart recovery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).open(),
    settings = await new Settings(dir).open();
  const runtime = {
    async run(input: any) {
      input.onTurn();
      for (const [name, args] of [
        ["inspect_source", {}],
        [
          "run_transform_candidate",
          { code: 'return {valueType:"table",columns,value:rows}' },
        ],
        ["validate_candidate", {}],
      ] as any) {
        await input.tools.find((x: any) => x.name === name).execute("id", args);
      }
    },
  };
  const agents = new AgentService(store, runtime, {
      review: async () => ({ passed: true, issues: [], repairInstruction: "" }),
    }),
    server = createHost(store, settings, agents, dir);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = "http://127.0.0.1:" + (server.address() as any).port;
  assert.equal((await fetch(url + "/api/projects")).status, 401);
  assert.equal(
    (
      await fetch(url + "/api/health", {
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const token = ((await (await fetch(url + "/api/health")).json()) as any)
    .token;
  const api = async (path: string, body?: any) => {
    const r = await fetch(url + path, {
      method: body ? "POST" : "GET",
      headers: { "X-RA-Token": token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data: any = await r.json();
    assert.ok(r.ok, JSON.stringify(data));
    return data;
  };
  await api("/api/settings/ai", { apiKey: "secret-sentinel", enabled: true });
  const publicSettings = await api("/api/settings");
  assert.equal(publicSettings.ai.apiKeyConfigured, true);
  assert.equal(publicSettings.ai.apiKey, undefined);
  assert.ok(
    !(await readFile(join(dir, "settings.json"), "utf8")).includes(
      "secret-sentinel",
    ),
  );
  const p = (await api("/api/projects", { name: "test" })).project,
    doc = (
      await api("/api/projects/" + p.id + "/documents", {
        key: "/a.xlsx",
        kind: "et",
      })
    ).document;
  const d = await api("/api/projects/" + p.id + "/variables/preview", {
    name: "test",
    documentId: doc.id,
    description: "保留",
    values: [["x"], [1]],
  });
  assert.equal(d.status, "preview_ready");
  const committed = await api("/api/projects/" + p.id + "/variables/apply", {
    draftId: d.draftId,
  });
  assert.equal(committed.variable.sessionId, d.sessionId);
  await store.transaction((s) => {
    s.runs.push({
      id: "interrupted-run",
      projectId: p.id,
      draftId: "x",
      sessionId: d.sessionId,
      status: "running",
      startedAt: "now",
    });
  });
  assert.equal(
    (await new Store(dir).open()).snapshot().runs.at(-1)?.status,
    "interrupted",
  );
});
