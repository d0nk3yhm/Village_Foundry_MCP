@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Village Foundry needs Node.js 20 or newer.
  echo Install Node.js from https://nodejs.org/ and open this launcher again.
  pause
  exit /b 1
)
node "%~dp0scripts\local-server.mjs" %*
set "foundry_exit=%errorlevel%"
if not "%foundry_exit%"=="0" (
  echo.
  echo Village Foundry stopped with an error. The message is shown above.
  pause
)
exit /b %foundry_exit%
