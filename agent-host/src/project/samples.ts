import { cp, mkdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { Store } from "./store.js";
export async function prepareSamples(store: Store, assetDir: string) {
  const samples = resolve(assetDir, "..", "samples"),
    output = join(homedir(), "DataReportAssistant-标准测试项目"),
    names = [
      ["标准测试-本年预算.xlsx", "et"],
      ["标准测试-历史预算.xlsx", "et"],
      ["标准测试-预算汇报.pptx", "wpp"],
      ["调试步骤.md", ""],
    ];
  for (const [name] of names) await access(join(samples, name));
  await mkdir(output, { recursive: true });
  // Repeated preparation never overwrites a user's edited sample workbook.
  for (const [name] of names)
    await cp(join(samples, name), join(output, name), {
      force: false,
      errorOnExist: false,
    });
  let p = store
    .snapshot()
    .projects.find((p) =>
      p.documents.some((d) => d.key === join(output, names[0][0])),
    );
  if (!p) p = await store.createProject("标准测试项目");
  for (const [name, kind] of names)
    if (kind)
      await store.registerDocument(p.id, {
        key: join(output, name),
        name,
        kind,
      });
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : undefined;
  if (opener) {
    const child = spawn(opener, [output], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  }
  return {
    ok: true,
    project: store.getProject(p.id),
    paths: names.map(([name]) => join(output, name)),
  };
}
