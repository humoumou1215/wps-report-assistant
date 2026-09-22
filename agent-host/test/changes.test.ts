import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, id, now } from "../src/project/store.js";
import { AgentService } from "../src/agent/runtime.js";
import { Changes } from "../src/project/changes.js";
test("binding drafts share variable session; stale target rejection and Apply/Undo persist", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-binding-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).open(),
    p = await store.createProject("P"),
    doc = await store.registerDocument(p.id, { key: "/a.pptx", kind: "wpp" }),
    sessionId = id();
  await store.transaction((s) => {
    const p = s.projects[0];
    p.sources.push({
      id: "src",
      revision: 1,
      documentId: doc.id,
      values: [["预算"], [10000]],
    });
    p.variables.push({
      id: "var",
      revision: 1,
      sessionId,
      sourceId: "src",
      transform: {},
      valueType: "number",
      columns: [],
      value: 10000,
      updatedAt: now(),
    });
  });
  const contexts: any[] = [];
  const service = new AgentService(
    store,
    {
      async run(input) {
        contexts.push(JSON.parse(input.context));
        input.onTurn();
        for (const [name, args] of [
          ["inspect_binding", {}],
          [
            "run_renderer_candidate",
            {
              code: 'function render(variable,target){return {kind:"text",text:String(variable.value)}}',
            },
          ],
          [
            "propose_memory_update",
            { category: "binding-decision", content: "金额单位保持元" },
          ],
          ["validate_candidate", {}],
        ] as any)
          await input.tools
            .find((t) => t.name === name)!
            .execute("id", args, undefined, undefined, {} as any);
      },
    },
    {
      review: async () => ({ passed: true, issues: [], repairInstruction: "" }),
    },
  );
  const before = { version: 1, kind: "text", text: { text: "old" } },
    after = { version: 1, kind: "text", text: { text: "10000" } },
    target = { kind: "text", slideId: 1, shapeId: 2 };
  const draft = await service.createDraft(p.id, "render", {
    documentId: doc.id,
    variableId: "var",
    description: "按元展示",
    target,
    targetSnapshot: before,
  });
  assert.equal(draft.sessionId, sessionId);
  const preview = await service.run(p.id, draft.id),
    changes = new Changes(store);
  const request = {
    requestId: id(),
    documentId: doc.id,
    entries: [{ draftId: draft.id, expectedPlan: preview.plan, before }],
  };
  await assert.rejects(
    changes.prepare(p.id, {
      ...request,
      entries: [{ ...request.entries[0], before: after }],
    }),
    { code: "TARGET_CHANGED" },
  );
  const prepared = await changes.prepare(p.id, request);
  assert.equal(store.getProject(p.id).bindings.length, 0);
  assert.equal((await changes.prepare(p.id, request)).id, prepared.id);
  await assert.rejects(service.cancel(p.id, draft.id), {
    code: "DRAFT_COMMITTED",
  });
  const applied = await changes.transition(p.id, prepared.id, 0, {
    action: "complete",
    snapshot: after,
  });
  assert.equal(applied.entries[0].status, "applied");
  const binding = store.getProject(p.id).bindings[0];
  assert.equal(
    store.snapshot().memories[sessionId][0].scope,
    "binding:" + binding.id,
  );
  await assert.rejects(
    changes.transition(p.id, prepared.id, 0, {
      action: "undo-start",
      snapshot: { ...after, text: { text: "manual" } },
    }),
    { code: "TARGET_CHANGED" },
  );
  const edit = await service.createDraft(p.id, "render", {
    documentId: doc.id,
    variableId: "var",
    bindingId: binding.id,
    description: "保留元并再次确认",
    target,
    targetSnapshot: after,
  });
  const editPreview = await service.run(p.id, edit.id);
  const editChange = await changes.prepare(p.id, {
    requestId: id(),
    documentId: doc.id,
    entries: [
      { draftId: edit.id, expectedPlan: editPreview.plan, before: after },
    ],
  });
  await changes.transition(p.id, editChange.id, 0, {
    action: "complete",
    snapshot: after,
  });
  const appliedRevision = store.getProject(p.id).bindings[0].revision;
  await changes.transition(p.id, editChange.id, 0, {
    action: "undo-start",
    snapshot: after,
  });
  await changes.transition(p.id, editChange.id, 0, {
    action: "undo-complete",
    snapshot: after,
  });
  assert.ok(store.getProject(p.id).bindings[0].revision > appliedRevision);
  assert.equal(store.snapshot().memories[sessionId].length, 1);
  const restarted = new Changes(await new Store(dir).open());
  await restarted.transition(p.id, prepared.id, 0, {
    action: "undo-start",
    snapshot: after,
  });
  await restarted.transition(p.id, prepared.id, 0, {
    action: "undo-complete",
    snapshot: before,
  });
  assert.equal(
    (await new Store(dir).open()).getProject(p.id).bindings.length,
    0,
  );
  // An unrelated binding must never receive this binding's semantic memory.
  const second = await service.createDraft(p.id, "render", {
    documentId: doc.id,
    variableId: "var",
    description: "按万元展示",
    target: { ...target, shapeId: 3 },
    targetSnapshot: before,
  });
  await service.run(p.id, second.id);
  assert.deepEqual(contexts.at(-1).memory, []);
});
