param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$NpmArgs
)

$ErrorActionPreference = "Stop"

$DataRoot = $env:PAPER_DATA_ROOT
if (-not $DataRoot) {
  $DataRoot = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "XiaoJiaAI Data"
}
$NpmCacheRoot = Join-Path $DataRoot ".dsh-state\npm-cache"
New-Item -ItemType Directory -Path $NpmCacheRoot -Force | Out-Null
$env:NPM_CONFIG_CACHE = $NpmCacheRoot

Write-Host "1/6 Protecting current DSH customizations..." -ForegroundColor Cyan
node scripts/verify-model-routing.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/model-dependency-lock.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/protect-dsh-customizations.mjs snapshot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "2/6 Updating dependencies..." -ForegroundColor Cyan
if ($NpmArgs -and $NpmArgs.Count -gt 0) {
  node scripts/guarded-model-update.mjs @NpmArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  node scripts/guarded-model-update.mjs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "3/6 Restoring external figure resources..." -ForegroundColor Cyan
node scripts/install-figures4papers.mjs
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Figures for Papers update failed; keeping existing resources and continuing DSH update."
}

Write-Host "4/6 Syncing DSH runtime..." -ForegroundColor Cyan
node scripts/sync-dsh-runtime.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "5/6 Running build check..." -ForegroundColor Cyan
npm run build --silent
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "6/6 Refreshing protected customization snapshot..." -ForegroundColor Cyan
node scripts/protect-dsh-customizations.mjs snapshot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Safe update finished. To roll back protected customizations, run npm run custom:restore." -ForegroundColor Green
