export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type RecordData = Record<string, any>;
export interface TransformScript {
  language: "javascript";
  version: number;
  code: string;
}
export interface TransformResult {
  valueType: "table" | "string" | "number";
  columns: string[];
  value: any;
}
export interface Source extends RecordData {
  id: string;
  revision: number;
  documentId: string;
  values: any[][];
}
export interface Variable extends TransformResult, RecordData {
  id: string;
  sourceId: string;
  sessionId: string;
  revision: number;
  transform: RecordData;
}
export interface Binding extends RecordData {
  id: string;
  variableId: string;
  documentId: string;
  revision: number;
  target: RecordData;
  renderer: RecordData;
}
export interface MergeCell {
  row: number;
  column: number;
  rowSpan: number;
  colSpan: number;
}
export interface Project extends RecordData {
  id: string;
  revision: number;
  documents: Document[];
  sources: Source[];
  variables: Variable[];
  bindings: Binding[];
}
export type RenderPlan =
  | { kind: "text"; text: string }
  | {
      kind: "table";
      header?: string[] | null;
      rows: Json[][];
      mergeCells?: MergeCell[];
    };
export interface MemoryDelta {
  category:
    | "objective"
    | "confirmed-decision"
    | "user-correction"
    | "transform-intent"
    | "lesson"
    | "binding-decision";
  content: string;
  scope: string;
}
export interface Draft extends RecordData {
  id: string;
  projectId: string;
  sessionId: string;
  kind: "transform" | "render";
  status: string;
  pendingMemory: MemoryDelta[];
  sourceRevision: number;
  variableRevision: number;
  bindingRevision: number;
}
export interface AgentRun extends RecordData {
  id: string;
  projectId: string;
  draftId: string;
  sessionId: string;
  status:
    | "queued"
    | "running"
    | "waiting_tool"
    | "reviewing"
    | "preview_ready"
    | "failed"
    | "cancelled"
    | "interrupted";
  startedAt: string;
  finishedAt?: string;
}
export interface State extends RecordData {
  version: number;
  projects: Project[];
  drafts: Draft[];
  runs: AgentRun[];
  memories: Record<string, MemoryDelta[]>;
  variableRevisions: RecordData[];
  pptChanges: RecordData[];
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
    public hint = "",
  ) {
    super(message);
  }
  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint };
  }
}
export const fail = (
  code: string,
  message: string,
  status = 422,
  hint = "",
): never => {
  throw new AppError(code, message, status, hint);
};

export interface Document extends RecordData {
  id: string;
  key: string;
  name: string;
  kind: string;
  capabilities?: string[];
}
export interface SourceDraft extends RecordData {
  documentId: string;
  values: Json[][];
  headersMode?: "first-row" | "none";
  requestedAddress?: string;
  effectiveAddress?: string;
  selectionMode?: "range" | "whole-rows" | "whole-columns" | "whole-sheet";
}
export interface TargetSnapshot extends RecordData {
  version: 1;
  kind: "text" | "table";
  comparison?: Json;
  adapterId?: string;
}
export interface Revision extends RecordData {
  id: string;
  projectId: string;
  variableId: string;
  createdAt: string;
  variable: Variable;
  source: Source;
  sessionEntryId?: string;
}
export type PendingMemoryDelta = MemoryDelta;
export type ToolErrorCode =
  | "SCRIPT_SYNTAX"
  | "SCRIPT_CONTRACT_ERROR"
  | "SCRIPT_NO_RETURN"
  | "SCRIPT_TIMEOUT"
  | "SCRIPT_RESULT_TOO_LARGE"
  | "RESULT_SCHEMA_INVALID"
  | "SOURCE_SCHEMA_CHANGED"
  | "STALE_SOURCE_REVISION"
  | "STALE_VARIABLE_REVISION"
  | "TARGET_CHANGED"
  | "MODEL_ERROR"
  | "TOOL_INTERNAL_ERROR";
export interface AgentToolError {
  code: ToolErrorCode;
  message: string;
  hint: string;
}
