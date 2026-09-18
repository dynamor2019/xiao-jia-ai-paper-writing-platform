@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo  小贾AI科研论文写作平台 初始化
echo ========================================
echo.
echo 将检查完整 Node.js，并创建 F:\DSH data。
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-dsh.ps1"
if errorlevel 1 (
  echo.
  echo 初始化失败。请按上方提示安装完整 Node.js LTS 后重试。
  pause
  exit /b 1
)

echo.
echo 初始化完成。
pause
