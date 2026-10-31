; ============================================================================
;  UNC（\\server\share）路径实测
;  由 tools/unc-check.js 拼进 launcher.ahk 副本（_launcher_unc.ahk）后调用，
;  跑完 ExitApp。测的都是真代码：Launch / QuoteArgv / IconForExe / Loop Files。
; ============================================================================

UAppend(text) {
    global SCRIPT_DIR
    FileAppend(text . '`n', SCRIPT_DIR '\_unc.log', 'UTF-8-RAW')
}

UKv(k, v) {
    UAppend(k . '  ->  ' . v)
}

UFreeLetters() {
    return 26 - StrLen(DriveGetList())
}

/* 关掉探针开出来的 cmd 窗口，并且等它真的没了再往下走：
   cmd /k + pushd 会临时映射一个盘符，进程不退出映射就不还。WinClose 是异步的，
   不等就直接 ExitApp，映射会跟着漏在系统里，跑几轮就把盘符吃干净
   （表现就是下一轮 B4/C1 假失败，排查半天）。 */
UCloseCmd() {
    if WinWait('QL_UNC_PROBE', , 3) {
        WinClose('QL_UNC_PROBE')
        if !WinWaitClose('QL_UNC_PROBE', , 3)
            try WinKill('QL_UNC_PROBE')
    }
}

/* 即便关了窗口，pushd 的临时映射偶尔还是会被系统留着（进程被杀时来不及还）。
   记下跑之前的盘符，跑完把「这一轮新冒出来、且指向本次测试共享」的映射删掉 ——
   只删自己刚弄出来的，用户原有的映射一个都不碰。 */
UReleaseNew(before) {
    global A_Temp
    after := DriveGetList()
    Loop Parse, after {
        if InStr(before, A_LoopField)
            continue                          ; 跑之前就有，不是我们的
        f := A_Temp . '\netuse-probe.txt'
        try FileDelete(f)
        try RunWait(A_ComSpec ' /c net use ' A_LoopField ': > "' f '" 2>&1', , 'Hide')
        s := FileExist(f) ? FileRead(f, 'UTF-8') : ''
        if InStr(s, '\\localhost\')
            try RunWait(A_ComSpec ' /c net use ' A_LoopField ': /delete /y', , 'Hide')
    }
}

UWait(p, ms := 6000) {
    Loop ms // 100 {
        if FileExist(p)
            return true
        Sleep(100)
    }
    return false
}

URead(p) {
    try
        return Trim(FileRead(p, 'UTF-8'), ' `t`r`n')
    catch
        return '(读不到)'
}

/* 注意：这个版本的 AHK 里 FileDelete 删不存在的文件会抛异常，一律 try 包住 */
UWrite(p, text) {
    try FileDelete(p)
    f := FileOpen(p, 'w', 'UTF-8')
    f.Write(text)
    f.Close()
}

UNC_Probe() {
    global A_Temp

    base := '\\localhost\Users\Administrator\AppData\Local\Temp\unctest'
    tmp  := A_Temp
    node := 'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
    UAppend('==== UNC 实测 ====')
    UAppend('base=' . base)
    /* pushd 靠临时映射盘符绕过「cmd 不认 UNC 工作目录」，所以 B4/C1 成败取决于
       有没有空闲盘符。这台机器常年被 webdav 占掉 A/I/X/Y，测试脚本自己漏下的
       映射再占几个就见底了 —— 先把现状写进日志，免得 FAIL 时无从判断。 */
    UAppend('空闲盘符=' . UFreeLetters() . '  已用=' . DriveGetList())

    ; 辅助脚本：读 cwd / 回显 argv
    jsCwd := tmp . '\cwdprobe.js'
    UWrite(jsCwd, "require('fs').writeFileSync(process.argv[2], process.cwd());")
    jsArgv := tmp . '\argvprobe.js'
    UWrite(jsArgv, "require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));")

    ; ---------- A. 基础判定与列目录 ----------
    UKv('A1 FileExist  UNC exe      ', FileExist(base . '\cmd2.exe') != '' ? 'YES' : 'NO')
    UKv('A2 DirExist   UNC 子目录    ', DirExist(base . '\子 目录') != '' ? 'YES' : 'NO')
    UKv('A3 DirExist   中文共享名    ', DirExist('\\localhost\临时下载') != '' ? 'YES' : 'NO')
    n := 0, names := ''
    Loop Files, base . '\*', 'FD' {
        n++
        if (n <= 6)
            names .= A_LoopFileName . ' | '
    }
    UKv('A4 Loop Files UNC           ', 'n=' . n . '  ' . names)

    ; ---------- B. 启动：UNC 上的 exe / bat ----------
    try FileDelete(tmp . '\t1.txt')
    try {
        Launch('app', base . '\cmd2.exe', '/c echo UNC_EXE_OK>t1.txt', tmp, [], '')
        UKv('B1 UNC 上的 exe（本地cwd）  ', UWait(tmp . '\t1.txt') ? ('ok ' . URead(tmp . '\t1.txt')) : 'FAIL')
    } catch as e {
        UKv('B1 UNC 上的 exe（本地cwd）  ', 'THROW ' . e.Message)
    }

    try FileDelete(tmp . '\cwd1.txt')
    try {
        t0 := A_TickCount
        Launch('app', node, '"' . jsCwd . '" "' . tmp . '\cwd1.txt"', base, [], '')
        UAppend('B2-0 Launch 返回，耗时 ' . (A_TickCount - t0) . 'ms')
        ok := UWait(tmp . '\cwd1.txt', 15000)   ; 首次用 UNC cwd 起进程，实测要 8 秒左右
        UKv('B2 UNC 工作目录（普通 exe） ', ok ? ('ok cwd=' . URead(tmp . '\cwd1.txt'))
            : ('FAIL 等了 ' . (A_TickCount - t0) . 'ms 仍无输出'))
        if !ok {
            ; 再试一次：看是不是"第一次一定失败"
            try FileDelete(tmp . '\cwd1b.txt')
            try {
                Launch('app', node, '"' . jsCwd . '" "' . tmp . '\cwd1b.txt"', base, [], '')
                ok2 := UWait(tmp . '\cwd1b.txt', 15000)
                UKv('B2-1 第二次尝试              ', ok2 ? ('ok cwd=' . URead(tmp . '\cwd1b.txt')) : 'FAIL')
            }
        }
    } catch as e {
        UKv('B2 UNC 工作目录（普通 exe） ', 'THROW ' . e.Message)
    }

    try {
        Launch('app', base . '\probe.bat', '', tmp, [], '')
        UKv('B3 UNC 上的 .bat（本地cwd） ', UWait(tmp . '\bat_out.txt') ? ('ok ' . URead(tmp . '\bat_out.txt')) : 'FAIL')
    } catch as e {
        UKv('B3 UNC 上的 .bat（本地cwd） ', 'THROW ' . e.Message)
    }

    try FileDelete(base . '\bat_out.txt')
    if (UFreeLetters() < 1)
        UKv('B4 UNC 上的 .bat（UNC cwd） ', 'SKIP 没有空闲盘符，pushd 映不出来（先 net use 清临时映射）')
    else try {
        lettersB := DriveGetList()
        Launch('app', base . '\probe.bat', '', base, [], '')
        ok := UWait(base . '\bat_out.txt')
        UKv('B4 UNC 上的 .bat（UNC cwd） ', ok ? 'ok' : 'FAIL 没生成 bat_out.txt')
    } catch as e {
        UKv('B4 UNC 上的 .bat（UNC cwd） ', 'THROW ' . e.Message)
    }
    if IsSet(lettersB)
        UReleaseNew(lettersB)

    ; ---------- C. 命令行 cwd 在 UNC 上（cmd 类型的常见配置）----------
    ; cmd 是 /k，窗口会一直开着 —— 打个专属标题，测完自己关掉
    try FileDelete(tmp . '\cwd2.txt')
    if (UFreeLetters() < 1)
        UKv('C1 cmd 类型 + UNC workdir   ', 'SKIP 没有空闲盘符，pushd 映不出来（先 net use 清临时映射）')
    else try {
        letters := DriveGetList()
        Launch('cmd', 'title QL_UNC_PROBE && cd > "' . tmp . '\cwd2.txt"', '', base, [], '')
        UKv('C1 cmd 类型 + UNC workdir   ', UWait(tmp . '\cwd2.txt') ? ('ok cwd=' . URead(tmp . '\cwd2.txt')) : 'FAIL')
    } catch as e {
        UKv('C1 cmd 类型 + UNC workdir   ', 'THROW ' . e.Message)
    }
    UCloseCmd()
    if IsSet(letters)
        UReleaseNew(letters)

    ; 对照：本地 workdir 不能被这一改弄坏
    try FileDelete(tmp . '\cwd3.txt')
    try {
        Launch('cmd', 'title QL_UNC_PROBE && cd > "' . tmp . '\cwd3.txt"', '', tmp, [], '')
        UKv('C2 cmd 类型 + 本地 workdir  ', UWait(tmp . '\cwd3.txt') ? ('ok cwd=' . URead(tmp . '\cwd3.txt')) : 'FAIL')
    } catch as e {
        UKv('C2 cmd 类型 + 本地 workdir  ', 'THROW ' . e.Message)
    }
    UCloseCmd()

    ; ---------- D. 传参 ----------
    ; D1 bat 里 %~1（cmd 解析引号）
    batEcho := tmp . '\echoargs.bat'
    UWrite(batEcho, "@echo off`r`necho A=[%~1]>>ea_out.txt`r`necho B=[%~2]>>ea_out.txt`r`necho C=[%~3]>>ea_out.txt")
    try FileDelete(tmp . '\ea_out.txt')
    try {
        Launch('app', batEcho, '', tmp, [base . '\', 'a b', base . '\子 目录'], '')
        UAppend('D1 bat 收到的参数（cmd 解析）')
        UAppend(UWait(tmp . '\ea_out.txt') ? URead(tmp . '\ea_out.txt') : '   FAIL 没生成 ea_out.txt')
    } catch as e {
        UKv('D1 bat 收到的参数（cmd 解析）', 'THROW ' . e.Message)
    }

    ; D2 exe 的 argv（CRT 解析：反斜杠在引号前是有含义的）
    try FileDelete(tmp . '\argv_out.txt')
    try {
        Launch('app', node, '"' . jsArgv . '" "' . tmp . '\argv_out.txt"', tmp
            , [base . '\', 'a b', 'C:\Windows\', 'plain'], '')
        UKv('D2 exe 收到的 argv         '
            , UWait(tmp . '\argv_out.txt') ? URead(tmp . '\argv_out.txt') : 'FAIL')
    } catch as e {
        UKv('D2 exe 收到的 argv         ', 'THROW ' . e.Message)
    }
    UKv('D3 QuoteArgv 产出          ', QuoteArgv([base . '\', 'a b', 'C:\Windows\']))

    ; ---------- E. 图标 / 转义 / 长路径 ----------
    try {
        png := IconForExe(base . '\cmd2.exe')
        UKv('E1 UNC exe 提图标          ', png = '' ? 'FAIL 返回空'
            : (FileExist(png) != '' ? ('ok ' . png) : ('FAIL ' . png)))
    } catch as e {
        UKv('E1 UNC exe 提图标          ', 'THROW ' . e.Message)
    }
    v := base . '\子 目录\a b.txt'
    UKv('E2 JsonQuote/JsonStr 往返  ', JsonStr('{"x":' . JsonQuote(v) . '}', 'x') = v ? 'ok 一致' : 'FAIL')
    UKv('E3 \\?\UNC\ 前缀           '
        , FileExist('\\?\UNC\localhost\Users\Administrator\AppData\Local\Temp\unctest\cmd2.exe') != '' ? 'YES' : 'NO')
    UKv('E4 ToFileUrl(UNC)          ', ToFileUrl(base . '\a b.png'))

    ; ---------- F. 边界：服务器根 / 不可达主机 ----------
    n2 := 0
    try {
        Loop Files, '\\localhost\*', 'FD'
            n2++
        UKv('F1 Loop Files \\\\server\*  ', n2 . ' 项')
    } catch as e {
        UKv('F1 Loop Files \\\\server\*  ', 'THROW ' . e.Message)
    }
    UKv('F2 DirExist \\\\localhost\   ', DirExist('\\localhost') != '' ? 'YES' : 'NO')
    t := A_TickCount
    ex := FileExist('\\nonexistent-host-xyz\share\a.txt')
    UKv('F3 不可达主机 FileExist     ', '返回=' . (ex = '' ? '空' : ex) . ' 耗时=' . (A_TickCount - t) . 'ms')

    ; ---------- G. 共享名枚举（Tab 补全 \\server\ 用）----------
    try {
        sh := ListShares('\\localhost')
        if IsObject(sh) {
            head := ''
            Loop Min(6, sh.Length)
                head .= sh[A_Index] . ' | '
            UKv('G1 ListShares \\\\localhost ', 'n=' . sh.Length . '  ' . head)
        } else {
            UKv('G1 ListShares \\\\localhost ', 'FAIL 返回空')
        }
    } catch as e {
        UKv('G1 ListShares \\\\localhost ', 'THROW ' . e.Message)
    }
    t := A_TickCount
    try {
        sh2 := ListShares('\\nonexistent-host-xyz')
        UKv('G2 ListShares 不可达主机    ', (IsObject(sh2) ? 'FAIL 竟然成功' : 'ok 返回空') . ' 耗时=' . (A_TickCount - t) . 'ms')
    } catch as e {
        UKv('G2 ListShares 不可达主机    ', 'THROW ' . e.Message . ' 耗时=' . (A_TickCount - t) . 'ms')
    }

    UAppend('==== 结束 ====')
    ExitApp(0)
}
