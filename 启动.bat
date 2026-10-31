@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 找 Python：py 启动器 > PATH 里的 python > 常见安装位置。
rem 旧版把 E:\python-3.13.11\python.exe 写死在这里，换一台机器就废了。
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
