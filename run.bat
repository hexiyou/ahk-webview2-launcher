@echo off
cd /d "%~dp0"

rem 编译版优先：同目录有 QuickLaunch.exe 就直接跑，不再需要 AHK 解释器
if exist "QuickLaunch.exe" (
    start "" "QuickLaunch.exe"
    exit /b 0
)

if exist "runtime\AutoHotkey64.exe" (
    start "" "runtime\AutoHotkey64.exe" "launcher.ahk"
) else (
    start "" "launcher.ahk"
)
