@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "root="
set "ans="
set "APPLY_ARGS="
echo ==========================================================
echo   DSH plugin migration pack - RESTORE
echo ==========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found. DSH itself needs Node 22+.
  echo     Install it first: https://nodejs.org/
  pause
  exit /b 1
)

echo [1/3] Pack contents
node restore.mjs --list <nul
echo.
echo [2/3] Where should local plugin sources be placed?
echo       Enter = keep the original path recorded in this pack
echo       on another machine, type the new folder, e.g. D:\my-plugins
echo.
set /p root=Plugin root:
for /f "tokens=* delims= " %%a in ("%root%") do set "root=%%a"
echo.
echo [3/3] Apply now?
echo       Enter = dry run only, nothing is written
echo       y     = really restore (package.json is backed up first)
echo.
set /p ans=Choice:
echo.

set "APPLY_ARGS=--profile web --dry-run"
if /i "%ans%"=="y" set "APPLY_ARGS=--profile web"
if not "%root%"=="" set APPLY_ARGS=%APPLY_ARGS% --root "%root%"

echo Running: node restore.mjs %APPLY_ARGS%
echo ----------------------------------------------------------
node restore.mjs %APPLY_ARGS% %* <nul
echo ----------------------------------------------------------
echo.
echo If it says the target profile does not exist:
echo   launch DSH once (so it creates ~/.dsh/profiles/web), then run this file again.
echo Remote plugins (npm / github) only restore their dependency line:
echo   cd into the profile folder, run npm install (or pnpm install), then run this file again.
echo Restart DSH when done (desktop build: close the window, launch the icon again).
pause
