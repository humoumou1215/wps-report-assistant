import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError, type RenderRecord } from "../../../shared/contracts/index.js";
import { atomic, canonical, fingerprint, id, now } from "../project/store.js";
import { SnapshotStore } from "./snapshot-store.js";

type LedgerLine = {
  kind: "record" | "event";
  previousHash?: string;
  entryHash: string;
  record?: RenderRecord;
  recordId?: string;
  patch?: Record<string, any>;
};

export class RenderLedger {
  private tail: Promise<any> = Promise.resolve();
  readonly snapshots: SnapshotStore;
  constructor(private root: string, private projectId: string) {
    this.snapshots = new SnapshotStore(root);
  }
  private file() { return join(this.root, "projects", this.projectId, "render-ledger.jsonl"); }
  private async lines(): Promise<LedgerLine[]> {
    try {
      const content = await readFile(this.file(), "utf8");
      return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  private async append(line: Omit<LedgerLine, "entryHash" | "previousHash">) {
    const job = this.tail.then(async () => {
      const integrity = await this.verifyHashChain();
      if (!integrity.ok) throw new AppError("RENDER_LEDGER_INTEGRITY_FAILURE", "Render 历史完整性校验失败，拒绝追加", 503);
      const existing = await this.lines();
      const previousHash = existing.at(-1)?.entryHash;
      const unsigned = { ...line, previousHash };
      const entryHash = fingerprint(unsigned);
      const full = { ...unsigned, entryHash } as LedgerLine;
      await mkdir(join(this.root, "projects", this.projectId), { recursive: true, mode: 0o700 });
      const handle = await open(this.file(), "a", 0o600);
      try {
        await handle.writeFile(JSON.stringify(full) + "\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return full;
    });
    this.tail = job.catch(() => {});
    return job;
  }
  async verifyHashChain() {
    const lines = await this.lines();
    let previous: string | undefined;
    let previousRecordHash: string | undefined;
    for (const line of lines) {
      if (line.previousHash !== previous) return { ok: false, reason: "previous hash mismatch" };
      const expected = fingerprint({ kind: line.kind, record: line.record, recordId: line.recordId, patch: line.patch, previousHash: line.previousHash });
      if (expected !== line.entryHash) return { ok: false, reason: "entry hash mismatch" };
      if (line.kind === "record" && line.record) {
        const recordHash = fingerprint({ ...line.record, recordHash: undefined });
        if (recordHash !== line.record.recordHash) return { ok: false, reason: "record hash mismatch" };
        if (line.record.previousRecordHash !== previousRecordHash) return { ok: false, reason: "record chain mismatch" };
        previousRecordHash = line.record.recordHash;
      }
      previous = line.entryHash;
    }
    return { ok: true, count: lines.length, lastHash: previous };
  }
  private async materialize(): Promise<RenderRecord[]> {
    const lines = await this.lines();
    const records = new Map<string, RenderRecord>();
    for (const line of lines) {
      if (line.kind === "record" && line.record) records.set(line.record.id, structuredClone(line.record));
      if (line.kind === "event" && line.recordId && line.patch) {
        const record = records.get(line.recordId);
        if (record) Object.assign(record, structuredClone(line.patch));
      }
    }
    return [...records.values()];
  }
  async list() { return this.materialize(); }
  async get(renderId: string) {
    const record = (await this.materialize()).find((item) => item.id === renderId);
    if (!record) throw new AppError("NOT_FOUND", "Render 记录不存在", 404);
    if (record.beforeSnapshotRef && !record.beforeSnapshot) record.beforeSnapshot = await this.snapshots.load(this.projectId, record.beforeSnapshotRef);
    if (record.afterSnapshotRef && !record.actualAfterSnapshot) record.actualAfterSnapshot = await this.snapshots.load(this.projectId, record.afterSnapshotRef);
    return record;
  }
  async findByTaskOperationId(taskOperationId: string) {
    return (await this.materialize()).find((record) => record.taskOperationId === taskOperationId);
  }
  async appendPrepared(record: Omit<RenderRecord, "id" | "status" | "createdAt" | "programVerification"> & Partial<Pick<RenderRecord, "id" | "createdAt" | "programVerification">>) {
    const existing = record.taskOperationId ? await this.findByTaskOperationId(record.taskOperationId) : undefined;
    if (existing) return existing;
    const savedBefore = record.beforeSnapshot ? await this.snapshots.save(this.projectId, record.beforeSnapshot) : {};
    const previous = (await this.materialize()).at(-1);
    const item: RenderRecord = {
      ...structuredClone(record),
      id: record.id || id(),
      status: "prepared",
      createdAt: record.createdAt || now(),
      programVerification: record.programVerification || { ok: false, checks: [] },
      ...(savedBefore.ref ? { beforeSnapshotRef: savedBefore.ref, beforeSnapshot: undefined } : {}),
      previousRecordHash: previous?.recordHash,
    } as RenderRecord;
    item.recordHash = fingerprint({ ...item, recordHash: undefined });
    await this.append({ kind: "record", record: item });
    return item;
  }
  async patch(renderId: string, patch: Record<string, any>) {
    const current = await this.get(renderId);
    const allowed = new Set(["status", "error", "appliedAt", "verifiedAt", "afterSnapshotRef", "actualAfterSnapshot", "afterFingerprint", "programVerification", "agentVerification", "recoveryRequired"]);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new AppError("LEDGER_IMMUTABLE", `Render 历史字段不可修改：${key}`, 409);
    const transitions: Record<string, string[]> = {
      prepared: ["applying", "failed"], applying: ["applied", "failed"], applied: ["verifying", "verified", "verify_failed"], verifying: ["verified", "verify_failed"],
      verify_failed: [], verified: [], failed: [], recovered: [],
    };
    if (patch.status && patch.status !== current.status && !transitions[current.status]?.includes(patch.status))
      throw new AppError("LEDGER_TRANSITION_INVALID", `非法 Render 状态迁移：${current.status} → ${patch.status}`, 409);
    await this.append({ kind: "event", recordId: renderId, patch });
    return this.get(renderId);
  }
  async appendAppliedEvidence(renderId: string, input: { actualAfterSnapshot: any; afterFingerprint: string }) {
    const saved = await this.snapshots.save(this.projectId, input.actualAfterSnapshot);
    return this.patch(renderId, {
      ...(saved.ref ? { afterSnapshotRef: saved.ref, actualAfterSnapshot: undefined } : { actualAfterSnapshot: input.actualAfterSnapshot }),
      afterFingerprint: input.afterFingerprint,
      status: "applied",
      appliedAt: now(),
    });
  }
  async transition(renderId: string, status: RenderRecord["status"], extra: Record<string, any> = {}) {
    return this.patch(renderId, { status, ...extra });
  }
  async appendFailure(renderId: string, error: unknown) {
    const e = error instanceof AppError ? error : new AppError("RENDER_APPLY_FAILED", String(error));
    return this.patch(renderId, { status: "failed", error: { code: e.code, message: e.message } });
  }
}
