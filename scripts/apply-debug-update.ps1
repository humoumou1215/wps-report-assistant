param(
    [Parameter(Mandatory = $true)]
    [string]$Package,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "DataReportAssistant\app")
)

$ErrorActionPreference = "Stop"

function Assert-RelativePath([string]$RelativePath) {
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or
        [IO.Path]::IsPathRooted($RelativePath) -or
        $RelativePath.Replace('\', '/') -match '(^|/)\.\.(/|$)') {
        throw "Invalid package path: $RelativePath"
    }
}

function Get-PackagePath([string]$Root, [string]$RelativePath) {
    Assert-RelativePath $RelativePath
    return Join-Path $Root ($RelativePath.Replace('/', '\'))
}

function Read-Json([string]$Path) {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Assert-ManifestFiles([string]$Root, $Manifest, [string[]]$OnlyRelative = $null) {
    $properties = $Manifest.files.PSObject.Properties
    if ($null -ne $OnlyRelative) {
        $properties = $OnlyRelative | ForEach-Object {
            $name = $_
            $property = $Manifest.files.PSObject.Properties[$name]
            if ($null -eq $property) { throw "Update manifest is missing a file hash: $name" }
            $property
        }
    }
    foreach ($property in $properties) {
        $relative = [string]$property.Name
        $expected = [string]$property.Value
        $path = Get-PackagePath $Root $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Package is missing file: $relative"
        }
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected.ToLowerInvariant()) {
            throw "Package file hash mismatch: $relative"
        }
    }
}

function Stop-InstalledAgent([string]$Root) {
    $nodePath = [IO.Path]::GetFullPath((Join-Path $Root "runtime\node.exe")).ToLowerInvariant()
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq $nodePath } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }
}

function Start-InstalledAgent([string]$Root, [string]$ExpectedVersion = "") {
    $nodePath = [IO.Path]::GetFullPath((Join-Path $Root "runtime\node.exe"))
    $entryPath = [IO.Path]::GetFullPath((Join-Path $Root "agent-host\dist\agent-host\src\main.js"))
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
        throw "Installed Agent runtime not found: $nodePath"
    }
    if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
        throw "Installed Agent entry not found: $entryPath"
    }

    $dataRoot = Join-Path (Split-Path -Parent $Root) "data"
    $stdout = Join-Path $env:TEMP ("DataReportAssistant-debug-start-" + [guid]::NewGuid().ToString("N") + ".out.log")
    $stderr = Join-Path $env:TEMP ("DataReportAssistant-debug-start-" + [guid]::NewGuid().ToString("N") + ".err.log")
    $oldAssets = $env:REPORT_ASSISTANT_ASSET_DIR
    $oldData = $env:REPORT_ASSISTANT_DATA_DIR
    try {
        $env:REPORT_ASSISTANT_ASSET_DIR = Join-Path $Root "addins"
        $env:REPORT_ASSISTANT_DATA_DIR = $dataRoot
        $process = Start-Process -FilePath $nodePath -ArgumentList $entryPath -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    } finally {
        if ($null -eq $oldAssets) { Remove-Item Env:REPORT_ASSISTANT_ASSET_DIR -ErrorAction SilentlyContinue } else { $env:REPORT_ASSISTANT_ASSET_DIR = $oldAssets }
        if ($null -eq $oldData) { Remove-Item Env:REPORT_ASSISTANT_DATA_DIR -ErrorAction SilentlyContinue } else { $env:REPORT_ASSISTANT_DATA_DIR = $oldData }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $lastVersion = ""
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 500
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:17891/api/health" -TimeoutSec 2
            $lastVersion = [string]$health.version
            if ($health.ok -eq $true -and ([string]::IsNullOrWhiteSpace($ExpectedVersion) -or $lastVersion -eq $ExpectedVersion)) {
                Write-Host "Agent started: version=$lastVersion"
                return
            }
        } catch {
            # The process may need a few seconds to initialize its data lock and HTTP server.
        }
        if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { break }
    }

    if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    throw "Agent failed to start or returned the wrong version (expected=$ExpectedVersion, actual=$lastVersion). Logs: $stdout ; $stderr"
}

$packagePath = (Resolve-Path -LiteralPath $Package).Path
$tempRoot = Join-Path $env:TEMP ("DataReportAssistant-debug-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
try {
    Expand-Archive -LiteralPath $packagePath -DestinationPath $tempRoot -Force
    $basePath = Join-Path $tempRoot "FIXED_DEPENDENCIES.json"
    $updatePath = Join-Path $tempRoot "DEBUG_UPDATE_MANIFEST.json"
    $hasBase = Test-Path -LiteralPath $basePath -PathType Leaf
    $hasUpdate = Test-Path -LiteralPath $updatePath -PathType Leaf
    if ($hasBase -eq $hasUpdate) {
        throw "Package must contain exactly one manifest: FIXED_DEPENDENCIES.json or DEBUG_UPDATE_MANIFEST.json"
    }

    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    if ($hasBase) {
        $manifest = Read-Json $basePath
        if ($manifest.kind -ne "fixed-dependencies") { throw "Invalid fixed-dependencies manifest kind" }
        Assert-ManifestFiles $tempRoot $manifest
        Stop-InstalledAgent $InstallRoot
        foreach ($property in $manifest.files.PSObject.Properties) {
            $destination = Get-PackagePath $InstallRoot ([string]$property.Name)
            New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
            Copy-Item -LiteralPath (Get-PackagePath $tempRoot ([string]$property.Name)) -Destination $destination -Force
        }
        Copy-Item -LiteralPath $basePath -Destination (Join-Path $InstallRoot "FIXED_DEPENDENCIES.json") -Force
        $expectedVersion = ""
        $versionPath = Join-Path $InstallRoot "VERSION.txt"
        if (Test-Path -LiteralPath $versionPath -PathType Leaf) {
            $expectedVersion = (Get-Content -LiteralPath $versionPath -Raw -Encoding UTF8).Trim()
        }
        Start-InstalledAgent $InstallRoot $expectedVersion
        Write-Host "Fixed dependencies applied: $($manifest.id)"
    } else {
        $manifest = Read-Json $updatePath
        if ($manifest.kind -ne "debug-update") { throw "Invalid debug-update manifest kind" }
        $installedBasePath = Join-Path $InstallRoot "FIXED_DEPENDENCIES.json"
        if (-not (Test-Path -LiteralPath $installedBasePath -PathType Leaf)) {
            throw "Fixed dependencies not found; apply the matching Debug-Base package first"
        }
        $installedBase = Read-Json $installedBasePath
        if ([string]$installedBase.id -ne [string]$manifest.baseId) {
            throw "Fixed dependencies mismatch: installed=$($installedBase.id), required=$($manifest.baseId)"
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$manifest.fromVersion)) {
            $versionMarker = Join-Path $InstallRoot ".debug-version.txt"
            if (-not (Test-Path -LiteralPath $versionMarker -PathType Leaf)) {
                $versionMarker = Join-Path $InstallRoot "VERSION.txt"
            }
            if (-not (Test-Path -LiteralPath $versionMarker -PathType Leaf)) {
                throw "Current debug version not found; intermediate updates cannot be skipped"
            }
            $installedVersion = (Get-Content -LiteralPath $versionMarker -Raw -Encoding UTF8).Trim()
            if ($installedVersion -ne [string]$manifest.fromVersion) {
                throw "Update order mismatch: installed=$installedVersion, required=$($manifest.fromVersion)"
            }
        }
        Assert-ManifestFiles $tempRoot $manifest @($manifest.changed)
        Stop-InstalledAgent $InstallRoot
        foreach ($relative in @($manifest.delete)) {
            $destination = Get-PackagePath $InstallRoot ([string]$relative)
            if (Test-Path -LiteralPath $destination -PathType Leaf) {
                Remove-Item -LiteralPath $destination -Force
            }
        }
        foreach ($property in $manifest.files.PSObject.Properties) {
            $relative = [string]$property.Name
            if ($relative -notin @($manifest.changed)) { continue }
            $destination = Get-PackagePath $InstallRoot $relative
            New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
            Copy-Item -LiteralPath (Get-PackagePath $tempRoot $relative) -Destination $destination -Force
        }
        Copy-Item -LiteralPath $updatePath -Destination (Join-Path $InstallRoot "DEBUG_UPDATE_MANIFEST.json") -Force
        Start-InstalledAgent $InstallRoot ([string]$manifest.version)
        Set-Content -LiteralPath (Join-Path $InstallRoot ".debug-version.txt") -Value ([string]$manifest.version) -Encoding ascii
        Write-Host "Debug update applied: $($manifest.fromVersion) -> $($manifest.version)"
    }
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
