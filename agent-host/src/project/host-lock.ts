import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const staleLockAgeMs = 30_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function removeStaleLock(path: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await sleep(250);
    }
  }
}

async function readOwner(lock: string) {
  try {
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    if (
      Number.isInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.nonce === "string" &&
      owner.nonce
    )
      return owner;
  } catch {}
  return null;
}

async function recoverMalformedLock(lock: string) {
  // A live process can briefly have created the directory but not written its
  // owner file yet. Give that initialization a chance to finish first.
  for (let attempt = 0; attempt < 8; attempt++) {
    const owner = await readOwner(lock);
    if (owner) return owner;
    await sleep(250);
  }
  const info = await stat(lock);
  if (Date.now() - info.mtimeMs < staleLockAgeMs)
    throw new Error("Agent Host 正在初始化，请稍后重试：" + lock);

  const reaping = join(lock, "reaping");
  try {
    await mkdir(reaping, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Agent Host 锁正在恢复，请稍后重试：" + lock);
    throw error;
  }
  let moved = false;
  try {
    const latest = await readOwner(lock);
    if (latest) return latest;
    const stale = lock + ".stale-" + randomUUID();
    await rename(lock, stale);
    moved = true;
    // Windows scanners may briefly hold owner.json after the rename. The
    // active lock is already gone, so cleanup failure must not block startup.
    void removeStaleLock(stale);
    await mkdir(lock, { mode: 0o700 });
    return null;
  } finally {
    if (!moved) await rm(reaping, { recursive: true, force: true });
  }
}

// OS PID liveness, not a timestamp, determines whether an old owner may be replaced.
export async function acquireHostLock(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, ".agent-host-lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner = await recoverMalformedLock(lock);
    if (!owner) {
      // recoverMalformedLock replaced an abandoned directory; continue with a
      // fresh owner record below.
    } else {
      try {
        process.kill(owner.pid, 0);
        throw new Error("已有 Agent Host 使用此数据目录");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      // Serialize stale-owner recovery, then re-read: another contender may have
      // already replaced the directory since our first liveness check.
      await mkdir(join(lock, "reaping"), { mode: 0o700 });
      const latest = JSON.parse(
        await readFile(join(lock, "owner.json"), "utf8"),
      );
      if (latest.nonce !== owner.nonce) {
        await rm(join(lock, "reaping"), { recursive: true, force: true });
        throw new Error("Agent Host 锁已更新，请重试启动");
      }
      const stale = lock + ".stale-" + randomUUID();
      await rename(lock, stale);
      void removeStaleLock(stale);
      await mkdir(lock, { mode: 0o700 });
    }
  }
  const nonce = randomUUID();
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, nonce }),
    { mode: 0o600 },
  );
  return async () => {
    try {
      const owner = JSON.parse(
        await readFile(join(lock, "owner.json"), "utf8"),
      );
      if (owner.nonce === nonce) await rm(lock, { recursive: true });
    } catch {}
  };
}
