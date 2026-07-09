@echo off
title PinPilot
cd /d "%~dp0"

echo ============================================
echo    PinPilot - se porneste, asteapta putin
echo ============================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [EROARE] Node.js nu este instalat.
  echo Instaleaza-l de la https://nodejs.org  ^(versiunea LTS^), apoi da din nou dublu-click aici.
  echo.
  pause
  exit /b
)

if not exist "node_modules" (
  echo Prima pornire: instalez componentele... ^(dureaza ~1 minut, o singura data^)
  call npm install
)

echo.
echo Pornesc PinPilot... se deschide singur in browser.
echo Ca sa opresti aplicatia: inchide aceasta fereastra.
echo.

start "" http://localhost:3000
call npm start

pause
