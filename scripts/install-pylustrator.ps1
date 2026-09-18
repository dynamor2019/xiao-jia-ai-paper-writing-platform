param(
  [string]$Python = $env:DSH_PYLUSTRATOR_PYTHON,
  [switch]$SkipIfInstalled
)

$ErrorActionPreference = "Stop"

$dataRoot = $env:PAPER_DATA_ROOT
if (-not $dataRoot) {
  $dataRoot = "F:\DSH data"
}
$pipCache = Join-Path $dataRoot ".dsh-state\pip-cache"
$venvRoot = Join-Path $dataRoot ".dsh-state\pylustrator-venv"
$venvPython = Join-Path $venvRoot "Scripts\python.exe"
New-Item -ItemType Directory -Path $pipCache -Force | Out-Null
$env:PIP_CACHE_DIR = $pipCache

if (-not $Python) {
  if (-not (Test-Path -LiteralPath $venvPython)) {
    $builders = @("python", "py")
    foreach ($builder in $builders) {
      try {
        & $builder -m venv $venvRoot
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $venvPython)) {
          break
        }
      } catch {
      }
    }
  }
  if (Test-Path -LiteralPath $venvPython) {
    $Python = $venvPython
  }
}

if (-not $Python) {
  Write-Host "Python not found. Install Python 3.10+ or set DSH_PYLUSTRATOR_PYTHON." -ForegroundColor Red
  exit 2
}

try {
  & $Python -c "import pylustrator" | Out-Null
  if ($SkipIfInstalled) {
    Write-Host "Pylustrator already installed for: $Python" -ForegroundColor Green
    exit 0
  }
} catch {
}

Write-Host "Installing Pylustrator for: $Python" -ForegroundColor Cyan
& $Python -m pip install --cache-dir $pipCache pylustrator
if ($LASTEXITCODE -ne 0) {
  Write-Host "Cached install failed, retrying without pip cache..." -ForegroundColor Yellow
  & $Python -m pip install --no-cache-dir pylustrator
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Pylustrator install failed." -ForegroundColor Red
    exit $LASTEXITCODE
  }
}
Write-Host "Pylustrator ready." -ForegroundColor Green
