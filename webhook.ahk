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

; ----------------------------------------------------------------------------
;  ↓ 以下必须留在自动执行段之后
; ----------------------------------------------------------------------------
CleanComError(msg) {
    p := InStr(msg, 'Source:')
    if p
        msg := SubStr(msg, 1, p - 1)
    msg := Trim(StrReplace(StrReplace(msg, "`r", ' '), "`n", ' '))
    return msg
}
