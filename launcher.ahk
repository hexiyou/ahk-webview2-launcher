; ============================================================================
;  QuickLaunch  —  AutoHotkey v2 + WebView2 快速启动器（可行性验证版）
;  ---------------------------------------------------------------------------
;  结构：
;    launcher.ahk        本文件：Win32 无边框窗口 + WebView2 宿主 + 全局热键 + 启动逻辑
;    launcher.ini        AHK 侧设置（热键 / 窗口尺寸 / 行为）
;    config.json         数据源（应用条目，由前端 JS 读取解析）
;    ui/                 前端界面（HTML + CSS + JS）
;    lib/WebView2/       thqby 的 WebView2 COM 绑定库（MIT）
;    lib/WebView2Loader.dll
;
;  通信：JS --chrome.webview.postMessage--> AHK；AHK --PostWebMessageAsJson--> JS
; ============================================================================

#Requires AutoHotkey v2.0
; 不用 #SingleInstance Force：那样"重复启动 = 杀掉旧进程重开"，
; 正在跑的 webhook/download、用户敲了一半的查询、刚写一半的 usage.json 全丢。
; 单例改为自己拿命名互斥体实现，后来的进程一律当客户端把请求投递进来（见文末「命令行」段）。
#SingleInstance Off
#Warn All, Off
#Include lib\WebView2\WebView2.ahk

; ---------------------------- 路径常量 --------------------------------------
global SCRIPT_DIR := A_ScriptDir
global INI_PATH   := SCRIPT_DIR '\launcher.ini'
global CFG_PATH   := SCRIPT_DIR '\config.json'
global USAGE_PATH := SCRIPT_DIR '\usage.json'
global UI_PATH    := SCRIPT_DIR '\ui\index.html'
global DLL_PATH   := SCRIPT_DIR '\lib\WebView2Loader.dll'
global DATA_DIR   := SCRIPT_DIR '\.webview2'
global ICON_DIR   := A_Temp '\quicklaunch-icons'
global HTTP_DIR   := A_Temp '\quicklaunch-http'
global PULL_DIR   := A_Temp '\quicklaunch-pull'   ; 「拉取在线配置」先落到这里，校验过了才换掉本地文件
global CLI_DIR    := A_Temp '\quicklaunch-cli'    ; 客户端的回执文件放这里（跨进程用，别用脚本目录）
global SCHED_LOG  := SCRIPT_DIR '\sched.log'      ; 定时任务的执行记录（一行一条，主界面没有入口，靠它查）
global HTTP_MAX_BODY := 400000        ; webhook 响应正文上限（字符），超出截断防止消息过大

; 请求头动态值的签名密钥：**只存在于这里**。
; config.json 里写 {{#hmac:demo:...}} 引用名字，明文密钥不落配置文件；
; 编译成 exe 后连这张表也看不见（只剩 exe 里的压缩脚本）。
global SIG_KEYS := Map(
    'demo', 'ql-demo-2026-secret'
)

; 单实例 / 进程间通信的标识：跟着脚本目录走，同一份程序的多个副本互不干扰
global INST_KEY   := HashText(StrLower(SCRIPT_DIR))
global MUTEX_NAME := 'Local\QuickLaunch-' INST_KEY
global IPC_TITLE  := 'QuickLaunch/ipc/' INST_KEY

; ---------------------------- 运行时状态 ------------------------------------
global g := ""
global wvc := 0
global wv := 0
global uiReady := false
global lastNavOK := -1        ; 最近一次导航结果（-1 = 还没导航过）
global lastNavErr := -1
global dropNav := false       ; 上一次导航是被我们拦下的（拖文件进来），别当成加载失败
global dropSeen := ''         ; 上一次转给页面的拖入 URI（同一次拖放别转两遍）
global dropSeenAt := 0
global ncDrag := false        ; WebView2 原生非客户区拖拽是否可用
global httpJobs := Map()      ; 进行中的 webhook 请求：id -> {dir, pid, deadline}
global ipcGui := 0            ; 收件箱窗口（接收命令行请求）
global mutexHandle := 0
global cliQueue := []         ; 还没投递给页面的请求
global cliRec := Map()        ; rid -> 请求记录 {rid, reply, show, exitAfter, task}
global wakePending := false   ; 有客户端只是要求"打开一下"
global schedTasks := []       ; 已安装的定时任务
global schedStage := []       ; sched-begin..sched-end 之间攒的条目
global schedInside := false

; ---------------------------- 启动引导 --------------------------------------
SetProcessDpi()

; 命令行参数先只做解析，不产生任何副作用
CLI := CliParse(A_Args)

if (CLI.help) {
    CliUsage()
    ExitApp(0)
}
if (CLI.err != '') {
    StdOut('参数错误：' CLI.err '`n`n', true)
    CliUsage()
    ExitApp(6)
}

; 拿不到单例锁 = 已经有实例在跑，本进程只当客户端把请求投进去
/* 带命令的启动一律走客户端通道：投递完就退场。
   客户端绝不"自己变成常驻实例" —— 否则 `ql run 记事本` 这条命令会因为没有
   --wait 而一直挂在终端里不返回（批处理在等这个进程结束）。 */
if (CLI.mode != 'none')
    CliClient(CLI)                       ; 内部会 ExitApp

if !AcquireInstance(CLI.replace ? 3000 : 0) {
    ; 没有命令行、但已经有实例在跑（双击 run.bat）：唤醒它，不要重启
    CLI.mode := 'wake'
    CliClient(CLI)
}

CreateInbox()                            ; 收件箱要早于 WebView2，后来者才找得到人

settings := LoadSettings()
A_IconTip := 'QuickLaunch　' settings.hotkey ' 呼出'
SetupTray()

if !FileExist(UI_PATH) {
    if (CLI.mode != 'none')
        CliFail(5, '找不到界面文件：' UI_PATH)
    MsgBox('找不到界面文件：`n' UI_PATH, 'QuickLaunch', 'Icon!')
    ExitApp()
}

; 清掉上次运行留下的 webhook 临时目录（响应正文可能不小，不清理会越积越多）
try DirDelete(HTTP_DIR, true)
try DirDelete(PULL_DIR, true)
CleanStaleCli()                          ; 只清过期回执，别把整个目录端掉（见函数注释）

/* 窗口显不显示由命令本身决定，不看 ini：
     search → 一定显示（人要看结果）
     list   → 不显示（输出走 stdout，是给脚本用的）
     run    → 只有 --show 才显示
   --hide 是"被客户端拉起"时用的：先藏起来，等请求里的 cli-applied 再决定要不要露脸，
   免得 `ql run 记事本` 冷启动时先闪一下空窗口。
   完全没有命令行参数时维持原来的 ShowOnStart 行为。 */
if (CLI.mode = 'none') {
    if CLI.show
        settings.showOnStart := 1
    else if CLI.hide
        settings.showOnStart := 0
} else if (CLI.mode = 'search')
    settings.showOnStart := 1                     ; 打开就要看到过滤结果
else
    settings.showOnStart := CLI.show ? 1 : 0      ; list / run：默认不露窗

BuildUi(settings)
RegisterHotkey(settings.hotkey)

if settings.showOnStart
    ShowLauncher()

; ============================================================================
;  窗口 / WebView2
; ============================================================================

SetProcessDpi() {
    ; Per-Monitor V2，保证高分屏下 WebView2 与坐标计算一致
    try DllCall('user32\SetProcessDpiAwarenessContext', 'ptr', -4)
    catch
        try DllCall('shcore\SetProcessDpiAwareness', 'int', 2)
}

LoadSettings() {
    global INI_PATH
    return {
        hotkey:          IniRead(INI_PATH, 'General', 'Hotkey', '^!Space'),
        width:       Integer(IniRead(INI_PATH, 'General', 'Width', '820')),
        height:      Integer(IniRead(INI_PATH, 'General', 'Height', '580')),
        radius:      Integer(IniRead(INI_PATH, 'General', 'CornerRadius', '14')),
        topmost:     Integer(IniRead(INI_PATH, 'General', 'AlwaysOnTop', '1')),
        hideOnBlur:  Integer(IniRead(INI_PATH, 'General', 'HideOnBlur', '0')),
        hideAfterLaunch: Integer(IniRead(INI_PATH, 'General', 'HideAfterLaunch', '1')),
        showOnStart: Integer(IniRead(INI_PATH, 'General', 'ShowOnStart', '1')),
        devtools:    Integer(IniRead(INI_PATH, 'General', 'DevTools', '1'))
    }
}

BuildUi(s) {
    ; 注意：ncDrag 必须在这里声明为 global。
    ; 少写一个变量名就会变成「局部变量」，赋值只写进本函数，
    ; StartDrag() / InjectBootstrap() 读到的全局值永远是 false ——
    ; 结果就是原生拖拽设置明明成功了却被判定为失败，一直走轮询拖拽。
    global g, wvc, wv, DLL_PATH, DATA_DIR, UI_PATH, ncDrag

    g := Gui('-Caption +ToolWindow' (s.topmost ? ' +AlwaysOnTop' : ''), 'QuickLaunch')
    g.BackColor := '0xFFFFFF'
    g.MarginX := 0
    g.MarginY := 0
    ; 关闭窗口（✕ / Alt+F4）只隐藏，不退出进程；
    ; 真正退出只走托盘菜单的「退出软件」，否则全局热键就再也没人能唤醒了。
    g.OnEvent('Close', (*) => HideLauncher())
    g.OnEvent('Escape', (*) => HideLauncher())

    ; ★ 关键顺序：窗口必须先「真正显示」，再创建 WebView2 控制器。
    ;   如果在隐藏窗口（Show ... Hide）上创建，页面照样能加载（CapturePreview 也能
    ;   抓到完整内容），但 DirectComposition 的视觉树不会挂到窗口上 —— 屏幕上就是
    ;   一个什么都没有的纯白窗口。这是本项目最隐蔽的一个坑。
    if (s.showOnStart) {
        CenterWindow()
        g.Show('w' s.width ' h' s.height)
        CenterWindow()          ; Show 会微调位置，显示后必须再对齐一次
        if (s.topmost)
            WinSetAlwaysOnTop(1, 'ahk_id ' g.Hwnd)
    } else {
        ; 不想开机就弹窗时，先摆到屏幕外「显示」着建控制器，建完再藏起来
        g.Show('x-32000 y-32000 w' s.width ' h' s.height ' NA')
    }

    if (s.radius > 0)
        ApplyRoundRegion(g.Hwnd, s.width, s.height, s.radius)

    if (s.hideOnBlur)
        OnMessage(0x0006, WM_ACTIVATE)          ; 失焦自动隐藏
    OnMessage(0x0005, WM_SIZE)                  ; 窗口尺寸变化时让 WebView2 跟上

    ; ---- 创建 WebView2 控制器 ----
    try {
        wvc := WebView2.CreateControllerAsync(g.Hwnd, 0, DATA_DIR, '', DLL_PATH).await()
    } catch as e {
        MsgBox('WebView2 初始化失败：`n' e.Message
            . '`n`n请确认：`n1) 已安装 Microsoft Edge WebView2 Runtime`n2) lib\WebView2Loader.dll 与本脚本位数一致（64 位）'
            , 'QuickLaunch', 'Icon!')
        ExitApp()
    }

    wv := wvc.CoreWebView2

    if !s.devtools {
        try {
            wv.Settings.AreDevToolsEnabled := 0
            wv.Settings.AreDefaultContextMenusEnabled := 0
        }
    }

    ; 开启 WebView2 的「非客户区支持」：页面里标了 -webkit-app-region: drag 的区域
    ; 会被上报成 HTCAPTION，窗口移动交回 Windows 自己的移动循环 —— 平滑、零闪烁、
    ; 松手即停，也不存在自己算鼠标偏移量算错导致窗口飞出去的问题。
    try {
        wv.Settings.IsNonClientRegionSupportEnabled := 1
        ncDrag := true
    } catch as e {
        ncDrag := false                        ; 运行时太老则退回轮询拖拽
    }

    wvc.Fill()
    try
        wvc.IsVisible := 1

    wv.add_WebMessageReceived(OnWebMessage)
    wv.add_NavigationStarting(OnNavStarting)
    wv.add_NewWindowRequested(OnNewWindow)
    wv.add_NavigationCompleted(OnNavDone)
    wv.add_ProcessFailed(OnProcFailed)

    InjectBootstrap()
    ; 和 OnNavStarting 里放行用的那串保持完全一致（见那里的注释）
    wv.Navigate(ToFileUrl(UI_PATH))

    ; 窗口显示后合成层可能还没跟上，补两次尺寸/可见性，收掉残留白屏
    SetTimer(Refill, -120)
    SetTimer(Refill, -450)
    SetTimer(ReadyWatchdog, -9000)

    if !s.showOnStart
        g.Hide()
}

Refill() {
    global wvc
    if !wvc
        return
    try {
        wvc.Fill()
        wvc.IsVisible := 1
    }
}

; ============================================================================
;  拦住"拖进来的东西"
;
;  WebView2 的默认动作：把拖进窗口的文件当成一次**顶层导航**（file:///C:/…），
;  也就是整个界面被换成那个文件的内容 —— 看上去像"程序用它打开了文件"。
;  页面自己救不了：DataTransfer 里的 File 只有名字、没有路径（Chromium 的安全设计），
;  所以只能在宿主侧拦：Cancel 掉这次导航，把 URI 交给页面自己去解路径。
;
;  为什么不在 AHK 里解：PathCreateFromUrlW 把 %E6%8B%96 解成 U+00E6 U+008B U+0096
;  （一个字节一个字符），中文/多字节路径必然乱码 —— 实测踩过。页面有 `new URL()`
;  + `decodeURIComponent`，解 URL 本来就该交给它。
;
;  这里刻意**保留** AllowExternalDrop = true（默认值）：置成 false 之后 Chromium
;  会拒绝一切 OLE 拖放，连这个导航都不会发生，路径也就无从得到。
; ============================================================================
OnNavStarting(sender, args) {
    global UI_PATH, dropNav
    dropNav := false                       ; 每次新导航先复位，别让上一次的拦截影响判断
    uri := ''
    try uri := args.Uri
    if (uri = '')
        return

    ; 自己的页面（首次加载 / 重载 / #锚点）放行。
    ; 两道判据：整串相等（平时都走这条），以及末尾 12 个字符相等（"i/index.html"）——
    ; 脚本目录里带中文时，Chromium 会把 URI 前面的部分百分号编码，整串比不上，
    ; 但 "ui/index.html" 这一段是 ASCII，一定原样。绝不能拿"解码后的路径"来比：
    ; 一旦解码错，连自己的首页都会被拦掉，界面直接起不来。
    uiUrl := ToFileUrl(UI_PATH)
    uiTail := SubStr(StrReplace(UI_PATH, '\', '/'), -12)
    if (SubStr(uri, 1, StrLen(uiUrl)) = uiUrl || SubStr(uri, -12) = uiTail)
        return

    args.Cancel := 1
    dropNav := true

    if RegExMatch(uri, 'i)^file://') {
        ; 文件 / 文件夹：页面解出真实路径，填进参数
        if DropOnce(uri)
            JsSend('{"type":"dropped","uri":' JsonQuote(uri) '}')
    } else {
        ; 不是文件：拖进来的多半是浏览器里的链接。照样拦下来（界面不能被顶掉），
        ; 只是没法当路径用，提示一句。
        Notify('只支持拖文件 / 文件夹进来；链接请直接粘贴')
    }
}

; 拖进来的文件有时不是"就地导航"，而是让 Chromium 另开一个窗口
; （WebView2Feedback #278 里就是这么表现的）。两条路都堵上 ——
; 本程序不需要任何弹窗，新窗口一律 Handled。
OnNewWindow(sender, args) {
    uri := ''
    try uri := args.Uri
    try args.Handled := 1
    if (uri = '')
        return
    if RegExMatch(uri, 'i)^file://') {
        if DropOnce(uri)
            JsSend('{"type":"dropped","uri":' JsonQuote(uri) '}')
    } else {
        Notify('只支持拖文件 / 文件夹进来；链接请直接粘贴')
    }
}

; 同一次拖放可能同时触发「导航」和「新窗口」两种事件：1 秒内同一个 URI 只转一次，
; 否则路径会被填两遍
DropOnce(uri) {
    global dropSeen, dropSeenAt
    now := A_TickCount
    if (uri = dropSeen && now - dropSeenAt < 1000)
        return false
    dropSeen := uri
    dropSeenAt := now
    return true
}

OnNavDone(sender, args) {
    global lastNavOK, lastNavErr, dropNav
    if (dropNav) {
        ; 被 OnNavStarting 拦下的那次导航也会走到这里（IsSuccess=false），
        ; 这不是加载失败：别弹模态框（弹了界面就冻住），也别污染诊断信息。
        dropNav := false
        return
    }
    lastNavOK := args.IsSuccess
    lastNavErr := args.WebErrorStatus
    if !args.IsSuccess
        MsgBox('页面加载失败`n`nWebErrorStatus = ' args.WebErrorStatus
            . '`nURL = ' sender.Source, 'QuickLaunch', 'Icon!')
}

OnProcFailed(sender, args) {
    MsgBox('WebView2 渲染进程异常退出（kind = ' args.ProcessFailedKind '）`n`n请关闭程序后重新启动。'
        , 'QuickLaunch', 'Icon!')
}

ReadyWatchdog() {
    global uiReady, wv, lastNavOK, lastNavErr, cliQueue
    if (uiReady)
        return
    if (cliQueue.Length) {
        ; 界面起不来：把攒着的请求全部按失败回执掉，别让调用方干等到 30 秒超时。
        ; 也不能弹模态框 —— 由命令行拉起的实例通常是隐藏的，弹了没人关。
        pending := cliQueue.Clone()
        cliQueue := []
        for it in pending
            CliReply('{"rid":' JsonQuote(it.rid) ',"code":5,"text":'
                . JsonQuote('界面初始化失败，命令没有执行（详见 launcher.log）') ',"json":""}')
        try FileAppend(FormatTime() ' 界面 9 秒未就绪（WebErrorStatus=' lastNavErr '）`n'
            , SCRIPT_DIR '\launcher.log', 'UTF-8')
        return
    }
    MsgBox('界面在 9 秒内没有完成初始化，可能显示为白屏。`n`n'
        . '导航成功 = ' lastNavOK '`nWebErrorStatus = ' lastNavErr '`n'
        . '当前地址 = ' (wv ? wv.Source : '(无)') '`n`n'
        . '请把这段信息发给开发者，同时确认 ui\index.html 与 lib\WebView2Loader.dll 存在。'
        , 'QuickLaunch 诊断', 'Icon!')
}

ApplyRoundRegion(hwnd, w, h, r) {
    ; Win10 没有 DWM 圆角，直接用窗口区域裁一个圆角矩形
    hrgn := DllCall('gdi32\CreateRoundRectRgn', 'int', 0, 'int', 0
        , 'int', w + 1, 'int', h + 1, 'int', r * 2, 'int', r * 2, 'ptr')
    if hrgn
        DllCall('user32\SetWindowRgn', 'ptr', hwnd, 'ptr', hrgn, 'int', 1)
}

InjectBootstrap() {
    ; 把 config.json 原文注入页面（AHK 不解析 JSON，只做原文转发）
    ; 使用「文档创建时执行」的脚本，先于页面自身 JS 运行
    global wv, SCRIPT_DIR, settings, ncDrag
    script := 'window.__BOOTSTRAP__={config:' ReadConfigText()
    script .= ',usage:' ReadUsageText()
    script .= ',scriptDir:' JsonQuote(SCRIPT_DIR)
    script .= ',appName:' JsonQuote('QuickLaunch')
    script .= ',nativeDrag:' (ncDrag ? '1' : '0')
    script .= ',window:{radius:' settings.radius ',width:' settings.width ',height:' settings.height '}};'
    wv.AddScriptToExecuteOnDocumentCreatedAsync(script).await()
}

ReadConfigText() {
    global CFG_PATH
    if !FileExist(CFG_PATH)
        return '{"items":[]}'
    try t := FileRead(CFG_PATH, 'UTF-8')
    catch
        return '{"items":[]}'
    t := Trim(t, ' `t`r`n')
    if (t = '' || !RegExMatch(t, '^[\{\[]'))
        return '{"items":[]}'
    return t
}

; 使用记录：页面要的就是一份 JSON 对象，直接原文塞进 bootstrap，
; 读不出来就给空对象（首次运行 / 文件被手改坏都不该让界面白屏）
ReadUsageText() {
    global USAGE_PATH
    if !FileExist(USAGE_PATH)
        return '{}'
    try t := FileRead(USAGE_PATH, 'UTF-8')
    catch
        return '{}'
    t := Trim(t, ' `t`r`n')
    ; 防御 BOM：某些编辑器/旧版本写出来的首字符是 U+FEFF，不剥掉就会判定成"不是 JSON 对象"
    if (SubStr(t, 1, 1) = Chr(0xFEFF))
        t := SubStr(t, 2)
    if (t = '' || SubStr(t, 1, 1) != '{' || StrLen(t) > 200000)
        return '{}'
    return t
}

; 前端把整份记录序列化好发过来，这里只做长度/前缀校验后落盘。
; 先写 .tmp 再改名：中途断电也不会留下半截 JSON（加载时会当成空记录）。
SaveUsage(raw) {
    global USAGE_PATH
    text := JsonStr(raw, 'json')
    if (text = '' || SubStr(Trim(text, ' `t`r`n'), 1, 1) != '{' || StrLen(text) > 200000)
        return
    tmp := USAGE_PATH '.tmp'
    try {
        ; UTF-8-RAW：不带 BOM。带 BOM 的话读回来首字符不是 '{'，
        ; 会被 ReadUsageText 当成坏文件 → 使用历史每次重启都清零（踩过）
        f := FileOpen(tmp, 'w', 'UTF-8-RAW')
        if !IsObject(f)
            return
        f.Write(text)
        f.Close()
        FileMove(tmp, USAGE_PATH, 1)
    }
}

; ============================================================================
;  目录补全：Tab 补路径时由前端按需查询
;  只回名字不拼路径（拼路径的规则在前端，避免两边各算一套）
; ============================================================================

DoFs(raw) {
    global SCRIPT_DIR
    id := JsonStr(raw, 'id')
    if (id = '')
        return

    d := JsonStr(raw, 'dir')
    if (d = '')
        d := SCRIPT_DIR
    ; 根目录（C:\）不能把反斜杠削掉，否则 "C:" 变成"该盘的当前目录"
    if (SubStr(d, -1) != ':\')
        d := RTrim(d, '\ /')

    ; \\server 这种"服务器根"在 Windows 里不是目录，DirExist 永远为假，
    ; 但用户在这里按 Tab 想看的正是共享名 —— 单独走 NetShareEnum。
    if RegExMatch(d, '^\\\\[^\\]+$') {
        sh := ListShares(d)
        if !IsObject(sh) {
            JsSend('{"type":"fs-result","id":' JsonQuote(id) ',"ok":0,"dir":' JsonQuote(d)
                . ',"err":' JsonQuote('连不上这台服务器：' d) ',"entries":[]}')
            return
        }
        s := ''
        for nm in sh
            s .= (s = '' ? '' : ',') '{"n":' JsonQuote(nm) ',"d":1}'
        JsSend('{"type":"fs-result","id":' JsonQuote(id) ',"ok":1,"dir":' JsonQuote(d)
            . ',"err":"","entries":[' s ']}')
        return
    }

    if (d = '' || !DirExist(d)) {
        err := (d = '') ? '先输入服务器名，例如 \\nas01\共享' : '目录不存在：' d
        JsSend('{"type":"fs-result","id":' JsonQuote(id) ',"ok":0,"dir":' JsonQuote(d)
            . ',"err":' JsonQuote(err) ',"entries":[]}')
        return
    }

    dirs := '', files := '', nd := 0, nf := 0
    pat := (SubStr(d, -1) = '\') ? d '*' : d '\*'
    Loop Files, pat, 'FD' {
        nm := A_LoopFileName
        isDir := InStr(A_LoopFileAttrib, 'D') ? 1 : 0
        if (isDir) {
            if (nd >= 80)
                continue
            dirs .= (nd ? ',' : '') '{"n":' JsonQuote(nm) ',"d":1}'
            nd++
        } else {
            if (nf >= 40)
                continue
            files .= (nf ? ',' : '') '{"n":' JsonQuote(nm) ',"d":0}'
            nf++
        }
    }
    all := (nd && nf) ? dirs ',' files : dirs files
    JsSend('{"type":"fs-result","id":' JsonQuote(id) ',"ok":1,"dir":' JsonQuote(d)
        . ',"err":"","entries":[' all ']}')
}

/* 列出 \\server 下的共享（NetShareEnum level 1）。失败返回 ''，成功返回共享名数组。
   用 NetShareEnum 而不是"浏览网络"：只查这一台，快且不会弹认证框。 */
ListShares(server) {
    buf := 0, nRead := 0, nTotal := 0
    r := DllCall('netapi32\NetShareEnum', 'wstr', server, 'uint', 1, 'ptr*', &buf
        , 'uint', -1, 'uint*', &nRead, 'uint*', &nTotal, 'ptr', 0, 'uint')
    if (r != 0 || !buf)
        return ''

    out := []
    ; SHARE_INFO_1：netname(ptr) type(uint) [pad] remark(ptr)，步长 A_PtrSize * 3
    Loop nRead {
        p := buf + (A_Index - 1) * A_PtrSize * 3
        nm := StrGet(NumGet(p, 0, 'ptr'), 'UTF-16')
        typ := NumGet(p, A_PtrSize, 'uint')
        ; 只要磁盘共享（STYPE_DISKTREE = 0；高位 STYPE_SPECIAL 的管理共享 C$ 也留着）
        if ((typ & 0xFFFF) = 0 && nm != '')
            out.Push(nm)
    }
    DllCall('netapi32\NetApiBufferFree', 'ptr', buf)
    return out
}

ShowLauncher() {
    global g, wv, wvc, uiReady, settings
    if !IsObject(g)
        return
    CenterWindow()
    g.Show()
    CenterWindow()              ; Show 之后再对齐，保证每次唤出都居中
    if settings.topmost
        WinSetAlwaysOnTop(1, 'ahk_id ' g.Hwnd)
    WinActivate('ahk_id ' g.Hwnd)
    ; 从隐藏状态回来时，重新对齐尺寸并确认可见，避免出现空白内容区
    Refill()
    SetTimer(Refill, -150)
    if (uiReady && wv)
        try wv.ExecuteScriptAsync('window.__onShow&&window.__onShow()')
}

HideLauncher() {
    global g
    if IsObject(g)
        g.Hide()
}

; ---------------------------- 托盘菜单 --------------------------------------
; 覆盖 AHK 默认托盘子菜单（那个只有 Pause / Suspend / Reload / Exit 的英文菜单）
SetupTray() {
    try TraySetIcon('shell32.dll', 44)          ; 用一个系统图标，避免显示成脚本图标

    m := A_TrayMenu
    m.Delete()                                  ; 清空默认项（Delete 不带参数 = 全删）
    m.Add('编辑配置', (*) => OpenConfig())
    m.Add('重载配置', (*) => DoReload())
    m.Add()                                     ; 分隔线
    m.Add('重启软件', (*) => RestartApp())
    m.Add()                                     ; 分隔线
    m.Add('退出软件', (*) => ExitApp())
}

RestartApp() {
    ; 起一个新实例，新实例带 --replace：它会等本进程退出、释放单例锁后接管。
    ; 不能再用 AHK 的 /restart —— 单例改成自己管之后，新进程会把自己当客户端
    ; 去投递请求，结果是"重启完什么也没发生"。
    global g
    if IsObject(g)
        try g.Hide()
    try Run((A_IsCompiled ? '' : '"' A_AhkPath '" ')
        . '"' A_ScriptFullPath '" --replace')
    catch {
        Reload()
        return
    }
    ExitApp()
}

ToggleLauncher() {
    global g
    if !IsObject(g)
        return
    if (DllCall('user32\IsWindowVisible', 'ptr', g.Hwnd) && WinActive('ahk_id ' g.Hwnd))
        HideLauncher()
    else
        ShowLauncher()
}

CenterWindow() {
    ; 居中到「鼠标所在显示器」的工作区
    global g, settings
    MouseGetPos(&mx, &my)
    hMon := DllCall('user32\MonitorFromPoint', 'int64', (my << 32) | (mx & 0xFFFFFFFF), 'uint', 2, 'ptr')
    mi := Buffer(40, 0)
    NumPut('uint', 40, mi, 0)
    left := 0, top := 0, right := A_ScreenWidth, bottom := A_ScreenHeight
    if (hMon && DllCall('user32\GetMonitorInfoW', 'ptr', hMon, 'ptr', mi)) {
        left   := NumGet(mi, 20, 'int'), top    := NumGet(mi, 24, 'int')
        right  := NumGet(mi, 28, 'int'), bottom := NumGet(mi, 32, 'int')
    }
    x := left + ((right - left) - settings.width) // 2
    y := top + ((bottom - top) - settings.height) // 2 - 40
    if (y < top)
        y := top
    g.Move(x, y, settings.width, settings.height)
}

; ---------------------------- 拖拽（无标题栏） ------------------------------
; 首选：WebView2 原生非客户区拖拽（Settings.IsNonClientRegionSupportEnabled + CSS
;       -webkit-app-region: drag）。窗口移动完全交给 Windows，平滑无闪烁。
; 兜底：运行时较老、开不了该设置时，才用「页面报开始/结束 + AHK 轮询鼠标」。
;
; 兜底路径的两个历史坑（都已修掉）：
;   ① AHK v2 的 SetTimer() 没有返回值，以前写 dragTimer := SetTimer(...) 恒为空串，
;      StopDrag() 里的 if dragTimer 永远是假 → 定时器停不掉，多个计时器互相拉扯，
;      窗口会左右晃动甚至瞬间飞出屏幕。
;   ② 用 Bind() 每次生成新的函数对象，SetTimer 会认为是不同的计时器，同样会残留。
; 现在固定用同一个函数 FollowMouseTick + 全局偏移量：SetTimer 幂等，绝不会叠加。
global dragOn := false
global dragOffX := 0
global dragOffY := 0

StartDrag() {
    global g, ncDrag, dragOn, dragOffX, dragOffY
    if (ncDrag || !IsObject(g))
        return                                  ; 原生拖拽由系统处理，无需干预
    MouseGetPos(&sx, &sy)
    WinGetPos(&wx, &wy, , , 'ahk_id ' g.Hwnd)
    dragOffX := sx - wx
    dragOffY := sy - wy
    dragOn := true
    SetTimer(FollowMouseTick, 15)
}

FollowMouseTick() {
    global g, dragOn, dragOffX, dragOffY
    if !dragOn
        return
    if !GetKeyState('LButton', 'P') {           ; 鼠标已松开 → 兜底结束拖拽
        StopDrag()
        return
    }
    if !IsObject(g)
        return
    MouseGetPos(&x, &y)
    try g.Move(x - dragOffX, y - dragOffY)
}

StopDrag() {
    global dragOn
    if !dragOn
        return
    dragOn := false
    SetTimer(FollowMouseTick, 0)
}

WM_ACTIVATE(wp, lp, msg, hwnd) {
    global g
    if (IsObject(g) && hwnd = g.Hwnd && wp = 0)
        SetTimer(HideIfInactive, -150)
}

WM_SIZE(wp, lp, msg, hwnd) {
    ; 窗口尺寸被系统改动时（最大化 / DPI 切换 / 程序改动）让 WebView2 重新贴合
    global g, wvc
    if (IsObject(g) && hwnd = g.Hwnd && wvc)
        try wvc.Fill()
}

HideIfInactive() {
    global g
    if (IsObject(g) && !WinActive('ahk_id ' g.Hwnd))
        HideLauncher()
}

; ============================================================================
;  全局热键
; ============================================================================

RegisterHotkey(hk) {
    if (hk = '')
        hk := '^!Space'
    try {
        Hotkey(hk, (*) => ToggleLauncher(), 'On')
    } catch as e {
        MsgBox('全局热键注册失败：' hk '`n' e.Message '`n`n已回退到 Ctrl+Alt+Space。', 'QuickLaunch', 'Icon!')
        try Hotkey('^!Space', (*) => ToggleLauncher(), 'On')
    }
}

; ============================================================================
;  JS -> AHK 消息
; ============================================================================

OnWebMessage(sender, args) {
    global wvc, uiReady
    raw := args.WebMessageAsJson
    type := JsonStr(raw, 'type')

    switch type {
        case 'ready':
            uiReady := true
            try wvc.Fill()
            /* 页面重载了：重载前投出去的调度请求不可能再有回执，先把 busy 放掉，
               否则那条任务会永远"上一次还没结束" */
            SchedReset('界面重载，上一次调度请求作废')
            FlushCli()                      ; 页面就绪后把攒着的命令行请求投进去
        /* 三个调度消息走同一个 try：排程代码出错绝不能把消息循环卡死。
           AHK 的异常在回调里会弹一个模态错误框，那个框会把整个脚本冻住 ——
           页面随后连 ready 都发不进来，表现出来就是"界面一直不初始化"。
           （第一版就是这么翻车的：对象字面量写成 t.Has('err')。） */
        case 'sched-begin', 'sched-task', 'sched-end':
            try {
                if (type = 'sched-begin')
                    SchedBegin()
                else if (type = 'sched-task')
                    SchedTask(raw)
                else
                    SchedEnd()
            } catch as e {
                SchedLog('-', 'bad', '内部错误：' CleanComError(e.Message))
            }
        case 'cli-result':
            CliReply(raw)
        case 'cli-applied':
            ; 查询已经填好了再显示窗口，避免先闪一帧完整列表
            if CliWantsWindow(JsonStr(raw, 'rid'))
                ShowLauncher()
        case 'hide':
            HideLauncher()
        case 'close':
            HideLauncher()                  ; ✕ 只隐藏，进程和全局热键继续活着
        case 'exit':
            ExitApp()                       ; 仅托盘菜单「退出软件」走这里
        case 'drag-start':
            StartDrag()
        case 'drag-end':
            StopDrag()
        case 'run':
            DoRun(raw)
        case 'http':
            DoWebhook(raw)
        case 'download':
            DoDownload(raw)
        case 'pull-config':
            DoPullConfig(raw)
        case 'reload':
            DoReload()
        case 'open-config':
            OpenConfig()
        case 'icons':
            DoIcons(raw)
        case 'usage-save':
            SaveUsage(raw)
        case 'fs':
            DoFs(raw)
        case 'log':
            FileAppend(JsonStr(raw, 'text') '`n', SCRIPT_DIR '\launcher.log', 'UTF-8')
    }
}

DoRun(raw) {
    global settings
    ; 带 cli 字段说明是命令行发起的：执行结果要回执给调用方，而且不能顺手把
    ; 用户要求显示着的窗口藏起来（--show 场景）
    rid := JsonStr(raw, 'cli')
    try {
        ; argv 是"本次运行"的参数（app/ahk 用 token 数组，逐个加引号）；
        ; argvRaw 是用户在参数区敲的原文（cmd 类型直接拼在命令行末尾）
        Launch(JsonStr(raw, 'kind'), JsonStr(raw, 'target'), JsonStr(raw, 'args')
            , JsonStr(raw, 'workdir'), JsonStrArray(raw, 'argv'), JsonStr(raw, 'argvRaw'))
        if (settings.hideAfterLaunch && rid = '')
            HideLauncher()
        if (rid != '')
            JsSend('{"type":"run-ack","rid":' JsonQuote(rid) ',"ok":1,"msg":""}')
    } catch as e {
        msg := CleanComError(e.Message)
        if (rid != '')
            JsSend('{"type":"run-ack","rid":' JsonQuote(rid) ',"ok":0,"msg":' JsonQuote(msg) '}')
        else
            Notify('启动失败：' msg)
    }
}

/* 每个 token 单独加引号 —— 参数里的空格、中文路径都不会把命令行拆散。
   不能简单包一层 '"' t '"'：Windows 的规则是"反斜杠只在引号前面特殊"，
   t 以 \ 结尾时末尾的 \" 会被解析成一个字面引号，参数连同后面的引号一起吃掉。
   UNC 目录（\\nas\share\）几乎都以反斜杠结尾，所以这里是必踩的坑：
       QuoteArgv(['\\nas\share\'])  ->  "\\nas\share\"  ->  exe 收到 \\nas\share"
   正确做法：反斜杠要翻倍，引号本身写成 \"（MS 文档 "Parsing C++ command-line arguments"）。 */
QuoteArgv(tokens) {
    s := ''
    for t in tokens
        s .= ' ' QuoteArgv1(t)
    return s
}

QuoteArgv1(t) {
    q := Chr(34), bs := Chr(92)
    t := String(t)
    if (t = '')
        return q q
    ; 既没有空白也没有引号 → 不用加引号，反斜杠也就没有歧义（尾随反斜杠也无所谓）
    if !InStr(t, q) && !RegExMatch(t, '\s')
        return t

    out := '', n := 0, i := 1, len := StrLen(t)
    while (i <= len) {
        c := SubStr(t, i, 1)
        if (c = bs) {
            n++                       ; 反斜杠先攒着，看后面跟什么
            i++
            continue
        }
        if (c = q)
            out .= Pad(bs, 2 * n) . bs . q      ; 2n 个 \ + \" → 一个字面引号
        else
            out .= Pad(bs, n) . c
        n := 0
        i++
    }
    ; 收尾的反斜杠要翻倍，否则紧挨着闭合引号又会被当成转义
    out .= Pad(bs, 2 * n)
    return q . out . q
}

Pad(ch, n) {
    s := ''
    Loop n
        s .= ch
    return s
}

Launch(kind, target, args, workdir, argv := [], argvRaw := '') {
    global SCRIPT_DIR
    if (target = '')
        throw Error('目标为空')
    if (workdir = '')
        workdir := SCRIPT_DIR

    extra := (argv.Length ? QuoteArgv(argv) : '')

    switch kind {
        case 'url':
            Run(target)
        case 'folder':
            Run('explorer.exe "' target '"')
        case 'cmd':
            ; target 是"一整条命令行"（如 ipconfig /all），不能当路径改写。
            ; 外面包一层引号并用 /s：cmd 只剥掉首尾两个引号，命令里自带的引号
            ; （带空格的 exe 路径、重定向文件名）能原样保留。
            ; 运行时参数按用户原文追加 —— cmd 自己会解析引号和重定向。
            line := target . (argvRaw != '' ? ' ' argvRaw : '')
            ; cmd.exe 不认 UNC 工作目录（会退回 C:\Windows 再执行，等于在错的地方跑），
            ; 用 pushd 先把共享映射成临时盘再进去。
            if IsUncPath(workdir) {
                Run(A_ComSpec ' /s /k "pushd "' workdir '" && ' line '"')
                return
            }
            Run(A_ComSpec ' /s /k "' line '"', workdir)
        case 'ahk':
            Run('"' AhkInterp() '" "' target '"' (args != '' ? ' ' args : '') extra, workdir)
        case 'webhook':
            throw Error('webhook 类型由前端直接发请求，不应走到 Launch')
        default:                                  ; app
            if RegExMatch(target, '^(shell:|ms-|https?:|mailto:)') {
                Run(target)
                return
            }
            ; 相对路径：先按原样找，再按脚本目录兜一次
            if !FileExist(target) && FileExist(SCRIPT_DIR '\' target)
                target := SCRIPT_DIR '\' target
            ; 带分隔符却找不到 → 真错；裸命令名（notepad.exe）放行，交给 PATH
            if !FileExist(target) && InStr(target, '\')
                throw Error('文件不存在：' target)
            ; 批处理是 cmd 跑的，同样吃不了 UNC 工作目录：改由 cmd 自己 pushd 过去
            if IsUncPath(workdir) && RegExMatch(target, 'i)\.(bat|cmd)$') {
                line := 'pushd "' workdir '" && "' target '"' (args != '' ? ' ' args : '') extra
                Run(A_ComSpec ' /s /c "' line '"')
                return
            }
            Run('"' target '"' (args != '' ? ' ' args : '') extra, workdir)
    }
}

/* UNC 共享路径（\\server\share）—— \\?\ 长路径前缀不算 */
IsUncPath(p) {
    if (SubStr(p, 1, 2) != '\\')
        return false
    return (SubStr(p, 1, 4) != '\\?\')
}

DoReload() {
    global wv
    cfgText := ReadConfigText()
    if (wv && uiReady) {
        wv.ExecuteScriptAsync('window.__applyConfig&&window.__applyConfig(' cfgText ')')
        Notify('配置已重新加载')
    }
}

; ============================================================================
;  Webhook：请求交给子进程跑，主进程只轮询结果
;  ---------------------------------------------------------------------------
;  WinHttp 是同步的，直接在脚本线程里调会冻住整个窗口（超时 10 秒就是 10 秒假死）。
;  所以：主进程写 spec.ini -> 起 webhook.ahk 子进程 -> 定时看 meta.ini 是否出现。
; ============================================================================

DoWebhook(raw) {
    global HTTP_DIR, SCRIPT_DIR, httpJobs

    id := JsonStr(raw, 'id')
    url := JsonStr(raw, 'url')
    if (url = '') {
        Notify('webhook 没有配置请求地址')
        return
    }
    if (id = '')
        id := 'r' A_TickCount

    method := JsonStr(raw, 'method')
    if (method = '')
        method := 'GET'
    timeout := JsonNum(raw, 'timeout', 15)
    timeout := (timeout > 0) ? Min(timeout, 120) : 15

    dir := HTTP_DIR '\' id
    try DirCreate(dir)
    ; 上一次的产物必须先清掉，否则轮询会立刻读到旧结果
    for f in ['meta.ini', 'body.txt', 'spec.ini', 'h.txt', 'b.txt']
        try FileDelete(dir '\' f)

    ; 请求头由前端给成 "Name: Value" 的字符串数组 —— 避免在这里解析嵌套 JSON。
    ; 每行过一次 HdrExpand：{{#ts}} / {{#hmac:...}} 这类动态值只在这里展开，
    ; 展开失败（比如密钥名写错）直接拒发 —— 带着错签名发出去比不发更糟。
    hs := ''
    try {
        for h in JsonStrArray(raw, 'headers')
            hs .= HdrExpand(h) '`n'
    } catch as e {
        try DirDelete(dir, true)
        JsSend('{"type":"http-result","id":' JsonQuote(id) ',"ok":0,"status":0,"ms":0'
            ',"truncated":0,"error":' JsonQuote('请求头展开失败：' e.Message) ',"body":""}')
        return
    }
    try FileAppend(hs, dir '\h.txt', 'UTF-8-RAW')

    body := JsonStr(raw, 'body')
    try FileAppend(body, dir '\b.txt', 'UTF-8-RAW')

    spec := dir '\spec.ini'
    IniWrite(method, spec, 'req', 'Method')
    IniWrite(url, spec, 'req', 'Url')
    IniWrite(timeout, spec, 'req', 'Timeout')
    IniWrite(dir '\h.txt', spec, 'req', 'HeadersFile')
    IniWrite(dir '\b.txt', spec, 'req', 'BodyFile')
    IniWrite(dir, spec, 'req', 'OutDir')

    pid := 0
    try {
        Run('"' AhkInterp() '" /ErrorStdOut "' SCRIPT_DIR '\webhook.ahk" "' spec '"'
            , SCRIPT_DIR, 'Hide', &pid)
    } catch as e {
        JsSend('{"type":"http-result","id":' JsonQuote(id) ',"ok":0,"status":0,"ms":0'
            ',"truncated":0,"error":' JsonQuote('无法启动请求进程：' e.Message) ',"body":""}')
        return
    }

    httpJobs[id] := {dir: dir, pid: pid, timeout: timeout, kind: 'http', reload: false, purpose: ''
        , deadline: A_TickCount + (timeout + 1) * 1000}
    SetTimer(CheckHttp, 120)          ; SetTimer 幂等，重复调用只是重置间隔
}

CheckHttp() {
    global httpJobs, HTTP_MAX_BODY, CFG_PATH
    for id, job in httpJobs.Clone() {
        metaPath := job.dir '\meta.ini'
        err := ''

        if FileExist(metaPath) {
            ; 子进程先写 body 再写 meta，看到 meta 说明整套产物都齐了
        } else if !ProcessExist(job.pid) {
            err := '请求进程异常退出（webhook.ahk 可能报错，检查一下语法）'
        } else if (A_TickCount > job.deadline) {
            try ProcessClose(job.pid)
            err := '请求超时（超过 ' job.timeout ' 秒）'
        } else {
            continue
        }

        status := 0, ms := 0, body := ''
        if FileExist(metaPath) {
            sTxt := IniRead(metaPath, 'resp', 'Status', '0')
            mTxt := IniRead(metaPath, 'resp', 'Ms', '0')
            status := IsNumber(sTxt) ? Integer(sTxt) : 0
            ms := IsNumber(mTxt) ? Integer(mTxt) : 0
            mErr := IniRead(metaPath, 'resp', 'Error', '')
            if (mErr != '' && err = '')
                err := mErr
            bodyPath := job.dir '\body.txt'
            if FileExist(bodyPath)
                try body := FileRead(bodyPath, 'UTF-8')
        }

        if (job.kind = 'download') {
            dlFile := '', dlName := '', dlSize := 0, skipped := 0, bakFile := ''
            if FileExist(metaPath) {
                dlFile := IniRead(metaPath, 'dl', 'File', '')
                dlName := IniRead(metaPath, 'dl', 'Name', '')
                bakFile := IniRead(metaPath, 'dl', 'Backup', '')
                v := IniRead(metaPath, 'dl', 'Size', '0')
                dlSize := IsNumber(v) ? Integer(v) : 0
                v := IniRead(metaPath, 'dl', 'Skipped', '0')
                skipped := (IsNumber(v) && Integer(v) = 1) ? 1 : 0
            }

            if (err = '') {
                if (job.purpose = 'pull-config') {
                    ; 下载到的只是临时文件：校验通过才覆盖本地，并保留 .bak
                    r := InstallConfig(dlFile)
                    if (r.err != '') {
                        err := r.err
                    } else {
                        dlFile := CFG_PATH
                        bakFile := r.backup
                        DoReload()
                    }
                } else if job.reload {
                    DoReload()
                }
            }

            JsSend('{"type":"download-result","id":' JsonQuote(id)
                . ',"ok":' (err = '' ? 1 : 0)
                . ',"status":' status
                . ',"ms":' ms
                . ',"error":' JsonQuote(err)
                . ',"file":' JsonQuote(dlFile)
                . ',"name":' JsonQuote(dlName)
                . ',"size":' dlSize
                . ',"skipped":' skipped
                . ',"backup":' JsonQuote(bakFile)
                . ',"purpose":' JsonQuote(job.purpose) '}')
        } else {
            truncated := 0
            if (StrLen(body) > HTTP_MAX_BODY) {
                body := SubStr(body, 1, HTTP_MAX_BODY)
                truncated := 1
            }

            try {
                JsSend('{"type":"http-result","id":' JsonQuote(id)
                    . ',"ok":' (err = '' ? 1 : 0)
                    . ',"status":' status
                    . ',"ms":' ms
                    . ',"truncated":' truncated
                    . ',"error":' JsonQuote(err)
                    . ',"body":' JsonQuote(body) '}')
            }
        }

        ; 请求载荷（请求头/请求体/spec）用完就删，响应留在原处方便排查
        for f in ['h.txt', 'b.txt', 'spec.ini']
            try FileDelete(job.dir '\' f)
        httpJobs.Delete(id)
    }
    if !httpJobs.Count
        SetTimer(CheckHttp, 0)
}

; ============================================================================
;  Download：webhook 的变种，差别只在"响应体去哪"
;  ---------------------------------------------------------------------------
;  和 DoWebhook 共用同一套骨架：写 spec.ini -> 起 webhook.ahk 子进程 -> 轮询结果。
;  多出来的只有 [dl] 段，子进程据此把 ResponseBody 按二进制写进文件。
;  有意保持最小：一次性进内存，不做断点续传、校验和、分片。
; ============================================================================

DoDownload(raw) {
    StartDownload({
        id:       JsonStr(raw, 'id'),
        url:      JsonStr(raw, 'url'),
        saveDir:  JsonStr(raw, 'savePath'),
        name:     JsonStr(raw, 'fileName'),
        timeout:  JsonNum(raw, 'timeout', 15),
        onExists: JsonStr(raw, 'onExists'),
        backup:   JsonNum(raw, 'backup', 1) ? true : false,
        reload:   JsonNum(raw, 'reload', 0) ? true : false,
        headers:  JsonStrArray(raw, 'headers'),
        purpose:  ''
    })
}

/* 界面底部「拉取在线配置」：下到临时目录 -> 校验 -> 备份 -> 覆盖 config.json -> 重载 */
DoPullConfig(raw) {
    global PULL_DIR
    url := Trim(JsonStr(raw, 'url'), ' `t')
    if (url = '') {
        Notify('请先填写网址')
        return
    }
    ; 用户直接粘 example.com/x.json 也能用，不用纠结协议头
    if !RegExMatch(url, 'i)^https?://')
        url := 'https://' url

    try DirCreate(PULL_DIR)
    ; 上一次的残留必须先清掉：否则这次下载失败时会拿旧文件去覆盖配置
    for f in ['config.json', 'config.json.part', 'config.json.bak']
        try FileDelete(PULL_DIR '\' f)

    StartDownload({
        id:       'pull-' A_TickCount,
        url:      url,
        saveDir:  PULL_DIR,
        name:     'config.json',
        timeout:  JsonNum(raw, 'timeout', 20),
        onExists: 'overwrite',
        backup:   0,                 ; 备份交给 InstallConfig（要备到 config.json 旁边，不是临时目录）
        reload:   false,
        purpose:  'pull-config'
    })
}

StartDownload(cfg) {
    global HTTP_DIR, SCRIPT_DIR, httpJobs

    if (cfg.url = '') {
        Notify('download 没有配置下载地址')
        return
    }
    id := cfg.id != '' ? cfg.id : 'd' A_TickCount
    timeout := (cfg.timeout > 0) ? Min(cfg.timeout, 120) : 15

    saveDir := Trim(cfg.saveDir, ' `t')
    if (saveDir = '') {
        saveDir := EnvGet('USERPROFILE') '\Downloads'      ; 没写保存路径 → 系统「下载」目录
    } else {
        saveDir := ExpandEnvVars(saveDir)
        if !IsAbsPath(saveDir)
            saveDir := SCRIPT_DIR '\' saveDir              ; 相对路径按脚本目录
    }
    saveDir := RTrim(saveDir, '\/')

    if !DirExist(saveDir) {
        try DirCreate(saveDir)                             ; 多级目录一起建
        if !DirExist(saveDir) {
            SendDownloadError(id, cfg.purpose, '保存目录无法创建：' saveDir)
            return
        }
    }

    dir := HTTP_DIR '\' id
    try DirCreate(dir)
    for f in ['meta.ini', 'body.txt', 'spec.ini', 'h.txt', 'b.txt']
        try FileDelete(dir '\' f)

    ; download 只发 GET、不带请求体；请求头照传（内网下载常要带 token）
    hs := ''
    try {
        if cfg.HasOwnProp('headers')
            for h in cfg.headers
                hs .= HdrExpand(h) '`n'
    } catch as e {
        try DirDelete(dir, true)
        SendDownloadError(id, cfg.purpose, '请求头展开失败：' e.Message)
        return
    }
    try FileAppend(hs, dir '\h.txt', 'UTF-8-RAW')
    try FileAppend('', dir '\b.txt', 'UTF-8-RAW')

    spec := dir '\spec.ini'
    IniWrite('download', spec, 'req', 'Mode')
    IniWrite('GET', spec, 'req', 'Method')
    IniWrite(cfg.url, spec, 'req', 'Url')
    IniWrite(timeout, spec, 'req', 'Timeout')
    IniWrite(dir '\h.txt', spec, 'req', 'HeadersFile')
    IniWrite(dir '\b.txt', spec, 'req', 'BodyFile')
    IniWrite(dir, spec, 'req', 'OutDir')
    IniWrite(saveDir, spec, 'dl', 'SaveDir')
    IniWrite(cfg.name, spec, 'dl', 'SaveName')
    IniWrite(cfg.onExists = 'overwrite' ? 'overwrite' : 'skip', spec, 'dl', 'OnExists')
    IniWrite(cfg.backup ? 1 : 0, spec, 'dl', 'Backup')

    pid := 0
    try {
        Run('"' AhkInterp() '" /ErrorStdOut "' SCRIPT_DIR '\webhook.ahk" "' spec '"'
            , SCRIPT_DIR, 'Hide', &pid)
    } catch as e {
        SendDownloadError(id, cfg.purpose, '无法启动下载进程：' e.Message)
        return
    }

    httpJobs[id] := {dir: dir, pid: pid, timeout: timeout, kind: 'download'
        , reload: cfg.reload, purpose: cfg.purpose
        , deadline: A_TickCount + (timeout + 1) * 1000}
    SetTimer(CheckHttp, 120)
}

SendDownloadError(id, purpose, msg) {
    JsSend('{"type":"download-result","id":' JsonQuote(id) ',"ok":0,"status":0,"ms":0'
        . ',"error":' JsonQuote(msg) ',"file":"","name":"","size":0'
        . ',"skipped":0,"backup":"","purpose":' JsonQuote(purpose) '}')
}

/* 用下载到的文件替换本地 config.json。
   校验只做一件事：首字符必须是 { 或 [ —— 足以挡住 302 到登录页、404 的 HTML 这类
   "看着成功其实是错误页"的情况。真正的结构问题由前端 applyConfig 兜底。 */
InstallConfig(src) {
    global CFG_PATH
    if (src = '' || !FileExist(src))
        return { err: '下载到的文件不见了（临时目录可能被清理）', backup: '' }

    try t := Trim(FileRead(src, 'UTF-8'), ' `t`r`n')
    catch
        return { err: '读不到下载到的文件', backup: '' }

    if (SubStr(t, 1, 1) != '{' && SubStr(t, 1, 1) != '[')
        return { err: '下载到的内容不是 JSON（多半是错误页或登录页），本地配置未改动', backup: '' }

    bak := CFG_PATH '.bak'
    try FileDelete(bak)
    if FileExist(CFG_PATH) {
        try FileCopy(CFG_PATH, bak, 1)
        catch
            bak := ''
    }

    try FileMove(src, CFG_PATH, 1)
    catch {
        ; 临时目录和脚本目录不在同一个盘时 FileMove 会失败，退回复制
        try {
            FileCopy(src, CFG_PATH, 1)
            FileDelete(src)
        } catch as e {
            return { err: '覆盖配置失败：' CleanComError(e.Message), backup: '' }
        }
    }

    return { err: '', backup: (bak != '' && FileExist(bak)) ? bak : '' }
}

/* 展开 %USERPROFILE% 这类环境变量：配置里写 %TEMP% 比写死用户名可移植 */
ExpandEnvVars(p) {
    Loop 10 {                             ; 防御：变量值里再套变量也不至于打转
        if !RegExMatch(p, '%([^%]+)%', &m)
            break
        v := EnvGet(m[1])
        if (v = '')
            break                         ; 未知变量原样留着，用户一眼能看到
        p := StrReplace(p, m[0], v)
    }
    return p
}

IsAbsPath(p) {
    if RegExMatch(p, '^[a-zA-Z]:[\\/]')
        return true
    return (SubStr(p, 1, 2) = '\\' || SubStr(p, 1, 2) = '//')
}

OpenConfig() {
    global CFG_PATH
    if !FileExist(CFG_PATH) {
        Notify('找不到 config.json')
        return
    }
    try Run('"' CFG_PATH '"')
    catch
        Run('notepad.exe "' CFG_PATH '"')
}

; ============================================================================
;  图标：从 exe 提取 HICON -> GDI+ 转 PNG -> 前端用 file:// 加载
; ============================================================================

DoIcons(raw) {
    paths := JsonStrArray(raw, 'paths')
    s := ''
    for p in paths {
        try {
            png := IconForExe(p)
            if (png != '')
                s .= (s = '' ? '' : ',') JsonQuote(p) ':' JsonQuote(ToFileUrl(png))
        }
    }
    JsSend('{"type":"icons","map":{' s '}}')
}

IconForExe(exePath) {
    global ICON_DIR
    if (exePath = '' || !FileExist(exePath))
        return ''

    ; 缓存文件名 = (路径 + 修改时间) 的 32 位哈希
    key := exePath '|' FileGetTime(exePath, 'M')
    h := 2166136261
    Loop Parse, key
        h := ((h ^ Ord(A_LoopField)) * 16777619) & 0xFFFFFFFF
    DirCreate(ICON_DIR)
    out := ICON_DIR '\' Format('{:08x}', h) '.png'
    if FileExist(out)
        return out

    if !EnsureGdip()
        return ''

    ; 1) 取出 exe 的图标句柄
    shfi := Buffer(1024, 0)
    DllCall('shell32\SHGetFileInfoW', 'wstr', exePath, 'uint', 0, 'ptr', shfi
        , 'uint', shfi.Size, 'uint', 0x100)                     ; SHGFI_ICON
    hIcon := NumGet(shfi, 0, 'ptr')
    if !hIcon
        return ''

    ; 2) HICON -> GDI+ Bitmap -> PNG
    png := ''
    pBitmap := 0
    if !DllCall('gdiplus\GdipCreateBitmapFromHICON', 'ptr', hIcon, 'ptr*', &pBitmap) && pBitmap {
        clsid := Buffer(16, 0)
        DllCall('ole32\CLSIDFromString', 'wstr', '{557CF406-1A04-11D3-9A73-0000F81EF32E}', 'ptr', clsid)
        if !DllCall('gdiplus\GdipSaveImageToFile', 'ptr', pBitmap, 'wstr', out, 'ptr', clsid, 'ptr', 0)
            png := out
        DllCall('gdiplus\GdipDisposeImage', 'ptr', pBitmap)
    }
    DllCall('user32\DestroyIcon', 'ptr', hIcon)
    return png
}

EnsureGdip() {
    ; GDI+ 只在进程内初始化一次：反复 Startup/Shutdown 会导致进程崩溃
    static ok := 0
    if (ok != 0)
        return ok > 0
    si := Buffer(24, 0)
    NumPut('uint', 1, si, 0)                                    ; GdiplusVersion = 1
    token := 0
    st := DllCall('gdiplus\GdiplusStartup', 'ptr*', &token, 'ptr', si, 'ptr', 0)
    ok := (st = 0 && token) ? 1 : -1
    return ok > 0
}

ToFileUrl(p) {
    return 'file:///' StrReplace(StrReplace(p, '\', '/'), ' ', '%20')
}

; ============================================================================
;  AHK -> JS
; ============================================================================

JsSend(json) {
    global wv, uiReady
    if (uiReady && wv)
        try wv.PostWebMessageAsJson(json)
}

Notify(text) {
    JsSend('{"type":"toast","text":' JsonQuote(text) '}')
}

; ============================================================================
;  极简 JSON 工具（只处理扁平字段，够本工具用）
; ============================================================================

JsonQuote(s) {
    s := StrReplace(s, '\', '\\')
    s := StrReplace(s, '"', '\"')
    s := StrReplace(s, "`n", '\n')
    s := StrReplace(s, "`r", '\r')
    s := StrReplace(s, "`t", '\t')
    ; 剩下的控制字符（0x00-0x1F）必须转成 \u00XX：
    ; 否则 PostWebMessageAsJson 会因为"不是合法 JSON"整个消息被丢掉（响应体里带 BEL/ESC 就会中招）
    if RegExMatch(s, '[\x00-\x1f]') {
        out := ''
        Loop Parse, s
            out .= (Ord(A_LoopField) < 0x20) ? Format('\u{:04x}', Ord(A_LoopField)) : A_LoopField
        s := out
    }
    return '"' s '"'
}

JsonStr(text, key) {
    if RegExMatch(text, '"' key '"\s*:\s*"((?:\\u[0-9a-fA-F]{4}|\\.|[^"\\])*)"', &m)
        return JsonUnescape(m[1])
    return ''
}

; 数字/布尔字段：前端 postMessage 过来的是真正的 JSON 数字（不是字符串），
; 用 JsonStr 取不到，必须单独匹配一次
JsonNum(text, key, def := 0) {
    if RegExMatch(text, '"' key '"\s*:\s*(-?\d+(?:\.\d+)?)', &m)
        return Number(m[1])
    if RegExMatch(text, '"' key '"\s*:\s*"(-?\d+(?:\.\d+)?)"', &m)   ; 兼容写成字符串的情况
        return Number(m[1])
    return def
}

JsonStrArray(text, key) {
    out := []
    ; 只认"由字符串元素组成"的数组：老写法 \[(.*?)\] 遇到参数里带 ] 会提前截断
    if !RegExMatch(text
        , '"' key '"\s*:\s*\[((?:\s*"(?:\\u[0-9a-fA-F]{4}|\\.|[^"\\])*"\s*,?)*)\s*\]', &arr)
        return out
    pos := 1
    while RegExMatch(arr[1], '"((?:\\u[0-9a-fA-F]{4}|\\.|[^"\\])*)"', &s, pos) {
        out.Push(JsonUnescape(s[1]))
        pos := s.Pos + s.Len
    }
    return out
}

JsonUnescape(s) {
    if !InStr(s, '\')
        return s
    out := '', i := 1, n := StrLen(s)
    while (i <= n) {
        c := SubStr(s, i, 1)
        if (c != '\') {
            out .= c
            i++
            continue
        }
        i++
        d := SubStr(s, i, 1)
        if (d = 'n')
            out .= "`n"
        else if (d = 'r')
            out .= "`r"
        else if (d = 't')
            out .= "`t"
        else if (d = 'b')
            out .= Chr(8)
        else if (d = 'f')
            out .= Chr(12)
        else if (d = 'u' && RegExMatch(SubStr(s, i + 1, 4), '^[0-9a-fA-F]{4}$')) {
            out .= Chr(Integer('0x' SubStr(s, i + 1, 4)))
            i += 4
        } else
            out .= d
        i++
    }
    return out
}

/* AHK 的 COM 异常 Message 后面会挂 "Source: ... Description: ..."，只留前半句人话 */
CleanComError(msg) {
    p := InStr(msg, 'Source:')
    if p
        msg := SubStr(msg, 1, p - 1)
    return Trim(StrReplace(StrReplace(msg, "`r", ' '), "`n", ' '))
}

; ============================================================================
;  命令行接口（A_Args）+ 单实例
;  ---------------------------------------------------------------------------
;  两个角色：
;    实例   —— 拿到单例锁、跑着 WebView2 的那个进程，负责收请求；
;    客户端 —— 锁被占用时启动的进程，只解析参数、投递、按需等回执，约 100ms 退场。
;
;  执行一律交给页面里的 JS：评分、参数分配、模板替换、URL 拼装、启动全在 JS 里，
;  AHK 侧重写一遍就是两套会漂移的实现。所以命令行做的事只有"把意图翻译成一条
;  __cli() 调用"。
;
;  通信走 WM_COPYDATA（0x004A）：收件箱是一个隐藏的小 Gui，标题里带脚本目录的
;  哈希，翻遍全机也不会撞名。载荷是 UTF-8 的 JSON。
;  ⚠ 收件箱的消息处理必须"只入队、立刻返回"：SendMessage 是同步的，handler 里
;    只要做一点耗时的事，发起方就跟着一起卡（实测 Timeout 参数对此不生效）。
; ============================================================================

AcquireInstance(waitMs) {
    ; 命名互斥体：CreateMutex 的 LAST_ERROR 是 183（ERROR_ALREADY_EXISTS）就说明
    ; 已经有人持锁。拿不到时要把刚打开的句柄关掉，否则我们自己会把这个互斥体
    ; "续命"，旧进程退出后新进程永远等不到它消失。
    global MUTEX_NAME, mutexHandle
    deadline := A_TickCount + waitMs
    loop {
        h := DllCall('kernel32\CreateMutexW', 'ptr', 0, 'int', 0, 'wstr', MUTEX_NAME, 'ptr')
        err := A_LastError
        if (h) {
            if (err != 183) {
                mutexHandle := h
                return true
            }
            DllCall('kernel32\CloseHandle', 'ptr', h)
        }
        if (A_TickCount > deadline)
            return false
        Sleep 60
    }
}

CreateInbox() {
    global ipcGui, IPC_TITLE
    ; 摆到屏幕外"显示"着：隐藏窗口一样能收 SendMessage，但可见窗口在排查时
    ; 更容易被 WinExist/Spy 找到，行为也跟普通窗口一致
    ipcGui := Gui('-Caption +ToolWindow -DPIScale', IPC_TITLE)
    ipcGui.Show('x-32000 y-32000 w1 h1 NA')
    OnMessage(0x004A, OnCopyData)
}

OnCopyData(wp, lp, msg, hwnd) {
    global ipcGui
    if (ipcGui && hwnd != ipcGui.Hwnd)
        return
    if !lp
        return 1
    size := NumGet(lp, A_PtrSize, 'uint')
    ptr := NumGet(lp, A_PtrSize * 2, 'ptr')
    if (size < 2 || size > 65536 || !ptr)
        return 1
    text := StrGet(ptr, size, 'UTF-8')
    ; 任何进程都能往这里塞消息，先做最低限度的形状校验
    if (SubStr(text, 1, 1) != '{' || JsonStr(text, 'type') != 'cli')
        return 1
    QueueReq(text)
    return 1                                   ; 回一个 1 表示"收到了"
}

SendCopyData(hwnd, text) {
    ; COPYDATASTRUCT { ULONG_PTR dwData; DWORD cbData; PVOID lpData; }
    ; x64 上 cbData 后面有 4 字节填充，所以按 A_PtrSize*3 申请、按偏移取字段
    data := Buffer(StrPut(text, 'UTF-8'), 0)
    StrPut(text, data, 'UTF-8')
    cds := Buffer(A_PtrSize * 3, 0)
    NumPut('ptr', 0, cds, 0)
    NumPut('uint', data.Size, cds, A_PtrSize)
    NumPut('ptr', data.Ptr, cds, A_PtrSize * 2)
    try {
        r := SendMessage(0x004A, A_ScriptHwnd, cds.Ptr, , 'ahk_id ' hwnd, , , 3000)
        return (r = 1)
    }
    return false
}

WaitInbox(ms) {
    global IPC_TITLE
    prev := A_DetectHiddenWindows
    DetectHiddenWindows(true)                  ; 收件箱本身是"屏幕外显示"的，这里只是保险
    h := 0
    deadline := A_TickCount + ms
    loop {
        h := WinExist(IPC_TITLE)
        if (h || A_TickCount > deadline)
            break
        Sleep 50
    }
    DetectHiddenWindows(prev)
    return h
}

; ---------------------------------------------------------------- 参数解析

/* 命令行语法：
     ql                      → 打开/唤醒
     ql <查询>               → 打开并预填（语法同搜索框：>命令 @分组 拼音）
     ql search <查询>        → 显式写法
     ql list <查询>          → 列出候选
     ql run <条目> [选项]     → 直接执行
   子命令只认第一个参数，所以搜 "run" 用 `ql search run` 或 `ql -- run`。 */
CliParse(argv) {
    a := {mode: '', q: '', args: '', hasArgs: false, show: false, hide: false
        , wait: false, json: false, first: false, ephemeral: false, timeout: 30000
        , replace: false, help: false, err: ''}

    n := IsObject(argv) ? argv.Length : 0
    i := 1

    if (n >= 1) {
        s := StrLower(argv[1])
        if (s = 'run' || s = 'search' || s = 'list') {
            a.mode := s
            i := 2
        }
    }

    pos := [], rawParts := [], isRaw := false
    while (i <= n) {
        t := argv[i]
        if (isRaw) {
            rawParts.Push(t)
        } else if (t = '--') {
            isRaw := true
        } else if (RegExMatch(t, 'i)^--args=(.*)$', &m)) {
            a.args := m[1], a.hasArgs := true
        } else if (t = '--args' || t = '-a') {
            if (i >= n) {
                a.err := '--args 后面要跟参数内容'
                return a
            }
            i++
            a.args := argv[i], a.hasArgs := true
        } else if (RegExMatch(t, 'i)^--timeout=(\d+)$', &m)) {
            a.timeout := Integer(m[1])
        } else if (t = '--timeout') {
            if (i >= n) {
                a.err := '--timeout 后面要跟毫秒数'
                return a
            }
            i++
            a.timeout := Integer(argv[i])
        } else if (t = '--show') {
            a.show := true
        } else if (t = '--hide' || t = '--no-show') {
            a.show := false
            a.hide := true
        } else if (t = '--wait') {
            a.wait := true
        } else if (t = '--json') {
            a.json := true
        } else if (t = '--first') {
            a.first := true
        } else if (t = '--ephemeral') {
            a.ephemeral := true
        } else if (t = '--replace') {
            a.replace := true
        } else if (t = '--help' || t = '-h' || t = '/?' || t = '-?') {
            a.help := true
            return a
        } else if (SubStr(t, 1, 2) = '--') {
            a.err := '不认识的选项：' t
            return a
        } else {
            pos.Push(t)
        }
        i++
    }

    if (a.mode = '')
        a.mode := pos.Length ? 'search' : 'none'

    a.q := PosJoin(pos)

    /* `--` 后面的原文：run 模式下是运行时参数（原样拼给程序，不切分引号）；
       其它模式下并回查询串，这样 `ql -- run` 就是搜 "run" */
    if (rawParts.Length) {
        r := RawJoin(rawParts)
        if (a.mode = 'run')
            a.args := r, a.hasArgs := true
        else
            a.q := (a.q = '' ? r : a.q ' ' r)
    }

    if (a.mode = 'run' && a.q = '')
        a.err := 'run 后面要跟条目 id 或关键词'
    if (a.mode = 'list')
        a.wait := true                          ; 要拿结果回来，必然得等
    a.timeout := Max(1000, Min(a.timeout, 600000))
    return a
}

PosJoin(list) {
    s := ''
    for v in list
        s .= (s = '' ? '' : ' ') v
    return s
}

RawJoin(list) {
    /* 和 PosJoin 的区别：带空白的 token 要重新套上引号。
       cmd 交过来的 A_Args 已经把引号剥掉了，`-- "x y"` 会被拆成一个元素 'x y'，
       直接空格拼回去就变成两个参数了 —— 这里把'组'的边界补回来。 */
    s := ''
    for v in list {
        if (v = '' || RegExMatch(v, '\s'))
            v := '"' v '"'
        s .= (s = '' ? '' : ' ') v
    }
    return s
}

/* ------------------------------------------------------------------ 输出
   为什么不直接用 FileAppend(text, '*')：那玩意儿在真控制台里会翻车。
   实测（真 cmd 窗口）：FileAppend 抛「(6) 句柄无效」或者写进去的字节不被渲染，
   而外面套着 try，错误被吞掉 —— 表现就是命令跑完了、窗口一个字都没打印。
   管道里却一切正常，所以以前那些自动化测试永远测不出来。

   这里自己拿句柄写：
     · 控制台（FILE_TYPE_CHAR）→ 按 GetConsoleOutputCP 转成该代码页的字节，
       换行用 CRLF（控制台只给 LF 有些环境不换行）；
     · 管道 / 重定向（其他类型）→ UTF-8，换行只用 LF（和既有测试的期望一致）。 */
StdStream(toErr := false) {
    h := DllCall('kernel32\GetStdHandle', 'int', toErr ? -12 : -11, 'ptr')
    if (h && h != 0 && h != -1)
        return h
    /* 没有 stdout 的进程（GUI 子系统被别的东西拉起时见过）：
       主动挂到父进程的控制台上，再打开 CONOUT$/CONERR$ */
    if !DllCall('kernel32\AttachConsole', 'uint', -1, 'int')
        return 0
    h := DllCall('kernel32\CreateFileW', 'wstr', toErr ? 'CONERR$' : 'CONOUT$'
        , 'uint', 0xC0000000                     ; GENERIC_READ | GENERIC_WRITE
        , 'uint', 3, 'ptr', 0, 'uint', 3, 'uint', 0, 'ptr', 0, 'ptr')
    return (h = -1 ? 0 : h)
}

StdOut(text, toErr := false) {
    h := StdStream(toErr)
    if !h
        return false
    isConsole := (DllCall('kernel32\GetFileType', 'ptr', h, 'int') = 2)
    cp := 0
    if isConsole {
        cp := DllCall('kernel32\GetConsoleOutputCP', 'int')
        text := StrReplace(text, '`r`n', '`n')     ; 先规整，再统一成 CRLF
        text := StrReplace(text, '`n', '`r`n')
    }
    if (!cp)
        cp := isConsole ? 936 : 65001
    try {
        buf := Buffer(StrPut(text, 'CP' cp))
        n := StrPut(text, buf, 'CP' cp) - 1        ; 不含结尾 0
    } catch
        return false
    if (n <= 0)
        return true
    wrote := 0
    DllCall('kernel32\WriteFile', 'ptr', h, 'ptr', buf, 'uint', n, 'uint*', &wrote, 'ptr', 0)
    return wrote > 0
}

CliUsage() {
    L := [
        '用法：ql [命令] [参数...]'
        , ''
        , '  ql                          打开 / 唤醒启动器'
        , '  ql <查询>                   打开并预填查询（语法同搜索框：>命令  @分组  拼音）'
        , '  ql search <查询>            同上，显式写法'
        , '  ql list <查询>              列出匹配的条目（id、名称、类型，制表符分隔）'
        , '  ql run <id|名称|查询> [选项]  直接执行条目'
        , ''
        , 'run 的选项：'
        , '  --args "<原文>"      直接给出运行时参数（等同参数态里敲完再回车）'
        , '  -- <原文>            -- 之后的全部内容原样作为参数，不用套引号'
        , '  --show               执行时把窗口显示出来（默认不显示）'
        , '  --wait               等执行结束，结果打到 stdout，退出码反映成败'
        , '  --json               结果以 JSON 输出（配合 --wait / list）'
        , '  --timeout <毫秒>     等待上限，默认 30000'
        , '  --first              有多个候选时直接取最高分那条'
        , '  --ephemeral          若为此新建了实例，处理完就退出（不常驻）'
        , ''
        , '退出码：0 成功 / 1 没找到 / 2 有歧义 / 3 缺参数 / 4 执行失败 / 5 无响应或权限不同 / 6 用法错误'
    ]
    for l in L
        StdOut(l '`n')
}

; ---------------------------------------------------------------- 客户端

CliClient(a) {
    ; 本进程只做投递，永不常驻：
    ;   已有实例 → 直接投；没有 → 拉起一个隐藏实例，等它开门再投。
    ; mode=none（双击 run.bat）当成"唤醒"，不再像以前那样把旧进程杀掉重开。
    global CLI_DIR
    mode := (a.mode = 'none') ? 'wake' : a.mode

    ; 先短等一下：可能是另一个实例正在启动（互斥体已占用但窗口还没建）
    hwnd := WaitInbox(1500)
    if !hwnd {
        if !SpawnInstance()
            CliFail(5, '没能启动启动器进程。')
        hwnd := WaitInbox(20000)
        if !hwnd
            CliFail(5, '启动器进程没有在 20 秒内就绪（WebView2 初始化失败？详见 launcher.log）。')
    }

    rid := MakeRid()
    needWait := a.wait || a.mode = 'list'
    reply := ''
    if needWait {
        try DirCreate(CLI_DIR)
        reply := CLI_DIR '\' rid '.json'
        try FileDelete(reply)
    }

    if !SendCopyData(hwnd, CliReqJson(a, rid, mode, reply))
        CliFail(5, '无法把请求交给已有进程。最常见的原因是它正以管理员身份运行，'
            . '权限不同的进程之间收不到这类消息。')

    if !needWait
        ExitApp(0)

    deadline := A_TickCount + a.timeout
    loop {
        if FileExist(reply) {
            txt := ''
            try txt := FileRead(reply, 'UTF-8')
            try FileDelete(reply)
            if (txt = '') {
                ; 刚好读到改名的一瞬间也不是没可能，给一次重试
                Sleep 40
                if (A_TickCount <= deadline)
                    continue
            }
            PrintReply(txt, a.json)
            ExitApp(JsonNum(txt, 'code', 0))
        }
        if (A_TickCount > deadline)
            CliFail(5, '等待执行结果超时（' a.timeout ' ms）。')
        Sleep 50
    }
}

SpawnInstance() {
    ; --hide：先藏起来，要不要露脸由随后到达的请求（cli-applied）决定
    exe := A_IsCompiled ? A_ScriptFullPath : '"' A_AhkPath '" "' A_ScriptFullPath '"'
    try {
        Run(exe ' --hide', SCRIPT_DIR, 'Hide')
        return true
    }
    return false
}

MakeRid() {
    return 'c' ProcessExist() '-' A_TickCount '-' Random(1000, 9999)
}

CliReqJson(a, rid, mode, reply) {
    ; show / exitAfter 都随请求走：决定权在发起方，实例只管照做
    show := (mode = 'search' || a.show)
    return '{"type":"cli","rid":' JsonQuote(rid)
        . ',"mode":' JsonQuote(mode)
        . ',"q":' JsonQuote(a.q)
        . ',"args":' JsonQuote(a.args)
        . ',"first":' (a.first ? 1 : 0)
        . ',"show":' (show ? 1 : 0)
        . ',"exitAfter":' (a.ephemeral ? 1 : 0)
        . ',"reply":' JsonQuote(reply) '}'
}

PrintReply(json, asJson) {
    out := asJson ? json : JsonStr(json, 'text')
    if (out != '')
        StdOut(out '`n')
}

CliFail(code, msg) {
    StdOut(msg '`n', true)
    ExitApp(code)
}

; ---------------------------------------------------------------- 实例端

QueueReq(text) {
    global cliRec, cliQueue, wakePending
    rid := JsonStr(text, 'rid')
    if (rid = '')
        rid := MakeRid()
    if (JsonStr(text, 'mode') = 'wake') {
        ; "打开一下"不需要麻烦页面，但也别在这个消息处理里做窗口操作
        wakePending := true
        SetTimer(FlushCli, -1)
        return
    }
    cliRec[rid] := {rid: rid, reply: JsonStr(text, 'reply')
        , show: JsonNum(text, 'show', 0) ? true : false
        , exitAfter: JsonNum(text, 'exitAfter', 0) ? true : false
        , task: 0}
    cliQueue.Push({text: text, rid: rid})
    SetTimer(FlushCli, -1)
}

FlushCli() {
    global cliQueue, wv, uiReady, wakePending
    if wakePending {
        wakePending := false
        ShowLauncher()
    }
    if (!uiReady || !wv)
        return
    while cliQueue.Length {
        it := cliQueue.RemoveAt(1)
        ; 不能 await：await 会阻塞 AHK 消息循环，页面跑完之前整个界面都是死的
        try wv.ExecuteScriptAsync('window.__cli&&window.__cli(' it.text ')')
        catch as e
            CliReply('{"rid":' JsonQuote(it.rid) ',"code":5,"text":'
                . JsonQuote('注入页面失败：' CleanComError(e.Message)) ',"json":""}')
    }
}

CliWantsWindow(rid) {
    global cliRec
    if (rid = '' || !cliRec.Has(rid))
        return false
    return cliRec[rid].show ? true : false
}

CliReply(raw) {
    global cliRec
    rid := JsonStr(raw, 'rid')
    if (rid = '' || !cliRec.Has(rid))
        return
    rec := cliRec[rid]
    code := JsonNum(raw, 'code', 0)
    json := JsonStr(raw, 'json')

    if (rec.reply != '' && json != '')
        WriteReply(rec.reply, json)

    /* 定时任务发起的执行：结果进 sched.log，并把该任务的 busy 放掉 */
    if (rec.task)
        SchedDone(rec.task, code, JsonStr(raw, 'text'))

    cliRec.Delete(rid)

    /* 本进程要不要退场完全由发起方说了算（--ephemeral）：
       它可能是被人从命令行临时拉起来的，干完活就该走，不该在后台常驻。 */
    if rec.exitAfter {
        Sleep 200                    ; 给 usage.json 落盘和子进程收尾留一点时间
        ExitApp(code)
    }
}

WriteReply(path, json) {
    ; 先写 .tmp 再改名：客户端可能恰好在写的过程中来读，看到半截 JSON 会解析出错。
    ; 目录可能被清理过（冷启动时客户端比实例先建好路径），必须自己确保它在。
    try DirCreate(RegExReplace(path, '\\[^\\]*$'))
    tmp := path '.tmp'
    try {
        f := FileOpen(tmp, 'w', 'UTF-8-RAW')
        if !IsObject(f)
            return
        f.Write(json)
        f.Close()
        FileMove(tmp, path, 1)
    }
}

; ============================================================================
;  请求头里的动态值：{{#函数名:参数}}
;
;  为什么放在 AHK 而不是前端：签名密钥与算法要能「编译进 exe」。
;  config.json 只留 {{#hmac:demo:{ts}}} 这样的占位符，明文和算法都不落配置文件。
;
;  为什么要那个 #：前端的模板变量 TPL_RE 是 /\{\{\s*([\w.-]+)\s*\}\}/。
;  一开始写成 {{ts}}，结果它和前端的"参数变量"长得一模一样 ——
;  条目一旦声明了 params，前端就会把 {{ts}} 当成"引用了没声明的变量"，
;  直接拒绝执行；就算不报错也会被替换成空串。加个 # 之后，
;  # 不在 [\w.-] 里，前端从头到尾都不认它，原样送到这里（不需要任何遮罩代码）。
;
;  支持：
;    {{#ts}}                    Unix 秒
;    {{#tsms}}                  Unix 毫秒
;    {{#uuid}}                  UUID v4
;    {{#nonce:16}}              N 位随机小写字母数字（默认 16，上限 128）
;    {{#sha256:文本}}           十六进制 SHA-256
;    {{#hmac:密钥名:待签内容}}   十六进制 HMAC-SHA256，密钥取自 SIG_KEYS
;
;  待签内容里可以用**单花括号**引用另一个动态值：{{#hmac:demo:{ts}}}
;  —— 为什么不是 {{#hmac:demo:{{#ts}}}}：内层收尾紧跟外层收尾会凑出 }}}}，
;  那是前端「输出字面 }}」的逃生口（见 ui/app.js 的 TPL_RE），会被吃成 }}，
;  于是签名占位符少两个括号、整条失效。单花括号两头都不碰，最省事。
;  单花括号只认 ts / tsms / uuid / nonce，不支持再套 hmac。
; ============================================================================
HdrExpand(line) {
    if !InStr(line, '{{#')
        return line
    Loop 4 {                              ; 里层先展开，外层用结果再算一次
        out := '', pos := 1, hit := false
        m := ''
        /* 内层允许一对单花括号：{{#hmac:demo:{ts}}} —— 但不能有第二层 */
        while RegExMatch(line, '\{\{#((?:[^{}]|\{[^{}]*\})*)\}\}', &m, pos) {
            r := HdrEval(m[1])
            out .= SubStr(line, pos, m.Pos - pos) . (r.ok ? r.val : m[0])
            if r.ok
                hit := true
            pos := m.Pos + m.Len
        }
        out .= SubStr(line, pos)
        if (!hit || !InStr(out, '{{#'))
            return out
        line := out
    }
    return line
}

HdrEval(expr) {
    global SIG_KEYS
    name := expr, rest := ''
    p := InStr(expr, ':')
    if p {
        name := SubStr(expr, 1, p - 1)
        rest := SubStr(expr, p + 1)
    }
    name := Trim(name, ' ' . "`t")

    switch name {
        case 'ts':
            return {ok: true, val: String(DateDiff(A_NowUTC, '19700101000000', 'Seconds'))}
        case 'tsms':
            return {ok: true, val: String(DateDiff(A_NowUTC, '19700101000000', 'Seconds') * 1000 + A_MSec)}
        case 'uuid':
            return {ok: true, val: UuidV4()}
        case 'nonce':
            n := (Trim(rest, ' ' . "`t") = '') ? 16 : Integer(Trim(rest, ' ' . "`t"))
            if (n < 1 || n > 128)
                n := 16
            return {ok: true, val: RandAlnum(n)}
        case 'sha256':
            return {ok: true, val: HashHex(rest)}
        case 'hmac':
            ; hmac:密钥名:待签内容  —— 只按第一个冒号切，内容里的冒号照旧
            q := InStr(rest, ':')
            if !q
                throw Error('hmac 少了参数，写法是 {{hmac:密钥名:待签内容}}')
            kname := Trim(SubStr(rest, 1, q - 1), ' ' . "`t")
            if !SIG_KEYS.Has(kname)
                throw Error('未知的签名密钥名「' kname '」——在 launcher.ahk 的 SIG_KEYS 里定义')
            return {ok: true, val: HashHex(HdrInline(SubStr(rest, q + 1)), 'SHA256', SIG_KEYS[kname])}
    }
    return {ok: false, val: ''}          ; 不认识：原样留着
}

/* 待签内容里的单花括号占位：{ts} {tsms} {uuid} {nonce:8}
   只认无副作用的这几个，不认 hmac（避免自己套自己）；不认识的整段原样留着。 */
HdrInline(s) {
    if !InStr(s, '{')
        return s
    out := '', pos := 1
    m := ''
    while RegExMatch(s, '\{([a-z][\w]*)(?::([^{}]*))?\}', &m, pos) {
        name := m[1]
        if (name = 'ts' || name = 'tsms' || name = 'uuid' || name = 'nonce') {
            r := HdrEval(m[2] = '' ? name : name ':' m[2])
            out .= SubStr(s, pos, m.Pos - pos) . (r.ok ? r.val : m[0])
        } else {
            out .= SubStr(s, pos, m.Pos - pos) . m[0]
        }
        pos := m.Pos + m.Len
    }
    return out . SubStr(s, pos)
}

UuidV4() {
    static HEX := '0123456789abcdef'
    s := ''
    Loop 32
        s .= SubStr(HEX, Random(1, 16), 1)
    ; 版本位固定 4，变体位固定 8/9/a/b
    s := SubStr(s, 1, 12) . '4' . SubStr(s, 14, 3) . SubStr('89ab', Random(1, 4), 1) . SubStr(s, 18)
    return SubStr(s, 1, 8) '-' SubStr(s, 9, 4) '-' SubStr(s, 13, 4) '-' SubStr(s, 17, 4) '-' SubStr(s, 21, 12)
}

RandAlnum(n) {
    static CS := 'abcdefghijklmnopqrstuvwxyz0123456789'
    s := ''
    Loop n
        s .= SubStr(CS, Random(1, 36), 1)
    return s
}

/* SHA-256 / HMAC-SHA256，走 Windows 自带的 bcrypt（不引第三方库）。
   key 为空 = 普通摘要；非空 = HMAC（要带 BCRYPT_ALG_HANDLE_HMAC_FLAG）。 */
HashHex(text, algo := 'SHA256', key := '') {
    hAlg := 0, hHash := 0
    flags := (key = '') ? 0 : 0x00000008
    if DllCall('bcrypt\BCryptOpenAlgorithmProvider'
        , 'ptr*', &hAlg, 'wstr', algo, 'ptr', 0, 'uint', flags, 'int')
        throw Error('系统不支持摘要算法：' algo)
    try {
        szBuf := Buffer(4, 0), got := 0
        DllCall('bcrypt\BCryptGetProperty', 'ptr', hAlg, 'wstr', 'ObjectLength'
            , 'ptr', szBuf, 'uint', 4, 'uint*', &got, 'uint', 0, 'int')
        objLen := NumGet(szBuf, 0, 'uint')
        /* 属性名是 HashDigestLength。写成 HashLength 会返回 STATUS_NOT_SUPPORTED，
           而 Buffer 保持上一次的旧值 —— 这里踩过：hashLen 变成 326（对象长度），
           接着 BCryptFinishHash 报 0xC000000D「参数无效」，看着像加密失败，
           实际只是名字写错。 */
        DllCall('bcrypt\BCryptGetProperty', 'ptr', hAlg, 'wstr', 'HashDigestLength'
            , 'ptr', szBuf, 'uint', 4, 'uint*', &got, 'uint', 0, 'int')
        hashLen := NumGet(szBuf, 0, 'uint')
        if (!objLen || !hashLen)
            throw Error('取不到摘要长度：' algo)

        dLen := StrPut(text, 'utf-8')
        dBuf := Buffer(dLen, 0)
        StrPut(text, dBuf, 'utf-8')

        kBuf := 0, kLen := 0
        if (key != '') {
            kLen := StrPut(key, 'utf-8') - 1
            kBuf := Buffer(kLen, 0)
            StrPut(key, kBuf, 'utf-8')
        }

        objBuf := Buffer(objLen, 0)
        if DllCall('bcrypt\BCryptCreateHash', 'ptr', hAlg, 'ptr*', &hHash
            , 'ptr', objBuf, 'uint', objLen
            , 'ptr', kBuf, 'uint', kLen, 'uint', 0, 'int')
            throw Error('BCryptCreateHash 失败')
        if DllCall('bcrypt\BCryptHashData', 'ptr', hHash, 'ptr', dBuf, 'uint', dLen - 1, 'uint', 0, 'int')
            throw Error('BCryptHashData 失败')
        outBuf := Buffer(hashLen, 0)
        if DllCall('bcrypt\BCryptFinishHash', 'ptr', hHash, 'ptr', outBuf, 'uint', hashLen, 'uint', 0, 'int')
            throw Error('BCryptFinishHash 失败')

        hex := ''
        Loop hashLen
            hex .= Format('{:02x}', NumGet(outBuf, A_Index - 1, 'uchar'))
        return hex
    } finally {
        if hHash
            DllCall('bcrypt\BCryptDestroyHash', 'ptr', hHash, 'int')
        if hAlg
            DllCall('bcrypt\BCryptCloseAlgorithmProvider', 'ptr', hAlg, 'uint', 0, 'int')
    }
}

AhkInterp() {
    /* 「跑另一个 .ahk」时用的解释器路径。
       脚本版就是 A_AhkPath；编译版的 A_AhkPath 指向 exe 自己，拿它当解释器
       只会再起一个自己 —— 参数全进 A_Args，目标脚本一次都不会执行（实测过：
       目标脚本的 FileAppend 从没落盘）。所以编译版优先用随包的 runtime 解释器，
       找不到再退回 A_AhkPath：这样漏带 runtime 时是 webhook 报错，而不是静默跑飞。 */
    global SCRIPT_DIR
    if A_IsCompiled {
        p := SCRIPT_DIR '\runtime\AutoHotkey64.exe'
        if FileExist(p)
            return p
    }
    return A_AhkPath
}

HashText(s) {
    ; djb2，只求稳定不重复，不用于安全用途
    h := 5381
    Loop Parse, s
        h := Mod((h * 33) + Ord(A_LoopField), 0x7FFFFFFF)
    return Format('{:08x}', h)
}

CleanStaleCli() {
    /* 回执目录是客户端和实例共用的。以前这里直接 DirDelete(...,true) 把整个
       目录端掉 —— 冷启动时客户端先建好回执路径、再去拉起实例，实例一启动就把
       目录连根删了，于是动作照跑、回执永远写不出来，调用方只能等到超时。
       现在只清一天以上的陈货。 */
    global CLI_DIR
    if !DirExist(CLI_DIR)
        return
    cutoff := DateAdd(A_Now, -1, 'Days')
    Loop Files, CLI_DIR '\*.json*', 'F' {
        try {
            if (A_LoopFileTimeModified < cutoff)
                FileDelete(A_LoopFilePath)
        }
    }
}

; ============================================================================
;  定时调度
;  ---------------------------------------------------------------------------
;  config.json 顶层 schedules 里的任务，由页面 JS 校验、展开后逐条报上来
;  （sched-begin / sched-task… / sched-end），这里只负责排程与触发。
;
;  为什么不用页面的 setTimeout：窗口平时是藏着的，Chromium 对隐藏页面的定时器
;  会做后台节流（不可见久了降到一分钟一次甚至更稀），调度从一开始就不准。
;  AHK 的 SetTimer 是 Win32 定时器，藏不藏窗口都一样。
;
;  触发时不另开一套执行逻辑：把一条 cli 请求塞进现有的 cliQueue，由页面的
;  window.__cli 走和 `ql run` 完全相同的路（含参数分配、歧义处理）。
;  区别只有 show=0 + quiet=1：不弹窗、不写结果面板、不计使用频率。
;
;  约定（README「定时调度」一节有同一份说明）：
;    · 不补跑：下次时刻永远严格大于现在；晚了 90 秒以上就只记一行 miss
;    · 不重试：失败就是一行 fail 日志
;    · 同一任务上一次还没收尾就跳过本次（skip），避免 webhook 卡住时堆一串
;    · 到点精度 < 1 秒（一次性精确定时），另有 60 秒兜底重算
; ============================================================================

SchedBegin() {
    global schedStage, schedInside
    ; 整批替换：先攒在新表里，收到 sched-end 才换掉旧的（配置重载走同一条路）
    schedStage := []
    schedInside := true
}

SchedTask(raw) {
    global schedStage, schedInside
    if !schedInside
        return
    id := JsonStr(raw, 'id')
    err := JsonStr(raw, 'err')
    if (err != '') {
        schedStage.Push({id: id, err: err})
        return
    }
    schedStage.Push({
        id: id
        , q: JsonStr(raw, 'q')
        , args: JsonStr(raw, 'args')
        , first: JsonNum(raw, 'first', 1) ? 1 : 0
        , mode: JsonStr(raw, 'mode')
        , days: JsonStr(raw, 'days')
        , times: JsonStr(raw, 'times')
        , every: Integer(JsonNum(raw, 'every', 0))
        , next: ''
        , last: ''
        , busy: false
    })
}

SchedEnd() {
    global schedTasks, schedStage, schedInside
    schedInside := false
    stage := schedStage
    schedStage := []

    now := A_Now
    list := []
    for t in stage {
        /* 注意用 HasOwnProp：AHK 的对象字面量没有 Has()（那是 Map 的方法），
           写成 t.Has('err') 会抛 "no method named Has" —— 而这个异常发生在
           消息回调里，会弹一个错误框把整个消息循环卡住（页面随后连 ready 都发不进去） */
        if (IsObject(t) && t.HasOwnProp('err')) {
            SchedLog(t.id, 'bad', t.err '（已跳过）')
            continue
        }
        if (t.q = '') {
            SchedLog(t.id, 'bad', '缺少要执行的条目（已跳过）')
            continue
        }
        SchedAdvance(t, now)
        list.Push(t)
        SchedLog(t.id, 'plan', SchedDescribe(t))
    }
    schedTasks := list
    /* 一条任务都没有就什么都不写：没配定时器的用户不该多出一个 sched.log */
    SchedArm()
}

SchedAdvance(t, now) {
    /* 把 t.next 推到"严格大于 now"的下一个时刻。严格大于这点很关键：
       它同时保证了「不补跑」和「不会在同一秒里触发两次」。 */
    if (t.mode = 'every') {
        cand := ''
        if (t.last != '')
            cand := DateAdd(t.last, t.every, 'Seconds')
        if (cand = '' || cand <= now)
            cand := DateAdd(now, t.every, 'Seconds')
        t.next := cand
        return
    }
    t.next := SchedNextAt(now, t.days, t.times)
}

SchedNextAt(now, days, times) {
    /* at 模式：从今天起往后数 8 天，找第一个「星期几命中 且 时刻晚于 now」的组合。
       8 天足够覆盖最坏情况（今天是唯一命中的那天、且时刻已过 → 要跳到下周）。 */
    if (days = '' || times = '')
        return ''
    tlist := StrSplit(times, ',')
    Loop 8 {
        d := DateAdd(now, A_Index - 1, 'Days')
        wd := Integer(FormatTime(d, 'WDay')) - 1        ; WDay 是 1..7（1=周日），换成 0..6
        if !InStr(',' days ',', ',' wd ',')
            continue
        ymd := FormatTime(d, 'yyyyMMdd')
        for t in tlist {
            cand := ymd . t
            if (cand > now)
                return cand
        }
    }
    return ''
}

SchedArm() {
    global schedTasks
    best := ''
    for t in schedTasks {
        if (t.next = '')
            continue
        if (best = '' || t.next < best)
            best := t.next
    }
    if (best = '') {
        SetTimer(SchedTick, 0)
        return
    }
    /* 一次性定时对准最近的那一个（精度到秒）；离得远就每 60 秒回来重算一次，
       既省得排一个几天长的定时器，也能兜住系统时间跳变和休眠唤醒。 */
    sec := DateDiff(best, A_Now, 'Seconds')
    ms := sec * 1000 + 100
    if (ms < 100)
        ms := 100
    if (ms > 60000)
        ms := 60000
    SetTimer(SchedTick, -ms)
}

SchedTick() {
    global schedTasks
    SchedReap()
    now := A_Now
    for t in schedTasks {
        if (t.next = '' || t.next > now)
            continue
        due := t.next
        late := DateDiff(now, due, 'Seconds')
        t.last := due
        SchedAdvance(t, now)                ; 先把指针推走，这一轮就不会重复触发
        /* 晚了 90 秒以上只可能是休眠/关机/时间跳变。按「不补跑」处理：
           记一行，跳过，等下一次正常时刻。 */
        if (late > 90) {
            SchedLog(t.id, 'miss', '晚了 ' late ' 秒才处理（休眠或程序没在跑），本次不补')
            continue
        }
        SchedFire(t)
    }
    SchedArm()
}

SchedFire(t) {
    global cliQueue, cliRec, uiReady
    if !uiReady {
        SchedLog(t.id, 'fail', '界面还没就绪，本次跳过')
        return
    }
    if t.busy {
        SchedLog(t.id, 'skip', '上一次还没结束，本次跳过')
        return
    }
    rid := 'sched-' A_TickCount '-' Random(1000, 9999)
    req := '{"type":"cli","rid":' JsonQuote(rid)
        . ',"mode":"run","q":' JsonQuote(t.q)
        . ',"args":' JsonQuote(t.args)
        . ',"first":' t.first
        . ',"show":0,"quiet":1,"exitAfter":0,"reply":""}'
    t.busy := true
    cliRec[rid] := {rid: rid, reply: '', show: false, exitAfter: false
        , task: t, since: A_Now}
    cliQueue.Push({text: req, rid: rid})
    SetTimer(FlushCli, -1)
}

SchedDone(t, code, text) {
    try t.busy := false
    text := Trim(StrReplace(StrReplace(text, "`r", ' '), "`n", ' '))
    if (StrLen(text) > 300)
        text := SubStr(text, 1, 300) '…'
    if (text = '')
        text := (code = 0) ? '已执行' : '执行失败（没有更多信息）'
    SchedLog(t.id, code = 0 ? 'ok' : 'fail', text)
}

SchedReset(reason) {
    /* 页面重载：重载前投出去的请求不可能再有回执了。不把 busy 放掉的话，
       那条任务会永远停在"上一次还没结束"上，从此再也不执行。 */
    global cliRec
    stale := []
    for rid, rec in cliRec {
        if rec.task
            stale.Push(rid)
    }
    for rid in stale {
        rec := cliRec[rid]
        try rec.task.busy := false
        cliRec.Delete(rid)
        SchedLog(rec.task.id, 'fail', reason)
    }
}

SchedReap() {
    /* 兜底：页面活着但一直没回执（请求卡死）。5 分钟还没结果就按失败处理，
       别让一条任务因为一次异常就永久停摆。 */
    global cliRec
    stale := []
    for rid, rec in cliRec {
        if (!rec.task || !rec.HasOwnProp('since'))
            continue
        if (DateDiff(A_Now, rec.since, 'Seconds') > 300)
            stale.Push(rid)
    }
    for rid in stale {
        rec := cliRec[rid]
        try rec.task.busy := false
        cliRec.Delete(rid)
        SchedLog(rec.task.id, 'fail', '5 分钟没有收到结果，按失败处理')
    }
}

SchedDescribe(t) {
    when := (t.next = '') ? '(算不出下次时间)' : FormatTime(t.next, 'MM-dd HH:mm:ss')
    if (t.mode = 'every')
        return SchedEveryText(t.every) '，下次 ' when
    return SchedDaysText(t.days) ' ' SchedTimesText(t.times) '，下次 ' when
}

SchedEveryText(sec) {
    if (Mod(sec, 3600) = 0)
        return '每 ' (sec // 3600) ' 小时'
    if (Mod(sec, 60) = 0)
        return '每 ' (sec // 60) ' 分钟'
    return '每 ' sec ' 秒'
}

SchedTimesText(times) {
    out := ''
    for x in StrSplit(times, ',') {
        c := SubStr(x, 1, 2) ':' SubStr(x, 3, 2)
        if (SubStr(x, 5, 2) != '00')
            c .= ':' SubStr(x, 5, 2)
        out .= (out = '' ? '' : ',') c
    }
    return out
}

SchedDaysText(days) {
    if (days = '0,1,2,3,4,5,6')
        return '每天'
    if (days = '1,2,3,4,5')
        return '工作日'
    if (days = '0,6')
        return '周末'
    names := ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    out := ''
    for x in StrSplit(days, ',') {
        n := Integer(x) + 1
        if (n < 1 || n > 7)
            continue
        out .= (out = '' ? '' : ',') names[n]
    }
    return (out = '') ? '每天' : out
}

SchedLog(id, kind, text) {
    /* 一行一条，主界面没有入口，这个文件就是"它到底跑没跑"的唯一凭据。
       超过 512 KB 轮转成 sched.log.1，只留一份 —— 排查用的日志不需要历史。 */
    global SCHED_LOG
    try {
        if (FileExist(SCHED_LOG) && FileGetSize(SCHED_LOG) > 512000)
            FileMove(SCHED_LOG, SCHED_LOG '.1', 1)
    }
    line := FormatTime(A_Now, 'yyyy-MM-dd HH:mm:ss') '  '
    line .= SubStr(kind '      ', 1, 6)
    line .= (id = '' ? '-' : id) '  ' text "`n"
    try FileAppend(line, SCHED_LOG, 'UTF-8')
}
