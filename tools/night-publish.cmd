@echo off
rem Scheduled-task entry for the night publish flow.
rem Why a .cmd wrapper: schtasks /tr with nested quotes is fragile in cmd.exe.
rem This file MUST stay ASCII / LF / no BOM (project convention).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0night-publish.ps1" >> "%~dp0..\.night-publish-console.log" 2>&1
exit /b %errorlevel%
