# Libre CMMS - Copyright (C) 2026 CreativeMed LLC - AGPL-3.0-or-later
# Builds the distributable archives into dist\:
#   libre-<version>.zip         ready-to-install package (program, docs, install scripts)
#   libre-<version>-source.zip  complete source tree (from git if available)
#   libre-demo-<version>.zip    ready-to-run demo with a populated, fictional database (port 8090)
#   SHA256SUMS.txt
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1 [-SkipTests]
param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version

# Windows PowerShell's Compress-Archive writes '\' separators, which break on Linux/macOS.
# Build zips with standard '/' entry names instead.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
function New-PortableZip([string]$SourceDir, [string]$ZipPath) {
  if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
  $base = (Get-Item $SourceDir).Parent.FullName.TrimEnd('\') + '\'
  $zip = [IO.Compression.ZipFile]::Open($ZipPath, 'Create')
  try {
    Get-ChildItem $SourceDir -Recurse -File -Force | ForEach-Object {
      $name = $_.FullName.Substring($base.Length).Replace('\', '/')
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name, 'Optimal')
    }
  } finally { $zip.Dispose() }
}
$dist = Join-Path $Root 'dist'
# Start from an empty dist folder so SHA256SUMS lists only this version.
if (Test-Path $dist) { Get-ChildItem $dist -Force | Remove-Item -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$stage = Join-Path $dist "libre-$version"

if (Select-String -Path LICENSE -Pattern 'FULL LICENSE TEXT PLACEHOLDER' -Quiet) {
  Write-Warning 'LICENSE still contains the placeholder. Add the official AGPL-3.0 text before publishing.'
}

if (-not $SkipTests) {
  Write-Host 'Running tests...'
  node --test
  if ($LASTEXITCODE -ne 0) { throw 'Tests failed; release not built.' }
}

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# Ready-to-install package
$include = @('server', 'public', 'scripts', 'docs', 'config\libre.config.example.json', 'package.json', 'README.md', 'LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'start-libre.cmd', 'start-libre.sh')
foreach ($item in $include) {
  $src = Join-Path $Root $item
  $dst = Join-Path $stage $item
  New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
  Copy-Item $src $dst -Recurse -Force
}
Copy-Item (Join-Path $Root 'docs\REQUIREMENTS.md') (Join-Path $stage 'REQUIREMENTS.md')
@"
Libre CMMS $version
Copyright (C) 2026 CreativeMed LLC - GNU AGPL v3.0 or later

1. Read REQUIREMENTS.md (hardware, OS, network, remote access).
2. Install Node.js 24 LTS from https://nodejs.org
3. Windows: run  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1  as Administrator
   Linux:   sudo bash scripts/install-linux.sh
   Try it without installing: double-click start-libre.cmd (Windows) or run ./start-libre.sh
4. Open http://<server>:8080 and create the administrator account.

Full instructions: docs\INSTALL.md
"@ | Set-Content -Path (Join-Path $stage 'INSTALL.txt') -Encoding UTF8

$pkg = Join-Path $dist "libre-$version.zip"
New-PortableZip $stage $pkg

# Source archive
$srcZip = Join-Path $dist "libre-$version-source.zip"
if (Test-Path $srcZip) { Remove-Item $srcZip -Force }
$haveGit = $false; $clean = $false
if (Get-Command git -ErrorAction SilentlyContinue) {
  $ErrorActionPreference = 'Continue'
  $null = cmd /c "git rev-parse --verify HEAD 2>nul"
  $haveGit = ($LASTEXITCODE -eq 0)
  # Untracked files are not part of the release; only uncommitted changes to tracked files matter.
  if ($haveGit) { $clean = -not (cmd /c "git status --porcelain --untracked-files=no 2>nul") }
  $ErrorActionPreference = 'Stop'
}
if ($haveGit -and $clean) {
  git archive --format=zip --prefix="libre-$version-source/" -o $srcZip HEAD
} else {
  if ($haveGit) { Write-Warning 'Working tree has uncommitted changes; source zip is built from the folder instead of git HEAD.' }
  $srcStage = Join-Path $dist "libre-$version-source"
  if (Test-Path $srcStage) { Remove-Item $srcStage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $srcStage | Out-Null
  Get-ChildItem $Root -Force | Where-Object { $_.Name -notin @('.git', 'data', 'dist', 'node_modules', 'DEMO', '.claude') -and $_.Name -notlike '*.odt' } | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $srcStage $_.Name) -Recurse -Force
  }
  Remove-Item (Join-Path $srcStage 'config\libre.config.json') -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $srcStage '.claude\settings.local.json') -ErrorAction SilentlyContinue
  New-PortableZip $srcStage $srcZip
  Remove-Item $srcStage -Recurse -Force
}
Remove-Item $stage -Recurse -Force

# Demo package: a fresh copy of Libre with a generated demonstration database.
$demoStage = Join-Path $dist 'LibreDemo'
node (Join-Path $Root 'scripts/build-demo.js') $demoStage
if ($LASTEXITCODE -ne 0) { throw 'Demo build failed.' }
New-PortableZip $demoStage (Join-Path $dist "libre-demo-$version.zip")
Remove-Item $demoStage -Recurse -Force

$sums = Get-ChildItem $dist -Filter *.zip | ForEach-Object { "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower())  $($_.Name)" }
$sums | Set-Content -Path (Join-Path $dist 'SHA256SUMS.txt') -Encoding ASCII

# GitHub release assets with stable names, so links to
# https://github.com/BetterBiomed/libre-cmms/releases/latest/download/<name> always
# serve the newest release.
$upload = Join-Path $dist 'github-release-upload'
New-Item -ItemType Directory -Force -Path $upload | Out-Null
Copy-Item (Join-Path $dist "libre-$version.zip") (Join-Path $upload 'libre-cmms.zip')
Copy-Item (Join-Path $dist "libre-$version-source.zip") (Join-Path $upload 'libre-cmms-source.zip')
Copy-Item (Join-Path $dist "libre-demo-$version.zip") (Join-Path $upload 'libre-cmms-demo.zip')
Get-ChildItem $upload -Filter *.zip | ForEach-Object { "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower())  $($_.Name)" } |
  Set-Content -Path (Join-Path $upload 'SHA256SUMS.txt') -Encoding ASCII
Write-Host ''
Get-ChildItem $dist | Format-Table Name, @{n = 'Size (KB)'; e = { [math]::Round($_.Length / 1KB) } } -AutoSize
