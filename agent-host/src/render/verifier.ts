import type { ProgramVerification, RenderPlan, TargetLocator, TargetSnapshot } from "../../../shared/contracts/index.js";
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

function dimensions(snapshot: any) {
  const rows = Number(snapshot?.rows || snapshot?.cells?.length || 0);
  const columns = Number(snapshot?.cols || snapshot?.cells?.[0]?.length || 0);
  return { rows, columns };
}

function textStyle(snapshot: any) {
  const text = snapshot?.text;
  if (!text || typeof text !== "object") return undefined;
  return {
    frame: text.frame,
    emptyFont: text.emptyFont,
    runs: (text.runs || []).map((run: any) => ({ font: run.font, language: run.language })),
    paragraphs: (text.paragraphs || []).map((paragraph: any) => ({
      properties: paragraph.properties, indent: paragraph.indent, bullet: paragraph.bullet, bulletFont: paragraph.bulletFont,
    })),
  };
}

function formatFingerprint(snapshot: any) {
  // Writer's OOXML is sufficient to restore the exact range, but raw XML also
  // contains the changed text. Until we extract formatting-only OOXML, report
  // recoverability and leave exact format equivalence to the independent review.
  if (snapshot?.adapterId === "wps.range") return undefined;
  if (snapshot?.adapterId === "et.range") {
    return canonical({
      cells: (snapshot.cells || []).map((row: any[]) => row.map((cell: any) => ({ format: cell.format, font: cell.font, alignment: cell.alignment }))),
      rows: snapshot.heights, columns: snapshot.widths,
    });
  }
  if (snapshot?.kind === "table") {
    return canonical({
      geometry: snapshot.geometry && Object.fromEntries(Object.entries(snapshot.geometry).filter(([key]) => key !== "LockAspectRatio")),
      dimensions: dimensions(snapshot), widths: snapshot.widths, heights: snapshot.heights,
      cells: (snapshot.cells || []).map((row: any[]) => row.map(textStyle)),
    });
  }
  if (snapshot?.kind === "text") {
    return canonical({
      geometry: snapshot.geometry && Object.fromEntries(Object.entries(snapshot.geometry).filter(([key]) => key !== "LockAspectRatio")),
      text: textStyle(snapshot),
    });
  }
  return undefined;
}

function addCheck(checks: ProgramVerification["checks"], code: string, ok: boolean, message: string) {
  checks.push({ code, ok, message, confidence: "verified" });
}

function unsupported(checks: ProgramVerification["checks"], warnings: string[], code: string, message: string) {
  checks.push({ code, ok: false, message, confidence: "unsupported" });
  warnings.push(message);
}

export async function verifyProgramResult(
  expected: RenderPlan | Record<string, any>,
  actual: TargetSnapshot,
  expectedAfter?: TargetSnapshot,
  before?: TargetSnapshot,
  target?: TargetLocator,
): Promise<ProgramVerification> {
  const plan: any = expected;
  const checks: ProgramVerification["checks"] = [];
  const warnings: string[] = [];
  addCheck(checks, "TARGET_EXISTS", !!actual, actual ? "目标存在且可读取" : "目标不存在");
  if (expectedAfter) {
    addCheck(checks, "SNAPSHOT_EQUALS_EXPECTED", fingerprint(actual) === fingerprint(expectedAfter),
      fingerprint(actual) === fingerprint(expectedAfter) ? "恢复后的实际快照与预期完全一致" : "恢复后快照不匹配");
    return { ok: checks.every((check) => check.ok), checks, confidence: "verified", actualSummary: { fingerprint: fingerprint(actual) } };
  }

  const capabilityId = target?.capabilityId || actual?.adapterId;
  const targetIdentity = actual?.targetIdentity;
  const identityMatches = (!actual?.adapterId || !target?.capabilityId || actual.adapterId === target.capabilityId) &&
    (!targetIdentity || (!targetIdentity.capabilityId || targetIdentity.capabilityId === capabilityId) &&
      (!target?.locator || canonical(targetIdentity.locator) === canonical(target.locator)));
  addCheck(checks, "TARGET_IDENTITY", identityMatches, identityMatches ? "目标能力与定位信息匹配" : "实际快照不属于候选目标");

  if (plan?.kind === "text") {
    const matches = actualText(actual) === String(plan.text ?? "");
    addCheck(checks, "TEXT_EQUALS_EXPECTED", matches, matches ? "实际文本与 RenderPlan 一致" : "实际文本与 RenderPlan 不匹配");
  } else if (plan?.kind === "table") {
    const expectedRows: any[][] = (plan.header ? [plan.header] : []).concat(plan.rows || []);
    const rows = actualRows(actual);
    const shapeOk = Array.isArray(rows) && rows.length >= expectedRows.length && expectedRows.every((row, i) => Array.isArray(rows?.[i]) && row.length <= (rows?.[i]?.length || 0));
    addCheck(checks, "TARGET_DIMENSIONS", shapeOk, shapeOk ? "目标具有足够的行列" : "目标表格行列不足");
    const valuesOk = shapeOk && expectedRows.every((row: any[], y: number) => row.every((value: any, x: number) => {
      const actualValue = rows![y][x];
      if (typeof actualValue === "string" && (typeof value === "number" || typeof value === "boolean")) return actualValue === String(value);
      return canonical(actualValue) === canonical(value);
    }));
    addCheck(checks, "CELL_VALUES", !!valuesOk, valuesOk ? "所有目标单元格值匹配" : "单元格值不匹配");
    const expectedMerges = plan.mergeCells === undefined ? (before as any)?.merges || [] : plan.mergeCells;
    const mergesOk = canonical(expectedMerges) === canonical((actual as any).merges || []);
    addCheck(checks, "MERGE_STRUCTURE", mergesOk, mergesOk ? "合并结构匹配" : "合并结构意外变化");
  } else {
    addCheck(checks, "SUPPORTED_PLAN", false, "RenderPlan 类型不支持");
  }

  if (before) {
    const oldDimensions = dimensions(before), newDimensions = dimensions(actual);
    if (oldDimensions.rows || oldDimensions.columns) {
      const dimensionsMatch = oldDimensions.rows === newDimensions.rows && oldDimensions.columns === newDimensions.columns;
      addCheck(checks, "TABLE_DIMENSIONS_STABLE", dimensionsMatch, dimensionsMatch ? "表格维度保持不变" : "表格维度发生意外变化");
    }
    if (before.geometry || actual.geometry) {
      const keys = ["Left", "Top", "Width", "Height", "Rotation"];
      const geometryMatches = keys.every((key) => (before as any).geometry?.[key] === (actual as any).geometry?.[key]);
      addCheck(checks, "GEOMETRY_PRESERVED", geometryMatches, geometryMatches ? "对象几何位置保持不变" : "对象位置或尺寸发生意外变化");
    }
    const oldFormat = formatFingerprint(before), newFormat = formatFingerprint(actual);
    if (oldFormat !== undefined && newFormat !== undefined) {
      const formatMatches = oldFormat === newFormat;
      addCheck(checks, "FORMAT_PRESERVED", formatMatches, formatMatches ? "可验证的格式属性保持不变" : "可验证的格式属性发生变化");
    } else if (capabilityId === "wps.range") {
      const restorable = !!(before as any).xml && !!(actual as any).xml;
      addCheck(checks, "FORMAT_RESTORABLE", restorable, restorable ? "修改前后均保留 WordOpenXML 恢复证据" : "缺少 WordOpenXML 格式恢复证据");
      unsupported(checks, warnings, "FORMAT_COMPARE_UNSUPPORTED", "文字宿主无法从 WordOpenXML 中可靠分离正文与格式差异，需独立语义/人工检查格式");
    }
  }

  if (actual?.adapterId === "et.range") {
    const cells = (actual as any).cells || [];
    const noFormula = cells.every((row: any[]) => row.every((cell: any) => !cell?.formula && cell?.formula !== true));
    addCheck(checks, "FORMULA_POLICY", noFormula, noFormula ? "写入结果未引入公式" : "检测到非预期公式");
  }

  if (actual?.adapterId === "wpp.object") {
    const geometry = (actual as any).geometry || {};
    const finite = [geometry.Left, geometry.Top, geometry.Width, geometry.Height].every((value) => typeof value === "number" && Number.isFinite(value));
    const boundsValid = finite && geometry.Width > 0 && geometry.Height > 0 && geometry.Left >= 0 && geometry.Top >= 0;
    addCheck(checks, "SHAPE_BOUNDS_VALID", boundsValid, boundsValid ? "形状几何范围有效" : "形状坐标或尺寸无效");
    const evidence = (actual as any).hostEvidence;
    if (evidence?.slideWidth > 0 && evidence?.slideHeight > 0) {
      const withinSlide = geometry.Left + geometry.Width <= evidence.slideWidth + 1 && geometry.Top + geometry.Height <= evidence.slideHeight + 1;
      addCheck(checks, "SLIDE_BOUNDS_VALID", withinSlide, withinSlide ? "形状位于幻灯片边界内" : "形状超出幻灯片边界");
    } else unsupported(checks, warnings, "SLIDE_BOUNDS_UNSUPPORTED", "当前 WPS 适配器无法读取幻灯片边界，需人工检查形状位置");
    if ((before as any)?.hostEvidence?.objectCount !== undefined && evidence?.objectCount !== undefined) {
      const sameCount = (before as any).hostEvidence.objectCount === evidence.objectCount;
      addCheck(checks, "OBJECT_COUNT_STABLE", sameCount, sameCount ? "幻灯片对象数保持不变" : "幻灯片对象数发生意外变化");
    } else unsupported(checks, warnings, "OBJECT_COUNT_UNSUPPORTED", "当前 WPS 适配器无法核验幻灯片对象数变化");
    unsupported(checks, warnings, "TEXT_OVERFLOW_UNSUPPORTED", "WPS 未提供可靠的文字溢出检测；请人工检查文本框换行与裁切");
  }

  const requiredChecks = checks.filter((check) => check.confidence !== "unsupported");
  const ok = requiredChecks.every((check) => check.ok);
  return {
    ok,
    checks,
    ...(warnings.length ? { warnings } : {}),
    confidence: warnings.length ? "partial" : "verified",
    expectedSummary: plan?.kind === "text" ? { kind: "text", text: String(plan.text ?? "").slice(0, 200) } : { kind: "table", rows: (plan?.rows || []).length },
    actualSummary: plan?.kind === "text" ? { kind: "text", text: String(actualText(actual) ?? "").slice(0, 200) } : { kind: "table", dimensions: dimensions(actual) },
  };
}
