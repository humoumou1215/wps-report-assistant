$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Version = "0.6.0-rc1"
$Dist = Join-Path $Root "dist"
$Payload = Join-Path $Root "installer\payload\app"

Write-Host "[1/6] Test Core"
Push-Location (Join-Path $Root "core-go")
go test ./...
go vet ./...
Pop-Location

Write-Host "[2/6] Test Installer helpers"
Push-Location (Join-Path $Root "installer")
go test ./...
Pop-Location

Write-Host "[3/6] Refresh installer payload"
Remove-Item $Payload -Recurse -Force -ErrorAction SilentlyContinue
New-Item $Payload -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $Root "addins") $Payload -Recurse -Force
Copy-Item (Join-Path $Root "samples") $Payload -Recurse -Force
Set-Content (Join-Path $Payload "VERSION.txt") $Version -Encoding ascii

Write-Host "[4/6] Build Windows Core"
$env:GOOS = "windows"
$env:GOARCH = "amd64"
$env:CGO_ENABLED = "0"
Push-Location (Join-Path $Root "core-go")
go build -trimpath -ldflags "-s -w -H=windowsgui" -o (Join-Path $Payload "DataReportAssistantCore.exe") .
Pop-Location

Write-Host "[5/6] Build Setup"
New-Item $Dist -ItemType Directory -Force | Out-Null
Push-Location (Join-Path $Root "installer")
go build -trimpath -ldflags "-s -w -H=windowsgui" -o (Join-Path $Dist "DataReportAssistant-Setup-$Version.exe") .
Pop-Location

Write-Host "[6/6] Done"
Write-Host (Join-Path $Dist "DataReportAssistant-Setup-$Version.exe")
