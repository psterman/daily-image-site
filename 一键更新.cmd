@echo off
chcp 65001 >nul
setlocal
title Daily Image Site - Prepare
cd /d "%~dp0"

echo ================================================
echo   Prepare
echo   grab images - headlines - clean - rank/follow - build - review desk
echo   Does NOT upload and does NOT deploy.
echo ================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\daily-review.ps1" %*
set RC=%errorlevel%
echo.
if "%RC%"=="0" (
  echo [DONE] Ready for review - the review desk should be open in your browser.
) else (
  echo [FAILED] Exit code %RC% -- check .daily-review.log in this folder.
  echo   The review desk was NOT started, so do not review this issue.
)
echo.
pause
