@echo off
chcp 65001 >nul
echo ========================================
echo  dsh 启动脚本
echo ========================================

cd /d "%~dp0"

echo 检查 Node 并准备 F:\DSH data...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-dsh.ps1"
if errorlevel 1 (
  pause
  exit /b 1
)

REM 配置 Python 环境（GPT-SoVITS .venv，含 numpy/pandas/scipy/matplotlib）
set PATH=E:\GPT-SoVITS\.venv\Scripts;E:\GPT-SoVITS\.venv;C:\Program Files\nodejs;%PATH%
set VIRTUAL_ENV=E:\GPT-SoVITS\.venv

echo 检查 Python 库...
python -c "import numpy, pandas, scipy, matplotlib; print('  numpy=' + numpy.__version__ + ', pandas=' + pandas.__version__ + ', scipy=' + scipy.__version__ + ', matplotlib=' + matplotlib.__version__)"

echo.
echo 启动 dsh web...
npm run web

pause
