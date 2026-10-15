[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$KeepStaging,
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$nativeArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($nativeArch -ne "AMD64" -or -not [System.Environment]::Is64BitOperatingSystem) {
  throw "The Windows x64 package must be built on native Windows x64 (current architecture: $nativeArch)"
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot "dist" }
$distRoot = [IO.Path]::GetFullPath($OutputDirectory)
$stageRoot = Join-Path $distRoot ".portable-staging"
$packageRoot = Join-Path $stageRoot "UCAS-Course-Portable"
$zipPath = Join-Path $distRoot "UCAS-Course-Portable.zip"
$hashPath = Join-Path $distRoot "UCAS-Course-Portable.zip.sha256"
$nodeVersion = "v22.14.0"
$nodeArchiveName = "node-$nodeVersion-win-x64.zip"
$nodeSha256 = "55b639295920b219bb2acbcfa00f90393a2789095b7323f79475c9f34795f217"
$nodeUrl = "https://nodejs.org/dist/$nodeVersion/$nodeArchiveName"

function Copy-RequiredFile([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Missing build file: $Source"
  }
  $parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  }
  finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Get-SourceSecrets {
  $values = @()
  $envFile = Join-Path $projectRoot ".env.local"
  if (Test-Path -LiteralPath $envFile -PathType Leaf) {
    foreach ($line in (Get-Content -LiteralPath $envFile)) {
      if ($line -match '^\s*(?:export\s+)?(?:AUTO_SIGN_SECRET|UCAS_ACCESS_KEY|AUTO_SIGN_ADMIN_TOKEN)\s*=\s*(.*?)\s*$') {
        $value = $Matches[1]
        if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or
            ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
          $value = $value.Substring(1, $value.Length - 2)
        }
        if ($value.Length -ge 16) { $values += $value }
      }
    }
  }
  foreach ($name in @("AUTO_SIGN_SECRET", "UCAS_ACCESS_KEY", "AUTO_SIGN_ADMIN_TOKEN")) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value -and $value.Length -ge 16) { $values += $value }
  }
  return @($values | Sort-Object -Unique)
}

function Assert-PortableClean([string]$Root) {
  $forbiddenNames = @(
    ".env", ".env.local", ".env.production", ".env.development", "secrets.env",
    "automation.json", "status.json", "events.json", "auto-sign.log", "completed.json"
  )
  $textExtensions = @(".js", ".mjs", ".cjs", ".json", ".ts", ".tsx", ".css", ".html", ".txt", ".md", ".cmd", ".bat", ".sh", ".map")
  $sourceSecrets = Get-SourceSecrets
  $rootUri = New-Object System.Uri("$Root\")
  foreach ($file in (Get-ChildItem -LiteralPath $Root -Recurse -File)) {
    $relative = $rootUri.MakeRelativeUri((New-Object System.Uri($file.FullName))).ToString()
    if ($forbiddenNames -contains $file.Name -or $relative -match '(^|[\\/])data([\\/]|$)') {
      throw "Portable package audit failed: runtime secret file found: $relative"
    }
    if ($file.Extension.ToLowerInvariant() -in $textExtensions) {
      $content = [IO.File]::ReadAllText($file.FullName)
      foreach ($secret in $sourceSecrets) {
        if ($content.Contains($secret)) {
          throw "Portable package audit failed: local secret found in build output ($relative)"
        }
      }
    }
  }
}

function Assert-ZipEntries([string]$Path) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($Path)
  try {
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName.Replace("/", "\\")
      if ($name -match '(^|[\\/])(?:data|\.env(?:\.[^\\/]*)?|secrets\.env)([\\/]|$)' -or
          $name -match '(^|[\\/])(?:automation|status|events|completed)\.json$' -or
          $name -match '(^|[\\/])auto-sign\.log$') {
        throw "ZIP audit failed: secret entry found: $($entry.FullName)"
      }
    }
  }
  finally {
    $archive.Dispose()
  }
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
if (Test-Path -LiteralPath $hashPath) { Remove-Item -LiteralPath $hashPath -Force }
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

if (-not $SkipBuild) {
  Push-Location $projectRoot
  try {
    $env:NEXT_TELEMETRY_DISABLED = "1"
    $env:APP_BASE_PATH = ""
    $env:NEXT_PUBLIC_BASE_PATH = ""
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "Next.js build failed with exit code $LASTEXITCODE" }
  }
  finally { Pop-Location }
}

$standaloneRoot = Join-Path $projectRoot ".next\standalone"
if (-not (Test-Path -LiteralPath (Join-Path $standaloneRoot "server.js") -PathType Leaf)) {
  throw "Missing .next/standalone/server.js; run a standalone build first"
}
Copy-Item -Path (Join-Path $standaloneRoot "*") -Destination $packageRoot -Recurse -Force
$portableMiddleware = Join-Path $packageRoot ".next\server\middleware.js"
if (Test-Path -LiteralPath $portableMiddleware -PathType Leaf) {
  Remove-Item -LiteralPath $portableMiddleware -Force
}
@{
  version = 3
  middleware = @{}
  sortedMiddleware = @()
  functions = @{}
} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $packageRoot ".next\server\middleware-manifest.json") -Encoding ASCII

$staticSource = Join-Path $projectRoot ".next\static"
if (-not (Test-Path -LiteralPath $staticSource -PathType Container)) { throw "Missing .next/static" }
New-Item -ItemType Directory -Path (Join-Path $packageRoot ".next\static") -Force | Out-Null
Copy-Item -Path (Join-Path $staticSource "*") -Destination (Join-Path $packageRoot ".next\static") -Recurse -Force

$publicSource = Join-Path $projectRoot "public"
if (Test-Path -LiteralPath $publicSource -PathType Container) {
  Copy-Item -Path $publicSource -Destination $packageRoot -Recurse -Force
}

foreach ($file in @("worker-multi.mjs", "ucas.mjs", "schedule.mjs")) {
  Copy-RequiredFile (Join-Path $projectRoot "src\$file") (Join-Path $packageRoot "src\$file")
}
foreach ($file in (Get-ChildItem -LiteralPath (Join-Path $projectRoot "src\automation") -File -Filter "*.mjs")) {
  Copy-RequiredFile $file.FullName (Join-Path $packageRoot "src\automation\$($file.Name)")
}
foreach ($file in @("store.mjs", "events.mjs", "format.mjs")) {
  Copy-RequiredFile (Join-Path $projectRoot "src\qq\$file") (Join-Path $packageRoot "src\qq\$file")
}
Copy-RequiredFile (Join-Path $projectRoot "scripts\portable-launcher.mjs") (Join-Path $packageRoot "scripts\portable-launcher.mjs")
Copy-RequiredFile (Join-Path $projectRoot "scripts\start-windows.cmd") (Join-Path $packageRoot "Start-UCAS-Course.cmd")
Copy-RequiredFile (Join-Path $projectRoot "README-PORTABLE.txt") (Join-Path $packageRoot "README-PORTABLE.txt")
Copy-RequiredFile (Join-Path $projectRoot "LICENSE") (Join-Path $packageRoot "LICENSE")

$runtimeCache = Join-Path $distRoot ".runtime-cache"
New-Item -ItemType Directory -Path $runtimeCache -Force | Out-Null
$nodeZip = Join-Path $runtimeCache $nodeArchiveName
$actualHash = if (Test-Path -LiteralPath $nodeZip -PathType Leaf) { Get-Sha256 $nodeZip } else { "" }
if ($actualHash -ne $nodeSha256) {
  if (Test-Path -LiteralPath $nodeZip) { Remove-Item -LiteralPath $nodeZip -Force }
  Write-Host "Downloading official Node.js $nodeVersion Windows x64 runtime..."
  Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing
  $actualHash = Get-Sha256 $nodeZip
  if ($actualHash -ne $nodeSha256) {
    Remove-Item -LiteralPath $nodeZip -Force
    throw "Node.js runtime SHA256 mismatch: expected $nodeSha256, got $actualHash"
  }
}
Write-Host "Official Node.js runtime SHA256 verified: $actualHash"

$nodeExtract = Join-Path $stageRoot ".node-extract"
New-Item -ItemType Directory -Path $nodeExtract -Force | Out-Null
Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract -Force
$nodeExe = Get-ChildItem -LiteralPath $nodeExtract -Recurse -File -Filter "node.exe" | Select-Object -First 1
if (-not $nodeExe) { throw "node.exe was not found in the Node.js archive" }
Copy-RequiredFile $nodeExe.FullName (Join-Path $packageRoot "runtime\node.exe")

$manifest = [ordered]@{
  product = "UCAS Course portable Windows x64"
  nodeVersion = $nodeVersion
  nodeArchive = $nodeArchiveName
  nodeSha256 = $nodeSha256
  bindAddress = "127.0.0.1"
  localDesktopMode = $true
  accessKeyRequired = $false
  secretStorage = "%LOCALAPPDATA%\\UCAS-Course\\secrets.env"
  dataStorage = "%LOCALAPPDATA%\\UCAS-Course\\data"
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot "portable-manifest.json") -Encoding UTF8

Assert-PortableClean $packageRoot
Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
Assert-ZipEntries $zipPath
$zipHash = Get-Sha256 $zipPath
Set-Content -LiteralPath $hashPath -Value "$zipHash  UCAS-Course-Portable.zip" -Encoding ASCII

if (-not $KeepStaging) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
Write-Host "Portable package created: $zipPath"
Write-Host "ZIP SHA256: $zipHash"
