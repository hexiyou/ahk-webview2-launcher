; ============================================================================
;  webhook.ahk  —  QuickLaunch 的 HTTP 执行器（独立子进程）
;  ---------------------------------------------------------------------------
;  为什么要单独一个进程：
;    WinHttp.WinHttpRequest 是同步 COM 调用，请求期间会阻塞脚本线程。
;    如果放在 launcher.ahk 里，10 秒超时就是 10 秒假死（窗口拖不动、Esc 也没反应）。
;    拆成子进程后主进程只轮询结果文件，界面全程可用。
;
;  调用方式：
;    AutoHotkey64.exe webhook.ahk <spec.ini>
;    spec.ini 由主进程写，内容见下面 IniRead 的键名。
;
;  两种模式（spec 里的 [req] Mode）：
;    http      默认。响应正文按文本落盘，交给前端显示（webhook 类型）
;    download  把响应体按二进制写进文件（download 类型）。和 http 共用
;              同一套请求逻辑，只是"结果去哪"不同
;
;  产物（写给主进程读）：
;    <OutDir>\meta.ini   [resp] Status / Error / Ms / Len
;                        [dl]   File / Name / Size / Skipped / Backup   （仅 download）
;    <OutDir>\body.txt   响应正文（UTF-8 无 BOM，仅 http 模式）
;
;  注意：这里刻意不做任何 JSON 解析 —— 正文原样落盘，交给前端的 JSON.parse 处理。
; ============================================================================

#Requires AutoHotkey v2.0
#Warn All, Off
#SingleInstance Off

spec := A_Args.Length >= 1 ? A_Args[1] : ''
if (spec = '' || !FileExist(spec))
    ExitApp(2)

mode     := IniRead(spec, 'req', 'Mode', 'http')
method   := IniRead(spec, 'req', 'Method', 'GET')
url      := IniRead(spec, 'req', 'Url', '')
timeout  := IntOr(IniRead(spec, 'req', 'Timeout', '15'), 15)
hdrsFile := IniRead(spec, 'req', 'HeadersFile', '')
bodyFile := IniRead(spec, 'req', 'BodyFile', '')
outDir   := IniRead(spec, 'req', 'OutDir', '')

; download 专用
saveDir  := IniRead(spec, 'dl', 'SaveDir', '')
saveName := IniRead(spec, 'dl', 'SaveName', '')
onExists := IniRead(spec, 'dl', 'OnExists', 'skip')
backup   := IntOr(IniRead(spec, 'dl', 'Backup', '0'), 0)

if (outDir = '' || url = '')
    ExitApp(3)

meta := outDir '\meta.ini'
outBody := outDir '\body.txt'
try FileDelete(meta)
try FileDelete(outBody)

status := 0
errMsg := ''
body := ''
dl := { file: '', name: '', size: 0, skipped: 0, backup: '' }
t0 := A_TickCount

try {
    req := ComObject('WinHttp.WinHttpRequest.5.1')

    ; 四个超时都按用户设置（毫秒）：解析 / 连接 / 发送 / 接收
    ms := Max(timeout, 1) * 1000
    try req.SetTimeouts(ms, ms, ms, ms)

    req.Open(method, url, false)

    ; 先给一个默认 UA：GitHub 之类没有 UA 会直接 403；用户自己设了就以用户的为准
    try req.SetRequestHeader('User-Agent', 'QuickLaunch/1.0 (AutoHotkey + WebView2)')

    if (hdrsFile != '' && FileExist(hdrsFile)) {
        Loop Read, hdrsFile {
            line := Trim(A_LoopReadLine)
            if (line = '' || SubStr(line, 1, 1) = ';')
                continue
            p := InStr(line, ':')
            if (p < 2)
                continue
            try req.SetRequestHeader(Trim(SubStr(line, 1, p - 1)), Trim(SubStr(line, p + 1)))
        }
    }

    if (bodyFile != '' && FileExist(bodyFile)) {
        reqBody := FileRead(bodyFile, 'UTF-8')
        req.Send(reqBody)
    } else {
        req.Send()
    }

    status := req.Status

    if (mode = 'download') {
        ; 只认 2xx：404/500 的响应体是错误页，存成文件只会污染目录
        if (status < 200 || status > 299)
            throw Error('下载失败：服务器返回 HTTP ' status '（未保存任何文件）')
        dl := SaveToFile(req, saveDir, saveName, onExists, backup, url)
    } else {
        body := req.ResponseText
    }
} catch as e {
    errMsg := CleanComError(e.Message)

    ; 常见 WinHttp / WinINET 错误码翻译成人话，比 0x80072EE2 好懂。
    ; 这些错误都在"还没拿到 HTTP 响应"的阶段抛出，和 4xx/5xx（限流、鉴权失败）是两回事。
    codeMap := Map(
        '0x80072EE2', '连接超时：服务器没有在 ' timeout ' 秒内响应',
        '0x80072EE7', '域名解析失败：DNS 查不到这个主机',
        '0x80072EFD', '无法连接到服务器：端口不可达或被防火墙拦截',
        '0x80072EFE', '连接被对方中断：TCP 已连上但 TLS 握手被重置。多为网络干扰、代理或目标站点封禁，不是请求参数问题',
        '0x80072EF3', '服务器返回了无法识别的响应',
        '0x80072F78', '服务器返回的响应无效',
        '0x80072F8F', 'TLS/SSL 握手失败：系统可能未启用 TLS 1.2',
        '0x80090308', 'TLS 握手失败：证书或加密套件不被接受',
        '0x800B0109', '证书链不受信任：目标站点证书有问题或系统根证书缺失',
        '0x800C0005', '无法解析域名或连接被拒绝',
        '0x800C0008', '下载失败：连接被中途断开'
    )
    for code, text in codeMap {
        if InStr(errMsg, code) {
            errMsg := text '（' code '）'
            break
        }
    }
}

; AHK 的 COM 异常 Message 后面会挂一串 "Source: ... Description: ... HelpFile: ..."，
; 直接丢给用户看既长又没用，只留前半句人话。
; 注意：函数定义放在文件末尾 —— AHK v2 执行到第一个函数定义就结束自动执行段，
; 插在中间会让后面的写结果代码变成死代码。

elapsed := A_TickCount - t0

if (mode != 'download') {
    try FileAppend(body, outBody, 'UTF-8-RAW')
    catch
        errMsg := errMsg = '' ? '响应写入失败（可能无权限）' : errMsg
}

; 错误信息可能带换行，IniWrite 的值必须是单行
errMsg := StrReplace(StrReplace(errMsg, "`r", ' '), "`n", ' ')

try FileDelete(meta)
IniWrite(status, meta, 'resp', 'Status')
IniWrite(errMsg, meta, 'resp', 'Error')
IniWrite(elapsed, meta, 'resp', 'Ms')
IniWrite(mode = 'download' ? dl.size : StrLen(body), meta, 'resp', 'Len')

if (mode = 'download') {
    IniWrite(dl.file, meta, 'dl', 'File')
    IniWrite(dl.name, meta, 'dl', 'Name')
    IniWrite(dl.size, meta, 'dl', 'Size')
    IniWrite(dl.skipped, meta, 'dl', 'Skipped')
    IniWrite(dl.backup, meta, 'dl', 'Backup')
}

ExitApp(0)

; ----------------------------------------------------------------------------
;  ↓ 以下必须留在自动执行段之后
; ----------------------------------------------------------------------------

/* 把响应体写成文件。返回 {file, name, size, skipped, backup}
   —— 文件很小（配置文件、图标、脚本），所以一次性进内存，不做分片/断点。 */
SaveToFile(req, dir, given, onExists, doBackup, url) {
    name := SaltName(given != '' ? given : PickName(req, url))
    if (dir = '')
        dir := EnvGet('USERPROFILE') '\Downloads'
    try DirCreate(dir)                      ; 顺带创建多级目录
    if !DirExist(dir)
        throw Error('保存目录不可用：' dir)

    final := RTrim(dir, '\/') '\' name
    res := { file: final, name: name, size: 0, skipped: 0, backup: '' }

    if FileExist(final) {
        if (onExists != 'overwrite') {       ; 默认跳过：最保守的语义
            res.skipped := 1
            res.size := FileGetSize(final)
            return res
        }
        if (doBackup) {
            bakPath := final '.bak'
            try FileDelete(bakPath)
            try {
                FileCopy(final, bakPath, 1)
                res.backup := bakPath
            }
        }
    }

    ; 先写 .part 再改名：中途失败不会留下一个"看起来完整"的半截文件
    tmp := final '.part'
    try FileDelete(tmp)

    st := ComObject('ADODB.Stream')          ; ADODB 是最省事的二进制写盘方式
    st.Type := 1                             ; adTypeBinary（1 = 二进制，默认是文本）
    st.Open()
    try {
        ; ResponseBody 是 SafeArray(VT_UI1)，ADODB 能直接吃。
        ; 千万别用 ResponseText：那会按字符集解码，图片/压缩包当场废掉
        st.Write(req.ResponseBody)
        st.SaveToFile(tmp, 2)                ; 2 = adSaveCreateOverWrite
        st.Close()
    } catch as e {
        try st.Close()
        try FileDelete(tmp)
        throw Error('写入文件失败：' CleanComError(e.Message))
    }

    try FileMove(tmp, final, 1)
    catch {
        try FileDelete(tmp)
        throw Error('保存失败：目标被占用或没有权限（' final '）')
    }

    res.size := FileGetSize(final)
    return res
}

/* 文件名优先级：Content-Disposition > URL 最后一段（curl -O 的行为） */
PickName(req, url) {
    cd := ''
    try cd := req.GetResponseHeader('Content-Disposition')
    cd := Trim(cd == '' ? '' : cd)

    if (cd != '') {
        ; RFC 5987 的 filename*=UTF-8''%E4%B8%AD.txt 优先，浏览器/服务端都这么排
        if RegExMatch(cd, "i)filename\*\s*=\s*([^;]+)", &m) {
            v := Trim(m[1], ' "')
            if RegExMatch(v, "^[^']*'[^']*'(.*)$", &pfx)
                v := pfx[1]
            v := UrlDecode(v)
            if (v != '')
                return v
        }
        if RegExMatch(cd, 'i)filename\s*=\s*("([^"]*)"|([^;]+))', &m) {
            v := m[2] != '' ? m[2] : Trim(m[3], ' ')
            v := UrlDecode(v)
            if (v != '')
                return v
        }
    }

    u := url
    if (p := InStr(u, '#'))
        u := SubStr(u, 1, p - 1)
    if (p := InStr(u, '?'))
        u := SubStr(u, 1, p - 1)
    seg := ''
    for part in StrSplit(u, '/')
        seg := part
    seg := UrlDecode(seg)
    return (seg != '') ? seg : 'download.bin'
}

/* 文件名里不能出现的字符一律换掉 —— 远端可以返回任意字符串，
   带 : / \ 的名字会被当成路径写到别的地方去 */
SaltName(n) {
    n := RegExReplace(n, '[\\/:*?"<>|\x00-\x1f]', '_')
    n := Trim(n, ' .')
    if (n = '' || n = '.' || n = '..')
        n := 'download.bin'
    return n
}

/* %XX 解码（按 UTF-8 解释）。不做 + → 空格：路径里 + 就是加号本身 */
UrlDecode(s) {
    len := StrLen(s)
    if !len
        return ''
    buf := Buffer(len * 4 + 8, 0)
    n := 0, i := 1
    while (i <= len) {
        c := SubStr(s, i, 1)
        if (c = '%' && i + 2 <= len && RegExMatch(SubStr(s, i + 1, 2), '^[0-9a-fA-F]{2}$')) {
            NumPut('UChar', Integer('0x' SubStr(s, i + 1, 2)), buf, n)
            n += 1, i += 3
            continue
        }
        b := StrPut(c, 'UTF-8')
        tmp := Buffer(b, 0)
        StrPut(c, tmp, 'UTF-8')
        DllCall('RtlMoveMemory', 'ptr', buf.Ptr + n, 'ptr', tmp.Ptr, 'uptr', b - 1)
        n += b - 1
        i += 1
    }
    return n ? StrGet(buf, n, 'UTF-8') : ''
}

IntOr(s, def) {
    s := Trim(s)
    return IsNumber(s) ? Integer(s) : def
}

CleanComError(msg) {
    p := InStr(msg, 'Source:')
    if p
        msg := SubStr(msg, 1, p - 1)
    msg := Trim(StrReplace(StrReplace(msg, "`r", ' '), "`n", ' '))
    return msg
}
