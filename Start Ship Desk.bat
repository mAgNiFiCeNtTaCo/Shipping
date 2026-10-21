@echo off
title Ship Desk
cd /d "%~dp0"

set "PY="
python --version >nul 2>nul && set "PY=python"
if not defined PY py -3 --version >nul 2>nul && set "PY=py -3"

if not defined PY (
  echo.
  echo   Ship Desk needs Python, and Python isn't installed on this PC.
  echo.
  echo   1. Go to https://www.python.org/downloads/ and install Python 3.
  echo   2. On the first setup screen, tick "Add python.exe to PATH".
  echo   3. Double-click "Start Ship Desk" again.
  echo.
  pause
  exit /b 1
)

rem Run in the background (no window) with the windowless Python. Turn it off with the switch at the top of
rem the Ship Desk page, or "Stop Ship Desk". Problems go to Saved\ship-desk.log (and a message box).
set "PYW="
where pythonw >nul 2>nul && set "PYW=pythonw"
if not defined PYW where pyw >nul 2>nul && set "PYW=pyw -3"
if defined PYW (
  start "" %PYW% serve.py %*
  exit /b 0
)

rem No windowless Python here: run in this window as before.
echo.
echo   Starting Ship Desk. Your browser opens in a moment.
echo   Keep this window open while you use Ship Desk. Close it when you're done.
echo.
%PY% serve.py %*
if errorlevel 1 (
  echo.
  echo   Ship Desk stopped with a problem.
  echo   If the message above says the address is already in use, Ship Desk is probably
  echo   already running: open http://127.0.0.1:5091/ in your browser.
  echo.
  pause
)
