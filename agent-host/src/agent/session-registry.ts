import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
export class SessionRegistry {
  constructor(private dir: string) {}
  async resume(sessionId: string) {
    const directory = join(this.dir, "sessions", sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const existing = SessionManager.findById(this.dir, sessionId, directory);
    if (existing) return SessionManager.open(existing, directory, this.dir);
    // Pi normally delays file creation until the first assistant message. Persist
    // its native header first so a crash before the first response retains input.
    const manager = SessionManager.create(this.dir, directory, {
        id: sessionId,
      }),
      path = join(directory, "session.jsonl");
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(manager.getHeader()) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    return SessionManager.open(path, directory, this.dir);
  }
}
