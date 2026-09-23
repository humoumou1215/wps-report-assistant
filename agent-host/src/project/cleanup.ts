import { readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "./store.js";
// Results are debugging aids only; the committed project value remains authoritative.
export async function cleanupResults(
  store: Store,
  ttlMs = 24 * 60 * 60 * 1000,
) {
  const dir = join(store.dir, "results");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  const active = new Set<string>();
  for (const task of store.snapshot().tasks)
    for (const operation of task.operations)
      if (["pending", "running", "validated", "applied"].includes(operation.status)) {
        if ("resultRef" in operation && operation.resultRef) active.add(operation.resultRef);
        if ("renderPlanRef" in operation && operation.renderPlanRef) active.add(operation.renderPlanRef);
      }
  for (const file of files) {
    if (!/^[a-f0-9-]+\.json$/.test(file)) continue;
    const path = join(dir, file),
      info = await stat(path);
    if (!active.has(file.slice(0, -5)) && Date.now() - info.mtimeMs > ttlMs)
      await rm(path, { force: true });
  }
}
