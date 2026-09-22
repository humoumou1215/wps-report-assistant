import { fail } from "../../../shared/contracts/index.js";
export function validateResult(
  result: any,
  stage: "transform" | "render",
  target?: any,
) {
  if (target?.snapshot)
    target = {
      ...target,
      rowCount:
        target.rowCount ??
        (typeof target.snapshot.rows === "number"
          ? target.snapshot.rows
          : Array.isArray(target.snapshot.rows)
            ? target.snapshot.rows.length
            : Array.isArray(target.snapshot.cells)
              ? target.snapshot.cells.length
              : undefined),
      columnCount:
        target.columnCount ??
        (typeof target.snapshot.columns === "number"
          ? target.snapshot.columns
          : Array.isArray(target.snapshot.columns)
            ? target.snapshot.columns.length
            : Array.isArray(target.snapshot.rows)
              ? target.snapshot.rows[0]?.length
              : Array.isArray(target.snapshot.cells)
                ? target.snapshot.cells[0]?.length
                : undefined),
    };
  if (!result || typeof result !== "object")
    fail("RESULT_SCHEMA_INVALID", "必须返回结果对象");
  if (stage === "transform") {
    if (
      !["table", "string", "number"].includes(result.valueType) ||
      !Array.isArray(result.columns)
    )
      fail("RESULT_SCHEMA_INVALID", "缺少 valueType / columns");
    if (result.valueType === "table") {
      const cols = result.columns;
      if (
        cols.length > 200 ||
        new Set(cols).size !== cols.length ||
        cols.some((c: any) => typeof c !== "string" || !c)
      )
        fail("RESULT_SCHEMA_INVALID", "列名无效或超过 200 列");
      if (!Array.isArray(result.value) || result.value.length > 5000)
        fail("RESULT_SCHEMA_INVALID", "表格最多 5000 行");
      if (
        result.value.some(
          (r: any) =>
            !r ||
            typeof r !== "object" ||
            Array.isArray(r) ||
            cols.some(
              (c: string) =>
                !Object.hasOwn(r, c) ||
                (r[c] !== null &&
                  !["string", "number", "boolean"].includes(typeof r[c])) ||
                (typeof r[c] === "number" && !Number.isFinite(r[c])),
            ),
        )
      )
        fail("RESULT_SCHEMA_INVALID", "结果行缺少列字段");
    } else if (
      typeof result.value !== result.valueType ||
      (result.valueType === "number" && !Number.isFinite(result.value))
    )
      fail("RESULT_SCHEMA_INVALID", "结果类型不匹配");
  } else {
    if (!["text", "table"].includes(result.kind))
      fail("RESULT_SCHEMA_INVALID", "RenderPlan.kind 必须为 text/table");
    if (target?.kind && target.kind !== result.kind)
      fail("RESULT_SCHEMA_INVALID", "输出类型与目标不兼容");
    if (result.kind === "text" && typeof result.text !== "string")
      fail("RESULT_SCHEMA_INVALID", "缺少 text");
    if (result.kind === "table") {
      if (
        !Array.isArray(result.rows) ||
        result.rows.some((r: any) => !Array.isArray(r)) ||
        (result.header != null &&
          (!Array.isArray(result.header) ||
            result.header.some((c: any) => typeof c !== "string")))
      )
        fail("RESULT_SCHEMA_INVALID", "表格行或表头无效");
      const rows = (result.header ? [result.header] : []).concat(result.rows),
        width = rows[0]?.length || 0;
      if (
        rows.some(
          (r: any) =>
            r.length !== width ||
            r.some(
              (cell: any) =>
                cell !== null &&
                !["string", "number", "boolean"].includes(typeof cell),
            ),
        ) ||
        rows.length * width > 2000
      )
        fail("RESULT_SCHEMA_INVALID", "列数不一致或超过 2000 cells");
      if (
        (target?.rowCount && rows.length > target.rowCount) ||
        (target?.columnCount && width > target.columnCount)
      )
        fail("RESULT_SCHEMA_INVALID", "目标表格空间不足");
    }
  }
  // A model result is data, never a patch to Variable identity or metadata.
  if (stage === "transform")
    return {
      valueType: result.valueType,
      columns: result.columns,
      value: result.value,
    };
  return result;
}
