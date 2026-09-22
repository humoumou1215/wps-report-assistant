import { fingerprint } from "../project/store.js";
export function reduced(value: any, limit = 10) {
  const rows = Array.isArray(value?.value)
    ? value.value
    : Array.isArray(value?.rows)
      ? value.rows
      : null;
  const base = {
    valueType: value?.valueType,
    kind: value?.kind,
    columns: value?.columns || value?.header,
    rowCount: rows?.length,
    checksum: fingerprint(value),
  };
  // A cell can itself contain megabytes. Bound bytes as well as sample rows.
  let sample = rows
    ? rows.slice(0, Math.min(20, Math.max(0, limit)))
    : (value?.value ?? value?.text);
  if (Buffer.byteLength(JSON.stringify(sample ?? null)) > 12000)
    sample = JSON.stringify(sample).slice(0, 10000) + "…";
  return { ...base, sample };
}
export function projectSummary(p: any) {
  return {
    name: p.name,
    revision: p.revision,
    documents: p.documents.map((d: any) => ({
      name: d.name,
      kind: d.kind,
    })),
    sources: p.sources.map((s: any) => ({ revision: s.revision })),
    variables: p.variables.map((v: any) => ({ name: v.name, revision: v.revision })),
    bindings: p.bindings.map((b: any) => ({
      revision: b.revision,
    })),
  };
}
export function modelJSON(value: any, maxBytes = 32000): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  // Return valid JSON, with an explicit notice, rather than slicing JSON mid-token.
  const shrink = (v: any, depth = 0): any =>
    typeof v === "string"
      ? v.slice(0, 1200)
      : Array.isArray(v)
        ? v.slice(0, 10).map((x) => shrink(x, depth + 1))
        : v && typeof v === "object"
          ? depth > 6
            ? "[nested data omitted]"
            : Object.fromEntries(
                Object.entries(v)
                  .slice(0, 30)
                  .map(([k, x]) => [k, shrink(x, depth + 1)]),
              )
          : v;
  const bounded = { truncated: true, data: shrink(value) };
  const result = JSON.stringify(bounded);
  return Buffer.byteLength(result) <= maxBytes
    ? result
    : JSON.stringify({
        truncated: true,
        summary: result.slice(0, Math.floor(maxBytes / 4)),
      });
}
export function targetSummary(target: any) {
  if (!target) return null;
  const snapshot = target.snapshot || target;
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : undefined;
  const cells = Array.isArray(snapshot.cells) ? snapshot.cells : undefined;
  const rowCount =
    snapshot.rowCount ??
    (typeof snapshot.rows === "number" ? snapshot.rows : rows?.length) ??
    cells?.length;
  const columnCount =
    snapshot.columnCount ??
    (typeof snapshot.columns === "number" ? snapshot.columns : rows?.[0]?.length) ??
    cells?.[0]?.length;
  return {
    kind: target.kind,
    capabilityId: target.capabilityId,
    label: target.label,
    rowCount,
    columnCount,
    header: Array.isArray(snapshot.header)
      ? snapshot.header.slice(0, 200)
      : undefined,
    text:
      typeof snapshot.text === "string"
        ? snapshot.text.slice(0, 3000)
        : undefined,
  };
}

export function sourceStatistics(
  rows: Record<string, any>[],
  columns: string[],
) {
  return Object.fromEntries(
    columns.slice(0, 200).map((column) => {
      const numbers = rows
        .map((row) => row[column])
        .filter((v: any) => typeof v === "number" && Number.isFinite(v));
      return [
        column,
        {
          nonEmpty: rows.filter(
            (row) =>
              row[column] !== null &&
              row[column] !== undefined &&
              row[column] !== "",
          ).length,
          numericCount: numbers.length,
          ...(numbers.length
            ? {
                min: Math.min(...numbers),
                max: Math.max(...numbers),
                sum: numbers.reduce((a, b) => a + b, 0),
                mean: numbers.reduce((a, b) => a + b, 0) / numbers.length,
              }
            : {}),
        },
      ];
    }),
  );
}
