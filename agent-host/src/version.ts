import { readFile } from "node:fs/promises";

// The built host lives at dist/agent-host/src (and the packaged host keeps the
// same layout), so the copied package manifest is the runtime version source.
// package.json itself is checked against the repository VERSION before builds.
export async function readAppVersion() {
  const packageJSON = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  if (typeof packageJSON.version !== "string" || !packageJSON.version.trim())
    throw new Error("Agent Host package.json 缺少有效版本");
  return packageJSON.version;
}
