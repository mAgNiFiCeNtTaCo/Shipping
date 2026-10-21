@echo off
title Stop Ship Desk
rem Turns off Ship Desk running in the background (the same as "Turn off" at the top of the page).
curl -s -f -X POST -H "X-Ship-Desk: 1" -H "Origin: http://127.0.0.1:5091" http://127.0.0.1:5091/api/shutdown >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Ship Desk wasn't running.
) else (
  echo.
  echo   Ship Desk is turning off.
)
rem (a 3 second pause that also works when the window's input is redirected)
ping -n 4 127.0.0.1 >nul
