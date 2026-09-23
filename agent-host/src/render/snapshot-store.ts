import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomic, fingerprint } from "../project/store.js";
import type { SnapshotRef, TargetSnapshot } from "../../../shared/contracts/index.js";

const INLINE_LIMIT = 64 * 1024;

export class SnapshotStore {
  constructor(private root: string) {}
  private directory(projectId: string) {
    return join(this.root, "projects", projectId, "render-snapshots");
  }
  async save(projectId: string, snapshot: TargetSnapshot): Promise<{ snapshot?: TargetSnapshot; ref?: SnapshotRef }> {
    const data = JSON.stringify(snapshot);
    if (Buffer.byteLength(data) <= INLINE_LIMIT) return { snapshot };
    const sha256 = fingerprint(snapshot);
    const ref: SnapshotRef = { ref: sha256, sha256, size: Buffer.byteLength(data) };
    const file = join(this.directory(projectId), `${sha256}.json`);
    try {
      await stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(this.directory(projectId), { recursive: true, mode: 0o700 });
      await atomic(file, data);
    }
    return { ref };
  }
  async load(projectId: string, ref: SnapshotRef): Promise<TargetSnapshot> {
    const value = JSON.parse(await readFile(join(this.directory(projectId), `${ref.ref}.json`), "utf8"));
    if (fingerprint(value) !== ref.sha256) throw new Error("快照校验失败");
    return value;
  }
}
