@echo off
title QIDS-J + ECG
cd /d "%~dp0"

echo ============================================
echo   QIDS-J + ECG  starting...
echo   Browser opens http://127.0.0.1:8770/
echo   ECG pairing/monitor: http://127.0.0.1:8770/ecg/
echo   Close this window or press Ctrl+C to stop.
echo ============================================
echo.

rem Locate the real Python interpreter (bypass the WindowsApps stub).
set "PYEXE="
for /d %%D in ("%LOCALAPPDATA%\Python\pythoncore-*") do (
    if exist "%%D\python.exe" set "PYEXE=%%D\python.exe"
)
if not defined PYEXE (
    where python >nul 2>nul && set "PYEXE=python"
)
if not defined PYEXE (
    echo [ERROR] Python interpreter not found. Please install 64-bit Python.
    pause >nul
    exit /b 1
)

echo Using interpreter: %PYEXE%
echo.
"%PYEXE%" "%~dp0server\server.py" %*

echo.
echo Service stopped. Press any key to close.
pause >nul
