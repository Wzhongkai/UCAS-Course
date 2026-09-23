@echo off
setlocal
cd /d "%~dp0"
runtime\node.exe scripts\portable-launcher.mjs
set "UCAS_EXIT_CODE=%ERRORLEVEL%"
if not "%UCAS_EXIT_CODE%"=="0" (
  echo.
  echo UCAS Course failed to start. See the error above.
  pause
)
endlocal & exit /b %UCAS_EXIT_CODE%
