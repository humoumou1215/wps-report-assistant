import type { ProgramVerification, RenderPlan, TargetSnapshot } from "../../../shared/contracts/index.js";
import { canonical, fingerprint } from "../project/store.js";

function actualText(snapshot: any) {
  const value = typeof snapshot?.text === "string" ? snapshot.text : snapshot?.text?.text;
  return typeof value === "string" ? value.replace(/[\r\x07]+$/g, "") : value;
}
function actualRows(snapshot: any): any[][] | undefined {
  if (Array.isArray(snapshot?.cells)) return snapshot.cells.map((row: any[]) => row.map((cell: any) => {
    if (cell && typeof cell === "object") {
      if (cell.value !== undefined) return cell.value;
      if (cell.text && typeof cell.text === "object" && "text" in cell.text) return String(cell.text.text).replace(/[\r\x07]+$/g, "");
      if (typeof cell.text === "string") return cell.text.replace(/[\r\x07]+$/g, "");
    }
    return typeof cell === "string" ? cell.replace(/[\r\x07]+$/g, "") : cell;
  }));
  if (Array.isArray(snapshot?.rows)) return snapshot.rows;
  return undefined;
}

export async function verifyProgramResult(
  expected: RenderPlan | Record<string, any>,
  actual: TargetSnapshot,
  expectedAfter?: TargetSnapshot,
): Promise<ProgramVerification> {
  const plan: any = expected;
  const checks: ProgramVerification["checks"] = [];
  checks.push({ code: "TARGET_EXISTS", ok: !!actual, message: actual ? "目标存在" : "目标不存在" });
  if (expectedAfter) {
    const ok = fingerprint(actual) === fingerprint(expectedAfter);
    checks.push({ code: "SNAPSHOT_EQUALS_EXPECTED", ok, message: ok ? "恢复快照匹配" : "恢复后快照不匹配" });
    return { ok: checks.every((check) => check.ok), checks, actualSummary: { fingerprint: fingerprint(actual) } };
  }
  if (plan?.kind === "text") {
    const ok = actualText(actual) === String(plan.text ?? "");
    checks.push({ code: "TEXT_EQUALS_EXPECTED", ok, message: ok ? "文本匹配" : "文本与 RenderPlan 不匹配" });
  } else if (plan?.kind === "table") {
    const expectedRows: any[][] = (plan.header ? [plan.header] : []).concat(plan.rows || []);
    const rows = actualRows(actual);
    const shapeOk = Array.isArray(rows) && rows.length >= expectedRows.length && expectedRows.every((row, i) => Array.isArray(rows?.[i]) && row.length <= (rows?.[i]?.length || 0));
    checks.push({ code: "ROW_COUNT", ok: shapeOk, message: shapeOk ? "行数满足要求" : "目标行数不足" });
    const valuesOk = shapeOk && expectedRows.every((row: any[], y: number) => row.every((value: any, x: number) => {
      const actualValue = rows![y][x];
      if (typeof actualValue === "string" && (typeof value === "number" || typeof value === "boolean")) return actualValue === String(value);
      return canonical(actualValue) === canonical(value);
    }));
    checks.push({ code: "CELL_VALUES", ok: !!valuesOk, message: valuesOk ? "单元格值匹配" : "单元格值不匹配" });
    const mergesOk = !plan.mergeCells || canonical(plan.mergeCells) === canonical(actual.merges || []);
    checks.push({ code: "MERGE_CELLS", ok: mergesOk, message: mergesOk ? "合并区域匹配" : "合并区域不匹配" });
  } else {
    checks.push({ code: "SUPPORTED_PLAN", ok: false, message: "RenderPlan 类型不支持" });
  }
  return { ok: checks.every((check) => check.ok), checks };
}
