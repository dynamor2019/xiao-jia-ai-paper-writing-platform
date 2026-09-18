@echo off
chcp 65001 >nul
setlocal

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

echo ========================================
echo  小贾AI科研论文写作平台 一键启动
echo  Project: %CD%
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。
  echo 请先安装完整 Node.js LTS: https://nodejs.org/
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo 未检测到 npm。
  echo 请安装完整 Node.js LTS，npm 会随完整安装包一起安装。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 未找到 node_modules，正在先执行 setup-dsh.bat 同等安装流程...
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-dsh.ps1"
  if errorlevel 1 (
    echo 安装失败。
    pause
    exit /b 1
  )
)

echo 正在启动小贾AI科研论文写作平台...
call npm run web
if errorlevel 1 (
  echo.
  echo 启动失败，错误码：%errorlevel%
  echo 请截图本窗口内容，或查看 "%USERPROFILE%\Documents\XiaoJiaAI Data\.dsh-state\web-child.stderr.log"
)

pause
