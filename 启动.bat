@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Find Python: py launcher, python on PATH, common install locations.
rem Older versions hard-coded a python.exe path here, which broke on other machines.
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  for %%D in ("%LOCALAPPDATA%\Programs\Python\Python31*" "%ProgramFiles%\Python31*") do (
    if exist "%%~fD\python.exe" set "PY=%%~fD\python.exe"
  )
)
if not defined PY (
  echo [ERROR] 没找到 Python。装 Python 3.9+ 后重试： https://www.python.org/downloads/
  pause
  exit /b 1
)

echo ============================================
echo   InfiSheet  -  local infinite canvas
echo   ComfyUI expected at http://127.0.0.1:8188
echo ============================================
echo.

%PY% server.py %*

echo.
echo Server stopped.
pause
