; ============================================================================
;  控制台输出实测
;  由 tools/out-check.js 拼进 launcher.ahk 副本后调用。
;
;  为什么要单独测这个：以前所有测试的 stdout 都是「管道」（node 的 spawn 给的），
;  而 FileAppend(..., '*') 在管道里永远成功、在真控制台里却会抛「句柄无效」被 try
;  吞掉 —— 于是「命令跑完了但一个字都没打印」。管道测不出来，必须造一个真控制台。
;
;  AllocConsole 会给进程一个货真价实的控制台设备（FILE_TYPE_CHAR + 真的代码页），
;  写进去之后还能用 ReadConsoleOutputCharacterW 把屏幕缓冲区读回来逐字比对。
; ============================================================================

OutLog(s) {
    global SCRIPT_DIR
    FileAppend(s . '`n', SCRIPT_DIR . '\_out.log', 'UTF-8-RAW')
}

; 读控制台屏幕缓冲区第一行（前 width 个字符）
OutReadLine(hCon, width := 120) {
    buf := Buffer(width * 2, 0)
    n := 0
    /* COORD 是**按值**传的 4 字节结构，DllCall 里必须按指针大小传整数；
       给 Buffer 指针的话函数直接失败、返回 0 字符（这里踩过，一度以为"没写进去"）。 */
    DllCall('kernel32\ReadConsoleOutputCharacterW'
        , 'ptr', hCon, 'ptr', buf, 'uint', width, 'int64', 0, 'uint*', &n)
    if !n
        return ''
    return Trim(StrGet(buf, 'UTF-16'), ' ' . Chr(0))
}

OutProbe() {
    global SCRIPT_DIR
    try FileDelete(SCRIPT_DIR . '\_out.log')

    allocated := DllCall('kernel32\AllocConsole', 'int')
    /* AllocConsole 只给「本来就是 NULL」的标准句柄赋值；被 node 用管道拉起来时
       stdout 已经是个管道了，所以得自己开 CONOUT$ 再把它设成 stdout，
       这样才等于「在 cmd 窗口里跑」的情形。 */
    hCon := DllCall('kernel32\CreateFileW', 'wstr', 'CONOUT$'
        , 'uint', 0xC0000000, 'uint', 3, 'ptr', 0, 'uint', 3, 'uint', 0, 'ptr', 0, 'ptr')
    if (hCon = -1 || !hCon) {
        OutLog('RESULT FAIL 打不开 CONOUT$（alloc=' allocated '）')
        ExitApp(1)
    }
    DllCall('kernel32\SetStdHandle', 'int', -11, 'ptr', hCon)
    h := DllCall('kernel32\GetStdHandle', 'int', -11, 'ptr')
    ft := h ? DllCall('kernel32\GetFileType', 'ptr', h, 'int') : -1
    if (ft != 2) {
        OutLog('RESULT FAIL 没能造出控制台（alloc=' allocated ' handle=' h ' fileType=' ft '）')
        ExitApp(1)
    }
    cp := DllCall('kernel32\GetConsoleOutputCP', 'int')
    OutLog('控制台: handle=' h ' fileType=' ft '（2=控制台） outputCP=' cp)

    want := 'QL_OUT_TEST 中文 abc 123'
    ok := StdOut(want . '`n')
    Sleep 150                              ; 写进屏幕缓冲区有个刷新过程
    got := OutReadLine(h)

    OutLog('StdOut 返回=' (ok ? 'true' : 'false'))
    OutLog('屏幕缓冲区读到=[' got ']')
    OutLog((ok && InStr(got, want)) ? 'RESULT PASS' : 'RESULT FAIL 内容对不上')
    ExitApp(ok && InStr(got, want) ? 0 : 1)
}
