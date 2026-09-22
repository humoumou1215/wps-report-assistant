$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

& python (Join-Path $Root "scripts\build-release.py") "windows-x64"
if ($LASTEXITCODE -ne 0) {
    throw "统一发布构建失败，退出码：$LASTEXITCODE"
}
