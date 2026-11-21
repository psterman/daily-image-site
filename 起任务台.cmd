@echo off
rem Task dashboard launcher.
rem
rem IMPORTANT: launch this file through explorer.exe, so the server escapes
rem the caller's Windows Job Object. A Job with KILL_ON_JOB_CLOSE kills its
rem processes with no stderr and no exit code.
rem
rem   explorer.exe "<project-root>\<this file>"
rem
rem This is only the first hop. It runs the .mjs in --direct mode, which spawns
rem the server detached (no console window).
cd /d "%~dp0"
node tools\start-dashboard.mjs --direct
