import { SessionRegistry } from "./session-registry.js";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  AppError,
  fail,
  type Draft,
  type RecordData,
  type AgentRun,
} from "../../../shared/contracts/index.js";
import {
  Store,
  id,
  now,
  entity,
  project,
  atomic,
  fingerprint,
} from "../project/store.js";
import { execute, sourceRows } from "../sandbox/client.js";
import {
  reduced,
  projectSummary,
  modelJSON,
  targetSummary,
  sourceStatistics,
} from "./context-builder.js";
import type { AgentRuntime } from "./pi-runtime.js";
import type { Critic } from "./critic.js";
export const TOOL_NAMES = [
  "get_project_context",
  "inspect_source",
  "inspect_variable",
  "inspect_binding",
  "inspect_target",
  "run_transform_candidate",
  "run_renderer_candidate",
  "inspect_result",
  "validate_candidate",
  "propose_memory_update",
];

// A run already owns its project/source/variable/binding context.  Do not
// expose those identifiers as model-controlled arguments: doing so makes the
// model repeat ids it has only seen in summaries (or invent ids), which turns
// a valid bound tool call into TOOL_SCOPE_ERROR.  The checks in `call` below
// remain as a defence-in-depth boundary for direct/in-process callers.
const TOOL_SPECS: Record<string, { description: string; parameters: any }> = {
  get_project_context: {
    description: "读取当前任务所属项目的有限摘要。任务范围由宿主自动绑定。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  inspect_source: {
    description:
      "读取当前任务源数据的 schema、有限样本或统计信息。不要传 sourceId；源数据由宿主自动绑定。",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["schema", "sample", "stats"] },
        limit: { type: "integer", minimum: 0, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  inspect_variable: {
    description:
      "读取当前任务变量的元数据和有限结果摘要。不要传 variableId；变量由宿主自动绑定。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  inspect_binding: {
    description:
      "读取当前输出绑定或待创建绑定的展示要求。不要传 bindingId；绑定由宿主自动绑定。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  inspect_target: {
    description:
      "读取当前 WPS 目标对象的类型、容量、现有内容摘要和指纹。不要传 targetId。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  run_transform_candidate: {
    description:
      "在当前任务的完整源数据上执行一个 transform 候选。只提交完整 JavaScript 函数代码，不要传 sourceId。",
    parameters: {
      type: "object",
      properties: { code: { type: "string", minLength: 1, maxLength: 65536 } },
      required: ["code"],
      additionalProperties: false,
    },
  },
  run_renderer_candidate: {
    description:
      "在当前任务绑定的完整变量和目标上执行一个 renderer 候选。只提交完整 JavaScript 函数代码，不要传 variableId、bindingId 或 targetId。",
    parameters: {
      type: "object",
      properties: { code: { type: "string", minLength: 1, maxLength: 65536 } },
      required: ["code"],
      additionalProperties: false,
    },
  },
  inspect_result: {
    description:
      "按当前候选的 resultRef 查看有限结果摘要；省略 resultRef 时查看最近候选。",
    parameters: {
      type: "object",
      properties: {
        resultRef: { type: "string" },
        limit: { type: "integer", minimum: 0, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  validate_candidate: {
    description:
      "校验当前候选的结果结构、版本和任务范围。不要传 projectId、sourceId、variableId 或 bindingId。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  propose_memory_update: {
    description:
      "提出一条待用户确认的稳定语义记忆。宿主自动决定 scope；不要传 scope 或任何对象 ID。",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [
            "objective",
            "confirmed-decision",
            "user-correction",
            "transform-intent",
            "lesson",
            "binding-decision",
          ],
        },
        content: { type: "string", minLength: 1, maxLength: 2000 },
      },
      required: ["category", "content"],
      additionalProperties: false,
    },
  },
};
export class AgentService {
  events = new EventEmitter();
  private busy = new Set<string>();
  private controllers = new Map<string, AbortController>();
  constructor(
    public store: Store,
    private runtime: AgentRuntime,
    private critic: Critic,
    private maxConcurrent = 2,
    private timeoutMs = 120000,
  ) {}
  async createDraft(
    pid: string,
    kind: "transform" | "render",
    input: RecordData,
  ) {
    const draft = await this.store.transaction((s) => {
      const p = project(s, pid),
        v = input.variableId
          ? entity(p.variables, input.variableId)
          : undefined,
        b = input.bindingId ? entity(p.bindings, input.bindingId) : undefined;
      entity(p.documents, input.documentId);
      if (b && b.variableId !== v?.id)
        fail("INVALID_INPUT", "绑定不属于当前变量", 400);
      if (v && input.expectedVersion && input.expectedVersion !== v.updatedAt)
        fail("STALE_VARIABLE_REVISION", "变量已变化", 409);
      if (kind === "render" && !v) fail("INVALID_INPUT", "缺少变量", 400);
      if (kind === "transform" && (!input.name?.trim() || !input.values))
        fail("INVALID_INPUT", "缺少变量名称或源数据", 400);
      if (
        kind === "transform" &&
        p.variables.some((x) => x.name === input.name && x.id !== v?.id)
      )
        fail("NAME_CONFLICT", "当前项目内变量名称重复", 409);
      const src = v ? entity(p.sources, v.sourceId) : undefined;
      const d: Draft = {
        id: id(),
        projectId: pid,
        sessionId: v?.sessionId || id(),
        kind,
        status: "pending",
        pendingMemory: [],
        sourceRevision: src?.revision || 0,
        variableRevision: v?.revision || 0,
        bindingRevision: b?.revision || 0,
        input: structuredClone(input),
        variableId: v?.id,
        bindingId: b?.id,
        sourceId: src?.id,
        createdAt: now(),
        targetFingerprint:
          kind === "render"
            ? fingerprint(
                input.targetSnapshot?.comparison ||
                  input.targetSnapshot ||
                  input.target,
              )
            : undefined,
      };
      s.drafts.push(d);
      return d;
    });
    const session = await new SessionRegistry(this.store.dir).resume(
      draft.sessionId,
    );
    session.appendCustomEntry("report-assistant-scope", {
      scope: draft.variableId
        ? `variable:${draft.variableId}`
        : `variable-draft:${draft.id}`,
    });
    return draft;
  }
  draft(pid: string, did: string) {
    const d = entity(this.store.snapshot().drafts, did);
    if (d.projectId !== pid) fail("NOT_FOUND", "预览不存在", 404);
    return d;
  }
  async cancel(pid: string, did: string) {
    const d = this.draft(pid, did);
    this.controllers.get(did)?.abort();
    await this.store.transaction((s) => {
      const d = entity(s.drafts, did);
      if (["committed", "prepared"].includes(d.status))
        fail("DRAFT_COMMITTED", "文档事务中的预览不能取消", 409);
      d.status = "cancelled";
      d.pendingMemory = [];
    });
    if (d.resultRef)
      await rm(join(this.store.dir, "results", d.resultRef + ".json"), {
        force: true,
      });
  }
  start(
    pid: string,
    did: string,
  ): Promise<{ draftId: string; runId: string; status: string }> {
    return new Promise((resolve, reject) => {
      void this.run(pid, did, (run) =>
        resolve({ draftId: did, runId: run.id, status: "running" }),
      ).catch(reject);
    });
  }
  async run(pid: string, did: string, onStarted?: (run: AgentRun) => void) {
    const d = this.draft(pid, did),
      key = d.sessionId;
    if (this.busy.has(key))
      fail("VARIABLE_AGENT_BUSY", "这个变量正在处理另一项请求", 409);
    if (this.busy.size >= this.maxConcurrent)
      fail("AGENT_BUSY", "已有两个任务运行，请稍后重试", 429);
    if (["committed", "cancelled", "prepared", "running"].includes(d.status))
      fail("DRAFT_CLOSED", "预览已经结束", 409);
    this.busy.add(key);
    const controller = new AbortController();
    this.controllers.set(did, controller);
    const run: AgentRun = {
      id: id(),
      projectId: pid,
      draftId: did,
      variableId: d.variableId,
      sessionId: key,
      status: "running",
      startedAt: now(),
      toolCalls: [],
      toolErrors: [],
      candidateHashes: [],
      events: [],
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const emit = async (type: string) => {
      const event = { type, runId: run.id, timestamp: now() };
      run.events.push(event);
      await this.store.transaction((s) => {
        const old = s.runs.find((x) => x.id === run.id);
        if (old) Object.assign(old, run);
      });
      this.events.emit(run.id, event);
    };
    try {
      await this.store.transaction((s) => {
        s.runs.push(run);
        const current = entity(s.drafts, did);
        current.status = "running";
        current.runId = run.id;
        current.pendingMemory = [];
      });
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
      await emit("agent_started");
      onStarted?.(run);
      let candidate: any,
        executions = 0,
        turns = 0,
        needsInspect = false,
        validated = false,
        semanticRepairs = 0;
      let limitError: AppError | undefined;
      const fresh = () => this.store.getProject(pid);
      const variable = () =>
        d.variableId ? entity(fresh().variables, d.variableId) : undefined;
      const source = () =>
        sourceRows(
          d.input.values ||
            entity(fresh().sources, variable()!.sourceId).values,
        );
      const checkRevision = () => {
        const p = fresh();
        if (d.variableId) {
          const v = entity(p.variables, d.variableId);
          if (v.revision !== d.variableRevision)
            fail("STALE_VARIABLE_REVISION", "变量已变化", 409);
          if (entity(p.sources, v.sourceId).revision !== d.sourceRevision)
            fail("STALE_SOURCE_REVISION", "源数据已变化", 409);
        }
        if (
          d.bindingId &&
          entity(p.bindings, d.bindingId).revision !== d.bindingRevision
        )
          fail("STALE_BINDING_REVISION", "绑定已变化", 409);
      };
      const call = async (name: string, args: any) => {
        controller.signal.throwIfAborted();
        run.toolCalls.push(name);
        try {
          args =
            args && typeof args === "object" && !Array.isArray(args) ? args : {};
          // Tools are bound to the run's project and entities; callers cannot inspect another variable.
          for (const [field, expected] of Object.entries({
            projectId: pid,
            sourceId: d.sourceId,
            variableId: d.variableId,
            bindingId: d.bindingId,
          }))
            if (args[field] && args[field] !== expected)
              fail(
                "TOOL_SCOPE_ERROR",
                "对象不属于当前任务",
                403,
                "工具已经绑定当前任务，请省略 projectId/sourceId/variableId/bindingId 等对象 ID",
              );
          if (name === "get_project_context") return projectSummary(fresh());
          if (name === "inspect_source") {
            needsInspect = false;
            await emit("inspecting_source");
            const x = source();
            return {
              sourceRevision: d.sourceRevision,
              columnCount: x.columns.length,
              ...(args.mode === "stats"
                ? { stats: sourceStatistics(x.rows, x.columns) }
                : {}),
              ...reduced(
                { valueType: "table", columns: x.columns, value: x.rows },
                args.mode === "schema" ? 0 : args.limit || 10,
              ),
            };
          }
          if (name === "inspect_variable") {
            const v = variable();
            return v
              ? {
                  revision: v.revision,
                  description: v.description,
                  transform: v.transform,
                  ...reduced(v),
                }
              : { draftId: did };
          }
          if (name === "inspect_binding") {
            const b = d.bindingId
              ? entity(fresh().bindings, d.bindingId)
              : undefined;
            return {
              description: b?.description || d.input.description,
              renderer: b?.renderer,
              target: targetSummary(b?.target || d.input.target),
              bindingRevision: d.bindingRevision,
            };
          }
          if (name === "inspect_target")
            return {
              target: targetSummary(d.input.target),
              targetSnapshot: d.input.targetSnapshot
                ? reduced(d.input.targetSnapshot)
                : undefined,
              targetFingerprint: d.targetFingerprint,
            };
          if (name === "inspect_result") {
            if (
              !candidate ||
              (args.resultRef && args.resultRef !== candidate.ref)
            )
              fail("NOT_FOUND", "结果不存在", 404);
            return {
              resultRef: candidate.ref,
              ...reduced(candidate.result, args.limit),
            };
          }
          if (name === "propose_memory_update") {
            const categories = [
              "objective",
              "confirmed-decision",
              "user-correction",
              "transform-intent",
              "lesson",
              "binding-decision",
            ];
            if (
              !categories.includes(args.category) ||
              typeof args.content !== "string" ||
              !args.content.trim() ||
              args.content.length > 2000
            )
              fail("MEMORY_INVALID", "记忆提案无效");
            const scope =
              d.kind === "render"
                ? `binding:${d.bindingId || did}`
                : "variable";
            if (args.scope && args.scope !== scope)
              fail(
                "TOOL_SCOPE_ERROR",
                "记忆范围不匹配",
                403,
                "scope 由宿主自动分配，请省略 scope",
              );
            await this.store.transaction((s) => {
              const current = entity(s.drafts, did);
              if (current.pendingMemory.length >= 30)
                fail("MEMORY_LIMIT", "记忆提案过多");
              current.pendingMemory.push({
                category: args.category,
                content: args.content,
                scope,
              });
            });
            return { pending: true };
          }
          if (name === "validate_candidate") {
            if (!candidate) fail("NO_CANDIDATE", "请先执行候选程序");
            checkRevision();
            validated = true;
            await emit("candidate_validated");
            return { passed: true, resultRef: candidate.ref };
          }
          if (
            name === "run_transform_candidate" ||
            name === "run_renderer_candidate"
          ) {
            const stage =
              name === "run_transform_candidate" ? "transform" : "render";
            if (stage !== d.kind)
              fail("TOOL_SCOPE_ERROR", "当前阶段不允许此操作");
            if (needsInspect)
              fail("SOURCE_SCHEMA_CHANGED", "必须先重新调用 inspect_source");
            if (++executions > 5) {
              candidate = undefined;
              validated = false;
              limitError = new AppError("AGENT_LIMIT", "候选执行超过 5 次");
              throw limitError;
            }
            candidate = undefined;
            validated = false;
            await emit("candidate_execution_started");
            const input =
              stage === "transform"
                ? source()
                : {
                    variable: variable(),
                    target: d.input.target
                      ? {
                          ...d.input.target,
                          ...(d.input.target.snapshot || d.input.targetSnapshot
                            ? {
                                snapshot:
                                  d.input.target.snapshot ||
                                  d.input.targetSnapshot,
                              }
                            : {}),
                        }
                      : d.input.targetSnapshot,
                  };
            const out = await execute(
              args.code,
              stage,
              input,
              controller.signal,
            );
            candidate = { ...out, ref: id() };
            run.candidateHashes.push(fingerprint(out.code));
            await atomic(
              join(this.store.dir, "results", candidate.ref + ".json"),
              {
                sourceRevision: d.sourceRevision,
                scriptHash: fingerprint(out.code),
                runtimeVersion: "quickjs-0.31.0",
                createdAt: now(),
                result: out.result,
              },
            );
            await emit("candidate_generated");
            return {
              ok: true,
              resultRef: candidate.ref,
              ...reduced(out.result),
            };
          }
          fail("TOOL_NOT_ALLOWED", "工具不允许", 403);
        } catch (error) {
          const e =
            error instanceof AppError
              ? error
              : new AppError("TOOL_INTERNAL_ERROR", "工具执行失败");
          if (e.code === "SOURCE_SCHEMA_CHANGED") needsInspect = true;
          run.toolErrors.push({ tool: name, code: e.code });
          await emit("candidate_execution_failed");
          return { ok: false, error: e.toJSON() };
        }
      };
      const tools = TOOL_NAMES.map((name) => ({
        name,
        label: name,
        description: TOOL_SPECS[name].description,
        parameters: TOOL_SPECS[name].parameters,
        execute: async (_id: string, args: any) => ({
          content: [{ type: "text", text: modelJSON(await call(name, args)) }],
          details: {},
        }),
      })) as ToolDefinition[];
      let repair = "";
      while (true) {
        checkRevision();
        const p = fresh(),
          v = variable();
        const context = {
          memory: (this.store.snapshot().memories[key] || []).filter(
            (m) =>
              m.scope === "variable" ||
              (d.kind === "render" &&
                m.scope === `binding:${d.bindingId || did}`),
          ),
          memoryNotice:
            "仅保留已确认语义，旧 revision 已过期时不得作为实时事实",
          freshProject: projectSummary(p),
          freshVariable: v
            ? {
                revision: v.revision,
                transform: v.transform,
                ...reduced(v),
              }
            : null,
          freshBinding:
            d.kind === "render"
              ? {
                  bindingRevision: d.bindingRevision,
                  target: targetSummary(d.input.target),
                }
              : null,
          currentUserIntent: d.input.description,
          stage: d.kind,
          repair,
        };
        const runtimeResult = await this.runtime.run({
          sessionId: key,
          context: modelJSON(context, 100000),
          tools,
          signal: controller.signal,
          onTurn: () => {
            if (++turns > 8) fail("AGENT_LIMIT", "模型回合超过 8 次");
          },
        });
        if (runtimeResult) {
          run.sessionEntryId = runtimeResult.sessionEntryId;
          run.tokenUsage = runtimeResult.tokenUsage;
          run.model = runtimeResult.model;
        }
        controller.signal.throwIfAborted();
        if (limitError) throw limitError;
        if (!candidate || !validated)
          fail("NO_VALIDATED_CANDIDATE", "AI 未生成经过执行和校验的候选结果");
        run.status = "reviewing";
        await emit("critic_started");
        const review = await this.critic.review(
          {
            stage: d.kind,
            intent: d.input.description,
            // A renderer consumes the already transformed Variable.  Feeding
            // the raw Source to the critic here made a valid top-N variable
            // look like it had dropped rows or referenced missing columns.
            ...(d.kind === "transform"
              ? {
                  source: reduced(
                    { columns: source().columns, value: source().rows },
                    5,
                  ),
                }
              : {
                  variable: variable()
                    ? {
                        description: variable()!.description,
                        ...reduced(variable()!, 20),
                      }
                    : undefined,
                }),
            script: candidate.code,
            result: reduced(candidate.result),
            target:
              d.kind === "render" ? targetSummary(d.input.target) : undefined,
            validation: { passed: true },
          },
          controller.signal,
        );
        controller.signal.throwIfAborted();
        run.critic = review;
        if (review.passed || semanticRepairs >= 2) break;
        semanticRepairs++;
        repair = review.repairInstruction || review.issues.join(";");
        validated = false;
        await emit("candidate_repairing");
      }
      checkRevision();
      run.validation = { passed: true };
      run.status = "preview_ready";
      run.finishedAt = now();
      run.duration = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
      await this.store.transaction((s) => {
        const current = entity(s.drafts, did);
        if (current.status === "cancelled") fail("CANCELLED", "已取消", 409);
        Object.assign(current, {
          status: "preview_ready",
          sessionEntryId: run.sessionEntryId,
          code: candidate.code,
          result: candidate.result,
          resultRef: candidate.ref,
          validation: { passed: true, errors: [], warnings: [] },
          critic: run.critic,
          requiresRiskAcceptance: !run.critic.passed,
        });
      });
      await emit("preview_ready");
      return this.preview(pid, did);
    } catch (error) {
      run.status = controller.signal.aborted ? "cancelled" : "failed";
      run.finishedAt = now();
      run.duration = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
      run.error =
        error instanceof AppError
          ? error.toJSON()
          : {
              code: controller.signal.aborted ? "CANCELLED" : "MODEL_ERROR",
              message: controller.signal.aborted
                ? "任务已取消或超时"
                : "模型调用失败，请检查连接与设置",
            };
      await this.store.transaction((s) => {
        const current = entity(s.drafts, did);
        current.status = run.status;
        current.pendingMemory = [];
      });
      await emit(run.status);
      throw new AppError(run.error.code, run.error.message, 422);
    } finally {
      clearTimeout(timer);
      this.busy.delete(key);
      this.controllers.delete(did);
    }
  }
  preview(pid: string, did: string) {
    const d = this.draft(pid, did);
    return {
      draftId: did,
      runId: d.runId,
      sessionId: d.sessionId,
      status: d.status,
      error: this.store.snapshot().runs.find((r) => r.id === d.runId)?.error,
      generation: "pi-agent",
      transform:
        d.kind === "transform"
          ? { language: "javascript", version: 2, code: d.code }
          : undefined,
      renderer:
        d.kind === "render"
          ? { language: "javascript", version: 2, code: d.code }
          : undefined,
      result: d.kind === "transform" ? d.result : undefined,
      plan: d.kind === "render" ? d.result : undefined,
      validation: d.validation,
      critic: d.critic,
      requiresRiskAcceptance: d.requiresRiskAcceptance,
      targetFingerprint: d.targetFingerprint,
    };
  }
  async commitVariable(pid: string, did: string, acceptRisk = false) {
    const result = await this.store.transaction((s) => {
      const d = entity(s.drafts, did);
      if (d.projectId !== pid || d.kind !== "transform")
        fail("NOT_FOUND", "预览不存在", 404);
      if (d.status !== "preview_ready")
        fail("DRAFT_NOT_READY", "预览未就绪", 409);
      if (d.requiresRiskAcceptance && !acceptRisk)
        fail("RISK_ACK_REQUIRED", "请确认语义复核风险", 412);
      const p = project(s, pid),
        input = d.input;
      entity(p.documents, input.documentId);
      if (
        p.variables.some((v) => v.name === input.name && v.id !== d.variableId)
      )
        fail("NAME_CONFLICT", "变量名称重复", 409);
      let v = d.variableId ? entity(p.variables, d.variableId) : undefined,
        src = v ? entity(p.sources, v.sourceId) : undefined;
      if (v && v.revision !== d.variableRevision)
        fail("STALE_VARIABLE_REVISION", "变量已变化", 409);
      if (src && src.revision !== d.sourceRevision)
        fail("STALE_SOURCE_REVISION", "源数据已变化", 409);
      if (v)
        s.variableRevisions.push({
          id: id(),
          projectId: pid,
          variableId: v.id,
          createdAt: now(),
          variable: structuredClone(v),
          source: structuredClone(src),
        });
      // Editing uses a new source when shared, so other variables never become inconsistent.
      if (
        !src ||
        p.variables.some((x) => x.sourceId === src!.id && x.id !== v?.id)
      ) {
        src = {
          id: id(),
          revision: 0,
          documentId: input.documentId,
          values: [],
          createdAt: now(),
        };
        p.sources.push(src);
      }
      Object.assign(src, {
        ...input,
        id: src.id,
        values: input.values,
        revision: src.revision + 1,
        updatedAt: now(),
      });
      delete src.variableId;
      delete src.expectedVersion;
      if (!v) {
        v = {
          id: id(),
          sourceId: src.id,
          sessionId: d.sessionId,
          revision: 0,
          transform: {},
          valueType: "table",
          columns: [],
          value: [],
          createdAt: now(),
        };
        p.variables.push(v);
      }
      Object.assign(v, {
        name: input.name,
        displayName: input.displayName || input.name,
        description: input.description,
        sessionEntryId: d.sessionEntryId,
        sourceId: src.id,
        transform: { language: "javascript", version: 2, code: d.code },
        ...d.result,
        revision: v.revision + 1,
        updatedAt: now(),
        lastError: null,
      });
      s.memories[d.sessionId] = [
        ...(s.memories[d.sessionId] || []),
        ...d.pendingMemory,
      ];
      d.pendingMemory = [];
      d.status = "committed";
      d.variableId = v.id;
      p.revision++;
      p.updatedAt = now();
      return { source: src, variable: v };
    });
    await this.store.materializeMemories();
    return result;
  }
}
