import {
  Store,
  entity,
  project,
  id,
  now,
  fingerprint,
  canonical,
} from "./store.js";
import { fail } from "../../../shared/contracts/index.js";
import { render } from "../legacy/execute.js";
const same = (a: any, b: any) => canonical(a ?? null) === canonical(b ?? null);
const sameBinding = (a: any, b: any) => {
  const logical = (value: any) =>
    value
      ? Object.fromEntries(
          Object.entries(value).filter(
            ([key]) => !["revision", "updatedAt"].includes(key),
          ),
        )
      : null;
  return same(logical(a), logical(b));
};
const snapshotSame = (a: any, b: any) =>
  same(a?.comparison || a, b?.comparison || b);
const targetKey = (t: any) =>
  t.capabilityId
    ? { capabilityId: t.capabilityId, locator: t.locator }
    : { slideId: t.slideId, shapeId: t.shapeId };
const unresolved = (c: any) =>
  c.entries.some((e: any) => ["prepared", "undoing"].includes(e.status));
export class Changes {
  constructor(private store: Store) {}
  list(pid: string, documentId: string) {
    return this.store
      .snapshot()
      .pptChanges.filter(
        (c) => c.projectId === pid && c.documentId === documentId,
      )
      .reverse();
  }
  async prepare(pid: string, input: any) {
    return this.store.transaction(async (s) => {
      const p = project(s, pid),
        doc = entity(p.documents, input.documentId);
      if (
        !input.requestId ||
        !Array.isArray(input.entries) ||
        input.entries.length < 1 ||
        input.entries.length > 200
      )
        fail("INVALID_INPUT", "修改请求无效", 400);
      const existing = s.pptChanges.find((c) => c.id === input.requestId);
      if (existing) {
        if (existing.projectId === pid && existing.documentId === doc.id)
          return existing;
        fail("REQUEST_CONFLICT", "操作编号重复", 409);
      }
      if (
        s.pptChanges.some(
          (c) =>
            c.projectId === pid && c.documentId === doc.id && unresolved(c),
        )
      )
        fail("CHANGE_PENDING", "请先恢复未完成修改", 409);
      const entries: any[] = [];
      for (const req of input.entries) {
        if (req.before?.version !== 1 || !req.before.kind)
          fail("INVALID_SNAPSHOT", "缺少可恢复快照", 400);
        let beforeBinding: any = null,
          afterBinding: any,
          plan: any,
          draft: any;
        if (req.draftId) {
          draft = entity(s.drafts, req.draftId);
          if (
            draft.projectId !== pid ||
            draft.kind !== "render" ||
            draft.status !== "preview_ready"
          )
            fail("DRAFT_NOT_READY", "预览未就绪", 409);
          if (draft.requiresRiskAcceptance && !req.acceptRisk)
            fail("RISK_ACK_REQUIRED", "请确认语义复核风险", 412);
          if (draft.input.documentId !== doc.id)
            fail("DOCUMENT_CONFLICT", "目标文稿不一致", 409);
          if (
            draft.input.targetSnapshot &&
            !same(
              fingerprint(req.before?.comparison || req.before),
              draft.targetFingerprint,
            )
          )
            fail("TARGET_CHANGED", "目标对象已经变化，请重新生成预览", 409);
          beforeBinding = draft.bindingId
            ? entity(p.bindings, draft.bindingId)
            : null;
          if (beforeBinding && beforeBinding.revision !== draft.bindingRevision)
            fail("STALE_BINDING_REVISION", "绑定已变化", 409);
          const v = entity(p.variables, draft.variableId);
          if (v.revision !== draft.variableRevision)
            fail("STALE_VARIABLE_REVISION", "变量已变化", 409);
          if (entity(p.sources, v.sourceId).revision !== draft.sourceRevision)
            fail("STALE_SOURCE_REVISION", "源数据已变化", 409);
          afterBinding = {
            id: beforeBinding?.id || id(),
            variableId: v.id,
            documentId: doc.id,
            documentKey: doc.key,
            description: draft.input.description,
            target: draft.input.target,
            renderer: { language: "javascript", version: 2, code: draft.code },
            revision: (beforeBinding?.revision || 0) + 1,
            createdAt: beforeBinding?.createdAt || now(),
            updatedAt: now(),
          };
          plan = draft.result;
        } else {
          beforeBinding = entity(p.bindings, req.bindingId);
          afterBinding = structuredClone(beforeBinding);
          if (beforeBinding.documentId !== doc.id)
            fail("DOCUMENT_CONFLICT", "目标文稿不一致", 409);
          plan = await render(
            entity(p.variables, beforeBinding.variableId),
            beforeBinding.renderer,
            beforeBinding.target,
          );
        }
        if (!same(plan, req.expectedPlan))
          fail("STALE_PLAN", "渲染结果已变化", 409);
        if (
          entries.some((e) =>
            same(targetKey(e.target), targetKey(afterBinding.target)),
          )
        )
          fail("DUPLICATE_TARGET", "不能重复修改同一对象", 409);
        const v = entity(p.variables, afterBinding.variableId);
        entries.push({
          target: afterBinding.target,
          before: req.before,
          plan,
          beforeBinding: beforeBinding ? structuredClone(beforeBinding) : null,
          afterBinding: structuredClone(afterBinding),
          variableVersion: v.updatedAt,
          variableRevision: v.revision,
          status: "prepared",
          bindingCommitted: false,
          draftId: draft?.id,
        });
        if (draft) draft.status = "prepared";
      }
      const change = {
        id: input.requestId,
        projectId: pid,
        documentId: doc.id,
        label: input.label || "更新输出",
        createdAt: now(),
        entries,
      };
      s.pptChanges.push(change);
      return change;
    });
  }
  async transition(pid: string, cid: string, index: number, input: any) {
    const result = await this.store.transaction((s) => {
      const p = project(s, pid),
        c = entity(s.pptChanges, cid);
      if (c.projectId !== pid) fail("NOT_FOUND", "修改记录不存在", 404);
      const e = c.entries[index];
      if (!e) fail("NOT_FOUND", "条目不存在", 404);
      const { action, snapshot } = input,
        current = p.bindings.find((b) => b.id === e.afterBinding.id);
      if (["undo-start", "recover-start", "undo-complete"].includes(action)) {
        const later = s.pptChanges
          .slice(s.pptChanges.indexOf(c) + 1)
          .some(
            (x) =>
              x.projectId === pid &&
              x.documentId === c.documentId &&
              x.entries.some((y: any) =>
                ["applied", "prepared", "undoing"].includes(y.status),
              ),
          );
        if (
          later ||
          c.entries
            .slice(index + 1)
            .some((x: any) => !["undone", "failed"].includes(x.status))
        )
          fail("UNDO_ORDER", "请倒序撤销修改", 409);
      }
      switch (action) {
        case "complete":
          if (e.status === "applied" && snapshotSame(snapshot, e.after))
            return c;
          if (
            c.entries
              .slice(0, index)
              .some((x: any) => ["prepared", "undoing"].includes(x.status))
          )
            fail("CHANGE_ORDER", "前一对象尚未完成", 409);
          if (
            e.status !== "prepared" ||
            snapshot?.version !== 1 ||
            snapshot.kind !== e.before.kind ||
            !same(current, e.beforeBinding)
          )
            fail("CHANGE_CONFLICT", "修改状态或绑定已变化", 409);
          if (
            entity(p.variables, e.afterBinding.variableId).revision !==
            e.variableRevision
          )
            fail(
              "STALE_VARIABLE_REVISION",
              "变量已变化，请恢复本次文档修改",
              409,
            );
          if (current) Object.assign(current, e.afterBinding);
          else p.bindings.push(structuredClone(e.afterBinding));
          e.after = snapshot;
          e.bindingCommitted = true;
          e.status = "applied";
          if (e.draftId) {
            const d = entity(s.drafts, e.draftId);
            e.memoryBeforeScope = (s.memories[d.sessionId] || []).filter(
              (m) => m.scope === `binding:${e.afterBinding.id}`,
            );
            const deltas = d.pendingMemory.map((m: any) => ({
              ...m,
              scope: `binding:${e.afterBinding.id}`,
            }));
            s.memories[d.sessionId] = [
              ...(s.memories[d.sessionId] || []),
              ...deltas,
            ];
            d.pendingMemory = [];
            d.status = "committed";
          }
          break;
        case "fail":
          if (e.status === "failed") return c;
          if (e.status !== "prepared" || !snapshotSame(snapshot, e.before))
            fail("CHANGE_CONFLICT", "未验证恢复原状", 409);
          e.status = "failed";
          e.error = String(input.error || "");
          if (e.draftId) {
            const d = entity(s.drafts, e.draftId);
            d.status = "cancelled";
            d.pendingMemory = [];
          }
          break;
        case "undo-start":
        case "recover-start":
          if (e.status === "undoing") return c;
          if (
            !snapshot ||
            (action === "undo-start" &&
              (e.status !== "applied" ||
                (!snapshotSame(snapshot, e.after) &&
                  !snapshotSame(snapshot, e.before)))) ||
            (action === "recover-start" && e.status !== "prepared")
          )
            fail("TARGET_CHANGED", "对象已变化，不能自动撤销", 409);
          if (e.bindingCommitted && !sameBinding(current, e.afterBinding))
            fail("CHANGE_CONFLICT", "绑定已变化", 409);
          if (e.beforeBinding) entity(p.variables, e.beforeBinding.variableId);
          if (action === "recover-start") e.after = snapshot;
          e.status = "undoing";
          break;
        case "undo-complete":
          if (e.status === "undone") return c;
          if (e.status !== "undoing" || !snapshotSame(snapshot, e.before))
            fail("TARGET_CHANGED", "尚未验证恢复结果", 409);
          if (e.bindingCommitted) {
            if (!sameBinding(current, e.afterBinding))
              fail("CHANGE_CONFLICT", "绑定已变化", 409);
            if (e.beforeBinding)
              Object.assign(current!, e.beforeBinding, {
                revision: current!.revision + 1,
                updatedAt: now(),
              });
            else
              p.bindings = p.bindings.filter((b) => b.id !== e.afterBinding.id);
          }
          e.status = "undone";
          if (e.draftId) {
            const d = entity(s.drafts, e.draftId);
            if (e.bindingCommitted && e.memoryBeforeScope)
              s.memories[d.sessionId] = [
                ...(s.memories[d.sessionId] || []).filter(
                  (m) => m.scope !== `binding:${e.afterBinding.id}`,
                ),
                ...e.memoryBeforeScope,
              ];
            if (d.status !== "committed") {
              d.status = "cancelled";
              d.pendingMemory = [];
            }
          }
          break;
        default:
          fail("INVALID_INPUT", "未知修改操作", 400);
      }
      p.revision++;
      p.updatedAt = now();
      return c;
    });
    await this.store.materializeMemories();
    return result;
  }
}
