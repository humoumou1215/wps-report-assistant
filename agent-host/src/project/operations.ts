import { Store, project, entity, id, now } from "./store.js";
import { fail } from "../../../shared/contracts/index.js";
import { resolveVariableInputs } from "./variable-knowledge.js";
import { execute, sourceRows } from "../sandbox/client.js";

function variableRows(variable: any) {
  if (variable.valueType === "table")
    return { columns: variable.columns, rows: variable.value };
  return { columns: ["value"], rows: [{ value: variable.value }] };
}

function resultRows(result: any) {
  if (result.valueType === "table") return { columns: result.columns, rows: result.value };
  return { columns: ["value"], rows: [{ value: result.value }] };
}

/** Recompute the full downstream Variable DAG in the deterministic sandbox. */
export async function refreshSource(
  store: Store,
  pid: string,
  sid: string,
  input: any,
) {
  return store.transaction(async (state) => {
    const p = project(state, pid), src = entity(p.sources, sid);
    const previousSource = structuredClone(src);
    const sourceValues = input.values !== undefined ? input.values : src.values;
    let refreshedSourceRows: ReturnType<typeof sourceRows>;
    try {
      refreshedSourceRows = sourceRows(sourceValues);
    } catch (error) {
      return fail(
        "SOURCE_SCHEMA_CHANGED",
        "Source 数据结构无效",
        422,
        error instanceof Error ? error.message : undefined,
      );
    }

    for (const key of ["values", "requestedAddress", "effectiveAddress", "selectionMode", "locator"])
      if (input[key] !== undefined) src[key] = input[key];
    src.revision++;
    src.updatedAt = now();

    const variables = p.variables;
    const byId = new Map(variables.map((variable) => [variable.id, variable]));
    const affected = new Set<string>();
    const dependsOnSource = (variableId: string, path = new Set<string>()): boolean => {
      if (path.has(variableId)) fail("VARIABLE_DEPENDENCY_CYCLE", "变量依赖存在循环", 409);
      const nextPath = new Set(path).add(variableId);
      const variable = byId.get(variableId);
      for (const ref of variable ? resolveVariableInputs(variable) : []) {
        if (ref.type === "source" && ref.sourceId === sid) return true;
        if (ref.type === "variable" && ref.variableId && dependsOnSource(ref.variableId, nextPath)) return true;
      }
      return false;
    };
    for (const variable of variables)
      if (dependsOnSource(variable.id)) affected.add(variable.id);

    const order: any[] = [], visiting = new Set<string>(), visited = new Set<string>();
    const visit = (variableId: string) => {
      if (visiting.has(variableId)) fail("VARIABLE_DEPENDENCY_CYCLE", "变量依赖存在循环", 409);
      if (visited.has(variableId)) return;
      visiting.add(variableId);
      const variable = byId.get(variableId);
      for (const ref of variable ? resolveVariableInputs(variable) : [])
        if (ref.type === "variable" && ref.variableId && affected.has(ref.variableId)) visit(ref.variableId);
      visiting.delete(variableId);
      visited.add(variableId);
      if (variable) order.push(variable);
    };
    for (const variableId of affected) visit(variableId);

    const results = new Map<string, any>();
    const errors = new Map<string, string>();
    for (const variable of order) {
      const refs = resolveVariableInputs(variable);
      const datasets: Record<string, { columns: string[]; rows: any[] }> = {};
      let inputError: string | undefined;
      for (const ref of refs) {
        if (ref.type === "source" && ref.sourceId) {
          try {
            const source = entity(p.sources, ref.sourceId);
            datasets[`source:${source.id}`] = ref.sourceId === sid
              ? refreshedSourceRows!
              : sourceRows(source.values);
          } catch (error) {
            inputError = error instanceof Error ? error.message : "Source 数据无效";
            break;
          }
        } else if (ref.type === "variable" && ref.variableId) {
          const upstream = byId.get(ref.variableId);
          if (!upstream) {
            inputError = "依赖的变量不存在";
            break;
          }
          if (errors.has(upstream.id)) {
            inputError = `依赖变量 ${upstream.name || upstream.id} 需要修复`;
            break;
          }
          datasets[`variable:${upstream.id}`] = results.has(upstream.id)
            ? resultRows(results.get(upstream.id))
            : variableRows(upstream);
        }
      }
      try {
        if (inputError) throw new Error(inputError);
        const firstRef = refs[0];
        const firstId = firstRef?.type === "source" ? firstRef.sourceId : firstRef?.variableId;
        const first = firstId ? datasets[`${firstRef!.type}:${firstId}`] : undefined;
        if (!first) throw new Error("变量输入不存在");
        const result = await execute(variable.transform?.code, "transform", {
          rows: first.rows,
          columns: first.columns,
          sources: datasets,
        });
        results.set(variable.id, result.result);
      } catch (error) {
        errors.set(variable.id, error instanceof Error ? error.message : "Transform 执行失败");
      }
    }

    for (const variable of order) {
      state.variableRevisions.push({
        id: id(), projectId: pid, variableId: variable.id,
        revision: variable.revision, createdAt: now(),
        variable: structuredClone(variable), source: previousSource,
        inputs: resolveVariableInputs(variable).map((ref) => ({ ...ref })),
      } as any);
      const error = errors.get(variable.id);
      Object.assign(variable, error ? {} : results.get(variable.id), {
        revision: variable.revision + 1,
        status: error ? "needs-ai-repair" : "ready",
        lastError: error || null,
        inputRevisions: Object.fromEntries(resolveVariableInputs(variable).map((ref) => {
          if (ref.type === "source" && ref.sourceId)
            return [`source:${ref.sourceId}`, ref.sourceId === sid ? src.revision : entity(p.sources, ref.sourceId).revision];
          if (ref.type === "variable" && ref.variableId)
            return [`variable:${ref.variableId}`, byId.get(ref.variableId)?.revision || 0];
          return ["unknown", 0];
        })),
        updatedAt: now(),
      });
    }

    p.revision++;
    p.updatedAt = now();
    return {
      source: src,
      refreshedVariableIds: order.filter((variable) => !errors.has(variable.id)).map((variable) => variable.id),
      repairRequired: [...errors].map(([variableId, message]) => ({ variableId, message })),
    };
  });
}

export async function restoreVariable(
  store: Store,
  pid: string,
  vid: string,
  input: any,
) {
  return store.transaction((s) => {
    const p = project(s, pid), v = entity(p.variables, vid), rev = entity(s.variableRevisions, input.revisionId);
    if (rev.projectId !== pid || rev.variableId !== vid)
      fail("NOT_FOUND", "历史版本不存在", 404);
    if (input.expectedVersion !== v.updatedAt)
      fail("STALE_VARIABLE_REVISION", "变量已变化", 409);
    s.variableRevisions.push({
      id: id(), projectId: pid, variableId: vid, revision: v.revision,
      createdAt: now(), variable: structuredClone(v),
      inputs: resolveVariableInputs(v).map((ref) => ({ ...ref })),
    } as any);
    Object.assign(v, structuredClone(rev.variable), {
      revision: v.revision + 1,
      status: "ready",
      lastError: null,
      updatedAt: now(),
    });
    p.revision++;
    p.updatedAt = now();
    return { variable: v };
  });
}
