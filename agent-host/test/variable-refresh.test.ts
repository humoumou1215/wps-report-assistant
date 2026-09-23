import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, id, now } from "../src/project/store.js";
import { refreshSource } from "../src/project/operations.js";
import { bindingFreshness } from "../src/project/variable-knowledge.js";

test("source refresh recomputes multi-input variable DAG without AI and marks old outputs stale", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-variable-refresh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).open();
  const project = await store.createProject("refresh");
  const doc = await store.registerDocument(project.id, { key: "refresh.xlsx", kind: "et" });
  const sourceA = "source-a", sourceB = "source-b", variableA = "variable-a", variableB = "variable-b";
  await store.transaction((state) => {
    const p = state.projects.find((item) => item.id === project.id)!;
    p.sources.push(
      { id: sourceA, projectId: p.id, documentId: doc.id, revision: 1, values: [["amount"], [2], [3]], createdAt: now() },
      { id: sourceB, projectId: p.id, documentId: doc.id, revision: 1, values: [["extra"], [10]], createdAt: now() },
    );
    p.variables.push(
      {
        id: variableA, projectId: p.id, revision: 1, inputs: [{ type: "source", sourceId: sourceA }],
        transform: { language: "javascript", version: 2, code: 'function transform(rows,columns,sources){return {valueType:"number",columns:[],value:rows.reduce((sum,row)=>sum+row.amount,0)}}' },
        valueType: "number", columns: [], value: 5, createdAt: now(), updatedAt: now(),
      },
      {
        id: variableB, projectId: p.id, revision: 1,
        inputs: [{ type: "variable", variableId: variableA }, { type: "source", sourceId: sourceB }],
        transform: { language: "javascript", version: 2, code: 'function transform(rows,columns,sources){return {valueType:"number",columns:[],value:sources["variable:variable-a"].rows[0].value+sources["source:source-b"].rows[0].extra}}' },
        valueType: "number", columns: [], value: 15, createdAt: now(), updatedAt: now(),
      },
    );
    p.bindings.push({ id: id(), variableId: variableB, documentId: doc.id, revision: 1, target: {}, renderer: {}, lastRenderedVariableRevision: 1, createdAt: now(), updatedAt: now() });
  });

  const first = await refreshSource(store, project.id, sourceA, { values: [["amount"], [5], [6]] });
  let current = store.getProject(project.id);
  assert.deepEqual(first.repairRequired, []);
  assert.equal(current.variables.find((item) => item.id === variableA)?.value, 11);
  assert.equal(current.variables.find((item) => item.id === variableB)?.value, 21);
  assert.equal(bindingFreshness(current.bindings[0], current.variables.find((item) => item.id === variableB)!), "stale");
  assert.deepEqual(current.variables.find((item) => item.id === variableB)?.inputRevisions, {
    "variable:variable-a": 2,
    "source:source-b": 1,
  });

  await refreshSource(store, project.id, sourceB, { values: [["extra"], [20]] });
  current = store.getProject(project.id);
  assert.equal(current.variables.find((item) => item.id === variableA)?.value, 11);
  assert.equal(current.variables.find((item) => item.id === variableB)?.value, 31);
  assert.equal(current.sources.find((item) => item.id === sourceB)?.revision, 2);
});
