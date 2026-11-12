@echo off
rem Libre CMMS - Copyright (C) 2026 CreativeMed LLC - AGPL-3.0-or-later
rem Starts Libre in this window. Close the window or press Ctrl+C to stop.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or later is required. Download it from https://nodejs.org
  pause
  exit /b 1
)
node server\server.js
pause
