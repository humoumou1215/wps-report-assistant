import { execute, sourceRows } from "../sandbox/client.js";
import { validateResult } from "../sandbox/contracts.js";
import { fail } from "../../../shared/contracts/index.js";
// This interpreter is product code, never model-authored JavaScript. Unknown opcodes fail closed.
function legacyRows(
  values: any,
  headersMode = "first-row",
): { rows: Record<string, any>[]; columns: string[] } {
  const matrix = Array.isArray(values)
    ? values.map((r) => (Array.isArray(r) ? r : [r]))
    : [[values]];
  if (!matrix.length) return { rows: [], columns: [] };
  const width = Math.max(...matrix.map((r) => r.length)),
    used = new Set<string>();
  const columns = Array.from({ length: width }, (_, i) => {
    const base =
      headersMode === "none" ||
      matrix[0][i] == null ||
      !String(matrix[0][i]).trim()
        ? "列" + (i + 1)
        : String(matrix[0][i]).trim();
    let name = base,
      n = 2;
    while (used.has(name) || name === "__row") name = base + "_" + n++;
    used.add(name);
    return name;
  });
  const body = headersMode === "none" ? matrix : matrix.slice(1);
  return {
    columns,
    rows: body.map((row, i) => ({
      ...Object.fromEntries(columns.map((c, j) => [c, row[j] ?? null])),
      __row: i + 1,
    })),
  };
}
const num = (v: any) =>
  Number(
    String(v ?? 0)
      .trim()
      .replace(/[,￥¥%]/g, ""),
  ) || 0;
const str = (v: any) => (v === null || v === undefined ? "<nil>" : String(v));
const truth = (v: any) =>
  typeof v === "string"
    ? !!v.trim() && v !== "0" && v.toLowerCase() !== "false"
    : !!v;
function compare(a: any, op: string, b: any): boolean {
  switch (op) {
    case "eq":
      return str(a) === str(b);
    case "neq":
      return str(a) !== str(b);
    case "gt":
      return num(a) > num(b);
    case "gte":
      return num(a) >= num(b);
    case "lt":
      return num(a) < num(b);
    case "lte":
      return num(a) <= num(b);
    case "contains":
      return str(a).includes(str(b));
    case "notContains":
      return !str(a).includes(str(b));
    case "empty":
      return a == null || String(a).trim() === "";
    case "notEmpty":
      return a != null && String(a).trim() !== "";
    default:
      return fail("LEGACY_CONTRACT_ERROR", "未知比较操作");
  }
}
function expr(e: any, row: any, index = 0, rows: any[] = [], depth = 0): any {
  if (depth > 64) fail("LEGACY_CONTRACT_ERROR", "表达式嵌套过深");
  if (!e || typeof e !== "object" || Array.isArray(e)) return e;
  if ("field" in e) {
    if (!Object.hasOwn(row, e.field))
      fail("SOURCE_SCHEMA_CHANGED", "缺少字段 " + e.field);
    return row[e.field];
  }
  if ("value" in e) return e.value;
  if (e.var) {
    if (e.var === "index") return index;
    if (e.var === "rowNumber") return index + 1;
    if (e.var === "rowCount") return rows.length;
    fail("LEGACY_CONTRACT_ERROR", "未知变量");
  }
  const a = (e.args || []).map((x: any) =>
      expr(x, row, index, rows, depth + 1),
    ),
    op = e.op || e.fn;
  switch (op) {
    case "add":
      return a.reduce((n: number, x: any) => n + num(x), 0);
    case "sub":
      return a.length < 2 ? null : num(a[0]) - num(a[1]);
    case "mul":
      return a.reduce((n: number, x: any) => n * num(x), 1);
    case "div":
    case "percent":
      return num(a[1])
        ? (num(a[0]) / num(a[1])) * (op === "percent" ? 100 : 1)
        : null;
    case "mod":
      return num(a[1]) ? num(a[0]) % num(a[1]) : null;
    case "round":
      return (
        Math.round(num(a[0]) * 10 ** (e.digits ?? 2)) / 10 ** (e.digits ?? 2)
      );
    case "concat":
      return a
        .map((x: any) => (x == null ? "" : str(x)))
        .join(e.separator || "");
    case "and":
      return a.every(truth);
    case "or":
      return a.some(truth);
    case "not":
      return !truth(a[0]);
    case "if":
      return truth(a[0]) ? a[1] : a[2];
    default:
      return compare(a[0], op, a[1]);
  }
}
function agg(rows: any[], fn: string, field: string, expression?: any): any {
  const vals = rows.map((r, i) =>
    num(expression ? expr(expression, r, i, rows) : r[field]),
  );
  switch (fn) {
    case "count":
      return rows.length;
    case "countNonEmpty":
      return rows.filter((r) => r[field] != null && String(r[field]).trim())
        .length;
    case "sum":
      return vals.reduce((a, b) => a + b, 0);
    case "avg":
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    case "min":
      return vals.length ? Math.min(...vals) : null;
    case "max":
      return vals.length ? Math.max(...vals) : null;
    default:
      return fail("LEGACY_CONTRACT_ERROR", "未知聚合函数");
  }
}
function dynamic(rows: any[], columns: string[], program: any) {
  if (program?.language !== "ra-cap-v1" || program.stage !== "transform")
    fail("LEGACY_CONTRACT_ERROR", "旧动态程序格式无效");
  let scalar: any,
    hasScalar = false;
  for (const s of program.steps || []) {
    switch (s.op) {
      case "filter":
        rows = rows.filter((r, i) => truth(expr(s.expr, r, i, rows)));
        break;
      case "map": {
        const old = rows;
        columns = [
          ...new Set<string>([
            ...(s.keepExisting ? columns : []),
            ...s.columns.map((c: any) => c.name),
          ]),
        ];
        rows = old.map((r, i) => ({
          ...(s.keepExisting
            ? Object.fromEntries(
                Object.entries(r).filter(([k]) => k !== "__row"),
              )
            : {}),
          ...Object.fromEntries(
            s.columns.map((c: any) => [c.name, expr(c.expr, r, i, old)]),
          ),
        }));
        break;
      }
      case "sort":
        rows = rows
          .map((r, i) => ({ r, key: expr(s.expr, r, i, rows) }))
          .sort((a, b) => cmp(a.key, b.key) * (s.direction === "desc" ? -1 : 1))
          .map((x) => x.r);
        break;
      case "limit":
        rows = rows.slice(0, Math.max(0, s.count));
        break;
      case "reduce":
        scalar = agg(rows, s.fn, "", s.expr);
        hasScalar = true;
        return { rows, columns, scalar, hasScalar };
      default:
        fail("LEGACY_CONTRACT_ERROR", "未知动态步骤");
    }
  }
  return { rows, columns, scalar, hasScalar };
}
const cmp = (a: any, b: any) =>
  typeof a === "number" || typeof b === "number"
    ? num(a) - num(b)
    : str(a) < str(b)
      ? -1
      : str(a) > str(b)
        ? 1
        : 0;
export async function transform(values: any[][], spec: any) {
  if (spec.language === "javascript") {
    let code = spec.code;
    if (spec.version !== 2) {
      const normalized = await import("../sandbox/normalize-script.js");
      const fn = normalized.normalizeScript(code, "transform");
      code = `function transform(rows,columns){const out=(()=>{${fn};return transform(rows,columns)})();if(Array.isArray(out))return {valueType:'table',columns:out.length?Object.keys(out[0]):columns,value:out};if(typeof out==='string'||typeof out==='number')return {valueType:typeof out,columns:[],value:out};return out;}`;
      const input = legacyRows(values, spec.headersMode);
      input.rows = input.rows.map((row) =>
        Object.fromEntries(
          input.columns.map((column) => [column, row[column]]),
        ),
      );
      const output = await execute(code, "transform", input);
      return output.result;
    }
    return (await execute(code, "transform", sourceRows(values))).result;
  }
  if (spec.version !== 1)
    fail("LEGACY_CONTRACT_ERROR", "旧 Transform 版本不支持");
  let { rows, columns } = legacyRows(values, spec.headersMode),
    scalar: any,
    hasScalar = false;
  for (const s of spec.steps || []) {
    const kind = s.type || s.op;
    switch (kind) {
      case "filter":
        rows = rows.filter((r) => {
          if (!Object.hasOwn(r, s.field))
            fail("SOURCE_SCHEMA_CHANGED", "缺少字段 " + s.field);
          return compare(
            r[s.field],
            s.operator || (s.op !== "filter" ? s.op : ""),
            s.value,
          );
        });
        break;
      case "derive":
        rows.forEach((r, i) => (r[s.as] = expr(s.expr, r, i, rows)));
        columns = [...new Set([...columns, s.as])];
        break;
      case "select":
        columns = s.fields.map((f: any) =>
          typeof f === "string" ? f : f.as || f.from,
        );
        rows = rows.map((r) =>
          Object.fromEntries(
            s.fields.map((f: any) =>
              typeof f === "string" ? [f, r[f]] : [f.as || f.from, r[f.from]],
            ),
          ),
        );
        break;
      case "sort":
        rows.sort(
          (a, b) =>
            cmp(a[s.field], b[s.field]) * (s.direction === "desc" ? -1 : 1),
        );
        break;
      case "limit":
        rows = rows.slice(0, Math.max(0, s.count));
        break;
      case "aggregate":
        scalar = agg(rows, s.fn || (s.op !== "aggregate" ? s.op : ""), s.field);
        hasScalar = true;
        break;
      case "groupAggregate": {
        const groups = new Map<string, any[]>();
        for (const row of rows) {
          const k = JSON.stringify(s.by.map((f: string) => row[f]));
          groups.set(k, [...(groups.get(k) || []), row]);
        }
        columns = [
          ...s.by,
          ...s.aggregates.map(
            (a: any) => a.as || (a.fn || a.op) + "_" + a.field,
          ),
        ];
        rows = [...groups.values()].map((g) => ({
          ...Object.fromEntries(s.by.map((f: string) => [f, g[0][f]])),
          ...Object.fromEntries(
            s.aggregates.map((a: any) => [
              a.as || (a.fn || a.op) + "_" + a.field,
              agg(g, a.fn || a.op, a.field),
            ]),
          ),
        }));
        break;
      }
      case "dynamic": {
        const out = dynamic(rows, columns, s.program);
        rows = out.rows;
        columns = out.columns;
        if (out.hasScalar) {
          scalar = out.scalar;
          hasScalar = true;
        }
        break;
      }
      default:
        fail("LEGACY_CONTRACT_ERROR", "未知旧 Transform 步骤");
    }
  }
  const out = spec.output || {},
    type = out.type || (hasScalar ? "number" : "table");
  if (type === "number")
    return {
      valueType: type,
      columns: [],
      value: hasScalar
        ? scalar
        : rows.length && out.field
          ? num(rows[0][out.field])
          : 0,
    };
  if (type === "string")
    return {
      valueType: type,
      columns: [],
      value: str(
        out.field && rows.length ? rows[0][out.field] : hasScalar ? scalar : "",
      ),
    };
  columns = out.fields?.length ? out.fields : columns;
  return validateResult(
    {
      valueType: "table",
      columns,
      value: rows.map((r) =>
        Object.fromEntries(columns.map((c) => [c, r[c] ?? null])),
      ),
    },
    "transform",
  );
}
function format(value: any, f: any = {}) {
  if (typeof value !== "number") return value == null ? "" : str(value);
  let n = value;
  if (f.divideBy) n /= f.divideBy;
  if (f.scale !== undefined) n *= f.scale;
  const nf = f.numberFormat || "";
  if (nf.startsWith("percent"))
    return (n * 100).toFixed(Number(nf.slice(7))) + "%";
  if (/^0(?:\.0+)?$/.test(nf))
    return n.toFixed(nf.includes(".") ? nf.length - 2 : 0);
  return str(n);
}
export async function render(variable: any, spec: any, target: any = {}) {
  if (spec.language === "javascript")
    return (await execute(spec.code, "render", { variable, target })).result;
  const r = spec.renderer || spec,
    kind = r.kind || r.type;
  let plan: any;
  if (kind === "dynamic") {
    const p = r.program;
    if (p?.language !== "ra-cap-v1" || p.stage !== "render")
      fail("LEGACY_CONTRACT_ERROR", "旧 Renderer 动态程序无效");
    const rows = Array.isArray(variable.value) ? variable.value : [];
    plan =
      p.kind === "text"
        ? {
            kind: "text",
            text:
              (p.prefix || "") +
              str(expr(p.expr, rows[0] || {}, 0, rows)) +
              (p.suffix || ""),
          }
        : {
            kind: "table",
            header:
              p.includeHeader !== false
                ? p.columns.map((c: any) => c.label)
                : null,
            rows: rows
              .slice(0, p.maxRows ?? rows.length)
              .map((row: any, i: number) =>
                p.columns.map((c: any) =>
                  format(expr(c.expr, row, i, rows), c.format),
                ),
              ),
            resizeRows: p.resizeRows !== false,
          };
  } else if (kind === "text") {
    let val = variable.value;
    const path = /^\$\[(\d+)\]\.(.+)$/.exec(r.valuePath || "");
    if (path) val = variable.value[Number(path[1])]?.[path[2]];
    const f = { ...r, ...r.format };
    plan = {
      kind: "text",
      text: (r.template || "{{value}}").replaceAll(
        "{{value}}",
        (f.prefix || "") + format(val, f) + (f.suffix || ""),
      ),
    };
  } else if (kind === "table") {
    const cols = r.columns || [];
    plan = {
      kind: "table",
      header:
        r.includeHeader !== false
          ? cols.map((c: any) => c.label || c.field)
          : null,
      rows: variable.value
        .slice(0, r.maxRows ?? variable.value.length)
        .map((row: any) => cols.map((c: any) => format(row[c.field], c))),
      resizeRows: r.resizeRows !== false,
    };
  } else return fail("LEGACY_CONTRACT_ERROR", "旧 Renderer 类型不支持");
  return validateResult(plan, "render", target);
}
