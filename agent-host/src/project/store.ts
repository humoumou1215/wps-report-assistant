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
export const CURRENT_STATE_VERSION = 3;
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
  private listeners = new Set<(before: State, after: State) => void>();
  constructor(public dir: string) {}
  async open() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const file = join(this.dir, "state.json");
    const loaded = await readJSON(file, null);
    if (loaded === null) {
      this.state = {
        version: CURRENT_STATE_VERSION,
        projects: [],
        conversations: [],
        chatMessages: [],
        tasks: [],
        variableKnowledge: {},
        renderIndex: {},
        variableRevisions: [],
      };
      await atomic(file, this.state);
      return this;
    }
    if (loaded.version !== CURRENT_STATE_VERSION)
      fail("STATE_VERSION_UNSUPPORTED", `数据格式版本 ${loaded.version} 不受支持；需要全新的数据目录`, 409);
    if (
      !Array.isArray(loaded.projects) ||
      !Array.isArray(loaded.conversations) ||
      !Array.isArray(loaded.chatMessages) ||
      !Array.isArray(loaded.tasks) ||
      !Array.isArray(loaded.variableRevisions) ||
      !loaded.variableKnowledge || typeof loaded.variableKnowledge !== "object" ||
      !loaded.renderIndex || typeof loaded.renderIndex !== "object"
    ) fail("STATE_INVALID", "项目数据格式无效", 500);
    this.state = loaded;
    return this;
  }
  snapshot() {
    return structuredClone(this.state);
  }
  getProject(pid: string) {
    return project(this.snapshot(), pid);
  }
  subscribe(listener: (before: State, after: State) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async transaction<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    const job = this.tail.then(async () => {
      const before = this.snapshot();
      const next = this.snapshot();
      const result = await fn(next);
      await atomic(join(this.dir, "state.json"), next);
      this.state = next;
      for (const listener of this.listeners) {
        try { listener(structuredClone(before), structuredClone(next)); } catch { /* observers cannot invalidate a durable commit */ }
      }
      return structuredClone(result);
    });
    this.tail = job.catch(() => {});
    return job;
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
        const name = input.name || input.key, kind = input.kind;
        const capabilities = input.capabilities || [];
        const changed = d.name !== name || d.kind !== kind ||
          canonical(d.capabilities || []) !== canonical(capabilities);
        Object.assign(d, {
          name,
          kind,
          capabilities,
          revision: (d.revision || 1) + (changed ? 1 : 0),
          lastSeenAt: now(),
        });
        if (changed) p.revision++;
      } else {
        d = {
          id: id(),
          key: input.key,
          name: input.name || input.key,
          kind: input.kind,
          capabilities: input.capabilities || [],
          revision: 1,
          createdAt: now(),
          lastSeenAt: now(),
        };
        p.documents.push(d);
        p.revision++;
      }
      return d;
    });
  }
}
