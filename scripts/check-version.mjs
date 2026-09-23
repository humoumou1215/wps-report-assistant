#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = (await readFile(join(root, "VERSION"), "utf8")).trim();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error(`Invalid VERSION: ${version}`);

const checks = [
  ["installer/main.go", "var version = embeddedVersion()"],
  ["agent-host/package.json", `"version": "${version}"`],
  ["agent-host/package-lock.json", `"version": "${version}"`],
  ["agent-host/src/version.ts", 'new URL("../../../package.json"'],
  ["scripts/build-release.py", '(ROOT / "VERSION").read_text(encoding="utf-8")'],
  ["build-release.ps1", 'scripts\\build-release.py'],
  ["agent-host/src/server/http-server.ts", "version: options.version"],
  ["README.md", "# 数据报告助手"],
  ["THIRD_PARTY_NOTICES.md", "The runtime bundles Node.js"],
];
for (const [relative, expected] of checks) {
  const file = join(root, relative);
  const content = await readFile(file, "utf8");
  if (!content.includes(expected))
    throw new Error(`${relative} does not match VERSION=${version}`);
}
console.log(`Version ${version} is consistent across ${checks.length} release files.`);
