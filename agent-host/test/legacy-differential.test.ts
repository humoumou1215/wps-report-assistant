import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { transform, render } from "../src/legacy/execute.js";

test("legacy migration compares TypeScript results against the retained Go executor", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-go-oracle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const core = fileURLToPath(new URL("../../../../core-go/", import.meta.url));
  for (const file of await readdir(core))
    if (
      file === "go.mod" ||
      file === "go.sum" ||
      (file.endsWith(".go") && !file.endsWith("_test.go"))
    )
      await copyFile(join(core, file), join(dir, file));
  await writeFile(
    join(dir, "zz_oracle.go"),
    `package main
import("encoding/json";"os")
func init(){if len(os.Args)!=2||os.Args[1]!="--legacy-oracle"{return}; var input struct {Stage string \x60json:"stage"\x60; Values any \x60json:"values"\x60; Spec map[string]any \x60json:"spec"\x60; Variable Variable \x60json:"variable"\x60}; if err:=json.NewDecoder(os.Stdin).Decode(&input);err!=nil{panic(err)};var result any;var err error;if input.Stage=="transform"{result,err=ExecuteTransform(input.Values,input.Spec)}else{result,err=RenderPlan(input.Variable,input.Spec)};if err!=nil{json.NewEncoder(os.Stdout).Encode(map[string]any{"error":err.Error()})}else{json.NewEncoder(os.Stdout).Encode(map[string]any{"result":result})};os.Exit(0)}
`,
  );
  const binary = join(
    dir,
    process.platform === "win32" ? "oracle.exe" : "oracle",
  );
  execFileSync("go", ["build", "-o", binary, "."], {
    cwd: dir,
    timeout: 60000,
  });
  const oracle = (input: any) => {
    const out = JSON.parse(
      execFileSync(binary, ["--legacy-oracle"], {
        input: JSON.stringify(input),
        timeout: 10000,
      }).toString(),
    );
    if (out.error) throw new Error(out.error);
    return out.result;
  };
  const cases: any[] = [
    {
      name: "legacy JavaScript duplicate and blank headers",
      values: [
        ["x", "x", ""],
        [1, 2, 3],
      ],
      spec: { language: "javascript", version: 1, code: "return rows;" },
    },
    {
      name: "identity and duplicate empty headers",
      values: [
        ["x", "x", "", null],
        [1, 2, 3, 4],
      ],
      spec: { version: 1, steps: [] },
    },
    { name: "empty source", values: [], spec: { version: 1, steps: [] } },
    {
      name: "no header, ragged rows",
      values: [[1], [2, 3]],
      spec: { version: 1, headersMode: "none", steps: [] },
    },
    {
      name: "filter alias and descending numeric sort",
      values: [
        ["x", "active"],
        [3, "yes"],
        [1, "no"],
        [2, "yes"],
      ],
      spec: {
        version: 1,
        steps: [
          { type: "filter", op: "eq", field: "active", value: "yes" },
          { op: "sort", field: "x", direction: "desc" },
          { op: "select", fields: ["x"] },
        ],
      },
    },
    {
      name: "group sum alias",
      values: [
        ["team", "x"],
        ["A", 1],
        ["B", 2],
        ["A", 3],
      ],
      spec: {
        version: 1,
        steps: [
          {
            op: "groupAggregate",
            by: ["team"],
            aggregates: [{ op: "sum", field: "x", as: "total" }],
          },
        ],
      },
    },
    {
      name: "aggregate currency strings",
      values: [["x"], ["￥1,000"], ["20%"]],
      spec: {
        version: 1,
        steps: [{ type: "aggregate", op: "sum", field: "x" }],
      },
    },
    {
      name: "derive expression",
      values: [["x"], [3]],
      spec: {
        version: 1,
        steps: [
          {
            op: "derive",
            as: "ratio",
            expr: {
              fn: "round",
              digits: 2,
              args: [{ fn: "div", args: [{ field: "x" }, 7] }],
            },
          },
        ],
      },
    },
    {
      name: "dynamic map and row numbers",
      values: [["x"], [1], [2]],
      spec: {
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
                  keepExisting: true,
                  columns: [{ name: "index", expr: { var: "rowNumber" } }],
                },
              ],
            },
          },
        ],
      },
    },
  ];
  for (const c of cases)
    await t.test(c.name, async () =>
      assert.deepEqual(
        await transform(c.values, c.spec),
        oracle({ stage: "transform", ...c }),
      ),
    );
  const variable = {
    valueType: "table",
    columns: ["x"],
    value: [{ x: 12345.678 }],
  };
  for (const spec of [
    {
      kind: "table",
      columns: [
        { field: "x", label: "金额", divideBy: 10000, numberFormat: "0.00" },
      ],
    },
    { kind: "table", includeHeader: false, columns: [{ field: "x" }] },
    {
      kind: "text",
      valuePath: "$[0].x",
      format: { divideBy: 10000, numberFormat: "0.00", suffix: "万元" },
    },
  ])
    await t.test("renderer " + JSON.stringify(spec), async () =>
      assert.deepEqual(
        await render(variable, spec),
        oracle({ stage: "render", variable, spec }),
      ),
    );
});
