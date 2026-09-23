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
export interface VariableInput {
  type: "source" | "variable";
  sourceId?: string;
  variableId?: string;
}
export interface AuditRef {
  conversationId?: string;
  sessionEntryId?: string;
  userTurnId?: string;
  taskId?: string;
}
export interface VariableExplanation {
  revision: number;
  purpose: string;
  calculationSummary: string[];
  assumptions: string[];
  confirmedRules: string[];
  units?: string;
  generatedAt: string;
  generatedBy?: AuditRef;
}
export interface Source extends RecordData {
  id: string;
  revision: number;
  documentId: string;
  values: any[][];
}
export interface Variable extends TransformResult, RecordData {
  id: string;
  inputs: VariableInput[];
  revision: number;
  transform: RecordData;
  projectId?: string;
  explanation?: VariableExplanation;
  createdBy?: AuditRef;
  lastModifiedBy?: AuditRef;
}
export interface Binding extends RecordData {
  id: string;
  variableId: string;
  documentId: string;
  revision: number;
  target: RecordData;
  renderer: RecordData;
  lastRenderedVariableRevision?: number;
  lastRenderRecordId?: string;
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
export type ConversationStatus = "active" | "archived";
export interface Conversation {
  id: string;
  projectId: string;
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  lastCompactedAt?: string;
  status: ConversationStatus;
  ui?: { pinned?: boolean };
}
export type ChatReference =
  | {
      type: "variable";
      variableId: string;
      revisionAtSend: number;
      displayName: string;
    }
  | {
      type: "document";
      documentId: string;
      revisionAtSend?: number;
      displayName: string;
    }
  | {
      type: "selection";
      documentId: string;
      sheet?: string;
      address?: string;
      fingerprint: string;
      capturedAt: string;
      displayName: string;
      sourceId?: string;
      target?: TargetLocator;
    }
  | { type: "render-record"; renderId: string; displayName: string };
export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system-event";
  text: string;
  references: ChatReference[];
  richBlocks?: RecordData[];
  createdAt: string;
}
export type TaskOperationStatus =
  | "pending"
  | "running"
  | "validated"
  | "applied"
  | "failed"
  | "skipped";
export interface BaseTaskOperation {
  id: string;
  status: TaskOperationStatus;
  dependsOn?: string[];
  confirmationRequired?: boolean;
  semanticReview?: RecordData;
  changePreview?: RecordData;
}
export type TaskOperation = BaseTaskOperation &
  (
    | {
        type: "create-variable";
        name: string;
        inputs: VariableInput[];
        transformCandidate?: TransformScript;
        resultRef?: string;
        stagedVariableId?: string;
      }
    | {
        type: "update-variable";
        variableId: string;
        transformCandidate?: TransformScript;
        resultRef?: string;
        stagedVariableId?: string;
      }
    | {
        type: "create-binding" | "update-binding";
        bindingId?: string;
        variableId: string;
        documentId: string;
        target: RecordData;
        rendererCandidate?: TransformScript;
        renderPlanRef?: string;
      }
    | {
        type: "render";
        bindingId?: string;
        variableId: string;
        documentId: string;
        target: RecordData;
        rendererCandidate?: TransformScript;
        renderPlanRef?: string;
        renderRecordId?: string;
        targetFingerprint?: string;
      }
  );
export interface TaskValidation {
  passed: boolean;
  errors?: string[];
  warnings?: string[];
}
export interface TaskDraft {
  id: string;
  projectId: string;
  conversationId: string;
  userTurnId: string;
  status:
    | "planning"
    | "running"
    | "waiting_user"
    | "validating"
    | "rendering"
    | "verifying"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  references: ChatReference[];
  operations: TaskOperation[];
  validation?: TaskValidation;
  createdAt: string;
  updatedAt: string;
}
export interface ToolScope {
  projectId: string;
  conversationId: string;
  allowedDocumentIds: Set<string>;
  allowedVariableIds: Set<string>;
  allowedRenderIds: Set<string>;
  allowedSourceIds?: Set<string>;
  discoveryPolicy: "explicit-only" | "same-project";
}
export interface TargetLocator extends RecordData {
  capabilityId: string;
  documentId?: string;
  locator?: RecordData;
  kind?: "text" | "table";
}
export type RenderExecutionMode = "review" | "auto-reversible" | "auto" | "agent-auto" | "system-recovery" | "user-confirmed";
export interface ProgramVerification {
  ok: boolean;
  checks: { code: string; ok: boolean; message: string }[];
  expectedSummary?: Json;
  actualSummary?: Json;
}
export interface AgentVerification {
  ok: boolean;
  confidence: "high" | "medium" | "low";
  summary: string;
  issues: {
    type: "wrong-target" | "wrong-content" | "wrong-format" | "visual-risk" | "other";
    message: string;
  }[];
}
export type InversePlan = { kind: "restore-snapshot"; snapshot: TargetSnapshot };
export interface SnapshotRef {
  ref: string;
  sha256: string;
  size: number;
}
export interface RenderRecord {
  id: string;
  projectId: string;
  conversationId?: string;
  userTurnId?: string;
  taskId?: string;
  taskOperationId?: string;
  initiatedBy: "agent" | "user" | "system";
  action: "render" | "undo" | "recovery" | "correction";
  correctsRenderId?: string;
  undoOfRenderId?: string;
  variableIds: string[];
  bindingId?: string;
  documentId: string;
  target: TargetLocator;
  beforeSnapshot?: TargetSnapshot;
  beforeSnapshotRef?: SnapshotRef;
  beforeFingerprint: string;
  forwardPlan: RenderPlan;
  inversePlan: InversePlan;
  expectedAfter?: Json;
  actualAfterSnapshot?: TargetSnapshot;
  afterSnapshotRef?: SnapshotRef;
  afterFingerprint?: string;
  programVerification: ProgramVerification;
  agentVerification?: AgentVerification;
  status:
    | "prepared"
    | "applying"
    | "applied"
    | "verifying"
    | "verified"
    | "verify_failed"
    | "recovered"
    | "failed";
  error?: { code: string; message: string };
  createdAt: string;
  appliedAt?: string;
  verifiedAt?: string;
  previousRecordHash?: string;
  recordHash?: string;
}
export interface State extends RecordData {
  version: number;
  projects: Project[];
  conversations: Conversation[];
  chatMessages: ChatMessage[];
  tasks: TaskDraft[];
  variableKnowledge: Record<string, VariableExplanation>;
  renderIndex: Record<string, RecordData>;
  variableRevisions: RecordData[];
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
  revision?: number;
  index?: DocumentIndex;
}
export interface DocumentIndex {
  documentId: string;
  kind: "spreadsheet" | "presentation" | "writer";
  revision: number;
  summary: Json;
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
  source?: Source;
}
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
