@echo off
chcp 65001 >nul
setlocal

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

echo ========================================
echo  小贾AI科研论文写作平台 桌面端
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。
  echo 请先安装完整 Node.js LTS: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 未找到 node_modules，正在先执行初始化...
  call node "scripts\setup-dsh.mjs"
  if errorlevel 1 (
    echo 初始化失败。
    pause
    exit /b 1
  )
)

echo 正在启动桌面端...
call npm run desktop
if errorlevel 1 (
  echo.
  echo 桌面端启动失败，错误码：%errorlevel%
  echo 请先双击 setup-dsh.bat 完成初始化后重试。
)

pause
