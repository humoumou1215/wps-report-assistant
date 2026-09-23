import type { Document, DocumentIndex, Project } from "../../../shared/contracts/index.js";
import { entity, project } from "./store.js";

function indexKind(kind: string): DocumentIndex["kind"] {
  return kind === "et" || kind === "xlsx" || kind === "xls" ? "spreadsheet" : kind === "wpp" || kind === "pptx" || kind === "ppt" ? "presentation" : "writer";
}
export function buildDocumentIndex(p: Project, document: Document): DocumentIndex {
  const kind = indexKind(document.kind);
  if (kind === "spreadsheet") {
    const sheets = p.sources.filter((source) => source.documentId === document.id).map((source) => {
      const rows = Array.isArray(source.values) ? source.values : [];
      const headers = Array.isArray(rows[0]) ? rows[0].map((value) => String(value ?? "")) : [];
      return {
        name: source.sheetName || source.name || "当前选区",
        usedRange: source.effectiveAddress || source.requestedAddress || "",
        rowCount: Math.max(0, rows.length - 1),
        columnCount: headers.length,
        tables: [{ address: source.effectiveAddress || source.requestedAddress || "", headers }],
      };
    });
    return { documentId: document.id, kind, revision: document.revision || 1, summary: { sheets } };
  }
  if (kind === "presentation") {
    const slides = p.bindings.filter((binding) => binding.documentId === document.id).map((binding) => ({
      slideId: binding.target.slideId || binding.target.locator?.slideId || binding.target.slideIndex,
      index: Number(binding.target.slideIndex || 0),
      title: binding.target.shapeName,
      objects: [{ objectId: binding.target.shapeId || binding.target.locator?.shapeId, kind: binding.target.kind || binding.renderer?.kind || "text", summary: binding.description || "已注册输出目标" }],
    }));
    return { documentId: document.id, kind, revision: document.revision || 1, summary: { slides } };
  }
  return { documentId: document.id, kind, revision: document.revision || 1, summary: { ranges: p.sources.filter((source) => source.documentId === document.id).map((source) => ({ address: source.effectiveAddress || source.requestedAddress || "", textPreview: String(source.values?.[0]?.[0] ?? "").slice(0, 200) })) } };
}

export function inspectDocument(p: Project, documentId: string) {
  const document = entity(p.documents, documentId);
  return { document, index: buildDocumentIndex(p, document) };
}

export function searchDocument(p: Project, documentId: string, query: string) {
  const result = inspectDocument(p, documentId);
  const q = query.trim().toLocaleLowerCase();
  if (!q) return result.index.summary;
  const text = JSON.stringify(result.index.summary);
  return { query, matches: text.toLocaleLowerCase().includes(q) ? [result.index.summary] : [] };
}
