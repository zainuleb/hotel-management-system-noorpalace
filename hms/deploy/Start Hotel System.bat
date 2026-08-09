@echo off
REM ===========================================================================
REM  Hotel Management System - start
REM
REM  Double-click this file on the hotel's front-desk PC to run the system.
REM  Keep the window that opens; closing it stops the system for everyone.
REM ===========================================================================

title Hotel Management System
cd /d "%~dp0.."

REM --- settings you may want to change ---------------------------------------
REM Port other PCs and tablets connect on. Change it only if 8080 is in use.
if not defined HMS_PORT set HMS_PORT=8080
REM Where the database and backups are kept. Leave blank to use .\data
REM set HMS_DATA_DIR=D:\HotelData
set NODE_ENV=production
REM ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this PC.
  echo   Download the LTS installer from https://nodejs.org and run it,
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "dist\server.js" (
  echo.
  echo   The system has not been built yet.
  echo   Right-click deploy\install-windows.ps1 and choose "Run with PowerShell".
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting the Hotel Management System...
echo   Leave this window open. Closing it stops the system.
echo.

node dist\server.js

echo.
echo   The system has stopped.
pause
