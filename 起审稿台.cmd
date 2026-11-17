@echo off
rem Review station launcher.
rem
rem IMPORTANT: launch this file through explorer.exe, so the review station
rem escapes the caller's Windows Job Object. Example (this file lives in the
rem project root, next to the other one-click .cmd files):
rem   explorer.exe "<project-root>\<this file>"
rem A Job with KILL_ON_JOB_CLOSE force-kills its processes with no stderr,
rem no exit code and no event log entry - that is what silently killed the
rem review station on 2026-11-08 09:00.
rem
rem The publish date comes from .publish-date (written by daily.ps1).
cd /d "%~dp0"
node tools\start-review.mjs --direct
