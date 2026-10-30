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
;  产物（写给主进程读）：
;    <OutDir>\meta.ini   [resp] Status / Error / Ms / Len
;    <OutDir>\body.txt   响应正文（UTF-8 无 BOM）
;
;  注意：这里刻意不做任何 JSON 解析 —— 正文原样落盘，交给前端的 JSON.parse 处理。
; ============================================================================

#Requires AutoHotkey v2.0
#Warn All, Off
#SingleInstance Off

spec := A_Args.Length >= 1 ? A_Args[1] : ''
if (spec = '' || !FileExist(spec))
    ExitApp(2)

method   := IniRead(spec, 'req', 'Method', 'GET')
url      := IniRead(spec, 'req', 'Url', '')
timeout  := Integer(IniRead(spec, 'req', 'Timeout', '15'))
hdrsFile := IniRead(spec, 'req', 'HeadersFile', '')
bodyFile := IniRead(spec, 'req', 'BodyFile', '')
outDir   := IniRead(spec, 'req', 'OutDir', '')

if (outDir = '' || url = '')
    ExitApp(3)

meta := outDir '\meta.ini'
outBody := outDir '\body.txt'
try FileDelete(meta)
try FileDelete(outBody)

status := 0
errMsg := ''
body := ''
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
    body := req.ResponseText
} catch as e {
    errMsg := e.Message
    ; 常见 COM 错误码翻译成人话，比 0x80072EE2 好懂
    if InStr(errMsg, '0x80072EE2')
        errMsg := '连接超时或网络不可达（' timeout 's）'
    else if InStr(errMsg, '0x80072EFD')
        errMsg := '无法连接到服务器（DNS 或网络问题）'
    else if InStr(errMsg, '0x80072F8F')
        errMsg := 'TLS/SSL 握手失败（系统可能缺少 TLS 1.2 支持）'
    else if InStr(errMsg, '0x800C0005')
        errMsg := '无法解析域名或连接被拒绝'
}

elapsed := A_TickCount - t0

try FileAppend(body, outBody, 'UTF-8-RAW')
catch
    errMsg := errMsg = '' ? '响应写入失败（可能无权限）' : errMsg

; 错误信息可能带换行，IniWrite 的值必须是单行
errMsg := StrReplace(StrReplace(errMsg, "`r", ' '), "`n", ' ')

try FileDelete(meta)
IniWrite(status, meta, 'resp', 'Status')
IniWrite(errMsg, meta, 'resp', 'Error')
IniWrite(elapsed, meta, 'resp', 'Ms')
IniWrite(StrLen(body), meta, 'resp', 'Len')

ExitApp(0)
