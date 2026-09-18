param(
  [string]$DataRoot = $env:PAPER_DATA_ROOT,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

if (-not $DataRoot) {
  $DataRoot = "F:\DSH data"
}

$npmCacheRoot = Join-Path $DataRoot ".dsh-state\npm-cache"

function Require-Command {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$InstallHint
  )

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    Write-Host "$Name is not installed." -ForegroundColor Red
    Write-Host $InstallHint -ForegroundColor Yellow
    exit 2
  }
}

Require-Command -Name "node" -InstallHint "Install full Node.js LTS from https://nodejs.org/ or run: winget install OpenJS.NodeJS.LTS"
Require-Command -Name "npm" -InstallHint "Install full Node.js LTS. npm is included with the full installer; do not use a standalone node.exe."

$nodeVersion = (& node -v).TrimStart("v")
$major = [int]($nodeVersion.Split(".")[0])
if ($major -lt 20) {
  Write-Host "Node.js is too old: v$nodeVersion" -ForegroundColor Red
  Write-Host "Install full Node.js LTS 20 or newer: https://nodejs.org/" -ForegroundColor Yellow
  exit 2
}

$paths = @(
  $DataRoot,
  (Join-Path $DataRoot "output"),
  (Join-Path $DataRoot "output\papers"),
  (Join-Path $DataRoot "papers\input"),
  (Join-Path $DataRoot ".dsh-state"),
  (Join-Path $DataRoot ".dsh-state\tmp"),
  $npmCacheRoot
)

foreach ($path in $paths) {
  New-Item -ItemType Directory -Path $path -Force | Out-Null
}

if (-not (Test-Path -LiteralPath ".env") -and (Test-Path -LiteralPath ".env.example")) {
  Copy-Item -LiteralPath ".env.example" -Destination ".env"
}

$env:PAPER_DATA_ROOT = $DataRoot
$env:PAPER_STATE_DIR = ".dsh-state"

node scripts/link-dsh-data-root.mjs
node scripts/install-figures4papers.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-pylustrator.ps1 -SkipIfInstalled

if (-not $SkipInstall) {
  if (-not (Test-Path -LiteralPath "node_modules")) {
    Write-Host "Installing Node dependencies..." -ForegroundColor Cyan
    npm install --cache $npmCacheRoot
  }
}

Write-Host "DSH data root ready: $DataRoot" -ForegroundColor Green
Write-Host "Node.js: $(node -v), npm: $(npm -v)" -ForegroundColor Green
