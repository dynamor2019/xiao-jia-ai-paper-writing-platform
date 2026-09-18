@echo off
chcp 65001 >nul
cd /d "%~dp0\.."

echo ========================================
echo  打包小贾AI科研论文写作平台桌面端
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。
  echo 请先安装完整 Node.js LTS: https://nodejs.org/
  pause
  exit /b 1
)

if "%NPM_CONFIG_REGISTRY%"=="" set "NPM_CONFIG_REGISTRY=https://registry.npmmirror.com"
if "%ELECTRON_MIRROR%"=="" set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
if "%ELECTRON_BUILDER_BINARIES_MIRROR%"=="" set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

call node "scripts\setup-dsh.mjs"
if errorlevel 1 (
  echo 初始化失败。
  pause
  exit /b 1
)

call npm run build
if errorlevel 1 (
  echo 编译失败。
  pause
  exit /b 1
)

call npm run desktop:pack
if errorlevel 1 (
  echo 打包失败。
  pause
  exit /b 1
)

echo.
echo 打包完成，文件在 release 目录。
pause
