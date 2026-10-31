@echo off
rem ============================================================
rem  QuickLaunch 命令行入口（ql.cmd）
rem  ----------------------------------------------------------
rem  不要把这里改成 start /b：start 会把进程甩到后台，调用方立刻拿到
rem  退出码 0，--wait 就彻底失效了。批处理里直接调用可执行文件是会等它
rem  结束的；而启动器只有在“没有实例、需要拉起”时才会把自己甩成后台进程
rem  （见 launcher.ahk 的 SpawnInstance），所以这里不会被吊住。
rem ============================================================
setlocal

set "QL_DIR=%~dp0"
set "QL_AHK=%QL_DIR%runtime\AutoHotkey64.exe"
if not exist "%QL_AHK%" set "QL_AHK=AutoHotkey64.exe"

if "%~1"=="" (
    "%QL_AHK%" "%QL_DIR%launcher.ahk" --show
) else (
    "%QL_AHK%" "%QL_DIR%launcher.ahk" %*
)

exit /b %ERRORLEVEL%
