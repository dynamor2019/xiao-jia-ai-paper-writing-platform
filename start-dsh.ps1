# dsh 启动脚本 - 检查环境、准备外部数据目录并启动 Web
$ErrorActionPreference = "Continue"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

& powershell -NoProfile -ExecutionPolicy Bypass -File "scripts/setup-dsh.ps1"
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

# GPT-SoVITS 虚拟环境（含 numpy 1.26.4 / pandas 2.3.3 / scipy 1.17.1 / matplotlib 3.10.9）
$pythonExe = "E:\GPT-SoVITS\.venv\Scripts\python.exe"
$pythonDir = "E:\GPT-SoVITS\.venv\Scripts"
$venvRoot = "E:\GPT-SoVITS\.venv"

if (Test-Path $pythonExe) {
    $env:PATH = "$pythonDir;$venvRoot;$env:PATH"
    $env:VIRTUAL_ENV = $venvRoot
    Write-Host "Python environment: GPT-SoVITS .venv" -ForegroundColor Green
    & $pythonExe -c "import numpy, pandas, scipy, matplotlib; print('numpy=' + numpy.__version__ + ', pandas=' + pandas.__version__ + ', scipy=' + scipy.__version__ + ', matplotlib=' + matplotlib.__version__)"
} else {
    Write-Host "Python not found: $pythonExe" -ForegroundColor Yellow
}

$env:PATH = "C:\Program Files\nodejs;$env:PATH"

Write-Host "Starting dsh web..." -ForegroundColor Cyan
npm run web
