@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo  小贾AI科研论文写作平台 初始化
echo ========================================
echo.
echo 将检查完整 Node.js，并创建当前用户 Documents\XiaoJiaAI Data 数据目录。
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。
  echo 请先安装完整 Node.js LTS: https://nodejs.org/
  pause
  exit /b 1
)

call node "scripts\setup-dsh.mjs"
if errorlevel 1 (
  echo.
  echo 初始化失败。请按上方提示安装完整 Node.js LTS 后重试。
  pause
  exit /b 1
)

echo.
echo 初始化完成。
pause
