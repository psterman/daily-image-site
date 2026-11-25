@echo off
rem Night publish watchdog entry for the scheduled task.
rem Why a .cmd wrapper: schtasks /tr with nested quotes is fragile in cmd.exe.
rem This file MUST stay ASCII / LF / no BOM (project convention).
rem Do NOT put an interactive wait command in here -- an unattended job
rem would hang on it forever.
rem Extra args are forwarded to the PowerShell script.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0night-watchdog.ps1" %* >> "%~dp0..\.night-watchdog-console.log" 2>&1
exit /b %errorlevel%
