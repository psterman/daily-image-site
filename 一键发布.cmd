@echo off
chcp 65001 >nul
setlocal
title Daily Image Site - Publish
cd /d "%~dp0"

echo ================================================
echo   Publish
echo   upload images to R2 + deploy Pages
echo   Requires a review pass first
echo ================================================
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0tools\publish.ps1" %*
set RC=%errorlevel%
echo.
if "%RC%"=="0" (
  echo [DONE] Uploaded and deployed.
) else (
  echo [FAILED] Exit code %RC%  -- check the log above.
  echo   If it says the images are not reviewed yet, run the Prepare
  echo   script first and click the green button in the review desk.
)
echo.
pause
