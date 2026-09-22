import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, entity, project } from "../src/project/store.js";
import { AgentService } from "../src/agent/runtime.js";
import type { AgentRuntime } from "../src/agent/pi-runtime.js";
import { refreshSource } from "../src/project/operations.js";
import { reduced } from "../src/agent/context-builder.js";
const code =
  'function transform(rows,columns){return {valueType:"table",columns,value:rows.slice().sort((a,b)=>a.预算-b.预算)}}';
async function setup(t: any, fn?: (input: any, call: any) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "ra-agent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).open(),
    p = await store.createProject("项目"),
    doc = await store.registerDocument(p.id, { key: "/test.xlsx", kind: "et" });
  const contexts: any[] = [];
  const runtime: AgentRuntime = {
    async run(input) {
      contexts.push(JSON.parse(input.context));
      input.onTurn();
      const call = async (name: string, args: any = {}) => {
        const tool = input.tools.find((t) => t.name === name)!;
        const out = await tool.execute(
          "call",
          args,
          undefined,
          undefined,
          {} as any,
        );
        return JSON.parse((out.content[0] as any).text);
      };
      if (fn) await fn(input, call);
      else {
        await call("inspect_source");
        await call("run_transform_candidate", { code });
        await call("propose_memory_update", {
          category: "user-correction",
          content: "排序必须使用本年预算",
          scope: "variable",
        });
        await call("validate_candidate");
      }
    },
  };
  const service = new AgentService(store, runtime, {
    review: async () => ({ passed: true, issues: [], repairInstruction: "" }),
  });
  return {
    dir,
    store,
    p,
    doc,
    contexts,
    service,
    input: {
      documentId: doc.id,
      name: "预算",
      description: "预算升序",
      values: [["预算"], [2], [1]],
    },
  };
}
test("draft session survives commit, restart and follow-up; confirmed memory persists", async (t) => {
  const x = await setup(t);
  const draft = await x.service.createDraft(x.p.id, "transform", x.input);
  assert.equal(x.store.getProject(x.p.id).variables.length, 0);
  await x.service.run(x.p.id, draft.id);
  assert.equal(x.store.snapshot().memories[draft.sessionId], undefined);
  const { variable } = await x.service.commitVariable(x.p.id, draft.id);
  assert.equal(variable.sessionId, draft.sessionId);
  assert.match(
    await readFile(
      join(x.dir, "projects", x.p.id, "variables", variable.id, "memory.md"),
      "utf8",
    ),
    /本年预算/,
  );
  const restart = await new Store(x.dir).open();
  assert.equal(
    restart.getProject(x.p.id).variables[0].sessionId,
    draft.sessionId,
  );
  const follow = await x.service.createDraft(x.p.id, "transform", {
    ...x.input,
    variableId: variable.id,
  });
  assert.equal(follow.sessionId, draft.sessionId);
});
test("cancel discards memory; revision conflict prevents commit", async (t) => {
  const x = await setup(t),
    d = await x.service.createDraft(x.p.id, "transform", x.input);
  await x.service.run(x.p.id, d.id);
  await x.service.cancel(x.p.id, d.id);
  assert.equal(x.store.snapshot().memories[d.sessionId], undefined);
  assert.equal(x.service.draft(x.p.id, d.id).pendingMemory.length, 0);
  const d2 = await x.service.createDraft(x.p.id, "transform", x.input);
  await x.service.run(x.p.id, d2.id);
  const { variable } = await x.service.commitVariable(x.p.id, d2.id);
  const d3 = await x.service.createDraft(x.p.id, "transform", {
    ...x.input,
    variableId: variable.id,
  });
  await x.service.run(x.p.id, d3.id);
  await refreshSource(x.store, x.p.id, variable.sourceId, {
    values: [["预算"], [4]],
  });
  await assert.rejects(x.service.commitVariable(x.p.id, d3.id), {
    code: "STALE_VARIABLE_REVISION",
  });
});
test("syntax and schema errors are repaired through domain tools", async (t) => {
  const x = await setup(t, async (input, call) => {
    assert.equal(
      (await call("run_transform_candidate", { code: "function transform( {" }))
        .error.code,
      "SCRIPT_SYNTAX",
    );
    assert.equal(
      (
        await call("run_transform_candidate", {
          code: 'return {valueType:"number",columns:[],value:rows[0].旧预算}',
        })
      ).error.code,
      "SOURCE_SCHEMA_CHANGED",
    );
    assert.equal(
      (await call("run_transform_candidate", { code })).error.code,
      "SOURCE_SCHEMA_CHANGED",
    );
    await call("inspect_source");
    assert.equal((await call("run_transform_candidate", { code })).ok, true);
    await call("validate_candidate");
  });
  const d = await x.service.createDraft(x.p.id, "transform", x.input);
  assert.equal((await x.service.run(x.p.id, d.id)).status, "preview_ready");
});
test("large result never enters tools; fresh revision replaces old state", async (t) => {
  const x = await setup(t);
  const d = await x.service.createDraft(x.p.id, "transform", x.input);
  await x.service.run(x.p.id, d.id);
  const { variable } = await x.service.commitVariable(x.p.id, d.id);
  await x.store.transaction((s) => {
    entity(project(s, x.p.id).variables, variable.id).revision = 9;
  });
  const d2 = await x.service.createDraft(x.p.id, "transform", {
    ...x.input,
    variableId: variable.id,
  });
  await x.service.run(x.p.id, d2.id);
  assert.equal(x.contexts.at(-1).freshVariable.revision, 9);
  const reducedResult = reduced({
    columns: ["x"],
    value: Array.from({ length: 5000 }, (_, x) => ({ x })),
  });
  assert.equal(reducedResult.rowCount, 5000);
  assert.equal((reducedResult.sample as any[]).length, 10);
});
test("refresh failure preserves both source and variable, creates no agent turn", async (t) => {
  const x = await setup(t);
  const d = await x.service.createDraft(x.p.id, "transform", x.input);
  await x.service.run(x.p.id, d.id);
  const { variable } = await x.service.commitVariable(x.p.id, d.id);
  const before = x.store.getProject(x.p.id);
  await assert.rejects(
    refreshSource(x.store, x.p.id, variable.sourceId, {
      values: [["新预算"], [4], [3]],
    }),
    { code: "SOURCE_SCHEMA_CHANGED" },
  );
  assert.deepEqual(x.store.getProject(x.p.id), before);
  assert.equal(x.contexts.length, 1);
});

test("bound tools hide identity arguments and assign memory scope", async (t) => {
  const x = await setup(t, async (input, call) => {
    const identityFields = [
      "projectId",
      "sourceId",
      "variableId",
      "bindingId",
      "targetId",
      "scope",
    ];
    for (const tool of input.tools) {
      const properties = Object.keys((tool.parameters as any).properties || {});
      assert.deepEqual(
        properties.filter((key) => identityFields.includes(key)),
        [],
        tool.name,
      );
    }
    const memory = await call("propose_memory_update", {
      category: "user-correction",
      content: "本年预算按用户确认的规则处理",
    });
    assert.equal(memory.pending, true);
    assert.equal(x.store.snapshot().drafts[0].pendingMemory[0].scope, "variable");
    await call("inspect_source");
    await call("run_transform_candidate", { code });
    await call("validate_candidate");
  });
  const d = await x.service.createDraft(x.p.id, "transform", x.input);
  await x.service.run(x.p.id, d.id);
});

test("renderer critic reviews the transformed variable instead of raw source", async (t) => {
  const x = await setup(t);
  const variableDraft = await x.service.createDraft(x.p.id, "transform", x.input);
  await x.service.run(x.p.id, variableDraft.id);
  const { variable } = await x.service.commitVariable(x.p.id, variableDraft.id);
  let evidence: any;
  const renderService = new AgentService(
    x.store,
    {
      async run(input) {
        input.onTurn();
        const call = async (name: string, args: any = {}) => {
          const tool = input.tools.find((item) => item.name === name)!;
          return tool.execute("call", args, undefined, undefined, {} as any);
        };
        await call("inspect_variable");
        await call("inspect_binding");
        await call("inspect_target");
        await call("run_renderer_candidate", {
          code: 'function render(variable){return {kind:"table",header:variable.columns,rows:variable.value.map(function(row){return variable.columns.map(function(column){return row[column]})})}}',
        });
        await call("validate_candidate");
      },
    },
    {
      async review(input) {
        evidence = input;
        return { passed: true, issues: [], repairInstruction: "" };
      },
    },
  );
  const d = await renderService.createDraft(x.p.id, "render", {
    documentId: x.doc.id,
    variableId: variable.id,
    description: "展示已处理后的预算变量",
    target: {
      kind: "table",
      snapshot: { rows: 9, columns: 1, cells: Array.from({ length: 9 }, () => [""]) },
    },
    targetSnapshot: {
      version: 1,
      kind: "table",
      comparison: { rows: 9, columns: 1 },
    },
  });
  await renderService.run(x.p.id, d.id);
  assert.equal(evidence.source, undefined);
  assert.equal(evidence.variable.rowCount, variable.value.length);
  assert.deepEqual(evidence.variable.columns, variable.columns);
});

test("execution limit stops at five sandbox candidates", async (t) => {
  const x = await setup(t, async (_input, call) => {
    for (let i = 0; i < 6; i++) {
      await call("run_transform_candidate", { code });
      await call("validate_candidate");
    }
  });
  const d = await x.service.createDraft(x.p.id, "transform", x.input);
  await assert.rejects(x.service.run(x.p.id, d.id), { code: "AGENT_LIMIT" });
  assert.equal(x.store.snapshot().runs[0].candidateHashes.length, 5);
  assert.equal(x.service.draft(x.p.id, d.id).status, "failed");
});
test("same session rejects concurrent run; cancel interrupts and discards memory", async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const x = await setup(t, async (input, call) => {
    await call("propose_memory_update", {
      category: "user-correction",
      content: "待确认",
    });
    entered();
    await new Promise<void>((resolve, reject) =>
      input.signal.addEventListener(
        "abort",
        () => reject(new Error("cancelled")),
        { once: true },
      ),
    );
  });
  const d = await x.service.createDraft(x.p.id, "transform", x.input),
    running = x.service.run(x.p.id, d.id);
  await started;
  await assert.rejects(x.service.run(x.p.id, d.id), {
    code: "VARIABLE_AGENT_BUSY",
  });
  await x.service.cancel(x.p.id, d.id);
  await assert.rejects(running, { code: "CANCELLED" });
  assert.equal(x.service.draft(x.p.id, d.id).pendingMemory.length, 0);
});
test("critic is stateless, repairs twice, then requires explicit risk acceptance", async (t) => {
  const x = await setup(t);
  let reviews = 0,
    turns = 0;
  const service = new AgentService(
    x.store,
    {
      async run(input) {
        turns++;
        input.onTurn();
        for (const [name, args] of [
          ["run_transform_candidate", { code }],
          ["validate_candidate", {}],
        ] as any)
          await input.tools
            .find((t) => t.name === name)!
            .execute("id", args, undefined, undefined, {} as any);
      },
    },
    {
      async review(evidence) {
        reviews++;
        assert.equal(evidence.memory, undefined);
        assert.equal(evidence.messages, undefined);
        return {
          passed: false,
          issues: ["语义不确定"],
          repairInstruction: "检查排序",
        };
      },
    },
  );
  const d = await service.createDraft(x.p.id, "transform", x.input);
  const out = await service.run(x.p.id, d.id);
  assert.equal(turns, 3);
  assert.equal(reviews, 3);
  assert.equal(out.requiresRiskAcceptance, true);
  await assert.rejects(service.commitVariable(x.p.id, d.id), {
    code: "RISK_ACK_REQUIRED",
  });
  await service.commitVariable(x.p.id, d.id, true);
});

test("model turn budget rejects the ninth turn", async (t) => {
  const x = await setup(t, async (input) => {
    for (let i = 0; i < 8; i++) input.onTurn();
  });
  const d = await x.service.createDraft(x.p.id, "transform", x.input);
  await assert.rejects(x.service.run(x.p.id, d.id), { code: "AGENT_LIMIT" });
});
test("global concurrency cap and total timeout release both slots", async (t) => {
  const x = await setup(t);
  const runtime: AgentRuntime = {
    async run(input) {
      await new Promise<void>((_, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    },
  };
  const service = new AgentService(
    x.store,
    runtime,
    {
      review: async () => ({ passed: true, issues: [], repairInstruction: "" }),
    },
    2,
    150,
  );
  const drafts = await Promise.all(
    [1, 2, 3].map(() => service.createDraft(x.p.id, "transform", x.input)),
  );
  const runs = drafts
    .slice(0, 2)
    .map((d) => service.run(x.p.id, d.id).catch((e) => e));
  await assert.rejects(service.run(x.p.id, drafts[2].id), {
    code: "AGENT_BUSY",
  });
  for (const outcome of await Promise.all(runs))
    assert.equal(outcome.code, "CANCELLED");
  await assert.rejects(service.run(x.p.id, drafts[2].id), {
    code: "CANCELLED",
  });
  assert.equal(
    x.store.snapshot().runs.filter((r) => r.status === "running").length,
    0,
  );
});
