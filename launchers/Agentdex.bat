@echo off
rem Starts Agentdex and opens the town in your browser.
rem Easiest: right-click this file, choose "Send to", then "Desktop (create shortcut)".
title Agentdex
setlocal

rem Find the agentdex folder: next to this file, one level up, or in the usual places.
for %%D in ("%~dp0." "%~dp0.." "%USERPROFILE%\agentdex" "%USERPROFILE%\Documents\agentdex" "%USERPROFILE%\Desktop\agentdex") do (
  if exist "%%~D\package.json" if exist "%%~D\runtime\index.js" (
    set "AGENTDEX_DIR=%%~fD"
    goto found
  )
)
echo Could not find the agentdex folder.
echo Keep this file inside the agentdex folder, or download Agentdex into %USERPROFILE%\agentdex.
pause
exit /b 1

:found
cd /d "%AGENTDEX_DIR%"

rem Already running? Just open the town.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8787/api/state | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if %errorlevel%==0 (
  echo Agentdex is already running. Opening the town.
  start "" http://localhost:8787
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org, install it, then try again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First start: installing Agentdex. This takes a minute.
  call npm install
  if errorlevel 1 (
    echo Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo Starting Agentdex from %AGENTDEX_DIR%
echo Your browser will open in a few seconds. Keep this window open while you play.
echo To stop Agentdex, close this window.
start "" /min powershell -NoProfile -Command "Start-Sleep 3; Start-Process 'http://localhost:8787'"
call npm run real
echo.
echo Agentdex stopped.
pause
