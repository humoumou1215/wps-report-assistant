import test from "node:test";
import assert from "node:assert/strict";
import { transform, render } from "../src/legacy/execute.js";
test("legacy DSL filtering, derivation, aliases, group and render remain executable", async () => {
  const values = [
    ["部门", "预算", "状态"],
    ["A", 10000, "正式"],
    ["B", 20000, "正式"],
    ["A", 30000, "临时"],
  ];
  const result = await transform(values, {
    version: 1,
    steps: [
      { type: "filter", op: "eq", field: "状态", value: "正式" },
      {
        op: "derive",
        as: "万元",
        expr: { fn: "div", args: [{ field: "预算" }, { value: 10000 }] },
      },
      { op: "sort", field: "预算", direction: "desc" },
      { op: "select", fields: ["部门", "万元"] },
    ],
    output: { type: "table" },
  });
  assert.deepEqual(result.value, [
    { 部门: "B", 万元: 2 },
    { 部门: "A", 万元: 1 },
  ]);
  assert.deepEqual(
    await render(result, {
      renderer: {
        type: "table",
        columns: [{ field: "部门" }, { field: "万元", numberFormat: "0.00" }],
      },
    }),
    {
      kind: "table",
      header: ["部门", "万元"],
      rows: [
        ["B", "2.00"],
        ["A", "1.00"],
      ],
      resizeRows: true,
    },
  );
  const grouped = await transform(values, {
    version: 1,
    steps: [
      {
        op: "groupAggregate",
        by: ["部门"],
        aggregates: [{ fn: "sum", field: "预算", as: "合计" }],
      },
    ],
  });
  assert.deepEqual(grouped.value, [
    { 部门: "A", 合计: 40000 },
    { 部门: "B", 合计: 20000 },
  ]);
});
test("legacy dynamic programs execute without granting agent dynamic tools", async () => {
  const result = await transform([["x"], [1], [2]], {
    version: 1,
    steps: [
      {
        op: "dynamic",
        program: {
          language: "ra-cap-v1",
          stage: "transform",
          steps: [
            {
              op: "map",
              columns: [
                { name: "n", expr: { op: "mul", args: [{ field: "x" }, 2] } },
              ],
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(result.value, [{ n: 2 }, { n: 4 }]);
  const plan = await render(result, {
    kind: "dynamic",
    program: {
      language: "ra-cap-v1",
      stage: "render",
      kind: "table",
      columns: [
        { label: "序号", expr: { var: "rowNumber" } },
        { label: "数", expr: { field: "n" } },
      ],
    },
  });
  assert.deepEqual(plan.rows, [
    ["1", "2"],
    ["2", "4"],
  ]);
});
test("legacy JavaScript body and full function retain array and scalar result shorthand", async () => {
  assert.deepEqual(
    await transform([["x"], [1]], {
      language: "javascript",
      version: 1,
      code: "return rows;",
    }),
    { valueType: "table", columns: ["x"], value: [{ x: 1 }] },
  );
  assert.deepEqual(
    await transform([["x"], [1]], {
      language: "javascript",
      version: 1,
      code: "function transform(rows){return rows[0].x;}",
    }),
    { valueType: "number", columns: [], value: 1 },
  );
});
