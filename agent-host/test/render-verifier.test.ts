import test from "node:test";
import assert from "node:assert/strict";
import { verifyProgramResult } from "../src/render/verifier.js";

test("WPP verification checks identity, bounds, geometry and object stability while surfacing unsupported overflow", async () => {
  const before: any = {
    version: 1, kind: "text", adapterId: "wpp.object",
    geometry: { Left: 10, Top: 20, Width: 300, Height: 80, Rotation: 0 },
    text: { text: "old", frame: { AutoSize: 0 }, runs: [], paragraphs: [] },
    hostEvidence: { slideWidth: 960, slideHeight: 540, objectCount: 4 },
  };
  const actual: any = structuredClone(before);
  actual.text.text = "new";
  const target: any = { capabilityId: "wpp.object", locator: { slideId: 3, shapeId: 4 } };
  const good = await verifyProgramResult({ kind: "text", text: "new" }, actual, undefined, before, target);
  assert.equal(good.ok, true);
  assert.equal(good.confidence, "partial");
  assert.ok(good.checks.some((check) => check.code === "GEOMETRY_PRESERVED" && check.ok));
  assert.ok(good.checks.some((check) => check.code === "SLIDE_BOUNDS_VALID" && check.ok));
  assert.ok(good.checks.some((check) => check.code === "OBJECT_COUNT_STABLE" && check.ok));
  assert.ok(good.checks.some((check) => check.code === "TEXT_OVERFLOW_UNSUPPORTED" && check.confidence === "unsupported"));

  actual.geometry.Left = 800;
  const offSlide = await verifyProgramResult({ kind: "text", text: "new" }, actual, undefined, before, target);
  assert.equal(offSlide.ok, false);
  assert.ok(offSlide.checks.some((check) => check.code === "SLIDE_BOUNDS_VALID" && !check.ok));
});

test("ET verifies format preservation and Writer reports identity and format limits explicitly", async () => {
  const before: any = {
    version: 1, kind: "table", adapterId: "et.range",
    cells: [[{ value: "old", text: "old", formula: null, format: "0.00", font: { Bold: true }, alignment: { HorizontalAlignment: 1 } }]],
    merges: [],
  };
  const actual: any = structuredClone(before);
  actual.cells[0][0].value = "new";
  actual.cells[0][0].text = "new";
  let result = await verifyProgramResult({ kind: "table", rows: [["new"]] }, actual, undefined, before, { capabilityId: "et.range", locator: { address: "A1" } } as any);
  assert.equal(result.ok, true);
  assert.ok(result.checks.some((check) => check.code === "FORMULA_POLICY" && check.ok));
  actual.cells[0][0].format = "General";
  result = await verifyProgramResult({ kind: "table", rows: [["new"]] }, actual, undefined, before, { capabilityId: "et.range", locator: { address: "A1" } } as any);
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.code === "FORMAT_PRESERVED" && !check.ok));

  const writerBefore: any = { version: 1, kind: "text", adapterId: "wps.range", text: { text: "old" }, xml: "before", targetIdentity: { capabilityId: "wps.range", locator: { bookmark: "expected" } } };
  const writerAfter: any = { ...writerBefore, text: { text: "new" }, xml: "after", targetIdentity: { capabilityId: "wps.range", locator: { bookmark: "different" } } };
  result = await verifyProgramResult({ kind: "text", text: "new" }, writerAfter, undefined, writerBefore, { capabilityId: "wps.range", locator: { bookmark: "expected" } } as any);
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.code === "TARGET_IDENTITY" && !check.ok));
  assert.ok(result.checks.some((check) => check.code === "FORMAT_RESTORABLE" && check.ok));
  assert.ok(result.warnings?.some((warning) => /分离正文与格式/.test(warning)));
});
