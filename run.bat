@echo off
cd /d "%~dp0"
if exist "runtime\AutoHotkey64.exe" (
    start "" "runtime\AutoHotkey64.exe" "launcher.ahk"
) else (
    start "" "launcher.ahk"
)
