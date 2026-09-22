const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "apply-debug-update.ps1"),
  "utf8",
);

test("debug package updater restarts and health-checks the installed Agent", () => {
  assert.match(script, /function Start-InstalledAgent/);
  assert.match(script, /Start-Process -FilePath \$nodePath/);
  assert.match(script, /api\/health/);
  assert.match(script, /Start-InstalledAgent \$InstallRoot \(\[string\]\$manifest\.version\)/);
  assert.match(script, /Start-InstalledAgent \$InstallRoot \$expectedVersion/);
});
