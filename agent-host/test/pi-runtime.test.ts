import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PiRuntime } from "../src/agent/pi-runtime.js";

test("actual Pi SDK: explicit tool allowlist, durable native session and resume against fake OpenAI stream", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-pi-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(dir, ".pi", "extensions", "poison.js"),
    'throw new Error("USER_EXTENSION_WAS_LOADED")',
  );
  await writeFile(join(dir, "AGENTS.md"), "POISON_CONTEXT_DO_NOT_LOAD");
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta: any, finish_reason: any = null) =>
      res.write(
        "data: " +
          JSON.stringify({
            id: "fake",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n",
      );
    send({ role: "assistant", content: "已记录规则" });
    send({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const settings = () => ({
    enabled: true,
    model: "test-model",
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    apiKey: "test-secret",
    thinking: "off",
  });
  const sessionId = randomUUID(),
    input = {
      sessionId,
      context: "按本年预算排序",
      tools: [
        {
          name: "inspect_source",
          label: "inspect_source",
          description: "read current schema",
          parameters: { type: "object", properties: {} },
          execute: async () => ({
            content: [{ type: "text", text: "schema" }],
            details: {},
          }),
        },
      ] as any,
      signal: new AbortController().signal,
      onTurn: () => {},
    };
  await new PiRuntime(dir, settings).run(input);
  await new PiRuntime(dir, settings).run({ ...input, context: "改成升序" });
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[0].tools.map((x: any) => x.function.name),
    ["inspect_source"],
  );
  assert.ok(!JSON.stringify(requests).includes("POISON_CONTEXT"));
  assert.match(JSON.stringify(requests[1].messages), /本年预算/);
  const files = (await readdir(join(dir, "sessions", sessionId))).filter((f) =>
    f.endsWith(".jsonl"),
  );
  assert.equal(files.length, 1);
  const persisted = await readFile(
    join(dir, "sessions", sessionId, files[0]),
    "utf8",
  );
  assert.match(persisted, /改成升序/);
  assert.ok(!persisted.includes("test-secret"));
  assert.equal(JSON.parse(persisted.split("\n")[0]).id, sessionId);
});

test("actual Pi tool loop repairs syntax error and validates executed candidate", async (t) => {
  const { Store } = await import("../src/project/store.js");
  const { AgentService } = await import("../src/agent/runtime.js");
  const dir = await mkdtemp(join(tmpdir(), "ra-pi-loop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests: any[] = [];
  const calls = [
    { name: "inspect_source", args: {} },
    {
      name: "run_transform_candidate",
      args: { code: "function transform( {" },
    },
    {
      name: "run_transform_candidate",
      args: {
        code: 'function transform(rows,columns){return {valueType:"table",columns,value:rows}}',
      },
    },
    { name: "validate_candidate", args: {} },
  ];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text));
    const call = calls[requests.length - 1];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = call
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_" + requests.length,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            },
          ],
        }
      : { role: "assistant", content: "候选验证完成" };
    res.write(
      "data: " +
        JSON.stringify({
          id: "test",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta, finish_reason: null }],
        }) +
        "\n\n",
    );
    res.write(
      "data: " +
        JSON.stringify({
          id: "test",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: call ? "tool_calls" : "stop",
            },
          ],
        }) +
        "\n\n",
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const store = await new Store(dir).open(),
    p = await store.createProject("Pi Test"),
    doc = await store.registerDocument(p.id, {
      key: "/source.xlsx",
      kind: "et",
    }),
    cfg = () => ({
      enabled: true,
      model: "test-model",
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      apiKey: "test-key",
    });
  const service = new AgentService(store, new PiRuntime(dir, cfg), {
    review: async () => ({ passed: true, issues: [], repairInstruction: "" }),
  });
  const draft = await service.createDraft(p.id, "transform", {
    documentId: doc.id,
    name: "本年预算",
    values: [
      ["本年预算"],
      ...Array.from({ length: 5000 }, (_, i) => ["sensitive-row-" + i]),
    ],
    description: "保留本年预算",
  });
  const preview = await service.run(p.id, draft.id);
  assert.equal(preview.status, "preview_ready");
  assert.equal(preview.result.value.length, 5000);
  assert.ok(!JSON.stringify(requests).includes("sensitive-row-4999"));
  assert.equal(requests.length, 5);
  assert.match(JSON.stringify(requests[2].messages), /SCRIPT_SYNTAX/);
  const committed = await service.commitVariable(p.id, draft.id);
  assert.ok(committed.variable.sessionEntryId);
  assert.ok(store.snapshot().runs[0].tokenUsage);
});

test("native Pi compaction receives product memory rules and retains tree entries", async (t) => {
  const { SessionRegistry } = await import("../src/agent/session-registry.js");
  const dir = await mkdtemp(join(tmpdir(), "ra-pi-compact-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionId = randomUUID(),
    registry = new SessionRegistry(dir),
    manager = await registry.resume(sessionId);
  for (let i = 0; i < 4; i++) {
    manager.appendMessage({
      role: "user",
      content: "用户目标：正式员工、本年预算降序。" + "历史说明。".repeat(5000),
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "已确认使用本年预算。" }],
      api: "openai-completions",
      provider: "report-assistant",
      model: "test-model",
      usage: {
        input: 50000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 50100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } as any);
  }
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [delta, finish_reason] of [
      [
        {
          role: "assistant",
          content: "用户目标：正式员工、本年预算；历史不是实时事实。",
        },
        null,
      ],
      [{}, "stop"],
    ])
      res.write(
        "data: " +
          JSON.stringify({
            id: "compact",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n",
      );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  await new PiRuntime(dir, () => ({
    enabled: true,
    model: "test-model",
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    apiKey: "test-key",
  })).run({
    sessionId,
    context: "Fresh State revision 9；改成升序",
    tools: [],
    signal: new AbortController().signal,
    onTurn: () => {},
  });
  assert.ok(requests.length >= 2);
  assert.match(JSON.stringify(requests[0]), /明确纠正/);
  assert.match(JSON.stringify(requests[0]), /不是实时业务事实/);
  const restored = await registry.resume(sessionId);
  assert.ok(restored.getEntries().some((e) => e.type === "compaction"));
  assert.equal(restored.getSessionId(), sessionId);
  assert.ok(
    restored.getEntries().filter((e) => e.type === "message").length >= 4,
  );
});
