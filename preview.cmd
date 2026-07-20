@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\marked" (
  echo [preview] Installing dependencies...
  call npm.cmd install
  if errorlevel 1 goto :error
)

node scripts\preview.mjs
if errorlevel 1 goto :error
exit /b 0

:error
echo.
echo [preview] Failed to start. See the error above.
pause
exit /b 1
