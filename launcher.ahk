; ============================================================================
;  QuickLaunch  —  AutoHotkey v2 + WebView2 快速启动器（可行性验证版）
;  ---------------------------------------------------------------------------
;  结构：
;    launcher.ahk        本文件：Win32 无边框窗口 + WebView2 宿主 + 全局热键 + 启动逻辑
;                        + HTTP 执行器（`--webhook <spec>` 分支，见文末同名小节）
;                        + 回调切块/消息框（`_ql_callback`，见「回调」小节）
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
global FILE_MAX_BODY := 8 * 1024 * 1024   ; jsonfile 读本地文件的上限（字节）。超了一律拒读，见 DoReadJson
; YAML / TOML 单独一个上限，比 JSON 小得多：这两种解析器是逐字符扫状态机，
; 实测 8MB 要 1 秒以上（JSON.parse 只要 6ms），同步解析会把界面按住。
; 再说这个体量的配置文件本身罕见，2MB 足够覆盖到最大的 k8s / compose 合集。
global FILE_MAX_TEXT := 2 * 1024 * 1024
; webhook 模板里内联文件（{{#file:…}} / filebase64 / filehash）的上限。
; 比 jsonfile 小得多：内容要拼进字符串、再编码成 UTF-8 写盘，体积翻倍是常事，
; 真拿它传大文件会卡住界面，而且 base64 之后还要再涨 1/3。
global TPL_FILE_MAX := 2 * 1024 * 1024
; multipart 单文件上限。走的是字节流拼包，不进字符串，所以能放宽到 8MB。
global MP_FILE_MAX := 8 * 1024 * 1024

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
global cbBoxQ := []           ; 待弹的回调消息框（串行，见 DoCallbackMsg）
global cbBoxBusy := false     ; 已经有一条挂在屏幕上（串行放行，见 CallbackPump）
global cbBoxWin := 0          ; 当前那条对话框（Gui 对象；0 = 没有）
global cbSilent := false      ; 自检期间不写 launcher.log（别把噪音掺进用户日志）
global CB_TEXT_MAX := 2000    ; 回调消息框正文上限：400KB 的正文不该变成一个巨型对话框
global CB_TEXT_SHOW := 900    ; 屏上最多显示这么多字，再多就截断 —— 2000 字能顶到屏幕外
global CB_TITLE_MAX := 120
global CB_RAW_MAX := 16384    ; _ql_callback 原始片段上限：比这大的不是回调，是事故
global ipcGui := 0            ; 收件箱窗口（接收命令行请求）
global mutexHandle := 0
global cliQueue := []         ; 还没投递给页面的请求
global cliRec := Map()        ; rid -> 请求记录 {rid, reply, show, exitAfter, task}
global wakePending := false   ; 有客户端只是要求"打开一下"
global schedTasks := []       ; 已安装的定时任务
global schedStage := []       ; sched-begin..sched-end 之间攒的条目
global schedInside := false
global schedBoot := false     ; 本次进程是否已经处理过 runOnStart
global schedBootTries := 0    ; 等界面就绪的重试计数

; ------------------------- 内部通道：--webhook --------------------------------
/*  webhook / download 的 HTTP 请求跑在子进程里（WinHttp 是同步 COM，放主进程里
    10 秒超时就是 10 秒假死）。子进程就是本脚本自己：

      脚本版   AutoHotkey64.exe launcher.ahk --webhook <spec.ini>
      编译版   QuickLaunch.exe            --webhook <spec.ini>

    以前靠一个独立的 webhook.ahk + 随包解释器；并进主脚本之后，编译版不再需要
    runtime\AutoHotkey64.exe（只剩 "ahk" 类型条目还用它），也就少一个会漂移的实现。

    排查时也可以直接在终端手跑一份 spec.ini（不需要开界面）：
        ql --webhook C:\path\spec.ini                 什么都不打，只写 meta.ini
        ql --webhook C:\path\spec.ini --json          结果以 JSON 打到 stdout
        ql --webhook C:\path\spec.ini --body          只打响应正文（配 | jq）
    编译版把 ql 换成 QuickLaunch.exe 即可。

    ★ 这个分支必须在 DPI / 单例 / 配置 / 界面之前：子进程不建窗口、不抢锁、
      不读 config.json，跑完就带着退出码走人。 */
whSpec := ''
whOpt := ''
if WebhookArg(A_Args, &whSpec, &whOpt)
    ExitApp(WebhookMain(whSpec, whOpt))

/* 回调切片器的自检：只跑「从正文里切 _ql_callback」这一步（不弹框、不建窗口），
   每行打一个 JSON，由 tests/callback.test.js 断言。放在这里同样是为了不碰界面。 */
cbTestDir := ''
if CbTestArg(A_Args, &cbTestDir)
    ExitApp(CbTest(cbTestDir))

; ---------------------------- 启动引导 --------------------------------------
SetProcessDpi()

/* 回调消息框的自检：真建窗口，验置顶与自动关闭（不弹 WebView2、不读 config）。
   放在 SetProcessDpi 之后：它要真的画一个窗口，得按同样的 DPI 口径来。 */
if CbMsgTestArg(A_Args)
    ExitApp(CbMsgTest())

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

; ------------------------- 内部通道：读本地 JSON 文件 ------------------------
/*  jsonfile 类型的数据不走网络：AHK 直接把文件读出来回执。
    比起 webhook 那套「写 spec → 起子进程 → 轮询 meta → 超时兜底」，这里全都不需要 ——
    那套存在的唯一理由是 WinHttp 是同步 COM、放主线程会冻住窗口，读文件没有这个问题。

    回执故意做得和 http-result 同形（ok / ms / body / error / truncated），
    前端那一整套 JSON 树、Ctrl+F 查找、jsonPath 提取就能直接复用，一行都不用改。 */
DoReadJson(raw) {
    global FILE_MAX_BODY, FILE_MAX_TEXT
    id := JsonStr(raw, 'id')
    if (id = '')
        id := 'f' A_TickCount

    t0 := A_TickCount
    p := FileTargetPath(JsonStr(raw, 'path'))
    if (p = '')
        return JsReadFail(id, '没有配置文件路径', '', 0)

    if DirExist(p)
        return JsReadFail(id, '这是一个目录，不是文件', p, 0)
    if !FileExist(p)
        return JsReadFail(id, '文件不存在：' p, p, 0)

    size := 0
    try size := FileGetSize(p)
    /* 超限直接拒读，不截断：截断过的配置一定解析失败，会退化成纯文本，
       用户看到的就是「这文件好像坏了」，比明说「太大了」误导得多。 */
    fmt := DataFormatOf(p)
    /* 只有 YAML / TOML 走小上限：它们现场解析，慢；JSON 和纯文本 8MB 照旧 */
    maxBody := (fmt = 'yaml' || fmt = 'toml') ? FILE_MAX_TEXT : FILE_MAX_BODY
    if (size > maxBody)
        return JsReadFail(id, '文件太大（' FmtBytes(size) '），预览上限是 '
            . FmtBytes(maxBody) '，没有读取', p, size)

    err := ''
    body := ReadTextFile(p, &err)
    if (err != '')
        return JsReadFail(id, err, p, size)

    /* format 由这边判、跟着回执走，前端不再自己看一遍扩展名 —— 两处各判一次，
       迟早会在"大写扩展名""file:// 带百分号编码"这类边角上分叉。 */
    JsSend('{"type":"jsonfile-result","id":' JsonQuote(id) ',"ok":1'
        . ',"ms":' (A_TickCount - t0) ',"size":' size ',"truncated":0,"error":""'
        . ',"format":' JsonQuote(fmt) ',"path":' JsonQuote(p) ',"body":' JsonQuote(body) '}')
}

/* 本地文件按哪种语法解读，只看扩展名，不从内容猜：
   YAML 几乎能把任何文本解析成"一个标量"，猜错的代价是纯文本文件被当成
   "只有一个字符串的 YAML"，比不解析更让人困惑。

   不认识的扩展名（.txt / .log / 没有扩展名）返回 text：前端仍会试一把 JSON
   （保持原来"随便丢个文件进来，能解析就画树"的习惯），但**失败不报"解析失败"**
   —— 用户本来就没说它是 JSON，报语法错只会让人以为文件坏了。 */
DataFormatOf(p) {
    SplitPath(p, , , &ext)
    ext := StrLower(ext)
    if (ext = 'json')
        return 'json'
    if (ext = 'yaml' || ext = 'yml')
        return 'yaml'
    if (ext = 'toml')
        return 'toml'
    return 'text'
}

JsReadFail(id, msg, p, size) {
    JsSend('{"type":"jsonfile-result","id":' JsonQuote(id) ',"ok":0'
        . ',"ms":0,"size":' size ',"truncated":0,"error":' JsonQuote(msg)
        . ',"path":' JsonQuote(p) ',"body":""}')
}

/* 把配置里的 target 变成真实路径。三种写法都吃：
       file://c:\x\y.json      手写最常见（反斜杠、两个斜杠）
       file:///C:/x/y.json     URL 规范写法（三个斜杠）
       C:\x\y.json            裸路径；相对路径（data\x.json）按脚本目录算

   为什么 file://server/share/x.json 按 UNC 处理：URL 里 // 后面是主机名，
   Windows 正好用 \\server\share 表达同一件事。想写相对路径就直接写裸路径。 */
FileTargetPath(p) {
    global SCRIPT_DIR
    p := Trim(p)
    if (p = '')
        return ''

    hasScheme := RegExMatch(p, 'i)^file://(.*)$', &m)
    if hasScheme
        p := m[1]

    p := UriDecode(p)                     ; 从浏览器复制的路径，空格是 %20
    p := StrReplace(p, '/', '\')
    /* 环境变量必须在判断「绝对还是相对」之前展开：%TEMP%\x.json 展开后才是
       带盘符的绝对路径，否则会被当成相对路径拼到脚本目录后面。 */
    p := ExpandEnvVars(p)
    if RegExMatch(p, '^\\[a-zA-Z]:')                     ; ///C:/x → \C:\x
        p := SubStr(p, 2)
    else if (hasScheme && !RegExMatch(p, '^[a-zA-Z]:'))   ; //server/share → \\server\share
        p := '\\' p
    else if (!hasScheme && !RegExMatch(p, '^[a-zA-Z]:') && SubStr(p, 1, 2) != '\\')
        p := SCRIPT_DIR '\' p                            ; 相对路径按程序目录算

    return p
}

/* %XX → 字节。先攒字节再按 UTF-8 解，不然中文文件名（%E4%B8%AD…）会被拆成
   一串乱码；`50%off.json` 这种裸 % 不满足两位十六进制，原样留着。 */
UriDecode(s) {
    if !InStr(s, '%')
        return s
    buf := Buffer(StrPut(s, 'UTF-8') + 8), n := 0
    i := 1, len := StrLen(s)
    while (i <= len) {
        c := SubStr(s, i, 1)
        if (c = '%' && i + 2 <= len && RegExMatch(SubStr(s, i + 1, 2), '^[0-9a-fA-F]{2}$')) {
            NumPut('UChar', Integer('0x' SubStr(s, i + 1, 2)), buf, n)
            n += 1, i += 3
            continue
        }
        cb := Buffer(StrPut(c, 'UTF-8'))
        cl := StrPut(c, cb, 'UTF-8') - 1
        Loop cl
            NumPut('UChar', NumGet(cb, A_Index - 1, 'UChar'), buf, n), n += 1
        i += 1
    }
    return StrGet(buf, n, 'UTF-8')
}

/* 读文本，顺手把编码猜对。
   FileRead 自带 BOM 识别（UTF-8 带 BOM、UTF-16 都能直接读对，实测过），
   所以只需要处理「无 BOM 的老 GBK 文件」—— 国内工具导出的 JSON 很常见。
   拿 U+FFFD 当判据：按 UTF-8 读 GBK 必然满屏替换字符，再按 936 读一次对比即可。 */
ReadTextFile(path, &err) {
    err := ''
    try s := FileRead(path, 'UTF-8')
    catch as e {
        err := '读取失败：' CleanComError(e.Message)
        return ''
    }
    if !InStr(s, Chr(0xFFFD))
        return s

    alt := ''
    try alt := FileRead(path, 'CP936')
    catch
        return s
    /* 936 读得更干净才换 —— 真正含 U+FFFD 的 UTF-8 文件不会被误判 */
    return (alt != '' && !InStr(alt, Chr(0xFFFD))) ? alt : s
}

FmtBytes(n) {
    n := n + 0
    if (n < 1024)
        return n ' B'
    if (n < 1048576)
        return Format('{:.1f}', n / 1024) ' KB'
    return Format('{:.2f}', n / 1048576) ' MB'
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
        case 'readjson':
            DoReadJson(raw)
        case 'log':
            FileAppend(JsonStr(raw, 'text') '`n', SCRIPT_DIR '\launcher.log', 'UTF-8')
        /* 回调（_ql_callback）：页面解析动作，本地能做的两件事在这里 ——
           画置顶提示框、写日志。见文末「回调」小节。 */
        case 'cb-msg':
            DoCallbackMsg(raw)
        case 'cb-log':
            CbLog(JsonStr(raw, 'text'))
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
        case 'jsonfile':
            throw Error('jsonfile 类型由前端直接读文件（readjson），不应走到 Launch')
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
;  multipart/form-data 组包（等价 curl -F）
;  ---------------------------------------------------------------------------
;  为什么在主进程拼、而不是把文件清单丢给子进程：
;    · spec.ini 放不下嵌套结构，字段值里还可能带 tab / 换行，另约一套编码格式
;      比直接拼字节麻烦得多；
;    · 主进程本来就要展开 {{name}} / {{#…}}，手上已经有最终值；
;    · 拼成一个文件交给子进程，它那边只多一个「按字节读 body」的分支。
;
;  边界串带 16 位随机后缀：固定 boundary 一旦撞上正文内容就会把包切坏。
;  概率极低，但随机后缀的代价是零，没理由不加。
; ============================================================================

BuildMultipart(outPath, fields, files, boundary) {
    /* 先全部校验，再动手写 —— 写到第 3 个才发现文件不存在，前两段就白写了 */
    ready := []
    for f in files {
        p := FileTargetPath(f.path)
        if (p = '')
            throw Error('有一条没写文件路径')
        if DirExist(p)
            throw Error('这是个目录，不是文件：' p)
        if !FileExist(p)
            throw Error('文件不存在：' p)
        size := 0
        try size := FileGetSize(p)
        if (size > MP_FILE_MAX)
            throw Error('文件太大（' FmtBytes(size) '）：' p
                . '，multipart 单文件上限是 ' FmtBytes(MP_FILE_MAX))
        ready.Push({ field: f.field, path: p, name: f.name, ctype: f.ctype, size: size })
    }

    fh := FileOpen(outPath, 'w')
    try {
        for it in fields
            MpWrite(fh, '--' boundary "`r`n"
                . 'Content-Disposition: form-data; name="' MpQuote(it.name) '"' "`r`n`r`n"
                . it.value "`r`n")
        for it in ready {
            MpWrite(fh, '--' boundary "`r`n"
                . 'Content-Disposition: form-data; name="' MpQuote(it.field)
                . '"; filename="' MpQuote(it.name) '"' "`r`n"
                . 'Content-Type: ' it.ctype "`r`n`r`n")
            blob := ReadBlob(it.path, it.size)
            fh.RawWrite(blob.buf, blob.size)
            MpWrite(fh, "`r`n")
        }
        MpWrite(fh, '--' boundary '--' "`r`n")
    } finally {
        fh.Close()
    }
    return outPath
}

/* 把一段文本按 UTF-8 写进已打开的二进制句柄。
   二进制模式下 File 对象没有"写字符串"的入口，RawWrite 只吃 Buffer。 */
MpWrite(fh, s) {
    n := StrPut(s, 'UTF-8') - 1
    if (n <= 0)
        return
    b := Buffer(n, 0)
    StrPut(s, b, 'UTF-8')
    fh.RawWrite(b, n)
}

/* 头里的名字要挡两样：引号（会把 filename="…" 提前闭合）和换行
   （会凭空多出一段头部）。 */
MpQuote(s) {
    s := StrReplace(s, '"', "'")
    return StrReplace(StrReplace(s, "`r", ' '), "`n", ' ')
}

/* 按扩展名猜 MIME，猜不到就用 octet-stream。
   服务端若按 MIME 校验类型，宁可让它收到 octet-stream 报错，
   也不要瞎猜一个 image/png 送过去、被当成坏图静默丢掉。 */
MimeOf(name) {
    static M := Map(
        'txt', 'text/plain', 'json', 'application/json', 'xml', 'application/xml',
        'csv', 'text/csv', 'html', 'text/html', 'htm', 'text/html', 'md', 'text/markdown',
        'jpg', 'image/jpeg', 'jpeg', 'image/jpeg', 'png', 'image/png', 'gif', 'image/gif',
        'webp', 'image/webp', 'bmp', 'image/bmp', 'svg', 'image/svg+xml', 'ico', 'image/x-icon',
        'pdf', 'application/pdf', 'zip', 'application/zip', 'gz', 'application/gzip',
        'tar', 'application/x-tar', '7z', 'application/x-7z-compressed',
        'mp3', 'audio/mpeg', 'wav', 'audio/wav', 'mp4', 'video/mp4', 'webm', 'video/webm',
        'doc', 'application/msword', 'xls', 'application/vnd.ms-excel',
        'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    dot := InStr(name, '.', false, -1)
    if !dot
        return 'application/octet-stream'
    ext := StrLower(SubStr(name, dot + 1))
    return M.Has(ext) ? M[ext] : 'application/octet-stream'
}

; ============================================================================
;  Webhook：请求交给子进程跑，主进程只轮询结果
;  ---------------------------------------------------------------------------
;  WinHttp 是同步的，直接在脚本线程里调会冻住整个窗口（超时 10 秒就是 10 秒假死）。
;  所以：主进程写 spec.ini -> 起 `--webhook` 子进程 -> 定时看 meta.ini 是否出现。
; ============================================================================

DoWebhook(raw) {
    global HTTP_DIR, httpJobs

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
    for f in ['meta.ini', 'body.txt', 'spec.ini', 'h.txt', 'b.txt', 'b.bin']
        try FileDelete(dir '\' f)

    /* multipart：有文件要传就整个走它，body 不参与。
       前端把清单压平成 "字段\u0001路径\u0001文件名\u0001MIME" 的字符串数组，
       因为 JsonStr 只认顶层字符串字段，取不出 multipart.files 这种嵌套结构。 */
    mpFiles := JsonStrArray(raw, 'mpFiles')
    mpFields := JsonStrArray(raw, 'mpFields')
    isMp := (mpFiles.Length > 0)
    boundary := isMp ? '----QuickLaunch' RandAlnum(16) : ''

    ; 请求头由前端给成 "Name: Value" 的字符串数组 —— 避免在这里解析嵌套 JSON。
    ; 每行过一次 HdrExpand：{{#ts}} / {{#hmac:...}} / {{#file:...}} 这类动态值在请求头
    ; 这一层展开（body 也过一次，见下面的 else 分支），展开失败（密钥名写错、文件不存在）
    ; 直接拒发 —— 带着错签名发出去比不发更糟。
    hs := ''
    try {
        for h in JsonStrArray(raw, 'headers')
            hs .= HdrLine(h) '`n'
        /* boundary 是我们自己生成的，用户不可能提前写在配置里；真写了就尊重他 */
        if (isMp && !RegExMatch(hs, 'i)content-type\s*:'))
            hs .= 'Content-Type: multipart/form-data; boundary=' boundary "`n"
    } catch as e {
        try DirDelete(dir, true)
        JsSend('{"type":"http-result","id":' JsonQuote(id) ',"ok":0,"status":0,"ms":0'
            ',"truncated":0,"error":' JsonQuote('请求头展开失败：' e.Message) ',"body":""}')
        return
    }
    try FileAppend(hs, dir '\h.txt', 'UTF-8-RAW')

    bodyKind := 'text', bodyPath := dir '\b.txt'

    if isMp {
        fields := []
        for line in mpFields {
            parts := StrSplit(line, Chr(1), '', 2)      ; 只切一刀，值里再出现也不管
            if (parts.Length >= 2)
                fields.Push({ name: parts[1], value: parts[2] })
        }
        files := []
        for line in mpFiles {
            parts := StrSplit(line, Chr(1))
            if (parts.Length < 2 || parts[2] = '')
                continue
            fname := (parts.Length >= 3) ? parts[3] : ''
            if (fname = '')                              ; 没给就沿用磁盘上的文件名
                fname := RegExReplace(parts[2], '^.*[\\/]', '')
            ctype := (parts.Length >= 4) ? parts[4] : ''
            if (ctype = '')
                ctype := MimeOf(fname)
            files.Push({ field: parts[1], path: parts[2], name: fname, ctype: ctype })
        }

        bodyPath := dir '\b.bin'
        try
            BuildMultipart(bodyPath, fields, files, boundary)
        catch as e {
            try DirDelete(dir, true)
            JsSend('{"type":"http-result","id":' JsonQuote(id) ',"ok":0,"status":0,"ms":0'
                ',"truncated":0,"error":' JsonQuote('multipart 组包失败：' e.Message) ',"body":""}')
            return
        }
        bodyKind := 'binary'
    } else {
        /* body 也过一次展开：{{#file:…}} 让「整个请求体来自一个本地文件」成立，
           等价 curl 的 --data-binary @x。这里用 HdrExpand 而不是 HdrLine ——
           后者会拒绝换行，而多行 JSON 是正常请求体。 */
        body := JsonStr(raw, 'body')
        try
            body := HdrExpand(body)
        catch as e {
            try DirDelete(dir, true)
            JsSend('{"type":"http-result","id":' JsonQuote(id) ',"ok":0,"status":0,"ms":0'
                ',"truncated":0,"error":' JsonQuote('请求体展开失败：' e.Message) ',"body":""}')
            return
        }
        try FileAppend(body, dir '\b.txt', 'UTF-8-RAW')
    }

    spec := dir '\spec.ini'
    IniWrite(method, spec, 'req', 'Method')
    IniWrite(url, spec, 'req', 'Url')
    IniWrite(timeout, spec, 'req', 'Timeout')
    IniWrite(dir '\h.txt', spec, 'req', 'HeadersFile')
    IniWrite(bodyPath, spec, 'req', 'BodyFile')
    IniWrite(bodyKind, spec, 'req', 'BodyKind')
    IniWrite(dir, spec, 'req', 'OutDir')

    pid := 0
    try {
        pid := RunWebhook(spec)
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
            err := '请求进程异常退出（子进程报错了，用 --webhook 手动跑一遍那个 spec.ini 看输出）'
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
            /* 回调片段在**截断之前**切：面板只显示前 400KB，但 _ql_callback 完全
               可能落在后面。切出来的是原始 JSON 片段，解析交给页面（JSON.parse）。 */
            cbRaw := ''
            if (err = '') {
                sl := CbSlice(body)
                if (sl.why = 'bad')
                    CbLog('检测到 _ql_callback，但这一块切不出来（响应不是合法 JSON？）—— 已忽略')
                else if (sl.raw != '') {
                    if (StrLen(sl.raw) > CB_RAW_MAX)
                        CbLog('_ql_callback 超过 ' CB_RAW_MAX ' 字符（' StrLen(sl.raw) '）—— 已忽略')
                    else
                        cbRaw := sl.raw
                }
            }

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
                    . ',"cb":' JsonQuote(cbRaw)
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
;  回调（_ql_callback）
;  ---------------------------------------------------------------------------
;  远端接口在响应 JSON 的**根对象**上带一个 _ql_callback，就按里面的 actions
;  执行本地动作；没有这个键 = 什么都没发生（现有行为一字不变）。
;
;  为什么只认根对象第一层：既是防撞（业务响应深处出现同名字段不该触发本地动作），
;  也是防误伤（第三方接口返回一坨原文里带这个串，不该被执行）。
;
;  分工（刻意这么切）：
;    AHK  只做本地才能做的两件事 —— 从正文里切出这块原始 JSON（正文和 400KB
;         截断都在主进程），以及画那个提示框 / 写日志。
;    页面 解析与执行。WebView 里 JSON.parse 天然稳妥；"调用某个条目"直接复用
;         用户点条目时那条 launch()，app / cmd / ahk / url / folder / webhook /
;         download / jsonfile 全都走同一套实现 —— 连"运行时参数"（args / params）
;         和条目自己的 {{参数}} 替换也一并复用。
;
;  提示框两套并存，页面按 config.json 的 callback.popup 决定用哪套（缺省 native）：
;    native  系统消息框 + Owner<主窗口>。主窗口是 AlwaysOnTop，裸框会落在它下面
;            （实测低 8 层：z 10 vs 2），所以必须把主窗口当 owner 传进去 —— Windows
;            规定被拥有窗口永远在 owner 之上，owner 在置顶层，框就被一起抬进置顶层
;            （实测扩展样式多出 WS_EX_TOPMOST）。顺带白拿系统提示音、Ctrl+C 复制正文、
;            按 owner 居中、按钮随系统语言。
;    custom  自绘窗口，固定 +AlwaysOnTop。眼下和 native 只差样式，留着是为了将来：
;            回调要返回带样式的文本 / 图片 / HTML 时，MsgBox 就装不下了。
;
;  ⚠ 早先这里写过"MsgBox 没有置顶选项"—— 那是错的。没有 AlwaysOnTop 选项，
;    但有 Owner<hwnd>，效果一样（见 CbBoxNative 的实测记录）。
;
;  为什么不在这里解析 action：run 到一个 webhook 条目要拼 URL、展开模板、组
;  multipart —— 在这里再写一份就是第二份实现，早晚和页面那份对不上（这个项目
;  最贵的一课）。AHK 只管"切"和"画"，不管"懂"。
;
;  防环（链）由页面携带，见 ui/app.js 的 cbDispatch：按 id 记祖先 + 深度兜底。
; ============================================================================

CbLog(text) {
    global cbSilent
    if cbSilent                       ; 自检不该往用户的 launcher.log 里掺噪音
        return
    line := FormatTime(A_Now, 'yyyy-MM-dd HH:mm:ss') '  [cb] ' text "`n"
    try FileAppend(line, SCRIPT_DIR '\launcher.log', 'UTF-8')
}

/* 标量/容器值的结束位置（不含）。字符串用正则一次跳过整段 —— 逐字符 SubStr
   在 400KB 正文上要 100ms 以上，而开销几乎全在"跳过很长的字符串值"。 */
SkipWs(s, i, n) {
    while (i <= n && InStr(" `t`r`n", SubStr(s, i, 1)))
        i++
    return i
}

/* 入参 i 指向开引号，返回闭合引号**之后**的位置；没有闭合引号返回 0 */
StrEnd(s, i) {
    if RegExMatch(s, '(?s)"[^"\\]*(?:\\.[^"\\]*)*"', &m, i) && m.Pos = i
        return i + m.Len
    return 0
}

ValEnd(s, i) {
    static STRUCT := '["\[\]{}]'
    n := StrLen(s)
    if (i > n)
        return 0
    c := SubStr(s, i, 1)
    if (c = '"')
        return StrEnd(s, i)
    if (c = '{' || c = '[') {
        open := c
        close := (c = '{') ? '}' : ']'
        depth := 0
        j := i
        while (j <= n) {
            if !RegExMatch(s, STRUCT, &m, j)      ; 跳到下一个结构字符，中间整段跳过
                return 0
            j := m.Pos
            if (m[0] = '"') {
                e := StrEnd(s, j)
                if !e
                    return 0
                j := e
                continue
            }
            if (m[0] = open)
                depth++
            else if (m[0] = close) {
                depth--
                if (depth = 0)
                    return j + 1
            }
            j++
        }
        return 0
    }
    if RegExMatch(s, '[,\]}\s]', &m, i)           ; 数字 / true / false / null
        return (m.Pos > i) ? m.Pos : 0
    return n + 1
}

/* 从响应正文切出根对象上的 _ql_callback 原始片段。
   返回 {raw, why}：why = 'none' 没有这个键 / 'nested' 只在深层出现（按设计忽略）
   / 'bad' 根上有但切不动（正文不是合法 JSON）/ '' 切到了。 */
CbSlice(body) {
    if !InStr(body, '_ql_callback', false)
        return { raw: '', why: 'none' }
    n := StrLen(body)
    i := SkipWs(body, 1, n)
    if (SubStr(body, i, 1) != '{')
        return { raw: '', why: 'nested' }
    i := SkipWs(body, i + 1, n)
    while (i <= n) {
        c := SubStr(body, i, 1)
        if (c = '}')
            return { raw: '', why: 'nested' }
        if (c = ',') {                            ; 容错：多余的逗号
            i := SkipWs(body, i + 1, n)
            continue
        }
        if (c != '"')
            return { raw: '', why: 'bad' }
        e := StrEnd(body, i)
        if !e
            return { raw: '', why: 'bad' }
        key := SubStr(body, i + 1, e - i - 2)
        i := SkipWs(body, e, n)
        if (SubStr(body, i, 1) != ':')
            return { raw: '', why: 'bad' }
        i := SkipWs(body, i + 1, n)
        vEnd := ValEnd(body, i)
        if !vEnd
            return { raw: '', why: 'bad' }
        if (key = '_ql_callback')
            return { raw: SubStr(body, i, vEnd - i), why: '' }
        i := SkipWs(body, vEnd, n)
        if (SubStr(body, i, 1) = ',')
            i := SkipWs(body, i + 1, n)
    }
    return { raw: '', why: 'nested' }
}

/* 消息框走队列 + 定时器，不直接在 WebView2 的消息回调里弹：
   在 COM 回调栈上弹模态框是自找麻烦（native 那套是模态的，排队也就顺理成章：
   一条响应里连发三个 msg，不该三个框糊在一起）。 */
DoCallbackMsg(raw) {
    global cbBoxQ
    text := SubStr(JsonStr(raw, 'text'), 1, CB_TEXT_MAX)
    if (Trim(text, " `t`r`n") = '')
        return
    title := Trim(JsonStr(raw, 'title'), ' `t')
    title := (title = '') ? 'QuickLaunch' : SubStr(title, 1, CB_TITLE_MAX)
    /* 用哪套弹窗由页面按 config.json 的 callback.popup 决定并带下来。
       页面是唯一读 config.json 的地方（AHK 不解析 JSON 是本项目的硬约定），
       所以这里只认它给的值，认不出来就按缺省 native。 */
    cbBoxQ.Push({
        level: (JsonStr(raw, 'level') = 'error') ? 'error' : 'ok',
        title: title,
        text: text,
        timeout: Max(0, Min(600, Floor(JsonNum(raw, 'timeout', 0)))),
        quiet: JsonNum(raw, 'quiet', 0) ? 1 : 0,
        popup: CbPopupMode(JsonStr(raw, 'popup'))
    })
    CbLog('消息框入队（' cbBoxQ[cbBoxQ.Length].level '/' cbBoxQ[cbBoxQ.Length].popup '）'
        '：' OneLine(text, 100))
    SetTimer(CallbackPump, -1)
}

/* 认不出来的值一律回落 native：少写一个字母不该变成"什么都不弹" */
CbPopupMode(v) {
    v := Trim(v, ' `t')
    if (v = 'custom' || v = 'gui' || v = 'window')
        return 'custom'
    return 'native'
}

CallbackPump() {
    global cbBoxQ, cbBoxBusy, cbBoxWin
    if (cbBoxBusy || !cbBoxQ.Length)
        return
    a := cbBoxQ.RemoveAt(1)
    cbBoxBusy := true
    try {
        if a.quiet {
            /* 定时任务触发的链：没人看着，弹个模态框只会半夜挂在那里 */
            TrayTip(a.text, a.title)
            CbLog('安静模式：改用托盘提示（' a.level '）')
            CbBoxDone()
        } else if (a.popup = 'custom') {
            CbBoxShow(a)
        } else {
            CbBoxNative(a)
        }
    } catch as e {
        CbLog('消息框失败：' CleanComError(e.Message))
        cbBoxWin := 0
        CbBoxDone()
    }
}

/* 原生消息框 + Owner —— 缺省的那套。
   ★ 为什么裸 MsgBox 不行：主窗口是 AlwaysOnTop，裸框是普通层窗口，实测落在
     主窗口下面 8 层（z 10 vs 2）—— 有声音、看不见内容，正是用户报的那个 bug。
   ★ 为什么 Owner 就够：Windows 规定被拥有窗口永远在 owner 之上；owner 在置顶层，
     框就被一起抬进置顶层（实测扩展样式 0x10101 → 0x10109，多出的 0x8 是
     WS_EX_TOPMOST，系统自己加的）。同一句话还把 Ctrl+C 复制正文、按 owner 居中、
     按钮随系统语言一起带回来了。选项串里 Owner 后面直接拼十进制 hwnd（实测可拼）。
   ★ 代价是模态：这句不返回，队里后面的消息就等着 —— "关一条再放一条"本来就是
     这队列要的效果。调用点在 SetTimer 拉起的独立线程里，不在 COM 回调栈上。 */
CbBoxNative(a) {
    global g
    /* 主窗口不在屏幕上（ShowOnStart=0 时进程启动就把它摆在 -32000 备着）就不能当 owner：
       MessageBox 会按 owner 居中，框会跟着跑到看不见的地方 —— 那就不是"置顶"而是
       "置到屏幕外"了。这种时候退回自绘那套（屏幕居中 + 自己置顶）。 */
    if !CbOwnerUsable() {
        CbLog('主窗口不在屏幕上，这条改用自绘框（' a.level '）')
        CbBoxShow(a)
        return
    }
    text := a.text
    if (StrLen(text) > CB_TEXT_SHOW)
        text := SubStr(text, 1, CB_TEXT_SHOW) '…（正文过长，已截断；完整内容见响应面板）'
    opts := (a.level = 'error') ? 'Iconx' : 'Iconi'      ; 顺带把系统提示音也带出来
    if a.timeout
        opts .= ' T' a.timeout
    opts .= ' Owner' g.Hwnd
    try
        MsgBox(text, a.title, opts)
    catch as e {
        /* Owner 拼错、选项不认之类：别让一条消息把队列卡死，退到自绘那套 */
        CbLog('原生消息框失败，改用自绘：' CleanComError(e.Message))
        CbBoxShow(a)
        return
    }
    CbLog('消息框已关闭（' a.level '，native）')
    CbBoxDone()
}

/* 主窗口能不能当 owner：存在、可见、且至少有一部分落在虚拟屏幕里 */
CbOwnerUsable() {
    global g
    if !(IsObject(g) && g.Hwnd)
        return 0
    if !DllCall('user32\IsWindowVisible', 'ptr', g.Hwnd, 'int')
        return 0
    r := Buffer(16, 0)
    if !DllCall('user32\GetWindowRect', 'ptr', g.Hwnd, 'ptr', r, 'int')
        return 0
    x := NumGet(r, 0, 'int')
    y := NumGet(r, 4, 'int')
    w := NumGet(r, 8, 'int') - x
    h := NumGet(r, 12, 'int') - y
    if (w <= 0 || h <= 0)
        return 0
    vx := DllCall('user32\GetSystemMetrics', 'int', 76, 'int')    ; SM_XVIRTUALSCREEN
    vy := DllCall('user32\GetSystemMetrics', 'int', 77, 'int')
    vw := DllCall('user32\GetSystemMetrics', 'int', 78, 'int')    ; SM_CXVIRTUALSCREEN
    vh := DllCall('user32\GetSystemMetrics', 'int', 79, 'int')
    return (x < vx + vw && y < vy + vh && x + w > vx && y + h > vy) ? 1 : 0
}

/* 一条消息处理完了：放行下一条。关窗、超时、建窗失败都走这里，
   免得 cbBoxBusy 卡在 true 上把后面所有消息都堵死。 */
CbBoxDone() {
    global cbBoxBusy, cbBoxQ
    cbBoxBusy := false
    if cbBoxQ.Length
        SetTimer(CallbackPump, -1)
}

/* 自绘回调消息框（callback.popup = "custom" 时用这套；缺省走 CbBoxNative）。
   ★ 为什么留着：原生框只能放纯文本，回调将来要返回带样式的文本 / 图片 / HTML，
     MsgBox 装不下，得有个能自己排版的壳。眼下两套的差别只有样式。
   ★ 为什么自绘还得自己响一声：系统提示音是 MessageBox 按图标标志位放的，自绘窗口
     没有这一步，只听得到"窗口出现"看不到的那种安静 —— 用 MessageBeep 补，
     它和 MessageBox 内部是同一个声源（0x40 = Asterisk 对应 Iconi，0x10 = Hand 对应 Iconx）。
     而任务栏闪烁补不回来也不该补：那颗闪的是"框自己没拿到前台"的补偿，
     主窗口是 +ToolWindow 本来就没有任务栏按钮（见 README 的回调小节）。
   ★ 为什么非模态：串行交给 cbBoxBusy —— 关掉一条再放行下一条，不会五个框叠在一起。

   注意：这里的 g 是**局部变量**（对话框），别在这个函数里写 global g ——
   那会把主窗口那个 g 抢过来，CbBoxNative 的 Owner 就会指向刚建的这个框。 */
CbBoxShow(a) {
    global cbBoxWin

    text := a.text
    if (StrLen(text) > CB_TEXT_SHOW)
        text := SubStr(text, 1, CB_TEXT_SHOW) '…（正文过长，已截断；完整内容见响应面板）'
    w := CbBoxWidth(text)

    g := Gui('+AlwaysOnTop +ToolWindow -MinimizeBox -MaximizeBox', a.title)
    g.BackColor := 'FFFFFF'
    g.MarginX := 18
    g.MarginY := 14

    /* 首行图标 + 级别：颜色一眼区分成功/失败，不用读正文 */
    g.SetFont('s12 bold c' (a.level = 'error' ? 'D93025' : '1E8E3E'), 'Microsoft YaHei UI')
    g.AddText('xm ym', (a.level = 'error' ? '✕ 错误' : '✓ 成功'))

    g.SetFont('s10 c202124', 'Microsoft YaHei UI')
    g.AddText('xm y+9 w' w, text)

    g.SetFont('s9 c5B6169', 'Microsoft YaHei UI')
    btn := g.AddButton('x' (18 + w - 84) ' y+18 w84 Default', '确定')
    if a.timeout {
        g.SetFont('s9 c8A9099', 'Microsoft YaHei UI')
        g.AddText('xm yp+5 w' (w - 96), a.timeout ' 秒后自动关闭')
    }

    close(*) {
        global cbBoxWin
        if !cbBoxWin
            return
        cbBoxWin := 0
        try SetTimer(close, 0)
        try g.Destroy()
        CbLog('消息框已关闭（' a.level '）')
        CbBoxDone()
    }

    g.OnEvent('Close', close)
    g.OnEvent('Escape', close)
    btn.OnEvent('Click', close)

    cbBoxWin := g
    g.Show('AutoSize Center')
    /* 系统提示音：原生那套由 Iconi/Iconx 标志位自动放，自绘窗口得自己补一声。
       0x40 = Asterisk（对应 Iconi 的"咚"），0x10 = Hand（对应 Iconx）。响了才算数，
       失败也不影响显示。 */
    try DllCall('user32\MessageBeep', 'uint', (a.level = 'error') ? 0x10 : 0x40)
    /* +AlwaysOnTop 已经加过了，这里再压一遍：同层里还有别的置顶窗口时，
       光靠样式位不保证它在最上面。露脸前把焦点也拿过来，别让用户看不见。 */
    try WinSetAlwaysOnTop(1, 'ahk_id ' g.Hwnd)
    try WinActivate('ahk_id ' g.Hwnd)
    if a.timeout
        SetTimer(close, -(a.timeout * 1000))
    CbLog('消息框已显示（' a.level (a.timeout ? '，' a.timeout 's 后自动关' : '') '）')
}

/* 对话框宽度：中文按 1em 估、ASCII 按 0.55em 估，只求"别太窄也别撑破屏幕"。
   精确排版交给静态控件自己换行（宽度定了它就按字宽折）。 */
CbBoxWidth(text) {
    static MAXW := 560, MINW := 300
    w := 0
    for line in StrSplit(text, '`n') {
        u := 0
        Loop Parse, line
            u += (Ord(A_LoopField) > 0x2E80) ? 13.5 : 7.4
        w := Max(w, u)
    }
    return Round(Max(MINW, Min(MAXW, w + 10)))
}

/* 日志里一行一条：正文里的换行会把一条日志撑成好几行，排障时很难读 */
OneLine(s, max := 80) {
    s := StrReplace(StrReplace(StrReplace(s, "`r", ' '), "`n", ' / '), "`t", ' ')
    return (StrLen(s) > max) ? SubStr(s, 1, max) '…' : s
}

; ---- 自检：只跑切片，不弹框、不建窗口（见 tests/callback.test.js） -----------

CbTestArg(argv, &dir) {
    dir := ''
    if (argv.Length < 2 || argv[1] != '--selftest-callback')
        return false
    dir := Trim(argv[2], ' `t"')
    return true
}

/* 消息框自检：两套都真建一个，验「置顶 / 归属 / 自动关闭」，然后自己退出。
   "被主窗口压住" 是肉眼最难发现的一类坏法 —— 有提示音、有日志，就是看不见，
   所以这条必须由程序自己断言 WS_EX_TOPMOST，不能靠看。

   native 那条是模态的，量它只能在它挂着的时候下手：先挂一个定时器，再从当前线程
   调 CbBoxNative —— MessageBox 有自己的消息循环，定时器在它里面照样会被派发
   （已经实测过），量完写进共享对象，模态返回后读。 */
CbMsgTestArg(argv) {
    return (argv.Length >= 1 && argv[1] = '--selftest-cbmsg')
}

CbMsgTest() {
    global cbBoxWin, cbBoxBusy, cbSilent, g
    cbSilent := true                     ; 自检不写日志

    /* 这个自检跑在主窗口之前（见启动引导），得先造一个 +AlwaysOnTop 的替身当 owner，
       否则 CbBoxNative 没有 owner 可挂，测不到 "owner 把框抬进置顶层" 这条关键行为。
       替身用的就是主窗口那套样式（+ToolWindow +AlwaysOnTop）。 */
    g := Gui('+ToolWindow +AlwaysOnTop', 'QLCB-SELFTEST-MAIN')
    g.Show('w220 h140 Center')

    ; ---- native：靠定时器在框挂着时量 ----
    n := {found: 0, top: 0, owner: 0}
    SetTimer(ProbeNative.Bind(n, 'QLCB-SELFTEST-N'), -350)
    t := A_TickCount
    CbBoxNative({level: 'success', title: 'QLCB-SELFTEST-N'
        , text: '回调消息框自检（native）：应该压在主窗口之上，1 秒后自动关闭。'
        , timeout: 1, quiet: 0})
    nms := A_TickCount - t
    nClosed := (nms >= 800 && nms <= 6000) ? 1 : 0   ; 真的等到 T1 到点才返回

    ; ---- custom：原来的流程 ----
    cbBoxBusy := true
    CbBoxShow({level: 'success', title: 'QLCB-SELFTEST-C'
        , text: '回调消息框自检（custom）：应该在最上层，并在 1 秒后自动关闭。'
        , timeout: 1, quiet: 0})

    Sleep 300
    hwnd := 0
    try hwnd := cbBoxWin ? cbBoxWin.Hwnd : 0
    ex := hwnd ? WinGetExStyle('ahk_id ' hwnd) : 0
    vis := hwnd ? DllCall('user32\IsWindowVisible', 'ptr', hwnd, 'int') : 0

    Loop 50 {                            ; 等自动关闭（1 秒 + 余量）
        if !cbBoxWin
            break
        Sleep 100
    }
    cClosed := cbBoxWin ? 0 : 1
    cTop := (ex & 0x8) ? 1 : 0           ; WS_EX_TOPMOST

    StdOut('{"n_exists":' n.found ',"n_topmost":' n.top ',"n_owner":' n.owner
        . ',"n_closed":' nClosed
        . ',"c_exists":' vis ',"c_topmost":' cTop ',"c_closed":' cClosed '}`n')
    return (n.found && n.top && n.owner && nClosed && vis && cTop && cClosed) ? 0 : 1
}

/* 在 native 框还挂着的时候量它：按类名 + 标题找 #32770，读扩展样式与 owner */
ProbeNative(o, title) {
    global g
    h := 0
    for w in WinGetList('ahk_class #32770') {
        try {
            if !InStr(WinGetTitle('ahk_id ' w), title)
                continue
            if !DllCall('user32\IsWindowVisible', 'ptr', w, 'int')
                continue
            h := w
            break
        }
    }
    if !h
        return
    ex := WinGetExStyle('ahk_id ' h)
    owner := DllCall('user32\GetWindow', 'ptr', h, 'uint', 4, 'ptr')   ; GW_OWNER
    o.found := 1
    o.top := (ex & 0x8) ? 1 : 0
    o.owner := (IsObject(g) && owner = g.Hwnd) ? 1 : 0
}

CbTest(dir) {
    if !InStr(FileExist(dir), 'D') {
        StdOut('目录不存在：' dir '`n', true)
        return 2
    }
    n := 0
    Loop Files, dir '\*.json', 'F' {
        f := A_LoopFileFullPath
        try body := FileRead(f, 'UTF-8')
        catch {
            StdOut('{"file":' JsonQuote(A_LoopFileName) ',"error":"read"}' '`n')
            continue
        }
        r := CbSlice(body)
        StdOut('{"file":' JsonQuote(A_LoopFileName)
            . ',"raw":' JsonQuote(r.raw) ',"why":' JsonQuote(r.why) '}' '`n')
        n++
    }
    StdOut('{"summary":{"files":' n '}}' '`n')
    return 0
}

; ============================================================================
;  Download：webhook 的变种，差别只在"响应体去哪"
;  ---------------------------------------------------------------------------
;  和 DoWebhook 共用同一套骨架：写 spec.ini -> 起 `--webhook` 子进程 -> 轮询结果。
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
                hs .= HdrLine(h) '`n'
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
        pid := RunWebhook(spec)
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
;  请求头 / 请求体里的动态值：{{#函数名:参数}}
;
;  展开面只有 headers 和 body（外加 {{#file:…}} 的路径本身）。
;  target / query / multipart 不写这一步 —— 那里写了会原样发出去。
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
;  支持（全部走 Windows 自带实现，不引第三方 DLL / 外部 exe）：
;    {{#ts}}                    Unix 秒
;    {{#tsms}}                  Unix 毫秒
;    {{#uuid}}                  UUID v4
;    {{#nonce:16}}              N 位随机小写字母数字（默认 16，上限 128）
;    {{#env:NAME}}              环境变量 NAME 的值（取不到就报错，不给空串）
;    {{#md5:文本}}              十六进制摘要；同族还有 sha1 / sha256 / sha384 / sha512
;    {{#base64:文本}}           UTF-8 文本的 Base64；base64url 版本去掉 +/ 补位（=）
;    {{#hmac:密钥名:待签内容}}   十六进制 HMAC-SHA256，密钥取自 SIG_KEYS
;    {{#hmac-sha1:密钥名:内容}}  同族还有 hmac-md5 / hmac-sha256 / hmac-sha384 / hmac-sha512
;
;  所有"吃文本"的函数（摘要 / base64 / hmac）都先过一遍单花括号展开，
;  所以 {{#base64:{uuid}}}、{{#hmac:demo:GET{ts}}} 都能用。
;
;  待签内容里可以用**单花括号**引用另一个动态值：{{#hmac:demo:{ts}}}
;  —— 为什么不是 {{#hmac:demo:{{#ts}}}}：内层收尾紧跟外层收尾会凑出 }}}}，
;  那是前端「输出字面 }}」的逃生口（见 ui/app.js 的 TPL_RE），会被吃成 }}，
;  于是签名占位符少两个括号、整条失效。单花括号两头都不碰，最省事。
;  单花括号只认 ts / tsms / uuid / nonce，不支持再套 hmac（避免递归自套）。
; ============================================================================
HdrExpand(line) {
    /* 哨兵：文件内容里的 "{{#" 先换成「哨兵 + #」，循环结束时再还原。
       没有它的话，传一个 Handlebars / Jinja2 模板文件当请求体，第二轮展开
       会把文件里的 {{#each …}} 当成占位符去算，内容当场变形。
       用私用区字符（U+E000），正常文本里不会出现。 */
    static GUARD := Chr(0xE000)
    /* 早退也要还原哨兵：{{@config}} 注入的正文可能一个真占位符都没有
       （配置里写的 {{#hmac:…}} 全被页面用哨兵挡住了），这时直接 return 会把
       哨兵留在 body 里发出去。 */
    if !InStr(line, '{{#')
        return InStr(line, GUARD) ? StrReplace(line, GUARD, '{') : line
    Loop 4 {                              ; 里层先展开，外层用结果再算一次
        out := '', pos := 1, hit := false
        m := ''
        /* 内层允许一对单花括号：{{#hmac:demo:{ts}}} —— 但不能有第二层 */
        while RegExMatch(line, '\{\{#((?:[^{}]|\{[^{}]*\})*)\}\}', &m, pos) {
            r := HdrEval(m[1])
            if r.ok {
                v := r.val
                /* file 系列的结果是「数据」不是「模板」，不许再参与展开。
                   只把**第一个**大括号换成哨兵，第二个原样留着 —— 换成两个的话
                   还原时只能还原出一个，{{#each 会变成 {#each。 */
                if (r.HasProp('nore') && r.nore)
                    v := StrReplace(v, '{{#', GUARD '{#')
                out .= SubStr(line, pos, m.Pos - pos) . v
                hit := true
            } else
                out .= SubStr(line, pos, m.Pos - pos) . m[0]
            pos := m.Pos + m.Len
        }
        out .= SubStr(line, pos)
        /* 哨兵不是 "{{#"，所以这里只认真占位符 —— 文件内容里的不会让循环白跑 */
        if (!hit || !InStr(out, '{{#'))
            return StrReplace(out, GUARD, '{')
        line := out
    }
    return StrReplace(line, GUARD, '{')
}

/* 展开一整行请求头，并挡住「换行注入」。
   {{#env:…}} 的值来自进程环境（由外部注入），里面要是带 CR/LF，写进 h.txt 就会
   凭空多出一行 —— 那条多出来的会变成一个额外的请求头（RFC 7230 明确禁止）。
   这里直接拒发：报错比悄悄改写成别的请求安全得多。 */
HdrLine(raw) {
    line := HdrExpand(raw)
    if RegExMatch(line, '[\r\n]')
        throw Error('展开后出现换行，已拒绝发送：' (StrLen(raw) > 60 ? SubStr(raw, 1, 60) '…' : raw))
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
        case 'env':
            return {ok: true, val: HdrEnv(rest)}
        /* file 系列的结果是文件内容，不是模板 —— 打上 nore，HdrExpand 不会再展开它 */
        case 'file':
            return {ok: true, val: HdrFile(rest, 'text'), nore: 1}
        case 'file-raw':
            return {ok: true, val: HdrFile(rest, 'raw'), nore: 1}
        case 'filebase64':
            return {ok: true, val: HdrFile(rest, 'base64'), nore: 1}
        case 'filehash':
            return {ok: true, val: HdrFileHash(rest), nore: 1}
        case 'md5', 'sha1', 'sha256', 'sha384', 'sha512':
            return {ok: true, val: HashHex(HdrInline(rest), HashAlgo(name))}
        case 'base64', 'base64url':
            return {ok: true, val: B64Encode(HdrInline(rest), name = 'base64url')}
        case 'hmac', 'hmac-md5', 'hmac-sha1', 'hmac-sha256', 'hmac-sha384', 'hmac-sha512':
            ; hmac:密钥名:待签内容  —— 只按第一个冒号切，内容里的冒号照旧
            q := InStr(rest, ':')
            if !q
                throw Error('hmac 少了参数，写法是 {{#hmac:密钥名:待签内容}}')
            kname := Trim(SubStr(rest, 1, q - 1), ' ' . "`t")
            if !SIG_KEYS.Has(kname)
                throw Error('未知的签名密钥名「' kname '」——在 launcher.ahk 的 SIG_KEYS 里定义')
            /* 裸 hmac 沿用 SHA-256（和上一版配置兼容）；带后缀的按后缀选算法 */
            algo := (name = 'hmac') ? 'SHA256' : HashAlgo(SubStr(name, 6))
            return {ok: true, val: HashHex(HdrInline(SubStr(rest, q + 1)), algo, SIG_KEYS[kname])}
    }
    return {ok: false, val: ''}          ; 不认识：原样留着
}

/* {{#env:NAME}} —— 读环境变量。
   取不到时**报错而不是给空串**：空值会让 Authorization 变成 "Bearer "，
   服务端只回 401，人却会以为是签名算法写错了。宁可拒发并说清是哪个变量没定义。 */
HdrEnv(name) {
    name := Trim(name, ' ' . "`t")
    if (name = '')
        throw Error('env 少了变量名，写法是 {{#env:NAME}}')
    v := EnvGet(name)
    if (v = '')
        throw Error('环境变量「' name '」没有定义或为空')
    return v
}

/* {{#file:路径}} / {{#file-raw:路径}} / {{#filebase64:路径}} / {{#filehash:算法:路径}}
   —— 把本地文件读进模板，补上 curl 的 `-d @file` / `-F file=@x` 那类能力。

   三种读法对应三种去向，不能混：
     text / raw   读成字符串（BOM 自动识别、GBK 回退），拼进 body 或请求头
     base64       按字节读，编码成 ASCII，塞进 JSON 字段
     hash         按字节读，算摘要，用于 X-Content-SHA256 这类校验头

   二进制进 text/raw 是**静默损坏**：FileRead 按 UTF-8 解码，非法字节变成
   U+FFFD，再编码回去就不是原文件了，而请求照样可能返回 200。所以这里主动扫
   一遍 NUL 字节挡住它，报错让用户换 filebase64 —— 比发出去一个坏文件强得多。 */
HdrFile(spec, mode) {
    p := FileTargetPath(Trim(spec, ' ' . "`t"))
    if (p = '')
        throw Error('{{#file:…}} 少了文件路径')
    if DirExist(p)
        throw Error('这是个目录，不是文件：' p)
    if !FileExist(p)
        throw Error('文件不存在：' p)

    size := 0
    try size := FileGetSize(p)
    if (size > TPL_FILE_MAX)
        throw Error('文件太大（' FmtBytes(size) '），模板内联的上限是 ' FmtBytes(TPL_FILE_MAX)
            . '；要传更大的文件请用 multipart')

    blob := ReadBlob(p, size)

    if (mode = 'base64')
        return B64OfBlob(blob.buf, blob.size)
    if (mode = 'hash')
        return HashHexBytes(blob.buf, blob.size, 'SHA256')

    if IsBinaryBlob(blob)
        throw Error('这是二进制文件（' FmtBytes(size) '），拼进文本会损坏内容。'
            . '改用 {{#filebase64:' Trim(spec) '}} 或 multipart 上传')

    err := ''
    s := ReadTextFile(p, &err)
    if (err != '')
        throw Error(err)
    /* 默认裁掉尾部 CR/LF：token 文件、JSON 几乎都带一个编辑器补的换行。
       不裁的话 {{#file:token.txt}} 塞进 Authorization 头会被 HdrLine 拒发，
       而报错（"展开后出现换行"）完全指不到那个换行是文件带来的。 */
    return (mode = 'raw') ? s : RTrim(s, "`r`n")
}

/* {{#filehash:算法:路径}} —— 按第一个冒号切，算法名不区分大小写 */
HdrFileHash(rest) {
    q := InStr(rest, ':')
    if !q
        throw Error('filehash 少了参数，写法是 {{#filehash:sha256:路径}}')
    algo := StrUpper(Trim(SubStr(rest, 1, q - 1), ' ' . "`t"))
    if !RegExMatch(algo, '^(MD5|SHA1|SHA256|SHA384|SHA512)$')
        throw Error('filehash 不认这个算法：' algo '（支持 md5 / sha1 / sha256 / sha384 / sha512）')

    p := FileTargetPath(Trim(SubStr(rest, q + 1), ' ' . "`t"))
    if (p = '')
        throw Error('filehash 少了文件路径')
    if DirExist(p)
        throw Error('这是个目录，不是文件：' p)
    if !FileExist(p)
        throw Error('文件不存在：' p)

    size := 0
    try size := FileGetSize(p)
    if (size > TPL_FILE_MAX)
        throw Error('文件太大（' FmtBytes(size) '），filehash 的上限是 ' FmtBytes(TPL_FILE_MAX))

    blob := ReadBlob(p, size)
    return HashHexBytes(blob.buf, blob.size, algo)
}

/* 按字节读文件，返回 {buf, size}。size 是实际读到的字节数。

   **必须 Seek(0)**：文本模式打开时 AHK 会探测 BOM 并把文件指针挪到 BOM 之后，
   于是 RawRead 拿到的第一个字节其实是第 3 个（UTF-8 BOM）或第 3 个（UTF-16 的
   FE FF 之后）。RawRead 本身不做字符解码，但它从「当前指针」开始读 ——
   少了这 2~3 字节，base64 和摘要都会算错，而且**一声不响**。
   实测：18 字节的 UTF-16 文件不 Seek 时 got=16、首字节是 0x75。 */
ReadBlob(path, size) {
    buf := Buffer(Max(size, 1), 0)
    f := FileOpen(path, 'r')
    try {
        f.Seek(0)
        n := f.RawRead(buf, size)
    } finally
        f.Close()
    return { buf: buf, size: n }
}

/* 这个 blob 是二进制吗？判据是「出现 NUL 字节」。
   UTF-16 文本通篇都是 NUL，所以先看 BOM 放行 —— 否则存成 UTF-16 的 a.txt
   会被当成二进制拒掉，而 FileRead 明明读得动。 */
IsBinaryBlob(blob) {
    if (blob.size = 0)
        return false
    if (blob.size >= 2) {
        c0 := NumGet(blob.buf, 0, 'UChar')
        c1 := NumGet(blob.buf, 1, 'UChar')
        if ((c0 = 0xFF && c1 = 0xFE) || (c0 = 0xFE && c1 = 0xFF))
            return false
    }
    /* 200 万字节自己循环太慢，交给 CRT 的 memchr（返回首次出现的地址，没有就是 0） */
    return DllCall('msvcrt\memchr', 'ptr', blob.buf, 'int', 0, 'ptr', blob.size, 'ptr') != 0
}

/* 字节 → Base64。B64Encode 只吃文本（内部先 StrPut 成 UTF-8），
   二进制喂给它会被当成字符串重新编码，必须另开一条路。 */
B64OfBlob(buf, size) {
    if (size <= 0)
        return ''
    flags := 0x40000001                  ; BASE64 | NOCRLF
    cch := 0
    if !DllCall('crypt32\CryptBinaryToStringW', 'ptr', buf, 'uint', size, 'uint', flags
        , 'ptr', 0, 'uint*', &cch, 'int')
        throw Error('Base64 编码失败（取长度）')
    if (cch <= 1)
        return ''
    out := Buffer(cch * 2, 0)
    if !DllCall('crypt32\CryptBinaryToStringW', 'ptr', buf, 'uint', size, 'uint', flags
        , 'ptr', out, 'uint*', &cch, 'int')
        throw Error('Base64 编码失败')
    return Trim(StrGet(out, 'utf-16'), "`r`n")
}

/* 字节 → 十六进制摘要。和 HashHex 同源，只是数据源从 UTF-8 文本换成原始字节。
   独立实现是为了不碰已经跑通、还带 HMAC 分支的那条。 */
HashHexBytes(buf, size, algo := 'SHA256') {
    hAlg := 0, hHash := 0
    if DllCall('bcrypt\BCryptOpenAlgorithmProvider'
        , 'ptr*', &hAlg, 'wstr', algo, 'ptr', 0, 'uint', 0, 'int')
        throw Error('系统不支持摘要算法：' algo)
    try {
        szBuf := Buffer(4, 0), got := 0
        DllCall('bcrypt\BCryptGetProperty', 'ptr', hAlg, 'wstr', 'ObjectLength'
            , 'ptr', szBuf, 'uint', 4, 'uint*', &got, 'uint', 0, 'int')
        objLen := NumGet(szBuf, 0, 'uint')
        DllCall('bcrypt\BCryptGetProperty', 'ptr', hAlg, 'wstr', 'HashDigestLength'
            , 'ptr', szBuf, 'uint', 4, 'uint*', &got, 'uint', 0, 'int')
        hashLen := NumGet(szBuf, 0, 'uint')
        if (!objLen || !hashLen)
            throw Error('取不到摘要长度：' algo)

        objBuf := Buffer(objLen, 0)
        if DllCall('bcrypt\BCryptCreateHash', 'ptr', hAlg, 'ptr*', &hHash
            , 'ptr', objBuf, 'uint', objLen, 'ptr', 0, 'uint', 0, 'uint', 0, 'int')
            throw Error('BCryptCreateHash 失败')
        if DllCall('bcrypt\BCryptHashData', 'ptr', hHash, 'ptr', buf, 'uint', size, 'uint', 0, 'int')
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

/* 占位符名 -> bcrypt 的算法标识。
   bcrypt 认的就是 'MD5' / 'SHA1' / 'SHA256' / 'SHA384' / 'SHA512'，
   正好是占位符名的大写形式，不用查表。 */
HashAlgo(name) {
    return StrUpper(name)
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

/* Base64 编码（UTF-8 文本进，ASCII 出）。
   走 crypt32 的 CryptBinaryToStringW —— 系统自带，不引第三方库，也不用自己查表。
   urlSafe = true 时转成 base64url（+ -> -、/ -> _、去掉补位 =），JWT 那类场景用。 */
B64Encode(text, urlSafe := false) {
    n := StrPut(text, 'utf-8') - 1        ; StrPut 的返回值含结尾 \0
    if (n <= 0)
        return ''
    src := Buffer(n, 0)
    StrPut(text, src, 'utf-8')

    /* CRYPT_STRING_BASE64(0x1) | CRYPT_STRING_NOCRLF(0x40000000)。
       不加 NOCRLF 的话每 76 个字符插一次 \r\n —— 写进请求头就是灾难。 */
    flags := 0x40000001
    cch := 0
    if !DllCall('crypt32\CryptBinaryToStringW', 'ptr', src, 'uint', n, 'uint', flags
        , 'ptr', 0, 'uint*', &cch, 'int')
        throw Error('Base64 编码失败（取长度）')
    if (cch <= 1)                         ; 只有结尾 \0，即空串
        return ''
    out := Buffer(cch * 2, 0)             ; cch 含结尾 \0，WCHAR 占 2 字节
    if !DllCall('crypt32\CryptBinaryToStringW', 'ptr', src, 'uint', n, 'uint', flags
        , 'ptr', out, 'uint*', &cch, 'int')
        throw Error('Base64 编码失败')
    s := StrGet(out, 'utf-16')
    if urlSafe
        s := RTrim(StrReplace(StrReplace(s, '+', '-'), '/', '_'), '=')
    return s
}

AhkInterp() {
    /* 「跑另一个 .ahk」时用的解释器路径（现在只有 "ahk" 类型条目还会用到它；
       webhook / download 已经改走本脚本的 --webhook 分支，不再需要解释器）。
       脚本版就是 A_AhkPath；编译版的 A_AhkPath 指向 exe 自己，拿它当解释器
       只会再起一个自己 —— 参数全进 A_Args，目标脚本一次都不会执行（实测过：
       目标脚本的 FileAppend 从没落盘）。所以编译版优先用随包的 runtime 解释器，
       找不到再退回 A_AhkPath：这样漏带 runtime 时是 "ahk" 条目报错，而不是静默跑飞。 */
    global SCRIPT_DIR
    if A_IsCompiled {
        p := SCRIPT_DIR '\runtime\AutoHotkey64.exe'
        if FileExist(p)
            return p
    }
    return A_AhkPath
}

/* 起一个「请求子进程」：还是本脚本，带 --webhook <spec>。
   编译版直接跑自己（A_ScriptFullPath 就是 exe 路径），因此不依赖随包解释器；
   脚本版得先有解释器才能跑 .ahk，用 AhkInterp()。
   返回 pid；起不来会抛异常，由调用方决定怎么报错。 */
RunWebhook(spec) {
    global SCRIPT_DIR
    pid := 0
    if A_IsCompiled
        Run('"' A_ScriptFullPath '" --webhook "' spec '"', SCRIPT_DIR, 'Hide', &pid)
    else
        Run('"' AhkInterp() '" /ErrorStdOut "' A_ScriptFullPath '" --webhook "' spec '"'
            , SCRIPT_DIR, 'Hide', &pid)
    return pid
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
        , runOnStart: JsonNum(raw, 'runOnStart', 0) ? 1 : 0
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
    global schedTasks, schedStage, schedInside, schedBoot
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

    /* runOnStart：只在本次进程第一次装排程表时生效。之后重载配置（sched-end 会
       再来一次）不重跑 —— 只改了一行配置就把所有开机任务再执行一遍，太意外。
       延迟 800ms 是为了错开首屏渲染：启动瞬间就跑 webhook 会和界面抢那一下。 */
    if !schedBoot {
        schedBoot := true
        for t in schedTasks {
            if t.runOnStart {
                SetTimer(SchedBootFire, -800)
                break
            }
        }
    }
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

/* 启动时执行一次（配置里的 runOnStart: true）。
   和普通触发走同一个 SchedFire：不弹窗、不写结果面板、照样占用 busy 标志
   —— 启动那一秒正好撞上一次定时触发，也不会并发跑两遍。 */
SchedBootFire() {
    global schedTasks, uiReady, schedBootTries
    if !uiReady {
        /* 能收到 sched-end 就说明页面活着，走不到这里；留个兜底，别把任务静默丢掉 */
        if (schedBootTries < 10) {
            schedBootTries += 1
            SetTimer(SchedBootFire, -500)
            return
        }
        for t in schedTasks {
            if t.runOnStart
                SchedLog(t.id, 'boot', '界面没有就绪，启动时这一次跳过')
        }
        return
    }
    for t in schedTasks {
        if !t.runOnStart
            continue
        t.runOnStart := 0                    ; 只跑一次
        /* every 任务把下一次从"刚刚"重新算：启动跑过一次之后，隔一个完整周期再跑，
           而不是按刚才排好的那个时刻（可能就在几分钟后）紧接着又来一次。
           at 任务不动 —— 重算会把它推到下一个时刻，本该在 09:00 跑的那次就丢了。 */
        if (t.mode = 'every') {
            t.last := A_Now
            SchedAdvance(t, A_Now)
        }
        SchedLog(t.id, 'boot', '启动时执行一次')
        SchedFire(t)
    }
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

; ============================================================================
;  --webhook <spec.ini>：HTTP 执行器（子进程主体）
;  ---------------------------------------------------------------------------
;  以前这里是独立的 webhook.ahk。并进主脚本之后：
;    · 编译版自己就能当执行器，不用再随包 runtime\AutoHotkey64.exe；
;    · 只有一份实现，脚本版和编译版不会各跑各的、慢慢漂移。
;
;  为什么必须是子进程：WinHttp.WinHttpRequest 是同步 COM，请求期间会冻住
;  调用线程 —— 放在主进程里就是"10 秒超时 = 界面假死 10 秒"。
;
;  两种模式（spec 里的 [req] Mode）：
;    http      默认。响应正文按文本落盘，交给前端显示（webhook 类型）
;    download  把响应体按二进制写进文件（download 类型）。和 http 共用同一套
;              请求逻辑，只是"结果去哪"不同
;
;  spec 由主进程写，键名见 DoWebhook / StartDownload。产物（回写给主进程）：
;    <OutDir>\meta.ini   [resp] Status / Error / Ms / Len
;                        [dl]   File / Name / Size / Skipped / Backup   （仅 download）
;    <OutDir>\body.txt   响应正文（UTF-8 无 BOM，仅 http 模式）
;
;  [req] BodyKind 决定 b.txt 怎么读：
;    text（默认）  FileRead UTF-8，按字符串发
;    binary        ADODB.Stream 读成 SafeArray 再 Send —— multipart 的包体走这条，
;                  必须按字节发，经一趟字符集转换就全坏了
;
;  注意：这里刻意不做任何 JSON 解析 —— 正文原样落盘，交给前端的 JSON.parse。
; ============================================================================

/* 认命令行里的 --webhook。写法都吃：`--webhook <spec>`，`--webhook=<spec>`。
   后面还可以跟两个开关（顺序随意，写不写都一样）：
     --json   结果以 JSON 打到 stdout，同时照旧写 meta.ini
     --body   只把响应正文打到 stdout（配 `| jq` 这类管道用，不额外补换行）
   开关只影响"打印什么"，不影响请求本身 —— 主进程调子进程时不带它们，行为一字不变。 */
WebhookArg(argv, &spec, &opt) {
    static RE := 'i)^--webhook(?:=(.+))?$'
    spec := ''
    opt := { json: false, body: false }
    m := ''
    if (argv.Length < 1)
        return false
    if !RegExMatch(argv[1], RE, &m)
        return false

    i := 2
    if (m[1] != '')
        spec := Trim(m[1], ' `t"')
    else if (argv.Length >= 2 && SubStr(argv[2], 1, 2) != '--') {
        spec := Trim(argv[2], ' `t"')
        i := 3
    }

    ; 剩下的是开关。`--webhook --json spec.ini` 这种把开关写在路径前面的也认。
    while (i <= argv.Length) {
        a := argv[i]
        if (a = '--json')
            opt.json := true
        else if (a = '--body')
            opt.body := true
        else if (spec = '' && SubStr(a, 1, 2) != '--')
            spec := Trim(a, ' `t"')
        i += 1
    }
    return true
}

/* 返回进程退出码：0 正常 / 2 spec 读不到 / 3 spec 内容不全
   opt 是 WebhookArg 给的开关（--json / --body），只决定"往 stdout 打什么"。 */
WebhookMain(spec, opt := '') {
    if !IsObject(opt)
        opt := { json: false, body: false }

    /* 出错也要能被脚本消费：没带 --json 时保持安静（老行为），带了就回一个 ok:false。
       否则 `ql --webhook x --json` 失败时 stdout 是空的，调用方只能靠退出码猜。 */
    if (spec = '' || !FileExist(spec)) {
        if opt.json
            StdOut('{"ok":false,"error":' JsonQuote('spec 文件不存在：' spec)
                . ',"spec":' JsonQuote(spec) . '}' '`n')
        return 2
    }

    mode     := IniRead(spec, 'req', 'Mode', 'http')
    method   := IniRead(spec, 'req', 'Method', 'GET')
    url      := IniRead(spec, 'req', 'Url', '')
    timeout  := WhIntOr(IniRead(spec, 'req', 'Timeout', '15'), 15)
    hdrsFile := IniRead(spec, 'req', 'HeadersFile', '')
    bodyFile := IniRead(spec, 'req', 'BodyFile', '')
    bodyKind := IniRead(spec, 'req', 'BodyKind', 'text')
    outDir   := IniRead(spec, 'req', 'OutDir', '')

    ; download 专用
    saveDir  := IniRead(spec, 'dl', 'SaveDir', '')
    saveName := IniRead(spec, 'dl', 'SaveName', '')
    onExists := IniRead(spec, 'dl', 'OnExists', 'skip')
    backup   := WhIntOr(IniRead(spec, 'dl', 'Backup', '0'), 0)

    if (outDir = '' || url = '') {
        if opt.json
            StdOut('{"ok":false,"error":"spec 里缺少 [req] Url 或 OutDir","spec":'
                . JsonQuote(spec) . '}' '`n')
        return 3
    }

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
            if (bodyKind = 'binary') {
                /* multipart 的包体是字节流：交给 ADODB 转成 SafeArray(VT_UI1)，
                   WinHttp 收到这种变体就按二进制发，不经过任何字符集转换。
                   走 FileRead(UTF-8) 的话，一个 PNG 会被拆成 U+FFFD 再编码，
                   内容和体积全变，服务端只能收到坏文件。 */
                st := ComObject('ADODB.Stream')
                st.Type := 1                     ; adTypeBinary
                st.Open()
                try {
                    st.LoadFromFile(bodyFile)
                    reqBody := st.Read()
                } finally {
                    st.Close()
                }
                req.Send(reqBody)
            } else {
                reqBody := FileRead(bodyFile, 'UTF-8')
                req.Send(reqBody)
            }
        } else {
            req.Send()
        }

        status := req.Status

        if (mode = 'download') {
            ; 只认 2xx：404/500 的响应体是错误页，存成文件只会污染目录
            if (status < 200 || status > 299)
                throw Error('下载失败：服务器返回 HTTP ' status '（未保存任何文件）')
            dl := WhSaveToFile(req, saveDir, saveName, onExists, backup, url)
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

    /* 手跑排查用的输出。放在 meta.ini 之后：先保证调用方（主进程）那份契约不变，
       再考虑人要看的东西 —— 中间任何一步失败都不会影响定时/界面那条路。 */
    if opt.json {
        j := '{"ok":' (errMsg = '' ? 'true' : 'false')
            . ',"mode":' JsonQuote(mode)
            . ',"method":' JsonQuote(method)
            . ',"url":' JsonQuote(url)
            . ',"status":' status
            . ',"ms":' elapsed
            . ',"len":' (mode = 'download' ? dl.size : StrLen(body))
            . ',"error":' JsonQuote(errMsg)
            . ',"spec":' JsonQuote(spec)
        if (mode = 'download')
            j .= ',"file":' JsonQuote(dl.file) ',"name":' JsonQuote(dl.name)
                . ',"size":' dl.size ',"skipped":' dl.skipped
                . ',"backup":' JsonQuote(dl.backup)
        else
            j .= ',"body":' JsonQuote(body)
        StdOut(j . '}' '`n')
    } else if opt.body {
        StdOut(body)                 ; 不补换行：管道那头（jq 之类）自己会处理
    }

    return 0
}

/* 把响应体写成文件。返回 {file, name, size, skipped, backup}
   —— 文件很小（配置文件、图标、脚本），所以一次性进内存，不做分片/断点。 */
WhSaveToFile(req, dir, given, onExists, doBackup, url) {
    name := WhSaltName(given != '' ? given : WhPickName(req, url))
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
WhPickName(req, url) {
    cd := ''
    try cd := req.GetResponseHeader('Content-Disposition')
    cd := Trim(cd == '' ? '' : cd)

    if (cd != '') {
        ; RFC 5987 的 filename*=UTF-8''%E4%B8%AD.txt 优先，浏览器/服务端都这么排
        if RegExMatch(cd, "i)filename\*\s*=\s*([^;]+)", &m) {
            v := Trim(m[1], ' "')
            if RegExMatch(v, "^[^']*'[^']*'(.*)$", &pfx)
                v := pfx[1]
            v := WhUrlDecode(v)
            if (v != '')
                return v
        }
        if RegExMatch(cd, 'i)filename\s*=\s*("([^"]*)"|([^;]+))', &m) {
            v := m[2] != '' ? m[2] : Trim(m[3], ' ')
            v := WhUrlDecode(v)
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
    seg := WhUrlDecode(seg)
    return (seg != '') ? seg : 'download.bin'
}

/* 文件名里不能出现的字符一律换掉 —— 远端可以返回任意字符串，
   带 : / \ 的名字会被当成路径写到别的地方去 */
WhSaltName(n) {
    n := RegExReplace(n, '[\\/:*?"<>|\x00-\x1f]', '_')
    n := Trim(n, ' .')
    if (n = '' || n = '.' || n = '..')
        n := 'download.bin'
    return n
}

/* %XX 解码（按 UTF-8 解释）。不做 + → 空格：路径里 + 就是加号本身 */
WhUrlDecode(s) {
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

WhIntOr(s, def) {
    s := Trim(s)
    return IsNumber(s) ? Integer(s) : def
}
