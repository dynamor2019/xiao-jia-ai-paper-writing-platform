param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$NpmArgs
)

$ErrorActionPreference = "Stop"

$DataRoot = $env:PAPER_DATA_ROOT
if (-not $DataRoot) {
  $DataRoot = "F:\DSH data"
}
$NpmCacheRoot = Join-Path $DataRoot ".dsh-state\npm-cache"
New-Item -ItemType Directory -Path $NpmCacheRoot -Force | Out-Null
$env:NPM_CONFIG_CACHE = $NpmCacheRoot

Write-Host "1/6 Protecting current DSH customizations..." -ForegroundColor Cyan
node scripts/protect-dsh-customizations.mjs snapshot

Write-Host "2/6 Updating dependencies..." -ForegroundColor Cyan
if ($NpmArgs -and $NpmArgs.Count -gt 0) {
  npm install @NpmArgs --cache $NpmCacheRoot
} else {
  $targetVersion = $env:DSH_TARGET_VERSION
  if (-not $targetVersion) {
    $targetVersion = "0.1.2-rc.1"
  }
  $univerVersion = $env:DSH_UNIVER_OFFICE_TARGET_VERSION
  if (-not $univerVersion) {
    $univerVersion = "0.2.14"
  }
  $packageJson = Get-Content -Raw -LiteralPath "package.json" | ConvertFrom-Json
  $dshPackages = @($packageJson.dependencies.PSObject.Properties.Name | Where-Object { $_ -like "@deepseek-ai/dsh*" } | ForEach-Object { "$_@$targetVersion" })
  $installArgs = $dshPackages + @("dsh-univer-office@$univerVersion")
  npm install @installArgs --registry https://registry.npmjs.org --cache $NpmCacheRoot
}

Write-Host "3/6 Restoring external figure resources..." -ForegroundColor Cyan
node scripts/install-figures4papers.mjs

Write-Host "4/6 Syncing DSH runtime..." -ForegroundColor Cyan
node scripts/sync-dsh-runtime.mjs

Write-Host "5/6 Running build check..." -ForegroundColor Cyan
npm run build --silent

Write-Host "6/6 Verifying protected customizations..." -ForegroundColor Cyan
node scripts/protect-dsh-customizations.mjs verify

Write-Host "Safe update finished. If step 6 reports changed files, confirm whether they were intentional. To roll back, run npm run custom:restore." -ForegroundColor Green
