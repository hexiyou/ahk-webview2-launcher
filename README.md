# QuickLaunch — AutoHotkey v2 + WebView2 快速启动器

用 AutoHotkey 做壳、用 HTML/CSS/JS 做界面、用 WebView2 做渲染引擎的 uTools 式快速启动器。
本项目的用途是**验证「AHK + WebView2 开发小工具」这条链路是否真的可行**，所以功能刻意做得小、
但链路是完整的（无边框窗口、外部配置、搜索、图标、全局热键、JS↔AHK 双向通信）。

![screenshot](docs/screenshot.png)

---

## 一、结论

**可行，而且很成熟。**

### 1. AutoHotkey 能引用 WebView2 吗？

能。但**不能用 `Gui.AddActiveX` 那种方式**——WebView2 不是注册到 COM 的 ActiveX/OCX 控件，
系统里没有它的控件类。它对外只暴露一组「非注册」的 COM 接口，必须走这条路：

```
WebView2Loader.dll
  └─ CreateCoreWebView2EnvironmentWithOptions()      → ICoreWebView2Environment
       └─ CreateCoreWebView2Controller(hwnd)         → ICoreWebView2Controller（把浏览器合成到你的窗口上）
            └─ get_CoreWebView2()                    → ICoreWebView2（Navigate / ExecuteScript / WebMessage…）
```

AHK 靠 `DllCall` + 手写 COM vtable 索引就能完成全部调用，没有任何"底层做不到"的地方。
本项目直接使用社区库 [thqby/ahk2_lib · WebView2](https://github.com/thqby/ahk2_lib/tree/master/WebView2)（MIT），
它已经把 2000 多行 COM 接口定义封装好了，目录里已内置，开箱即用。

**两个前置条件**（缺一不可）：

| 依赖 | 说明 |
|---|---|
| WebView2 Runtime | Win11 自带；Win10 装过新版 Edge 一般就有。缺了去微软官网装 Evergreen Runtime |
| `lib\WebView2Loader.dll` | 微软 SDK 里的加载器，**位数必须和 AHK 一致**（本项目用 64 位 AHK → `x64` 的 dll） |

### 2. 四条需求逐条结论

| 需求 | 结论 | 实现方式 |
|---|---|---|
| ① 无边框 + 网页 UI | ✅ 可行 | `Gui('-Caption +ToolWindow')` + `SetWindowRgn` 圆角 + 页面自绘标题栏；拖拽用 WebView2 原生非客户区支持（`IsNonClientRegionSupportEnabled` + CSS `-webkit-app-region: drag`），由系统移动循环搬窗口 |
| ② 外部配置数据源 | ✅ 可行 | 条目全在 `config.json`（名称/关键词/图标/类型/路径/参数/置顶）；AHK 侧设置放 `launcher.ini` |
| ③ 搜索框 + 常用卡片 | ✅ 可行 | 纯前端实现：输入即时过滤 + `↑↓` 选择 + `Enter` 启动 + 置顶卡片 |
| ④ 全局热键呼出 | ✅ 可行 | `Hotkey()` 动态注册，热键写在 ini 里，改配置即换键 |

### 3. 本机实测结果

环境：Windows 10 19045 / Edge WebView2 Runtime 156.0.4314.50 / AutoHotkey v2.0.31（64 位）

| 验证项 | 结果 |
|---|---|
| WebView2 控制器创建、内核版本读取 | ✅ `156.0.4314.50` |
| 无边框窗口 + 圆角 + 页面渲染 | ✅ 见截图 |
| JS → AHK（`postMessage`） | ✅ 收到 `ready` / `icons` / `run` |
| AHK → JS（`PostWebMessageAsJson`） | ✅ 图标映射回传成功 |
| 从 exe 自动提取图标（GDI+ 转 PNG） | ✅ 记事本/cmd/PowerShell/画图/资源管理器 均为真实图标 |
| 页面搜索过滤 | ✅ 输入 `pow` → 只剩 PowerShell |
| 点击条目 → 真的启动程序 | ✅ 通过 `cmd /c echo ok>…` 生成了目标文件 |
| 全局热键 `Ctrl+Alt+Space` 显隐 | ✅ 用 `keybd_event` 模拟真实按键，窗口 visible 1→0→1 |

---

## 二、跑起来

```
双击 run.bat
```

- 项目自带免安装的 AHK v2 运行时（`runtime\AutoHotkey64.exe`），不装 AHK 也能直接跑；
  如果你本机已装 AutoHotkey v2，`run.bat` 找不到 runtime 时会用系统关联打开 `launcher.ahk`。
- 首次运行会生成 `.webview2\` 目录（WebView2 的缓存/用户数据，可随时删）。

### 操作与退出

| 操作 | 结果 |
|---|---|
| `Ctrl+Alt+Space` | 全局显隐（热键由 `launcher.ini` 的 `Hotkey` 决定） |
| 输入关键词 | 实时过滤；`↑` `↓` 选择，`Enter` 启动 |
| `Esc` / 标题栏 `—` | 隐藏窗口，进程继续在托盘 |
| 标题栏 `✕` | **只隐藏，不退出**（否则全局热键就唤不出来了） |
| 托盘图标右键 | 编辑配置 / 重载配置 / 重启软件 / 退出软件 |
| 托盘 → 退出软件 | **唯一真正退出程序的入口** |

> 程序是靠托盘常驻的：关掉窗口只是隐藏，热键随时能唤回；想彻底关掉就用托盘菜单的「退出软件」。

---

## 三、目录结构

```
wv2-launcher/
├─ launcher.ahk          主程序：无边框窗口 + WebView2 宿主 + 热键 + 启动逻辑 + 图标提取
├─ launcher.ini          AHK 侧设置：热键/尺寸/圆角/行为
├─ config.json           数据源：应用条目（前端读取解析）
├─ ui/
│  ├─ index.html         界面结构
│  ├─ app.css            样式（亮色、圆角、卡片、列表、Toast）
│  └─ app.js             搜索/键盘导航/图标/与 AHK 通信
├─ lib/
│  ├─ WebView2/WebView2.ahk   thqby 的 WebView2 COM 绑定库（MIT）
│  ├─ ComVar.ahk / Promise.ahk  库的依赖
│  └─ WebView2Loader.dll      x64 加载器（x86 版见 WebView2Loader_x86.dll）
├─ runtime/              免安装 AutoHotkey v2（可删，改用系统装的 AHK）
├─ docs/screenshot.png
└─ run.bat
```

---

## 四、配置说明

### launcher.ini（AHK 侧）

| 键 | 默认 | 说明 |
|---|---|---|
| `Hotkey` | `^!Space` | 全局热键，AHK 语法：`^`Ctrl `!`Alt `+`Shift `#`Win |
| `Width` / `Height` | 820 / 580 | 窗口尺寸 |
| `CornerRadius` | 14 | 圆角半径，设 `0` 变直角（**直角时系统阴影会回来**，见"已知限制"） |
| `AlwaysOnTop` | 1 | 置顶 |
| `HideOnBlur` | 0 | 失焦自动隐藏（想要 Spotlight 手感就设 1） |
| `HideAfterLaunch` | 1 | 启动程序后自动隐藏 |
| `ShowOnStart` | 1 | 启动即显示（调试用，正式用可设 0） |
| `DevTools` | 1 | 允许 F12 开发者工具与右键菜单 |

### config.json（数据源）

```json
{
  "id": "vscode",              // 唯一标识
  "name": "VS Code",           // 显示名（也是搜索主字段）
  "subtitle": "代码编辑器",     // 副标题
  "keywords": ["code", "vsc"], // 额外搜索词（支持中英文）
  "icon": "C:\\...\\Code.exe", // 图标：exe 路径 / png|ico|svg 路径 / http(s) 地址 / emoji
  "type": "app",               // app | cmd | url | folder | ahk
  "target": "C:\\...\\Code.exe",
  "args": "",                  // 启动参数
  "workdir": "",               // 工作目录，相对路径按脚本目录解析
  "pinned": true,              // 是否进"常用"卡片
  "accent": "#4f8cff"          // 卡片/头像的强调色（可选）
}
```

`type` 语义：

- `app` —— 启动 exe，`target` 支持 `shell:` / `ms-` 协议（如 `ms-calculator:`）
- `cmd` —— `cmd /s /k "<target>"`，`target` 是**一整条命令行**，如 `ipconfig /all`、`ping 127.0.0.1 -t`
- `url` —— ShellExecute 打开（网址、自定义协议）
- `folder` —— 用资源管理器打开目录
- `ahk` —— 用当前 AHK 运行另一个 .ahk 脚本

### `target` 的解析规则（按 type 区分）

| type | `target` 怎么处理 | 例子 |
|---|---|---|
| `cmd` | **原样**交给 cmd，绝不按路径改写 | `ipconfig /all` → `ipconfig /all` |
| `url` | 原样 | `ms-calculator:`、`https://…` |
| `folder` / `ahk` | 一律当路径，相对路径按脚本目录解析 | `docs` → `<脚本目录>\docs` |
| `app` | 绝对路径/协议原样；`.`、`..` 或带分隔符的相对路径按脚本目录解析；**裸命令名**交给 PATH | `.\tool.exe` → `<脚本目录>\tool.exe`；`notepad.exe` → 交给 PATH |

> 早期版本这里有个 bug：所有 `target` 都被无条件当成相对路径拼上了脚本目录，
> 于是 `cmd` 类型的 `ipconfig /all` 变成 `C:\…\wv2-launcher\ipconfig /all`，
> cmd 报「`C:\…\ipconfig` 不是内部或外部命令」。见下方踩坑 11。

`icon` 留空时，会自动从 `target` 的 exe 里提取图标（`SHGetFileInfo` → GDI+ → PNG 缓存到 `%TEMP%\quicklaunch-icons`）；
提取不到就退化成"首字 + 渐变色"头像（截图里的"计算器"就是这种）。

---

## 五、实现要点（也是踩过的坑）

0. **⭐ 最隐蔽的坑：绝对不能在「隐藏窗口」上创建 WebView2，否则屏幕上就是纯白窗口。**
   最初的写法是 `g.Show('w820 h580 Hide')` 先把窗口建好但藏着，然后在这个看不见的窗口上
   `CreateControllerAsync`，等页面加载完再 `g.Show()`。结果是：`NavigationCompleted` 报
   success、`CapturePreview` 抓出来是完整 UI、JS 消息全通——**但屏幕上什么也没有，只有一个白窗口**。
   原因是 DirectComposition 的视觉树没挂到这个"创建时不可见"的宿主窗口上。
   更坑的是：用 `CapturePreview` 验证看不出问题（它抓的是网页位图，绕过了窗口合成），
   只有真的看屏幕 / 用桌面 BitBlt 截屏才会发现。
   正确做法：**先让窗口真正显示出来，再创建控制器**；创建后再补一次 `Fill()` + `IsVisible := 1`。
   如果不想开机弹窗（`ShowOnStart=0`），就先 `Show('x-32000 y-32000 ... NA')` 摆到屏幕外"显示"着，
   建完控制器再 `Hide()`。另外加了 `ReadyWatchdog`：9 秒内收不到页面 `ready` 消息就弹诊断框，
   把导航结果和 URL 报出来，避免再出现"静默白屏"。

1. **WebView2 不是 ActiveX**：`AddActiveX` 那套走不通，必须 `CreateCoreWebView2EnvironmentWithOptions`。
   而且要先 `AddScriptToExecuteOnDocumentCreatedAsync` 注入数据再 `Navigate`，否则页面拿不到配置。

2. **`#Warn` 会卡死脚本**：AHK v2 默认把警告弹成模态框，在无控制台的 GUI 脚本里就是"界面永远不出现"。
   本项目在脚本头显式 `#Warn All, Off`。调试期想开就临时改成 `#Warn All, MsgBox`。

3. **GDI+ 反复 Startup/Shutdown 会导致进程崩溃**：连续提取多个图标时，每次都配对调用
   `GdiplusStartup` / `GdiplusShutdown`，第二次就 ACCESS_VIOLATION。改成进程内只初始化一次、不主动 Shutdown（见 `EnsureGdip()`）。

4. **`file://` 页面里 `fetch()` 读本地 JSON 会被 CORS 拦**：所以 AHK 用 `FileRead` 读 `config.json` 原文，
   通过 `AddScriptToExecuteOnDocumentCreated` 注入成 `window.__BOOTSTRAP__`，AHK 完全不用解析 JSON（省掉一个 JSON 库）。
   JS 侧就 `JSON.parse` 免了，直接是对象。

5. **WebView2 事件回调里不能 `await` 异步方法**（库的线程模型限制），所以 `ExecuteScriptAsync` 都是"发射后不管"。

6. **⭐ 拖拽：用 WebView2 官方的「非客户区」支持，别自己搬窗口。**
   正确做法只有两步：AHK 侧 `wv.Settings.IsNonClientRegionSupportEnabled := 1`，CSS 侧给标题栏
   `-webkit-app-region: drag`（按钮上加 `no-drag`）。之后 WebView2 会把这块区域命中测试成
   `HTCAPTION`，窗口移动完全交给 Windows 的移动循环——平滑、零闪烁、松手即停、多显示器边界都对。

   我最初的三版实现都踩了坑，值得记下来：
   - **第一版（轮询）**：页面 `pointerdown` 发消息，AHK 用 `SetTimer` 每 10ms `Gui.Move` 跟随鼠标。
     问题一：10ms 重排一次 WebView2 合成层，**拖拽时窗口狂闪**。
     问题二（致命）：**AHK v2 的 `SetTimer()` 没有返回值**，写成 `dragTimer := SetTimer(...)`
     时 `dragTimer` 恒为空串，`StopDrag()` 里的 `if dragTimer` 永远为假 → **定时器根本停不掉**。
     于是第二次拖动时两个定时器同时跑、互相拉扯，窗口瞬间飞出屏幕，只能杀进程重启。
   - **第二版（`PostMessage` 伪点击）**：给窗口发 `WM_NCLBUTTONDOWN + HTCAPTION` 骗系统进移动循环。
     在带标题栏的普通窗口上有效，但这个启动器是 `-Caption +ToolWindow`，实测纹丝不动。
   - **第三版（原生非客户区，但没生效）**：代码写对了，可拖拽依旧闪烁 + 左右晃动。
     根因是个很蠢的**作用域 bug**：`BuildUi()` 里漏写 `global ... , ncDrag`，
     于是 `ncDrag := true` 只写进了**函数的局部变量**，而 `StartDrag()` 和 `InjectBootstrap()`
     读的是全局 `ncDrag`（永远是 false）。结果就是：设置明明成功了（回读 `after set: 1`），
     程序却始终判定「原生拖拽不可用」，一直走轮询兜底 —— 于是闪烁和双计时器晃动全都还在。
     **教训**：AHK v2 里函数内赋值默认是局部变量，`global` 声明漏一个名字就静默失效，
     而且我上一轮"验证"时读的正是同一个函数里的局部变量，等于自证成功，把 bug 盖住了。
     现在用 `WM_ENTERSIZEMOVE` / `WM_EXITSIZEMOVE` 作为判据：只有这两个消息出现，
     才证明窗口移动真的由系统循环接管（实测已出现，且轮询调用次数为 0）。

   代码里保留了轮询作为兜底（运行时太老、开不了该设置时用），由 `nativeDrag` 标志从 AHK 注入给前端，
   前端据此决定加 `nc-drag` 类还是发 `drag-start`。兜底路径也重写过：固定用同一个
   `FollowMouseTick` 函数 + 全局偏移量，`SetTimer` 幂等，不会再出现计时器叠加。

9. **托盘菜单要整个接管**：AHK 默认托盘子菜单是英文的 Pause / Suspend / Reload / Exit。
   用 `A_TrayMenu.Delete()`（不带参数 = 全删）清空后重新 `Add`，只留
   「编辑配置 / 重载配置 / 重启软件 / 退出软件」。
   「重启软件」用 `Run('"' A_AhkPath '" /restart "' A_ScriptFullPath '"')` 再 `ExitApp()`，
   `/restart` 会让新实例等旧进程退出后接管（实测连续重启 3 次，3 个不同 PID 都正常）。

10. **关闭窗口 ≠ 退出程序**：`-Caption` 窗口没有系统关闭按钮，页面右上角的 ✕ 走 JS → AHK 消息，
    必须只调 `g.Hide()`。同理 `Gui.OnEvent('Close')`（Alt+F4 会触发）也要改成隐藏。
    否则一关窗口进程就没了，全局热键自然也就唤不出任何东西。
    真正退出的唯一入口是托盘菜单的「退出软件」。

7. **Win10 没有 DWM 圆角**，只能用 `SetWindowRgn` 裁一个圆角矩形；代价是窗口阴影会消失
   （想把阴影要回来就把 `CornerRadius` 设 0，牺牲圆角换阴影，二选一）。

8. **图标路径用 `file:///` 加载**：`<img src="file:///C:/...png">` 在 `file://` 页面里是允许的
   （图片不受 CORS 限制，但 `fetch` 受限）。

11. **⭐ `target` 不能一刀切当路径解析**：原 `normalizeItem()` 对每个条目都做了 `absPath(it.target)`，
    本意是支持 `target: "."` / `args: "config.json"` 这类相对写法，结果把 `cmd` 类型的
    `ipconfig /all` 也拼成了 `C:\…\wv2-launcher\ipconfig /all`，cmd 报
    「`C:\…\ipconfig` 不是内部或外部命令，也不是可运行的程序」。
    修法：把"路径解析"从归一化阶段拆出来按 type 判定（`resolveTarget(type, p)`）——
    `cmd`/`url` 原样、`folder`/`ahk` 一律当路径、`app` 只解析明确的相对路径，
    裸命令名留给 PATH。AHK 侧同步补了两处：`cmd` 用 `A_ComSpec ' /s /k "' target '"'`
    （`/s` 让 cmd 只剥掉首尾引号，命令里自带的引号能保住）；`app` 在 `FileExist` 失败时
    先按脚本目录兜一次，裸命令名不报"文件不存在"、放行给 PATH。
    顺带收紧了 `isProtocol()`：原正则 `/^[a-z][a-z0-9+.-]*:/i` 会把 `C:` 也匹配成协议
    （结果凑巧一致，但语义是错的），现已排除盘符形式。

---

## 六、已知限制

- 单实例策略是 `#SingleInstance Force`：重复启动会重启进程而非唤醒已有窗口。
- 没有做窗口动画（缩放/淡入），AHK 侧做需要额外 DWM 调用。
- 没有做「托盘图标左键 / 双击」快捷行为（AHK 不暴露托盘点击回调），只能走菜单。
- 图标按 32×32 提取，4K 屏上放大到 30px 显示会略糊。
- UWP 应用（如计算器）没有 exe 路径，只能用 `ms-xxx:` 协议启动，拿不到真实图标。
- 搜索是"子串 + 关键词前缀"匹配，没有拼音首字母（要加得引一个拼音表）。

## 七、可以继续加的东西

- 拼音搜索、模糊匹配打分（fzf 风格）
- 历史使用频率排序（记录到 JSON）
- 多分组 / 二级菜单（`>` 前缀切到命令模式）
- 窗口出现动画、亚克力背景（`DwmSetWindowAttribute` + `WS_EX_LAYERED`）
- 用 `A_Args` 支持从命令行直接搜索
