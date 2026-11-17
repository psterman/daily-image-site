@echo off
chcp 65001 >nul
setlocal
title Daily Image Site - Upload Now
cd /d "%~dp0"

echo ================================================
echo   Upload now
echo   grab images - headlines - clean - rank/follow - build - upload - deploy
echo   Does NOT wait for review. Skips the review gate.
echo   Live site: https://example.com/
echo ================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\manual-publish.ps1" %*
set RC=%errorlevel%
echo.
if "%RC%"=="0" (
  echo [OK] Script finished - read the lines above for the verdict.
  echo   Live: https://example.com/
  echo   Log : .manual-publish-*.log in this folder
  echo   To review this issue: run tools\morning-review.ps1
) else (
  echo [FAILED] Exit code %RC% -- check .manual-publish-*.log in this folder.
  echo   The site was NOT updated. Retry later or run tools\publish.ps1 by hand.
)
echo.
pause
