@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 没找到 node。请先装 Node.js 22 或更高版本：https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo === Plugin Porter 安装器 ===
echo.
node "%~dp0install.mjs" %*
echo.
pause
