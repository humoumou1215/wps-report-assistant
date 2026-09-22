import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  open,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  AppError,
  fail,
  type State,
  type Project,
  type RecordData,
} from "../../../shared/contracts/index.js";
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function canonical(v: any): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
}
export const fingerprint = (v: any) =>
  createHash("sha256").update(canonical(v)).digest("hex");
export async function atomic(file: string, data: any) {
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = file + "." + id() + ".tmp";
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(
      typeof data === "string" ? data : JSON.stringify(data, null, 2),
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
  if (process.platform !== "win32") {
    const directory = await open(join(file, ".."), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
export async function readJSON(file: string, fallback: any) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}
export function project(state: State, pid: string): Project {
  return (
    state.projects.find((p) => p.id === pid) ??
    fail("NOT_FOUND", "项目不存在", 404)
  );
}
export function entity<T extends RecordData>(list: T[], eid: string): T {
  return list.find((x) => x.id === eid) ?? fail("NOT_FOUND", "对象不存在", 404);
}
export class Store {
  private state!: State;
  private tail: Promise<any> = Promise.resolve();
  constructor(public dir: string) {}
  async open() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const loaded = await readJSON(join(this.dir, "state.json"), {
      version: 1,
      projects: [],
    });
    if (!Array.isArray(loaded.projects))
      fail("STATE_INVALID", "无法读取项目数据", 500);
    this.state = {
      ...loaded,
      drafts: loaded.drafts || [],
      runs: loaded.runs || [],
      memories: loaded.memories || {},
      variableRevisions: loaded.variableRevisions || [],
      pptChanges: loaded.pptChanges || [],
    };
    for (const p of this.state.projects) {
      p.revision ??= 1;
      for (const key of [
        "documents",
        "sources",
        "variables",
        "bindings",
      ] as const)
        p[key] ??= [];
      for (const s of p.sources) s.revision ??= 1;
      for (const v of p.variables) {
        v.revision ??= 1;
        v.sessionId ??= id();
      }
      for (const b of p.bindings) b.revision ??= 1;
    }
    for (const run of this.state.runs)
      if (
        ["queued", "running", "waiting_tool", "reviewing"].includes(run.status)
      ) {
        run.status = "interrupted";
        run.finishedAt = now();
      }
    for (const d of this.state.drafts)
      if (d.status === "running") d.status = "interrupted";
    // Keep the original migration input byte-for-byte, with private permissions.
    if (!loaded.agentHostVersion)
      await atomic(join(this.dir, "migration-backup.json"), loaded);
    this.state.agentHostVersion = 1;
    await atomic(join(this.dir, "state.json"), this.state);
    await this.materializeMemories();
    return this;
  }
  snapshot() {
    return structuredClone(this.state);
  }
  getProject(pid: string) {
    return project(this.snapshot(), pid);
  }
  async transaction<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    const job = this.tail.then(async () => {
      const next = this.snapshot();
      const result = await fn(next);
      await atomic(join(this.dir, "state.json"), next);
      this.state = next;
      return structuredClone(result);
    });
    this.tail = job.catch(() => {});
    return job;
  }
  async materializeMemories() {
    for (const p of this.state.projects)
      for (const v of p.variables) {
        const entries = this.state.memories[v.sessionId] || [];
        const text = [
          "# Variable Memory",
          "",
          ...entries.map(
            (e) => `## ${e.category} (${e.scope})\n\n${e.content}\n`,
          ),
          "## Revision Anchors",
          `variableRevision: ${v.revision}`,
          `sourceRevision: ${p.sources.find((s) => s.id === v.sourceId)?.revision || 0}`,
        ].join("\n");
        await atomic(
          join(this.dir, "projects", p.id, "variables", v.id, "memory.md"),
          text,
        );
      }
  }
  async createProject(name: string) {
    if (!name?.trim()) fail("INVALID_INPUT", "项目名称不能为空", 400);
    return this.transaction((s) => {
      const p: Project = {
        id: id(),
        name: name.trim(),
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
        documents: [],
        sources: [],
        variables: [],
        bindings: [],
      };
      s.projects.push(p);
      return p;
    });
  }
  async registerDocument(pid: string, input: RecordData) {
    return this.transaction((s) => {
      const p = project(s, pid);
      if (!input.key || !input.kind) fail("INVALID_INPUT", "缺少文件信息", 400);
      const key = (x: string) =>
        /^[A-Za-z]:|^\\\\/.test(x) ? x.replaceAll("\\", "/").toLowerCase() : x;
      for (const other of s.projects)
        if (
          other.id !== pid &&
          other.documents.some((d) => key(d.key) === key(input.key))
        )
          fail("DOCUMENT_CONFLICT", "文件已属于另一个项目", 409);
      let d = p.documents.find((d) => key(d.key) === key(input.key));
      if (d) {
        Object.assign(d, {
          name: input.name,
          kind: input.kind,
          lastSeenAt: now(),
        });
      } else {
        d = {
          id: id(),
          key: input.key,
          name: input.name || input.key,
          kind: input.kind,
          capabilities: input.capabilities || [],
          createdAt: now(),
          lastSeenAt: now(),
        };
        p.documents.push(d);
      }
      p.revision++;
      return d;
    });
  }
}
