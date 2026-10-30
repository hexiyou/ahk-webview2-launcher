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
#SingleInstance Force
#Warn All, Off
#Include lib\WebView2\WebView2.ahk

; ---------------------------- 路径常量 --------------------------------------
global SCRIPT_DIR := A_ScriptDir
global INI_PATH   := SCRIPT_DIR '\launcher.ini'
global CFG_PATH   := SCRIPT_DIR '\config.json'
global UI_PATH    := SCRIPT_DIR '\ui\index.html'
global DLL_PATH   := SCRIPT_DIR '\lib\WebView2Loader.dll'
global DATA_DIR   := SCRIPT_DIR '\.webview2'
global ICON_DIR   := A_Temp '\quicklaunch-icons'
global HTTP_DIR   := A_Temp '\quicklaunch-http'
global HTTP_MAX_BODY := 400000        ; webhook 响应正文上限（字符），超出截断防止消息过大

; ---------------------------- 运行时状态 ------------------------------------
global g := ""
global wvc := 0
global wv := 0
global uiReady := false
global lastNavOK := -1        ; 最近一次导航结果（-1 = 还没导航过）
global lastNavErr := -1
global ncDrag := false        ; WebView2 原生非客户区拖拽是否可用
global httpJobs := Map()      ; 进行中的 webhook 请求：id -> {dir, pid, deadline}

; ---------------------------- 启动引导 --------------------------------------
SetProcessDpi()
settings := LoadSettings()
A_IconTip := 'QuickLaunch　' settings.hotkey ' 呼出'
SetupTray()

if !FileExist(UI_PATH) {
    MsgBox('找不到界面文件：`n' UI_PATH, 'QuickLaunch', 'Icon!')
    ExitApp()
}

; 清掉上次运行留下的 webhook 临时目录（响应正文可能不小，不清理会越积越多）
try DirDelete(HTTP_DIR, true)

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
    wv.add_NavigationCompleted(OnNavDone)
    wv.add_ProcessFailed(OnProcFailed)

    InjectBootstrap()
    wv.Navigate('file:///' StrReplace(UI_PATH, '\', '/'))

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

OnNavDone(sender, args) {
    global lastNavOK, lastNavErr
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
    global uiReady, wv, lastNavOK, lastNavErr
    if (uiReady)
        return
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
    ; 起一个新实例，新实例会等旧进程退出后接管（AHK 的 /restart 开关）
    global g
    if IsObject(g)
        try g.Hide()
    try Run('"' A_AhkPath '" /restart "' A_ScriptFullPath '"')
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
        case 'reload':
            DoReload()
        case 'open-config':
            OpenConfig()
        case 'icons':
            DoIcons(raw)
        case 'log':
            FileAppend(JsonStr(raw, 'text') '`n', SCRIPT_DIR '\launcher.log', 'UTF-8')
    }
}

DoRun(raw) {
    global settings
    try {
        Launch(JsonStr(raw, 'kind'), JsonStr(raw, 'target'), JsonStr(raw, 'args'), JsonStr(raw, 'workdir'))
        if settings.hideAfterLaunch
            HideLauncher()
    } catch as e {
        Notify('启动失败：' e.Message)
    }
}

Launch(kind, target, args, workdir) {
    global SCRIPT_DIR
    if (target = '')
        throw Error('目标为空')
    if (workdir = '')
        workdir := SCRIPT_DIR

    switch kind {
        case 'url':
            Run(target)
        case 'folder':
            Run('explorer.exe "' target '"')
        case 'cmd':
            ; target 是"一整条命令行"（如 ipconfig /all），不能当路径改写。
            ; 外面包一层引号并用 /s：cmd 只剥掉首尾两个引号，命令里自带的引号
            ; （带空格的 exe 路径、重定向文件名）能原样保留。
            Run(A_ComSpec ' /s /k "' target '"', workdir)
        case 'ahk':
            Run('"' A_AhkPath '" "' target '"' (args != '' ? ' ' args : ''), workdir)
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
            Run('"' target '"' (args != '' ? ' ' args : ''), workdir)
    }
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

    ; 请求头由前端给成 "Name: Value" 的字符串数组 —— 避免在这里解析嵌套 JSON
    hs := ''
    for h in JsonStrArray(raw, 'headers')
        hs .= h '`n'
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
        Run('"' A_AhkPath '" /ErrorStdOut "' SCRIPT_DIR '\webhook.ahk" "' spec '"'
            , SCRIPT_DIR, 'Hide', &pid)
    } catch as e {
        JsSend('{"type":"http-result","id":' JsonQuote(id) ',"ok":0,"status":0,"ms":0'
            ',"truncated":0,"error":' JsonQuote('无法启动请求进程：' e.Message) ',"body":""}')
        return
    }

    httpJobs[id] := {dir: dir, pid: pid, timeout: timeout
        , deadline: A_TickCount + (timeout + 1) * 1000}
    SetTimer(CheckHttp, 120)          ; SetTimer 幂等，重复调用只是重置间隔
}

CheckHttp() {
    global httpJobs, HTTP_MAX_BODY
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

        truncated := 0
        if (StrLen(body) > HTTP_MAX_BODY) {
            body := SubStr(body, 1, HTTP_MAX_BODY)
            truncated := 1
        }

        try {
            JsSend('{"type":"http-result","id":' JsonQuote(id)
                ',"ok":' (err = '' ? 1 : 0)
                ',"status":' status
                ',"ms":' ms
                ',"truncated":' truncated
                ',"error":' JsonQuote(err)
                ',"body":' JsonQuote(body) '}')
        }
        ; 请求载荷（请求头/请求体/spec）用完就删，响应留在原处方便排查
        for f in ['h.txt', 'b.txt', 'spec.ini']
            try FileDelete(job.dir '\' f)
        httpJobs.Delete(id)
    }
    if !httpJobs.Count
        SetTimer(CheckHttp, 0)
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
    if !RegExMatch(text, '"' key '"\s*:\s*\[(.*?)\]', &arr)
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
