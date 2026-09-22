import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  utimes,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/project/store.js";
import { Settings } from "../src/model/settings.js";
import { acquireHostLock } from "../src/project/host-lock.js";
import { cleanupResults } from "../src/project/cleanup.js";

test("host single writer lock and concurrent settings updates", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const release = await acquireHostLock(dir);
  await assert.rejects(acquireHostLock(dir), /已有 Agent Host/);
  await release();
  await (
    await acquireHostLock(dir)
  )();
  const settings = await new Settings(dir).open();
  await Promise.all([
    settings.update({ ai: { model: "model-a" } }),
    settings.update({ debug: { enabled: true } }),
  ]);
  const reopened = await new Settings(dir).open();
  assert.equal(reopened.public().ai.model, "model-a");
  assert.equal(reopened.public().debug.enabled, true);
});
test("malformed abandoned host lock is recovered after initialization grace period", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-stale-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lock = join(dir, ".agent-host-lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), "{");
  await utimes(lock, 1, 1);
  const release = await acquireHostLock(dir);
  await release();
  await assert.rejects(access(lock), { code: "ENOENT" });
});
test("expired result cleanup preserves active preview evidence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-cleanup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).open();
  await mkdir(join(dir, "results"));
  for (const ref of ["aaa", "bbb"]) {
    const path = join(dir, "results", ref + ".json");
    await writeFile(path, "{}");
    await utimes(path, 1, 1);
  }
  await store.transaction((s) => {
    s.drafts.push({
      id: "d",
      status: "preview_ready",
      resultRef: "aaa",
    } as any);
  });
  await cleanupResults(store);
  await access(join(dir, "results", "aaa.json"));
  await assert.rejects(access(join(dir, "results", "bbb.json")), {
    code: "ENOENT",
  });
});
