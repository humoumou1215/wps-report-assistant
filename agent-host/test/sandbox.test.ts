import test from "node:test";
import assert from "node:assert/strict";
import { execute, sourceRows } from "../src/sandbox/client.js";
import { normalizeScript } from "../src/sandbox/normalize-script.js";
test("canonical renderer regression: full function returns its plan", async () => {
  const out = await execute(
    'function render(variable,target){return {kind:"text",text:"42"}}',
    "render",
    { variable: {}, target: { kind: "text" } },
  );
  assert.deepEqual(out.result, { kind: "text", text: "42" });
});
test("normalizes arrows, declarations and bodies", async () => {
  for (const code of [
    '(variable,target)=>({kind:"text",text:"ok"})',
    'const render=(variable,target)=>({kind:"text",text:"ok"});',
    'return {kind:"text",text:"ok"};',
  ])
    assert.equal(
      (await execute(code, "render", { variable: {}, target: {} })).result.text,
      "ok",
    );
  assert.throws(() => normalizeScript("function wrong() {}", "render"), {
    code: "SCRIPT_CONTRACT_ERROR",
  });
  assert.throws(() => normalizeScript("function render( {", "render"), {
    code: "SCRIPT_SYNTAX",
  });
});
test("no Node, clock, random, network or async globals", async () => {
  const out = await execute(
    'function render(){return {kind:"text",text:[typeof process,typeof require,typeof Buffer,typeof fetch,typeof Date,typeof Math.random,typeof Promise].join(",")}}',
    "render",
    {},
  );
  assert.equal(out.result.text, Array(7).fill("undefined").join(","));
});
test("timeout kills worker and host can run another candidate", async () => {
  await assert.rejects(
    execute("function render(){while(true){}}", "render", {}),
    { code: "SCRIPT_TIMEOUT" },
  );
  assert.equal(
    (await execute('return {kind:"text",text:"alive"}', "render", {})).result
      .text,
    "alive",
  );
});
test("structured missing field and missing return", async () => {
  await assert.rejects(
    execute(
      'function transform(rows){return {valueType:"number",columns:[],value:rows[0].old}}',
      "transform",
      sourceRows([["current"], [1]]),
    ),
    { code: "SOURCE_SCHEMA_CHANGED" },
  );
  await assert.rejects(execute("function render(){}", "render", {}), {
    code: "SCRIPT_NO_RETURN",
  });
});
test("result validation, nonfinite and output size", async () => {
  await assert.rejects(
    execute(
      'return {valueType:"table",columns:["x"],value:[{}]}',
      "transform",
      { rows: [], columns: [] },
    ),
    { code: "RESULT_SCHEMA_INVALID" },
  );
  await assert.rejects(
    execute(
      'return {valueType:"number",columns:[],value:NaN}',
      "transform",
      {},
    ),
    { code: "RESULT_SCHEMA_INVALID" },
  );
  await assert.rejects(
    execute('return {kind:"text",text:"a".repeat(2200000)}', "render", {}),
    { code: "SCRIPT_RESULT_TOO_LARGE" },
  );
});
test("renderer capacity is inferred from host cell snapshots", async () => {
  await assert.rejects(
    execute(
      'return {kind:"table",header:["x"],rows:[[1],[2],[3]]}',
      "render",
      {
        variable: {},
        target: { kind: "table", snapshot: { cells: [[""], [""]] } },
      },
    ),
    { code: "RESULT_SCHEMA_INVALID" },
  );
});
test("worker transport preserves multi-byte text across stdout chunks", async () => {
  const text = "预算😊".repeat(40000);
  const out = await execute(
    'return {kind:"text",text:"预算😊".repeat(40000)}',
    "render",
    {},
  );
  assert.equal(out.result.text, text);
});

test("transform output cannot overwrite variable identity metadata", async () => {
  const result = await execute(
    'function transform(){return {valueType:"number",columns:[],value:1,id:"spoof",sessionId:"spoof",sourceId:"spoof",transform:{code:"spoof"}}}',
    "transform",
    { rows: [], columns: [] },
  );
  assert.deepEqual(result.result, {
    valueType: "number",
    columns: [],
    value: 1,
  });
});
