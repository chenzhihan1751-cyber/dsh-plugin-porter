@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 22+ first, then run again.
  pause
  exit /b 1
)
echo ============================================================
echo  DSH full migration - RESTORE
echo  This package contains PLAINTEXT API KEYS. Keep it private.
echo ============================================================
echo.
echo Step 1/2: preview (dry-run, nothing is written)
echo.
node restore-dsh.mjs --dry-run
echo.
echo ------------------------------------------------------------
echo  Step 2/2: real restore.
echo  Existing config will be backed up to .restore-backup-^<timestamp^>
echo.
set /p GO=Continue? [Y/N]: 
if /i not "%GO%"=="Y" (
  echo Cancelled - nothing changed.
  pause
  exit /b 0
)
echo.
node restore-dsh.mjs %*
echo.
pause
