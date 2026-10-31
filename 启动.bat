@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "PY=python"
where python >nul 2>nul
if errorlevel 1 (
  if exist "E:\python-3.13.11\python.exe" (
    set "PY=E:\python-3.13.11\python.exe"
  ) else (
    echo [ERROR] Python not found. Install Python 3.9+ or edit PY in this file.
    pause
    exit /b 1
  )
)

echo ============================================
echo   InfiSheet  -  local infinite canvas
echo   ComfyUI expected at http://127.0.0.1:8188
echo ============================================
echo.

"%PY%" server.py %*

echo.
echo Server stopped.
pause
