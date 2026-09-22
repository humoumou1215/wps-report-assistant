import { Store, project, entity, id, now } from "./store.js";
import { transform } from "../legacy/execute.js";
import { fail } from "../../../shared/contracts/index.js";
export async function refreshSource(
  store: Store,
  pid: string,
  sid: string,
  input: any,
) {
  return store.transaction(async (state) => {
    const p = project(state, pid),
      src = entity(p.sources, sid),
      vars = p.variables.filter((v) => v.sourceId === sid),
      computed = [];
    try {
      for (const v of vars)
        computed.push(await transform(input.values, v.transform));
    } catch {
      fail(
        "SOURCE_SCHEMA_CHANGED",
        "数据结构发生变化，需要 AI 调整变量规则",
        422,
        "点击“让 AI 修复”生成预览；旧数据仍保留",
      );
    }
    for (let i = 0; i < vars.length; i++) {
      const v = vars[i];
      state.variableRevisions.push({
        id: id(),
        projectId: pid,
        variableId: v.id,
        createdAt: now(),
        variable: structuredClone(v),
        source: structuredClone(src),
      });
      Object.assign(v, computed[i], {
        revision: v.revision + 1,
        updatedAt: now(),
        lastError: null,
      });
    }
    for (const k of [
      "values",
      "requestedAddress",
      "effectiveAddress",
      "selectionMode",
      "locator",
    ])
      if (input[k] !== undefined) src[k] = input[k];
    src.revision++;
    src.updatedAt = now();
    p.revision++;
    p.updatedAt = now();
    return { source: src };
  });
}
export async function restoreVariable(
  store: Store,
  pid: string,
  vid: string,
  input: any,
) {
  return store.transaction((s) => {
    const p = project(s, pid),
      v = entity(p.variables, vid),
      rev = entity(s.variableRevisions, input.revisionId);
    if (rev.projectId !== pid || rev.variableId !== vid)
      fail("NOT_FOUND", "历史版本不存在", 404);
    if (input.expectedVersion !== v.updatedAt)
      fail("STALE_VARIABLE_REVISION", "变量已变化", 409);
    const source = entity(p.sources, v.sourceId);
    s.variableRevisions.push({
      id: id(),
      projectId: pid,
      variableId: vid,
      createdAt: now(),
      variable: structuredClone(v),
      source: structuredClone(source),
    });
    const restored = { ...rev.source, id: id(), revision: 1, updatedAt: now() };
    p.sources.push(restored);
    Object.assign(v, rev.variable, {
      sessionId: v.sessionId,
      revision: v.revision + 1,
      sourceId: restored.id,
      updatedAt: now(),
    });
    p.revision++;
    return { variable: v };
  });
}
