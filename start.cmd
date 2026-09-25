@echo off
cd /d "%~dp0"
if exist "%LOCALAPPDATA%\..\..\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
  "%LOCALAPPDATA%\..\..\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" app.py %*
) else (
  python app.py %*
)
if errorlevel 1 pause
