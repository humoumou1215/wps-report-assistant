import type { RenderPlan, RenderRecord, RenderExecutionMode, TargetLocator, TargetSnapshot, AgentVerification } from "../../../shared/contracts/index.js";
import { AppError, fail } from "../../../shared/contracts/index.js";
import { Store, entity, fingerprint, id, now, project } from "../project/store.js";
import { CapabilityRegistry, type RenderCapability } from "./capabilities.js";
import { RenderLedger } from "./ledger.js";
import { verifyProgramResult } from "./verifier.js";

export interface ExecuteRenderRequest {
  projectId: string;
  conversationId?: string;
  userTurnId?: string;
  taskId?: string;
  taskOperationId?: string;
  initiatedBy: "agent" | "user" | "system";
  action: "render" | "undo" | "recovery" | "correction";
  correctsRenderId?: string;
  correctsOperationId?: string;
  undoOfRenderId?: string;
  variableIds?: string[];
  bindingId?: string;
  documentId: string;
  target: TargetLocator;
  plan: RenderPlan | { kind: "restore-snapshot"; snapshot: TargetSnapshot };
  expectedTargetFingerprint?: string;
  expectedVariableRevision?: number;
  expectedBindingRevision?: number;
  expectedDocumentRevision?: number;
  displayName?: string;
  summary?: string;
  executionMode: RenderExecutionMode;
  expectedAfterSnapshot?: TargetSnapshot;
  agentVerification?: AgentVerification;
  /** Internal only: recovery must not recursively recover itself. */
  skipRecovery?: boolean;
  /** Internal only: recovery invoked by an already locked render. */
  skipLock?: boolean;
}

class DocumentMutex {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export class RenderGateway {
  private locks = new DocumentMutex();
  private ledgers = new Map<string, RenderLedger>();
  constructor(
    private store: Store,
    private capabilities: CapabilityRegistry,
    private ledgerFactory?: (projectId: string) => RenderLedger,
  ) {}
  ledger(projectId: string) {
    let ledger = this.ledgers.get(projectId);
    if (!ledger) {
      ledger = this.ledgerFactory?.(projectId) || new RenderLedger(this.store.dir, projectId);
      this.ledgers.set(projectId, ledger);
    }
    return ledger;
  }
  async capture(projectId: string, documentId: string, target: TargetLocator) {
    this.assertScope({ projectId, documentId, target } as ExecuteRenderRequest);
    return this.capabilities.resolve(target).capture(target);
  }
  async syncRecord(record: RenderRecord) {
    await this.store.transaction((state) => {
      const { beforeSnapshot, actualAfterSnapshot, ...index } = record;
      state.renderIndex[record.id] = structuredClone(index);
    });
  }
  private assertScope(request: ExecuteRenderRequest) {
    const p = this.store.getProject(request.projectId);
    const doc = entity(p.documents, request.documentId);
    if (request.target.documentId && request.target.documentId !== doc.id) fail("DOCUMENT_CHANGED", "Render 目标不属于指定文档", 409);
    if (request.expectedDocumentRevision !== undefined && doc.revision !== request.expectedDocumentRevision)
      fail("STALE_DOCUMENT_REVISION", "文档结构已变化，请重新检查文档并生成 RenderPlan", 409);
    if (request.variableIds) for (const variableId of request.variableIds) entity(p.variables, variableId);
    if (request.bindingId) {
      const binding = entity(p.bindings, request.bindingId);
      if (binding.documentId !== doc.id) fail("DOCUMENT_CHANGED", "绑定不属于指定文档", 409);
    }
    if (request.expectedVariableRevision !== undefined && request.variableIds?.[0]) {
      const variable = entity(p.variables, request.variableIds[0]);
      if (variable.revision !== request.expectedVariableRevision) fail("STALE_VARIABLE_REVISION", "变量已变化，请重新生成 RenderPlan", 409);
    }
    if (request.expectedBindingRevision !== undefined && request.bindingId) {
      const binding = entity(p.bindings, request.bindingId);
      if (binding.revision !== request.expectedBindingRevision) fail("STALE_BINDING_REVISION", "绑定已变化，请重新生成 RenderPlan", 409);
    }
    return { p, doc };
  }
  private async apply(capability: RenderCapability, target: TargetLocator, plan: ExecuteRenderRequest["plan"]) {
    if (plan.kind === "restore-snapshot") await capability.restore(target, plan.snapshot);
    else await capability.apply(target, plan);
  }
  async execute(request: ExecuteRenderRequest): Promise<RenderRecord> {
    const ledger = this.ledger(request.projectId);
    const existing = request.taskOperationId ? await ledger.findByTaskOperationId(request.taskOperationId) : undefined;
    if (existing) return ledger.get(existing.id);
    const integrity = await ledger.verifyHashChain();
    if (!integrity.ok) fail("RENDER_LEDGER_INTEGRITY_FAILURE", "Render 历史完整性校验失败，已阻止新写入", 503, integrity.reason);
    this.assertScope(request);
    const work = async () => {
      const duplicate = request.taskOperationId ? await ledger.findByTaskOperationId(request.taskOperationId) : undefined;
      if (duplicate) return ledger.get(duplicate.id);
      this.assertScope(request);
      const capability = this.capabilities.resolve(request.target);
      if (["agent-auto", "auto-reversible", "auto"].includes(request.executionMode) && !capability.reversible)
        fail("RENDER_NOT_REVERSIBLE", "该操作无法可靠恢复，禁止 AI 自动执行", 412);
      const unresolved = (await ledger.list()).find((item) =>
        item.documentId === request.documentId &&
        !(request.action === "recovery" && item.id === request.correctsRenderId) &&
        (["prepared", "applying", "applied", "verifying"].includes(item.status) || item.recoveryRequired === true),
      );
      if (unresolved) fail("RENDER_RECOVERY_REQUIRED", "该文档存在未完成的 Render，请先检查或恢复", 409);
      const before = await capability.capture(request.target);
      const beforeFingerprint = fingerprint(before);
      if (request.expectedTargetFingerprint && request.expectedTargetFingerprint !== beforeFingerprint)
        fail("TARGET_CHANGED", "目标在生成方案后已经变化，请重新检查", 409);
      const record = await ledger.appendPrepared({
        projectId: request.projectId,
        conversationId: request.conversationId,
        userTurnId: request.userTurnId,
        taskId: request.taskId,
        taskOperationId: request.taskOperationId,
        expectedDocumentRevision: request.expectedDocumentRevision,
        initiatedBy: request.initiatedBy,
        action: request.action,
        correctsRenderId: request.correctsRenderId,
        correctsOperationId: request.correctsOperationId,
        undoOfRenderId: request.undoOfRenderId,
        variableIds: request.variableIds || [],
        bindingId: request.bindingId,
        documentId: request.documentId,
        target: request.target,
        displayName: request.displayName || this.displayName(request.target, request.plan),
        summary: request.summary || this.summary(request.plan),
        beforeSnapshot: before,
        beforeFingerprint,
        forwardPlan: request.plan as RenderPlan,
        inversePlan: { kind: "restore-snapshot", snapshot: before },
        expectedAfter: request.expectedAfterSnapshot as any,
        agentVerification: request.agentVerification,
      });
      await this.syncRecord(record);
      try {
        await ledger.transition(record.id, "applying");
        await this.syncRecord(await ledger.get(record.id));
        await this.apply(capability, request.target, request.plan);
      } catch (error) {
        await ledger.appendFailure(record.id, error);
        await this.syncRecord(await ledger.get(record.id));
        if (!request.skipRecovery) {
          try { await this.recover(record.id, request.projectId, true); }
          catch (recoveryError) { await ledger.patch(record.id, { recoveryRequired: true, error: { code: "RECOVERY_REQUIRED", message: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) } }); await this.syncRecord(await ledger.get(record.id)); }
        }
        throw error;
      }
      let after: TargetSnapshot;
      try {
        after = await capability.capture(request.target);
      } catch (error) {
        await ledger.appendFailure(record.id, new AppError("AFTER_CAPTURE_FAILED", "Apply 后无法读取真实 WPS 目标", 422));
        await this.syncRecord(await ledger.get(record.id));
        try { await this.recover(record.id, request.projectId, true); }
        catch (recoveryError) { await ledger.patch(record.id, { recoveryRequired: true, error: { code: "RECOVERY_REQUIRED", message: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) } }); await this.syncRecord(await ledger.get(record.id)); }
        throw error;
      }
      const afterFingerprint = fingerprint(after);
      const evidence = await ledger.appendAppliedEvidence(record.id, { actualAfterSnapshot: after, afterFingerprint });
      await this.syncRecord(evidence);
      if (afterFingerprint !== beforeFingerprint) await this.bumpDocumentRevision(request.projectId, request.documentId);
      const verification = capability.verify
        ? await capability.verify(request.target, request.plan as RenderPlan, after, before)
        : await verifyProgramResult(request.plan, after, request.expectedAfterSnapshot, before, request.target);
      await ledger.patch(record.id, { programVerification: verification });
      await this.syncRecord(await ledger.get(record.id));
      if (!verification.ok) {
        await ledger.transition(record.id, "verify_failed");
        if (!request.skipRecovery) {
          try {
            await this.recover(record.id, request.projectId, true);
          } catch (error) {
            await ledger.patch(record.id, { recoveryRequired: true, error: { code: "RECOVERY_REQUIRED", message: error instanceof Error ? error.message : String(error) } });
            await this.syncRecord(await ledger.get(record.id));
          }
        }
        throw new AppError("RENDER_VERIFY_FAILED", "Render 程序验证失败，系统已尝试恢复", 422);
      }
      await ledger.transition(record.id, "verifying");
      if (!request.agentVerification) {
        const verifying = await ledger.patch(record.id, { status: "verifying", programVerification: verification });
        await this.syncRecord(verifying);
        return verifying;
      }
      return this.verifyRenderEffect(request.projectId, record.id, request.agentVerification);
    };
    return request.skipLock ? work() : this.locks.run(request.documentId, work);
  }
  async verifyRenderEffect(projectId: string, renderId: string, verification: AgentVerification, options: { allowRecovery?: boolean } = {}) {
    const ledger = this.ledger(projectId);
    const record = await ledger.get(renderId);
    if (record.status === "verified" || record.status === "recovered") return record;
    if (record.status !== "verifying" && record.status !== "applied") fail("RENDER_NOT_VERIFYING", "Render 当前不在待验证状态", 409);
    if (record.recoveryRequired) fail("RENDER_RECOVERY_REQUIRED", "Render 目标状态尚未解决，不能将其标记为已验证", 409);
    const result = await ledger.patch(renderId, {
      agentVerification: verification,
      status: verification.ok ? "verified" : "verify_failed",
      verifiedAt: now(),
    });
    await this.syncRecord(result);
    if (!verification.ok && options.allowRecovery !== false) {
      try {
        const recovery = await this.recover(renderId, projectId);
        const linked = await ledger.patch(renderId, { recoveryRenderId: recovery.id, recoveryRequired: false });
        await this.syncRecord(linked);
      } catch (error) {
        await ledger.patch(renderId, { recoveryRequired: true, error: { code: "RECOVERY_REQUIRED", message: error instanceof Error ? error.message : String(error) } });
        await this.syncRecord(await ledger.get(renderId));
      }
    } else if (!verification.ok) {
      await ledger.patch(renderId, { recoveryRequired: true, error: { code: "RECOVERY_VERIFICATION_FAILED", message: "Recovery 的语义验证未通过，已阻止后续自动写入" } });
      await this.syncRecord(await ledger.get(renderId));
    }
    const final = await ledger.get(renderId);
    await this.syncRecord(final);
    return final;
  }
  private displayName(target: TargetLocator, plan: any) {
    const location = String(target.label || target.shapeName || target.locator?.address || target.locator?.shapeName || "文档目标");
    const summary = plan?.kind === "text" ? String(plan.text || "").replace(/\s+/g, " ").slice(0, 40) : `${(plan?.rows || []).length} 行表格`;
    return `${location} · ${summary}`;
  }
  private summary(plan: any) {
    return plan?.kind === "text" ? String(plan.text || "").replace(/\s+/g, " ").slice(0, 200) : `${(plan?.rows || []).length} 行 · ${(plan?.header || plan?.rows?.[0] || []).length} 列`;
  }
  private async bumpDocumentRevision(projectId: string, documentId: string) {
    await this.store.transaction((state) => {
      const p = project(state, projectId), doc = entity(p.documents, documentId);
      doc.revision = (doc.revision || 1) + 1;
      p.revision++;
      p.updatedAt = now();
    });
  }
  async recover(renderId: string, projectId?: string, alreadyLocked = false) {
    let found: RenderRecord | undefined;
    if (!projectId) {
      for (const candidate of this.store.snapshot().projects) {
        try { found = await this.ledger(candidate.id).get(renderId); break; } catch { /* next project */ }
      }
      if (!found) fail("NOT_FOUND", "Render 记录不存在", 404);
    } else found = await this.ledger(projectId).get(renderId);
    if (!found) fail("NOT_FOUND", "Render 记录不存在", 404);
    const original = found as RenderRecord;
    const ledger = this.ledger(original.projectId);
    const capability = this.capabilities.resolve(original.target);
    const work = async () => {
    const current = await capability.capture(original.target);
    const currentFingerprint = fingerprint(current);
    if (original.afterFingerprint && currentFingerprint !== original.afterFingerprint)
      fail("RECOVERY_TARGET_CHANGED", "目标在失败 Render 后又发生变化，不能自动恢复", 409);
    if (!original.afterFingerprint && original.beforeFingerprint !== currentFingerprint)
      fail("RECOVERY_TARGET_CHANGED", "无法确认中断后的目标仍属于失败 Render，禁止覆盖当前文档内容", 409);
    const recovery = await this.execute({
      projectId: original.projectId,
      conversationId: original.conversationId,
      userTurnId: original.userTurnId,
      taskId: original.taskId,
      taskOperationId: `${original.id}:recovery`,
      initiatedBy: "system",
      action: "recovery",
      correctsRenderId: original.id,
      variableIds: original.variableIds,
      bindingId: original.bindingId,
      documentId: original.documentId,
      target: original.target,
      plan: original.inversePlan,
      expectedTargetFingerprint: original.afterFingerprint || original.beforeFingerprint,
      expectedAfterSnapshot: original.beforeSnapshot || (await ledger.get(original.id)).beforeSnapshot,
      executionMode: "system-recovery",
      skipRecovery: true,
      skipLock: true,
    });
    const linked = await ledger.patch(original.id, { recoveryRenderId: recovery.id });
    await this.syncRecord(linked);
    return recovery;
    };
    return alreadyLocked ? work() : this.locks.run(original.documentId, work);
  }
  async undo(projectId: string, renderId: string, actor: { type: "agent" | "user" | "system"; conversationId?: string }) {
    const original = await this.ledger(projectId).get(renderId);
    if (!["verified", "recovered"].includes(original.status)) fail("RENDER_NOT_UNDOABLE", "该 Render 尚未验证完成，不能撤销", 409);
    const capability = this.capabilities.resolve(original.target);
    const current = await capability.capture(original.target);
    if (fingerprint(current) !== original.afterFingerprint) fail("UNDO_TARGET_CHANGED", "目标在该 Render 后已变化，不能直接覆盖", 409);
    return this.execute({
      projectId,
      conversationId: actor.conversationId,
      initiatedBy: actor.type,
      action: "undo",
      undoOfRenderId: original.id,
      variableIds: original.variableIds,
      bindingId: original.bindingId,
      documentId: original.documentId,
      target: original.target,
      plan: original.inversePlan,
      expectedTargetFingerprint: original.afterFingerprint,
      expectedAfterSnapshot: original.beforeSnapshot,
      executionMode: "user-confirmed",
      taskOperationId: `${original.id}:undo:${id()}`,
    });
  }
  async recoverInterrupted(projectId: string, documentId?: string) {
    const ledger = this.ledger(projectId);
    const integrity = await ledger.verifyHashChain();
    if (!integrity.ok) fail("RENDER_LEDGER_INTEGRITY_FAILURE", "Render 历史完整性校验失败，拒绝自动恢复", 503, integrity.reason);
    const records = (await ledger.list()).filter((record) => (!documentId || record.documentId === documentId) && ["prepared", "applying", "applied", "verifying"].includes(record.status));
    const outcomes: any[] = [];
    for (const record of records) {
      try {
        const capability = this.capabilities.resolve(record.target);
        const current = await capability.capture(record.target);
        const fp = fingerprint(current);
        if (record.status === "verifying") {
          if (record.afterFingerprint && fp === record.afterFingerprint) outcomes.push(record);
          else outcomes.push(await ledger.patch(record.id, { recoveryRequired: true, error: { code: "RECOVERY_REQUIRED", message: "待语义验证的 Render 目标已再次变化；需人工检查" } }));
        } else if (record.status === "prepared" && fp === record.beforeFingerprint) outcomes.push(await ledger.patch(record.id, { status: "failed", error: { code: "INTERRUPTED_BEFORE_APPLY", message: "主机中断时 WPS 尚未发生变化" } }));
        else if (record.status === "applying" && fp === record.beforeFingerprint) outcomes.push(await ledger.patch(record.id, { status: "failed", error: { code: "INTERRUPTED_BEFORE_APPLY", message: "主机中断时 WPS 尚未发生变化" } }));
        else if (record.afterFingerprint && fp === record.afterFingerprint) {
          if (record.status === "applied") outcomes.push(await ledger.transition(record.id, "verifying"));
          else outcomes.push(await ledger.patch(record.id, { recoveryRequired: true, error: { code: "RECOVERY_REQUIRED", message: "中断记录与已应用状态冲突；需人工检查" } }));
        } else if (record.status === "applying" && !record.afterFingerprint) {
          const verification = capability.verify
            ? await capability.verify(record.target, record.forwardPlan, current, record.beforeSnapshot)
            : await verifyProgramResult(record.forwardPlan, current, undefined, record.beforeSnapshot, record.target);
          if (verification.ok) {
            await ledger.appendAppliedEvidence(record.id, { actualAfterSnapshot: current, afterFingerprint: fp });
            outcomes.push(await ledger.transition(record.id, "verifying", { programVerification: verification }));
            if (fp !== record.beforeFingerprint) await this.bumpDocumentRevision(projectId, record.documentId);
          } else outcomes.push(await ledger.patch(record.id, { recoveryRequired: true, error: { code: "RECOVERY_REQUIRED", message: "主机中断后无法确认目标状态；已阻止后续自动修改" } }));
        } else outcomes.push(await ledger.patch(record.id, { recoveryRequired: true, error: { code: "RECOVERY_REQUIRED", message: "无法判断 WPS 修改结果；已阻止后续自动修改" } }));
      } catch (error) {
        outcomes.push(await ledger.patch(record.id, { recoveryRequired: true, error: { code: "RECOVERY_REQUIRED", message: error instanceof Error ? error.message : String(error) } }));
      }
      await this.syncRecord(await ledger.get(record.id));
    }
    return outcomes;
  }
}
