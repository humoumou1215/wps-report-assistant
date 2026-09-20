$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Version = "0.8.0-js1"
$Dist = Join-Path $Root "dist"
$Payload = Join-Path $Root "installer\payload\app"

function Invoke-NativeChecked {
    param([string]$Name, [string[]]$Args)
    & $Name @Args
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

Write-Host "[1/6] Test Core"
Push-Location (Join-Path $Root "core-go")
Invoke-NativeChecked "go" @("test", "./...")
Invoke-NativeChecked "go" @("vet", "./...")
Pop-Location

Write-Host "[2/6] Test Installer helpers"
Push-Location (Join-Path $Root "installer")
Invoke-NativeChecked "go" @("test", "./...")
Pop-Location

Write-Host "[3/6] Refresh installer payload"
Remove-Item $Payload -Recurse -Force -ErrorAction SilentlyContinue
New-Item $Payload -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $Root "addins") $Payload -Recurse -Force
Copy-Item (Join-Path $Root "samples") $Payload -Recurse -Force
Copy-Item (Join-Path $Root "README.md") $Payload -Force
Copy-Item (Join-Path $Root "VALIDATION_GUIDE.md") $Payload -Force
Copy-Item (Join-Path $Root "DEBUG_GUIDE.md") $Payload -Force
Copy-Item (Join-Path $Root "CHANGE_HISTORY.md") $Payload -Force
Copy-Item (Join-Path $Root "HOST_CAPABILITIES.md") $Payload -Force
Copy-Item (Join-Path $Root "MACOS_VALIDATION.md") $Payload -Force
Copy-Item (Join-Path $Root "WINDOWS_VALIDATION.md") $Payload -Force
Copy-Item (Join-Path $Root "JAVASCRIPT_VALIDATION.md") $Payload -Force
Copy-Item (Join-Path $Root "THIRD_PARTY_NOTICES.md") $Payload -Force
Set-Content (Join-Path $Payload "VERSION.txt") $Version -Encoding ascii

foreach ($shared in @("common.css", "common.js", "main.js")) {
    $etShared = Join-Path $Root ("addins\et\" + $shared)
    $wppShared = Join-Path $Root ("addins\wpp\" + $shared)
    if ((Get-FileHash $etShared).Hash -ne (Get-FileHash $wppShared).Hash) {
        throw "Shared add-in file differs between ET and WPP: $shared"
    }
}

$RequiredPayload = @(
    "DataReportAssistantCore.exe",
    "README.md",
    "VALIDATION_GUIDE.md",
    "DEBUG_GUIDE.md",
    "CHANGE_HISTORY.md",
    "samples\标准测试-本年预算.xlsx",
    "samples\标准测试-历史预算.xlsx",
    "samples\标准测试-预算汇报.pptx",
    "samples\调试步骤.md",
    "addins\et\taskpane.html",
    "addins\wpp\taskpane.html",
    "addins\wps\index.html",
    "addins\workspace\taskpane.html",
    "addins\workspace\hosts.js",
    "addins\workspace\workspace.js",
    "HOST_CAPABILITIES.md",
    "MACOS_VALIDATION.md",
    "WINDOWS_VALIDATION.md"
)

Write-Host "[4/6] Build Windows Core"
$env:GOOS = "windows"
$env:GOARCH = "amd64"
$env:CGO_ENABLED = "0"
Push-Location (Join-Path $Root "core-go")
Invoke-NativeChecked "go" @("build", "-trimpath", "-ldflags", "-s -w -H=windowsgui", "-o", (Join-Path $Payload "DataReportAssistantCore.exe"), ".")
Pop-Location

if (-not (Test-Path (Join-Path $Payload "DataReportAssistantCore.exe"))) {
    throw "Core executable was not produced"
}
foreach ($relative in $RequiredPayload[1..($RequiredPayload.Length - 1)]) {
    if (-not (Test-Path (Join-Path $Payload $relative))) {
        throw "Required payload file is missing: $relative"
    }
}

Write-Host "[5/6] Build Setup"
New-Item $Dist -ItemType Directory -Force | Out-Null
Push-Location (Join-Path $Root "installer")
Invoke-NativeChecked "go" @("build", "-trimpath", "-ldflags", "-s -w -H=windowsgui", "-o", (Join-Path $Dist "DataReportAssistant-Setup-$Version.exe"), ".")
Pop-Location

if (-not (Test-Path (Join-Path $Dist "DataReportAssistant-Setup-$Version.exe"))) {
    throw "Setup executable was not produced"
}

Write-Host "[6/6] Done"
Write-Host (Join-Path $Dist "DataReportAssistant-Setup-$Version.exe")
