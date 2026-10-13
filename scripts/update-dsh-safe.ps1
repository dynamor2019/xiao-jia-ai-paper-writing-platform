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
node scripts/protect-dsh-customizations.mjs snapshot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "2/6 Updating dependencies..." -ForegroundColor Cyan
if ($NpmArgs -and $NpmArgs.Count -gt 0) {
  npm install @NpmArgs --cache $NpmCacheRoot --legacy-peer-deps
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  $targetVersion = $env:DSH_TARGET_VERSION
  if (-not $targetVersion) {
    $targetVersion = "0.1.7-rc.2"
  }
  $univerVersion = $env:DSH_UNIVER_OFFICE_TARGET_VERSION
  if (-not $univerVersion) {
    $univerVersion = "0.3.5"
  }
  $packageJson = Get-Content -Raw -Encoding UTF8 -LiteralPath "package.json" | ConvertFrom-Json
  $dshPackages = @($packageJson.dependencies.PSObject.Properties.Name | Where-Object { $_ -like "@deepseek-ai/dsh*" } | ForEach-Object { "$_@$targetVersion" })
  $installArgs = $dshPackages + @("dsh-univer-office@$univerVersion")
  npm install @installArgs --registry https://registry.npmjs.org --cache $NpmCacheRoot --legacy-peer-deps
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
