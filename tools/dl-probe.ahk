; ============================================================================
;  download / 拉取在线配置 实测
;  由 tools/dl-check.js 拼进 launcher.ahk 副本（_launcher_dl.ahk）后调用，跑完 ExitApp。
;  测的都是真代码：StartDownload / DoPullConfig / webhook.ahk 子进程 / InstallConfig。
;  文件字节是否一致由 node 侧比对（AHK 这边只报路径和 meta）。
; ============================================================================

DLW(t) {
    global SCRIPT_DIR
    FileAppend(t . '`n', SCRIPT_DIR '\_dl.log', 'UTF-8-RAW')
}

/* 等一个 job 跑完：meta.ini 出现 + spec.ini 已被 CheckHttp 删掉（说明结果已处理） */
DLDone(id, ms := 15000) {
    global HTTP_DIR
    dir := HTTP_DIR '\' id
    Loop ms // 100 {
        if (FileExist(dir '\meta.ini') && !FileExist(dir '\spec.ini'))
            return true
        Sleep(100)
    }
    return false
}

/* 等一个条件成立（条件用闭包传进来，比如"配置文件里出现 remote 标记"） */
DLUntil(fn, ms := 15000) {
    Loop ms // 100 {
        if fn()
            return true
        Sleep(100)
    }
    return false
}

/* 把 meta.ini 读成一行日志 */
DLMeta(id) {
    global HTTP_DIR
    p := HTTP_DIR '\' id '\meta.ini'
    if !FileExist(p)
        return 'meta 缺失（超时或进程异常退出）'
    s := 'status=' IniRead(p, 'resp', 'Status', '?')
    e := IniRead(p, 'resp', 'Error', '')
    f := IniRead(p, 'dl', 'File', '')
    n := IniRead(p, 'dl', 'Name', '')
    sz := IniRead(p, 'dl', 'Size', '0')
    sk := IniRead(p, 'dl', 'Skipped', '0')
    bk := IniRead(p, 'dl', 'Backup', '')
    out := s . ' size=' sz . ' skipped=' sk
    if (n != '')
        out .= ' name=' n
    if (f != '')
        out .= ' file=' f
    if (bk != '')
        out .= ' bak=' bk
    if (e != '')
        out .= ' err=' e
    return out
}

DLSave(dir, name) {
    try FileDelete(dir '\' name)
}

DL_Probe() {
    global CFG_PATH, PULL_DIR

    out := A_Temp '\ql-dl-test'
    try DirDelete(out, true)
    DirCreate(out)

    base := EnvGet('QL_DL_BASE')
    if (base = '')
        base := 'http://127.0.0.1:18082'

    DLW('== 目录 ' out ' · 服务 ' base ' ==')

    ; ---------- 1. 文件名取 Content-Disposition ----------
    DLSave(out, '远程 文件.bin')
    StartDownload({id: 't1', url: base '/file.bin', saveDir: out, name: '', timeout: 10
        , onExists: 'skip', backup: false, reload: false, purpose: ''})
    ok := DLDone('t1')
    DLW('T1 CD 文件名        -> ' (ok ? DLMeta('t1') : '超时'))

    ; ---------- 2. 没有 CD 时取 URL 最后一段 ----------
    DLSave(out, 'plain.bin')
    StartDownload({id: 't2', url: base '/plain.bin', saveDir: out, name: '', timeout: 10
        , onExists: 'skip', backup: false, reload: false, purpose: ''})
    ok := DLDone('t2')
    DLW('T2 URL 文件名       -> ' (ok ? DLMeta('t2') : '超时'))

    ; ---------- 3. 同名 + skip（用独立文件名，免得和 T1 互相干扰） ----------
    DLSave(out, 'skip.bin')
    StartDownload({id: 't3a', url: base '/file.bin', saveDir: out, name: 'skip.bin', timeout: 10
        , onExists: 'skip', backup: false, reload: false, purpose: ''})
    DLDone('t3a')
    StartDownload({id: 't3', url: base '/file2.bin', saveDir: out, name: 'skip.bin', timeout: 10
        , onExists: 'skip', backup: false, reload: false, purpose: ''})
    ok := DLDone('t3')
    DLW('T3 onExists=skip    -> ' (ok ? DLMeta('t3') : '超时'))

    ; ---------- 4. 同名 + overwrite + backup ----------
    DLSave(out, 'over.bin')
    DLSave(out, 'over.bin.bak')
    StartDownload({id: 't4a', url: base '/file.bin', saveDir: out, name: 'over.bin', timeout: 10
        , onExists: 'overwrite', backup: true, reload: false, purpose: ''})
    DLDone('t4a')
    StartDownload({id: 't4', url: base '/file2.bin', saveDir: out, name: 'over.bin', timeout: 10
        , onExists: 'overwrite', backup: true, reload: false, purpose: ''})
    ok := DLDone('t4')
    DLW('T4 overwrite+backup -> ' (ok ? DLMeta('t4') : '超时'))

    ; ---------- 5. 404 不许落盘 ----------
    StartDownload({id: 't5', url: base '/missing', saveDir: out, name: 'nope.bin', timeout: 10
        , onExists: 'overwrite', backup: false, reload: false, purpose: ''})
    ok := DLDone('t5')
    DLW('T5 404              -> ' (ok ? DLMeta('t5') : '超时'))

    ; ---------- 6. %TEMP% 展开 + 目录不存在时自动建 ----------
    StartDownload({id: 't6', url: base '/plain.bin', saveDir: '%TEMP%\ql-dl-test\env\deep', name: ''
        , timeout: 10, onExists: 'skip', backup: false, reload: false, purpose: ''})
    ok := DLDone('t6')
    DLW('T6 %TEMP% 展开      -> ' (ok ? DLMeta('t6') : '超时'))

    ; ---------- 7. 带非法字符的文件名要被清洗 ----------
    StartDownload({id: 't7', url: base '/plain.bin', saveDir: out, name: 'a:b?.bin', timeout: 10
        , onExists: 'overwrite', backup: false, reload: false, purpose: ''})
    ok := DLDone('t7')
    DLW('T7 非法文件名       -> ' (ok ? DLMeta('t7') : '超时'))

    ; ---------- 8. 拉取在线配置（正常 JSON） ----------
    CFG_PATH := out '\config.local.json'
    try FileDelete(CFG_PATH)
    try FileDelete(CFG_PATH '.bak')
    f := FileOpen(CFG_PATH, 'w', 'UTF-8-RAW')
    f.Write('{"items":[],"local":1}')
    f.Close()

    DoPullConfig('{"url":"' base '/config.json"}')
    ok := DLUntil(() => InStr(DLText(CFG_PATH), '"remote":1') ? true : false, 15000)
    DLW('T8 拉取配置成功     -> ' (ok ? ('配置=' DLText(CFG_PATH) ' bak=' (FileExist(CFG_PATH '.bak') ? DLText(CFG_PATH '.bak') : '无')) : '超时/未替换'))

    ; ---------- 9. 拉取到 HTML（错误页）时必须拒绝覆盖 ----------
    DoPullConfig('{"url":"' base '/bad-config"}')
    Sleep(1500)
    txt := DLText(CFG_PATH)
    DLW('T9 拉取到 HTML      -> 配置仍为=' txt ' bak 仍在=' (FileExist(CFG_PATH '.bak') ? 'Y' : 'N'))

    ; ---------- 10. 空网址要有明确提示（不该起进程） ----------
    DoPullConfig('{"url":""}')
    Sleep(300)
    DLW('T10 空网址          -> 已提示（无 job）')

    ; ---------- 11. 自定义请求头（内网下载常要带 token） ----------
    DLSave(out, 'token.bin')
    StartDownload({id: 't11', url: base '/needtoken', saveDir: out, name: 'token.bin', timeout: 10
        , onExists: 'overwrite', backup: false, reload: false, purpose: ''
        , headers: ['X-Token: abc']})
    ok := DLDone('t11')
    DLW('T11 带请求头        -> ' (ok ? DLMeta('t11') : '超时'))

    ; ---------- 12. 不带请求头 → 403，必须失败且不落盘 ----------
    StartDownload({id: 't12', url: base '/needtoken', saveDir: out, name: 'token2.bin', timeout: 10
        , onExists: 'overwrite', backup: false, reload: false, purpose: ''})
    ok := DLDone('t12')
    DLW('T12 缺请求头 403    -> ' (ok ? DLMeta('t12') : '超时'))

    ; 收尾：给还没跑完的 job 一点时间，避免和子进程收尾撞在一起
    Sleep(600)
    DLW('DONE')
    /* 这里不用 ExitApp：它会走 AHK 的收尾流程（释放 WebView2 那些 COM 对象），
       下载线程有余温时偶尔以 0xC0000409 快速失败退出。日志早就落盘了，
       但退出码会污染检查结果 —— 探针只需要日志，直接 ExitProcess 更确定。 */
    DllCall('kernel32\ExitProcess', 'uint', 0)
}

DLText(p) {
    try
        return Trim(FileRead(p, 'UTF-8'), ' `t`r`n')
    catch
        return '(读不到)'
}
