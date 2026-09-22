#!/usr/bin/env node
// Build on the release machine. Users receive Node + dependencies, never npm.
import {
  mkdir,
  cp,
  readFile,
  writeFile,
  chmod,
  rm,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appVersion = (await readFile(join(root, "VERSION"), "utf8")).trim();
execFileSync(process.execPath, [join(root, "scripts", "check-version.mjs")], {
  cwd: root,
  stdio: "inherit",
});
const [destArg, platform = process.platform, arch = process.arch] =
  process.argv.slice(2);
if (
  !destArg ||
  !["darwin", "win32", "linux"].includes(platform) ||
  !["x64", "arm64"].includes(arch)
)
  throw new Error(
    "usage: node scripts/package-agent-host.mjs DEST darwin|win32|linux x64|arm64",
  );
const dest = resolve(destArg),
  version = "22.19.0",
  os = platform === "win32" ? "win" : platform,
  ext = platform === "win32" ? "zip" : "tar.gz",
  name = `node-v${version}-${os}-${arch}`,
  archive = `${name}.${ext}`;
const cache = join(root, ".local-validation", "runtime-cache");
await mkdir(cache, { recursive: true });

async function download(name) {
  const response = await fetch(`https://nodejs.org/dist/v${version}/${name}`, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Node download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
const sums = (await download("SHASUMS256.txt")).toString(),
  expected = sums
    .split("\n")
    .find((l) => l.endsWith("  " + archive))
    ?.split(" ")[0];
if (!expected) throw new Error("No official checksum for runtime");
let binary;
try {
  binary = await readFile(join(cache, archive));
} catch {
  binary = await download(archive);
}
if (createHash("sha256").update(binary).digest("hex") !== expected)
  throw new Error("Node runtime checksum mismatch");
await writeFile(join(cache, archive), binary);
const extracted = join(cache, name);
await rm(extracted, { recursive: true, force: true });
if (platform === "win32") {
  if (process.platform === "win32")
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      join(cache, archive),
      cache,
    ]);
  else execFileSync("unzip", ["-q", join(cache, archive), "-d", cache]);
} else execFileSync("tar", ["-xzf", join(cache, archive), "-C", cache]);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(npm, ["run", "build"], {
  cwd: join(root, "agent-host"),
  stdio: "inherit",
  shell: process.platform === "win32",
});
await mkdir(join(dest, "runtime"), { recursive: true });
await cp(
  join(extracted, platform === "win32" ? "node.exe" : "bin/node"),
  join(dest, "runtime", platform === "win32" ? "node.exe" : "node"),
);
if (platform !== "win32") await chmod(join(dest, "runtime", "node"), 0o755);
await cp(join(extracted, "LICENSE"), join(dest, "runtime", "LICENSE"));
const host = join(dest, "agent-host");
await mkdir(host, { recursive: true });
await rm(join(host, "dist"), { recursive: true, force: true });
await cp(
  join(root, "agent-host", "dist", "agent-host", "src"),
  join(host, "dist", "agent-host", "src"),
  { recursive: true },
);
await cp(
  join(root, "agent-host", "dist", "shared"),
  join(host, "dist", "shared"),
  { recursive: true },
);
await cp(join(root, "agent-host", "package.json"), join(host, "package.json"));
await cp(
  join(root, "agent-host", "package-lock.json"),
  join(host, "package-lock.json"),
);
// npm ci is used in staging so dev dependencies and machine-specific symlinks do not ship.
execFileSync(
  npm,
  [
    "ci",
    "--omit=dev",
    `--os=${platform}`,
    `--cpu=${arch}`,
    "--ignore-scripts",
    "--registry=https://registry.npmjs.org",
  ],
  { cwd: host, stdio: "inherit", shell: process.platform === "win32" },
);

// Bundle the two runtime entry points before removing node_modules. This makes
// the deployment payload independent of Pi's package tree and all of its
// transitive CLI/build-time dependencies.
const esbuildCandidates = [
  join(
    root,
    "agent-host",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
    "esbuild",
    "bin",
    "esbuild",
  ),
  join(root, "agent-host", "node_modules", "esbuild", "bin", "esbuild"),
];
let esbuild;
for (const candidate of esbuildCandidates) {
  try {
    await readFile(candidate);
    esbuild = candidate;
    break;
  } catch {
    // Try the next layout; npm may hoist esbuild in a different install.
  }
}
if (!esbuild) throw new Error("Cannot find the esbuild CLI used for bundling");

const stagedDist = join(host, "dist");
const mainBundle = join(stagedDist, ".main.bundle.js");
const workerBundle = join(stagedDist, ".worker.bundle.js");
const wasm = join(stagedDist, ".emscripten-module.wasm");
const sourceDist = join(root, "agent-host", "dist", "agent-host", "src");
const esbuildArgs = (entry, outfile) => [
  entry,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--minify",
  `--outfile=${outfile}`,
];
execFileSync(process.execPath, [
  esbuild,
  ...esbuildArgs(join(sourceDist, "main.js"), mainBundle),
  '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
], { stdio: "inherit" });
execFileSync(process.execPath, [
  esbuild,
  ...esbuildArgs(join(sourceDist, "sandbox", "worker.js"), workerBundle),
], { stdio: "inherit" });
await cp(
  join(
    root,
    "agent-host",
    "node_modules",
    "@jitl",
    "quickjs-wasmfile-release-sync",
    "dist",
    "emscripten-module.wasm",
  ),
  wasm,
);

// Keep only the files loaded by the installer: ESM bundles, the QuickJS WASM
// module, and package.json (which marks the directory as type=module).
await rm(join(host, "node_modules"), { recursive: true, force: true });
await rm(join(host, "package-lock.json"), { force: true });
await rm(join(stagedDist, "agent-host"), { recursive: true, force: true });
await rm(join(stagedDist, "shared"), { recursive: true, force: true });
const runtimeSrc = join(stagedDist, "agent-host", "src");
await mkdir(runtimeSrc, { recursive: true });
await cp(mainBundle, join(runtimeSrc, "main.js"));
await cp(workerBundle, join(runtimeSrc, "worker.js"));
await cp(wasm, join(runtimeSrc, "emscripten-module.wasm"));
await rm(mainBundle, { force: true });
await rm(workerBundle, { force: true });
await rm(wasm, { force: true });

await writeFile(
  join(dest, "RUNTIME_MANIFEST.json"),
  JSON.stringify(
    {
      version: appVersion,
      node: version,
      pi: "0.86.0",
      quickjs: "0.31.0",
      platform,
      arch,
      archive,
      sha256: expected,
      bundled: true,
      nodeModules: false,
    },
    null,
    2,
  ),
);
console.log(`Packaged fixed Node ${version} and Pi 0.86.0 at ${dest}`);
