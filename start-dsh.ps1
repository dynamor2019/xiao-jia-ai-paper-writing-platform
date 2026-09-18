# dsh 启动脚本 - 检查环境、准备外部数据目录并启动 Web
$ErrorActionPreference = "Continue"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

& node "scripts/setup-dsh.mjs"
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$env:PATH = "C:\Program Files\nodejs;$env:PATH"

Write-Host "Starting dsh web..." -ForegroundColor Cyan
& npm run web
