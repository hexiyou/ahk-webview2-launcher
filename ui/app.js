/* ============================================================
   QuickLaunch 前端逻辑
   - 数据源：window.__BOOTSTRAP__（由 AHK 在文档创建时注入 config.json / usage.json 原文）
   - 与 AHK 通信：chrome.webview.postMessage / window.chrome.webview.addEventListener
   - 直接在浏览器打开时进入「预览模式」，用内置示例数据渲染

   查询串语法（见 parseQuery）：
     >ip        命令模式：只搜 cmd / ahk / webhook / download 这类「动作」条目
     @net       只看 net 分组；term 为空 = 列出整组（就是二级菜单）
     @net>ip    分组 + 命令模式
     其它       全量搜索

   搜索（见「匹配」段）：名字/拼音全拼/拼音首字母/关键词/副标题/target/args 逐字段打分，
   档位硬边界（全等 100 > 前缀 92 > 子串 ≤83 > 跳字模糊 ≤66），再乘一个 ≤8% 的使用频率加成。

   参数态（见「运行时参数」段）：名字后打空格进入，输入全归参数；
   `↑` 历史、`→` 前缀补全、`Tab` 目录补全（目录由 AHK 读，见 fsList）。
   ============================================================ */
(function () {
  'use strict';

  const boot = window.__BOOTSTRAP__ || null;
  const HAS_BRIDGE = !!(window.chrome && window.chrome.webview);
  const scriptDir = (boot && boot.scriptDir) || '';
  /* AHK 侧是否成功开启了 WebView2 的非客户区（原生拖拽）支持 */
  const NATIVE_DRAG = !!(boot && boot.nativeDrag);

  /* 预览模式下的示例数据（仅在没有 AHK 注入时使用） */
  const DEMO_ITEMS = [
    { id: 'a', name: '记事本', subtitle: '示例数据 · 浏览器预览', icon: '📝', type: 'app', target: 'C:\\Windows\\System32\\notepad.exe', pinned: true, group: 'sys' },
    { id: 'b', name: '命令提示符', subtitle: '示例数据 · 浏览器预览', icon: '🖥', type: 'app', target: 'C:\\Windows\\System32\\cmd.exe', pinned: true, group: 'sys' },
    { id: 'c', name: '计算器', subtitle: '示例数据 · 浏览器预览', icon: '🧮', type: 'url', target: 'ms-calculator:', pinned: true, group: 'sys' },
    { id: 'd', name: '画图', subtitle: '示例数据 · 浏览器预览', icon: '🎨', type: 'app', target: 'C:\\Windows\\System32\\mspaint.exe', pinned: false, group: 'sys' },
    { id: 'e', name: '查看本机 IP', subtitle: '示例数据 · 浏览器预览', icon: '⚙', type: 'cmd', target: 'ipconfig /all', pinned: false, group: 'net' },
    { id: 'f', name: '示例请求', subtitle: '示例数据 · 预览返回假响应', icon: '🌐', type: 'webhook', target: 'https://example.com/api', method: 'GET', pinned: true, group: 'net', jsonPath: 'data.items[0]' },
    { id: 'g', name: '下载示例文件', subtitle: '示例数据 · download 类型', icon: '⬇', type: 'download', target: 'https://example.com/demo.txt', savePath: '', fileName: '', pinned: false, group: 'net' }
  ];

  const DEMO_GROUPS = [
    { id: 'sys', name: '系统' },
    { id: 'net', name: '网络' }
  ];

  /* 预览模式下 webhook 的假响应，方便不开 AHK 也能看效果 */
  const DEMO_RESPONSE = JSON.stringify({
    status: 'ok',
    data: { total: 2, items: [{ name: '示例条目', score: 98 }, { name: '另一条', score: 61 }] },
    serverTime: '2026-10-30T08:00:00Z'
  }, null, 2);

  const state = {
    all: [],
    groups: [],
    results: [],
    pinned: [],
    sel: 0,
    q: '',
    scope: 'all',
    groupId: null,
    term: '',
    iconMap: {},
    requested: new Set(),
    reqSeq: 0,
    pending: new Map(),
    result: null,
    param: null,          /* 参数态：{ item, head }，列表锁定单条 */
    noSplit: false,       /* 刚按 Esc 退出参数态，别立刻又自动进去 */
    selTouched: false,    /* 选择被 ↑↓ 主动挪过（打字会立刻清掉，见 input 事件） */
    usage: {},            /* 使用记录：id -> { n 次数, t 上次时间戳(秒), args 参数历史 } */
    index: {},            /* 搜索索引缓存：id -> [{ t 待匹配文本, w 权重, fz 是否允许模糊 }] */
    cfg: null,            /* 原始配置：定时调度那段要重新解析，所以要留一份 */
    offCount: 0,          /* 配置里 enabled:false 的条目数（只用于提示，不参与搜索） */
    tplBad: [],           /* 模板变量写错的条目（执行时会被拒绝） */
    tplWarn: []           /* 用了 {{…}} 但没声明 params 的条目（只提醒） */
  };

  const $ = id => document.getElementById(id);
  const els = {};

  const PLACEHOLDER = '搜索应用、命令或关键词…（> 命令 · @ 分组）';

  /* ---------------------------------------------------------- 工具函数 */

  /* 协议头：http: / ms-xxx: / shell: ……（排除 C:\ 这类盘符） */
  function isProtocol(s) { return /^(?![a-z]:[\\/])[a-z][a-z0-9+.-]*:/i.test(s); }

  function isAbsPath(s) {
    return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('//');
  }

  /* 纯"路径语义"的字段（workdir / icon / 已判定为路径的 target）：相对路径按脚本目录解析 */
  function absPath(p) {
    if (!p) return '';
    const s = String(p).replace(/\//g, '\\');
    if (isProtocol(s)) return s;
    if (isAbsPath(s)) return s;
    const rel = s.replace(/^[.\\]+/, '');
    return scriptDir ? (rel ? scriptDir + '\\' + rel : scriptDir) : s;
  }

  /* target 的语义取决于 type：只有"路径型"条目才拼脚本目录。
     cmd 是一整条命令行（`ipconfig /all`），url 是协议串，都不能当路径改写，
     否则会被拼成 `C:\...\ipconfig /all` 交给 cmd，报"不是内部或外部命令"。 */
  function resolveTarget(type, p) {
    const s = (p == null ? '' : String(p)).trim();
    if (!s) return '';
    if (type === 'cmd' || type === 'url' || type === 'webhook' || type === 'download') return s;
    if (isProtocol(s) || isAbsPath(s)) return s;
    // folder / ahk 的 target 天然是路径，裸名也按脚本目录解析
    if (type === 'folder' || type === 'ahk') return absPath(s);
    // app：明确的相对路径（. / .. 开头或带分隔符）才拼脚本目录，
    // 裸命令名（notepad.exe / explorer）留给 PATH 解析
    if (/^\.{1,2}(?:[\\/]|$)/.test(s) || /[\\/]/.test(s)) return absPath(s);
    return s;
  }

  function fileUrl(p) {
    return 'file:///' + String(p).replace(/\\/g, '/').replace(/ /g, '%20');
  }

  function isEmoji(s) {
    return !!s && s.length <= 3 && !/[\\/:.]/.test(s);
  }

  function firstChar(name) {
    const s = (name || '?').trim();
    return s ? s.charAt(0).toUpperCase() : '?';
  }

  function hueOf(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  function tint(item) {
    const a = item.accent || `hsl(${hueOf(item.name || '')},65%,55%)`;
    return `linear-gradient(135deg, ${a}, ${a}cc)`;
  }

  const KIND_LABEL = { app: '应用', cmd: '命令', url: '链接', folder: '目录', ahk: '脚本', webhook: '请求', download: '下载' };

  function kindLabel(item) {
    /* webhook 直接显示请求方法，比"请求"两个字信息量大 */
    if (item.type === 'webhook') return (item.method || 'GET').toUpperCase();
    return KIND_LABEL[item.type] || '应用';
  }

  /* 保存路径：空 = 交给 AHK 用系统「下载」目录；%TEMP% 这类原样传给 AHK 展开 */
  function resolveSavePath(p) {
    const s = String(p == null ? '' : p).trim();
    if (!s) return '';
    if (/^%[^%]+%/.test(s)) return s;
    return absPath(s);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* ---------------------------------------------------------- 查询串解析 */

  /* 纯函数：把输入框内容拆成 {scope, groupId, term}
     scope: all | cmd | group | group-cmd
     前缀留在输入框里不做删除，否则用户退格时会发现退不回去 */
  function parseQuery(q) {
    const s = q == null ? '' : String(q);
    let scope = 'all', groupId = null, term = s;

    if (s[0] === '@') {
      const m = /^@([^\s>]*)(>?)/.exec(s);
      if (m) {
        groupId = m[1] || null;
        scope = m[2] === '>' ? 'group-cmd' : 'group';
        term = s.slice(m[0].length);
      }
    } else if (s[0] === '>') {
      scope = 'cmd';
      term = s.slice(1);
    }

    term = term.replace(/^[>\s]+/, '').trim();
    if (scope === 'group' && !groupId) scope = 'all';   /* 只敲了个 @ 就当普通搜索 */
    return { scope, groupId, term };
  }

  /* 分组 id 允许前缀匹配：@n 能命中 net */
  function findGroup(pid) {
    if (!pid) return null;
    const p = String(pid).toLowerCase();
    return state.groups.find(g => g.id.toLowerCase() === p)
        || state.groups.find(g => g.id.toLowerCase().startsWith(p))
        || null;
  }

  const CMD_TYPES = { cmd: 1, ahk: 1, webhook: 1, download: 1 };

  function sourceFor(scope, group) {
    let list = state.all;
    if (scope === 'cmd' || scope === 'group-cmd')
      list = list.filter(it => CMD_TYPES[it.type]);
    if (group && (scope === 'group' || scope === 'group-cmd'))
      list = list.filter(it => it.group === group.id);
    return list;
  }

  /* ---------------------------------------------------------- 运行时参数

     输入 `vs code src/app.js` 时，前半截是条目、后半截是本次运行的参数。
     难点在"从哪里切"：条目名自己可能带空格（"VS Code"），所以不能简单取第一个空格。
     做法是从右往左找「最长的、能唯一命中」的 head ——
       "vs code src/app.js" → head "vs code"（精确命中），tail "src/app.js"
       "ip 8.8.8.8"         → head "ip"（精确命中，再往左没有更长的候选）
  */

  /* 引号感知的 token 切分：`a "b c" d` → ['a', 'b c', 'd'] */
  function splitQuoted(s) {
    const out = [];
    let cur = '', quote = '', started = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === quote) quote = '';
        else cur += c;
      } else if (c === '"' || c === "'") {
        quote = c;
        started = true;
      } else if (/\s/.test(c)) {
        if (started || cur) out.push(cur);
        cur = '';
        started = false;
      } else {
        cur += c;
        started = true;
      }
    }
    if (started || cur) out.push(cur);
    return out.filter(x => x !== '');
  }

  /* 谁接受运行时参数：动作型条目；webhook / download 还要显式声明 params
     （否则不知道该往 URL 模板的哪个变量里填） */
  function takesArgs(item) {
    if (!item) return false;
    if (item.type === 'app' || item.type === 'cmd' || item.type === 'ahk') return true;
    if (item.type === 'webhook' || item.type === 'download') return (item.params || []).length > 0;
    return false;                       /* folder / url 不参与，避免误判 */
  }

  /* head 是否唯一确定一个条目。只认「精确」和「词边界上的唯一前缀」。
     词边界这条很关键：否则 "查看 ip" 会被「查看本机 IP」的前缀吃掉 ——
     "查看" 后面是 "本"，不算词边界，所以不分裂，正常走搜索。 */
  function uniqueMatch(head, pool) {
    const h = String(head || '').toLowerCase();
    if (!h) return null;
    const cand = (pool || []).filter(takesArgs);

    const exact = cand.filter(it =>
      (it.name || '').toLowerCase() === h || String(it.id || '').toLowerCase() === h);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;          /* 同名歧义：不分裂，交回普通搜索 */

    const kw = cand.filter(it => (it.keywords || []).some(k => String(k).toLowerCase() === h));
    if (kw.length === 1) return kw[0];
    if (kw.length > 1) return null;

    const pre = cand.filter(it => {
      const n = (it.name || '').toLowerCase();
      if (n === h || !n.startsWith(h)) return false;
      const next = n.charAt(h.length);
      return next === '' || /[\s\-_/(.]/.test(next);   /* "VS Code" 打 "vs " ✓ */
    });
    if (pre.length === 1) return pre[0];
    return null;
  }

  function splitArgs(raw) {
    const s = String(raw || '');
    if (!s.trim()) return null;
    const gaps = [];
    for (let i = 0; i < s.length; i++) if (/\s/.test(s[i])) gaps.push(i);

    for (let i = gaps.length - 1; i >= 0; i--) {
      const head = s.slice(0, gaps[i]);
      const tail = s.slice(gaps[i] + 1);
      const hq = parseQuery(head);
      if (!hq.term) continue;
      const pool = sourceFor(hq.scope, findGroup(hq.groupId));
      const item = uniqueMatch(hq.term, pool);
      if (item) return { item: item, head: head, tail: tail };
    }
    return null;
  }

  /* 空格到底是什么意思？两种意图共用这一个键：
       —— 多词搜索的分隔符（「查看 ip」要能命中「查看本机 IP」）
       —— 「给高亮的这一条填参数」（页脚也是这么写的：空格 带参数）

     靠「选择是不是用户自己挪过去的」来消歧。打字会触发 input 事件把 sel 归零、
     同时清掉这个标记，所以 selTouched 为真时用户的上一个动作一定是 ↑↓ ——
     此刻按空格的意图只可能是"给这一条填参数"。
     没挪过就交回文本判据（splitArgs），多词搜索一个字的语义都不变。

     鼠标悬停故意**不**置这个标记：窗口弹出时光标常常正压在列表上，
     一悬停就让空格变语义的话，「查看 ip」这种两段式搜索会被莫名其妙地打断。

     之前的 bug 就在这儿：空格只走文本判据（uniqueMatch("cmd") 精确命中 id 为
     cmd 的「命令提示符」），于是无论高亮停在第三行还是第四行，空格都把参数态
     钉到第一条上去。 */
  function spaceTarget(item, inParam, selTouched) {
    if (inParam || !selTouched) return null;
    return takesArgs(item) ? item : null;
  }

  /* 切范围（Tab 命中命令模式）时用：在新结果里找回原来选中的那条，找不到返回 -1 */
  function selIndexById(results, id) {
    if (!id) return -1;
    const list = results || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return i;
    }
    return -1;
  }

  /* 声明的参数 → 实际取值；没给又没默认值的进 missing */
  function resolveParamValues(item, values) {
    const decl = item.params || [];
    const args = {}, missing = [];
    decl.forEach(p => {
      const k = p.name;
      const v = values ? values[k] : '';
      if (v != null && v !== '') { args[k] = String(v); return; }
      if (p.default != null && p.default !== '') { args[k] = String(p.default); return; }
      args[k] = '';
      if (!p.optional) missing.push(k);
    });
    return { args: args, missing: missing };
  }

  /* 把参数区的 token 分配到声明的参数上：位置式为主，含 name= 的视为命名式 */
  function assignTokens(item, tail) {
    const decl = item.params || [];
    const tokens = splitQuoted(tail);
    const values = {};
    const byName = {};
    decl.forEach(p => { byName[String(p.name).toLowerCase()] = p.name; });

    let cursor = 0;
    let extra = 0;
    const extras = [];                    /* 多出来的（声明数量之外）原样留着，还得追加 */
    tokens.forEach(t => {
      const eq = t.indexOf('=');
      if (eq > 0) {
        const k = t.slice(0, eq).toLowerCase();
        if (byName[k]) { values[byName[k]] = t.slice(eq + 1); return; }
      }
      while (cursor < decl.length && values[decl[cursor].name] != null) cursor++;
      if (cursor < decl.length) {
        values[decl[cursor].name] = t;
        cursor++;
      } else {
        extra++;
        extras.push(t);
      }
    });
    return { values: values, extra: extra, extras: extras, tokens: tokens };
  }

  /* 模板变量的适用面：声明了 params 的条目，下面这些字段里的 {{x}} 都会被替换。
     没声明 params 的条目整条不替换，{{ }} 原样直传 —— 老配置一个字节都不变。

     刻意不含 workdir：它在 normalizeItem 里已经按"相对脚本目录"展开成绝对路径了，
     再往里塞模板只会得到 `D:\app\C:\work` 这种四不像。 */
  const TPL_FIELDS = ['target', 'args', 'query', 'headers', 'body', 'savePath', 'fileName'];

  /* 三种写法：{{{{ 出字面 {{，}}}} 出字面 }}，{{ name }} 才是变量。
     逃生口是给「参数本身就是模板语法」的场景留的（mustache 文件、Jinja2、
     PowerShell 脚本块），JSON 里直接写四个花括号，不用跟反斜杠搏斗。 */
  const TPL_RE = /\{\{\{\{|\}\}\}\}|\{\{\s*([\w.-]+)\s*\}\}/g;

  function fillTemplate(v, args, opts) {
    if (typeof v === 'string')
      return v.replace(TPL_RE, (m, k, off, whole) => {
        if (m === '{{{{') return '{{';
        if (m === '}}}}') return '}}';
        const val = args[k] == null ? '' : String(args[k]);
        if (!opts || !opts.quote || !/\s/.test(val)) return val;
        /* app / ahk 的 args 是拼成一整条命令的，值里有空格就必须自己补引号，
           否则 "C:\my dir\a.txt" 会被拆成两个参数。
           只给「独占一个位置」的变量补：--dir={{d}} 和 "{{d}}" 都已经有结构了，
           再套一层反而改坏用户写好的参数。 */
        const b = off > 0 ? whole[off - 1] : '';
        const a = whole[off + m.length] || '';
        const alone = (!b || /\s/.test(b)) && (!a || /\s/.test(a));
        return alone ? '"' + val + '"' : val;
      });
    if (Array.isArray(v)) return v.map(x => fillTemplate(x, args, opts));
    if (v && typeof v === 'object') {
      const o = {};
      Object.keys(v).forEach(k => { o[k] = fillTemplate(v[k], args, opts); });
      return o;
    }
    return v;
  }

  /* 扫出模板里真的用到了哪些变量（去重）。转义写法不算，query 只看值不看键。 */
  function tplVars(srcs) {
    const out = new Set();
    const scan = (v) => {
      if (typeof v === 'string') {
        const re = new RegExp(TPL_RE.source, 'g');
        let m;
        while ((m = re.exec(v))) {
          if (m[1]) out.add(m[1]);
        }
        return;
      }
      if (Array.isArray(v)) { v.forEach(scan); return; }
      if (v && typeof v === 'object') Object.keys(v).forEach(k => scan(v[k]));
    };
    (Array.isArray(srcs) ? srcs : [srcs]).forEach(scan);
    return out;
  }

  /* 模板体检：载入配置时跑一次，问题挂在条目上。
       err  —— 声明了 params，却引用了没声明的变量（执行时会被拒绝）
       warn —— 没声明 params，却出现了 {{x}}（可能忘了写 params；
               也可能它本来就是给别的工具用的字面量，所以只提示不拦） */
  function templateIssues(item) {
    const decl = item.params || [];
    const vars = tplVars(TPL_FIELDS.map(f => item[f]));
    if (!decl.length) return { err: [], warn: Array.from(vars) };

    const known = new Set(decl.map(p => p.name));
    const err = [];
    vars.forEach(k => {
      if (known.has(k)) return;
      /* 大小写敏感，但拼错大小写是手写配置最常见的一种，直接给提示 */
      const near = decl.map(p => p.name).find(n => n.toLowerCase() === k.toLowerCase());
      err.push('{{' + k + '}} 没有在 params 里声明' + (near ? '（是不是想写 ' + near + '？）' : ''));
    });
    return { err: err, warn: [] };
  }

  /* query 里"纯模板且替换为空"的键直接丢掉，避免拼出 ?lang= 这种空参 */
  function fillQuery(q, args) {
    if (Array.isArray(q)) return q.map(x => fillTemplate(x, args)).filter(x => x !== '');
    if (q && typeof q === 'object') {
      const o = {};
      Object.keys(q).forEach(k => {
        const src = q[k];
        const v = fillTemplate(src, args);
        if (v === '' && typeof src === 'string' && /^\s*\{\{[\w.-]+\}\}\s*$/.test(src)) return;
        o[k] = v;
      });
      return o;
    }
    return q;
  }

  /* 含空白的 token 补回引号：splitQuoted 把引号剥掉了，拼回 cmd 原文时得还原，
     否则 "a b" 会变成两个参数 */
  function joinTokens(toks) {
    return toks.map(t => (/\s/.test(t) ? '"' + t + '"' : t)).join(' ');
  }

  /* 按声明把运行时参数灌进条目，返回「本次执行专用」的副本。
        item     —— 填好模板的副本（target/args/workdir/query/… 都替换过）
        missing  —— 还缺的必填参数（非网络类型只算模板真的用到的）
        argv     —— 需要追加到末尾的 token（app / ahk 逐项加引号）
        argvRaw  —— 同一批 token 的 cmd 原文（引号、重定向交给 cmd 解析）
        used     —— 模板里点名过的参数名，这些不再追加 */
  function applyParams(item, raw) {
    const decl = item.params || [];
    const text = raw == null ? '' : String(raw);
    const isNet = item.type === 'webhook' || item.type === 'download';

    /* 没声明 params：整条不参与替换，参数照旧原样追加。
       这是「老配置零影响」的兜底 —— 也是 {{ }} 在这些条目上的语义：字面量。 */
    if (!decl.length) {
      return {
        item: item, missing: [], args: {},
        argv: splitQuoted(text), argvRaw: text.trim(), used: new Set()
      };
    }

    const asg = assignTokens(item, text);
    const r = resolveParamValues(item, asg.values);
    const used = tplVars(TPL_FIELDS.map(f => item[f]));

    const filled = Object.assign({}, item, {
      target: fillTemplate(item.target, r.args),
      /* app / ahk 的 args 是整条命令里的一段，含空格的取值要补引号；
         cmd 的 args 是「原文交给 cmd」，补了引号 echo 会把引号一起打出来 */
      args: fillTemplate(item.args, r.args,
        (item.type === 'app' || item.type === 'ahk') ? { quote: true } : null),
      query: fillQuery(item.query, r.args),
      headers: fillTemplate(item.headers, r.args),
      body: fillTemplate(item.body, r.args),
      /* download 的保存位置也能模板化：「下载 {{name}}」直接把远端文件名当本地文件名 */
      savePath: fillTemplate(item.savePath, r.args),
      fileName: fillTemplate(item.fileName, r.args)
    });

    /* 被模板点名的参数已经落到该落的位置了，不再往末尾重复追加一次；
       没被点名的照旧按声明顺序追加 —— 所以「声明了 params 但一个模板都不用」
       的配置，表现和以前一模一样。超出声明数量的多余 token 也照旧追加。 */
    const argv = [];
    decl.forEach(p => {
      if (used.has(p.name)) return;
      const v = r.args[p.name];
      if (v !== '' && v != null) argv.push(v);
    });
    asg.extras.forEach(t => argv.push(t));

    /* 非网络类型以前不校验必填（参数只是追加，缺了也能跑）。现在有了模板，
       缺的正好是模板要用的那个变量就得拦下来，否则会静默替换成空串。 */
    const missing = isNet ? r.missing : r.missing.filter(k => used.has(k));

    return {
      item: filled, missing: missing, args: r.args,
      argv: argv, argvRaw: joinTokens(argv), used: used
    };
  }

  /* ---------------------------------------------------------- 使用记录

     统一记在一份 usage.json 里（由 AHK 落盘，跟着脚本目录走）：
       { "notepad": { "n": 12, "t": 1761830000, "args": ["a.txt", "b.txt"] } }
       n = 启动次数，t = 上次使用时间（秒），args = 最近 5 次参数原文。

     为什么不只用 localStorage：WebView2 的 profile 在 .webview2 目录里，
     清一次缓存或换台机器就没了；写成脚本旁边的 JSON 能跟 config.json 一起备份，
     也方便用户自己看/改。用浏览器直接打开（没有桥接）时才退回 localStorage。 */

  const USAGE_KEY = 'ql.usage';
  const LEGACY_HIST_KEY = 'ql.args';
  let saveTimer = 0;

  function usageRec(id) {
    const u = state.usage[id];
    return (u && typeof u === 'object') ? u : null;
  }

  function usageCount(id) {
    const u = usageRec(id);
    return u ? (Number(u.n) || 0) : 0;
  }

  function historyOf(id) {
    const u = usageRec(id);
    return (u && Array.isArray(u.args)) ? u.args : [];
  }

  function pushHistory(id, tail) {
    const s = String(tail || '').trim();
    if (!s) return;
    const u = state.usage[id] || (state.usage[id] = { n: 0, t: 0, args: [] });
    const list = (Array.isArray(u.args) ? u.args : []).filter(x => x !== s);
    list.unshift(s);
    u.args = list.slice(0, 5);
    saveUsage();
  }

  function bumpUsage(item) {
    if (!item || !item.id) return;
    const u = state.usage[item.id] || (state.usage[item.id] = { n: 0, t: 0, args: [] });
    u.n = (Number(u.n) || 0) + 1;
    u.t = Math.floor(Date.now() / 1000);
    saveUsage();
  }

  /* 频率 → 加成百分比。次数越多越高，长期不用会慢慢沉下去（约两周减半）。
     上限压到 8%：分数档位是 100/92/≤83/≤66，8% 只够在同一档里排序，
     不足以让「前缀命中 92」翻过「名字全等 100」，等级感不会被使用习惯冲垮。 */
  function usageBoost(id) {
    const n = usageCount(id);
    if (n <= 0) return 0;
    const u = usageRec(id);
    const t = Number(u && u.t) || 0;
    const days = t ? Math.max(0, Date.now() / 1000 - t) / 86400 : 0;
    const decay = 1 / (1 + Math.log2(1 + days / 7));
    return Math.min(8, Math.log2(1 + n) * 2.2) * decay;
  }

  function saveUsage() {
    const text = JSON.stringify(state.usage);
    try { localStorage.setItem(USAGE_KEY, text); } catch (e) {}
    if (!HAS_BRIDGE) return;                 /* 预览模式没有接收方，别弹 toast */
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => post({ type: 'usage-save', json: text }), 400);
  }

  function loadUsage() {
    let u = {};
    const fromBoot = boot && boot.usage;
    if (fromBoot && typeof fromBoot === 'object') {
      u = fromBoot;
    } else {
      try {
        const raw = localStorage.getItem(USAGE_KEY);
        if (raw) {
          const o = JSON.parse(raw);
          if (o && typeof o === 'object') u = o;
        }
      } catch (e) {}
    }

    /* 老版本把参数历史单独存在 ql.args，搬进来后删掉，免得两处打架 */
    try {
      const old = localStorage.getItem(LEGACY_HIST_KEY);
      if (old) {
        const o = JSON.parse(old) || {};
        Object.keys(o).forEach(id => {
          const rec = u[id] || (u[id] = { n: 0, t: 0, args: [] });
          const merged = (Array.isArray(rec.args) ? rec.args : []).slice();
          (Array.isArray(o[id]) ? o[id] : []).forEach(x => {
            if (merged.indexOf(x) < 0) merged.push(x);
          });
          rec.args = merged.slice(0, 5);
        });
        localStorage.removeItem(LEGACY_HIST_KEY);
      }
    } catch (e) {}

    return u;
  }

  /* ---------------------------------------------------------- 桥接 */

  function post(msg) {
    if (HAS_BRIDGE) {
      window.chrome.webview.postMessage(msg);
    } else {
      toast('预览模式：未连接到 AHK（' + (msg.type || '') + '）');
    }
  }

  let toastTimer = 0;
  function toast(text, ms) {
    const el = els.toast;
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2000);
  }

  /* ---------------------------------------------------------- 数据 */

  function normalizeItem(raw, i) {
    const it = raw || {};
    const type = it.type || 'app';
    return {
      id: it.id || ('item-' + i),
      name: it.name || '未命名',
      subtitle: it.subtitle || it.desc || '',
      keywords: Array.isArray(it.keywords) ? it.keywords : [],
      icon: it.icon || '',
      type: type,
      target: resolveTarget(type, it.target),
      args: it.args || '',
      workdir: absPath(it.workdir || '') || scriptDir,
      pinned: it.pinned === true,
      /* 临时停用：写 "enabled": false 就不进候选。只有布尔 false 才算停用，
         漏写 / 写成别的值一律当启用（老配置里根本没有这个字段） */
      enabled: it.enabled !== false,
      accent: it.accent || '',
      group: it.group ? String(it.group) : '',
      /* webhook 专用 */
      method: (it.method || 'GET').toUpperCase(),
      headers: it.headers || null,
      query: it.query || null,
      body: it.body,
      timeout: Number(it.timeout) > 0 ? Math.min(Number(it.timeout), 120) : 15,
      jsonPath: it.jsonPath || it.jsonpath || '',
      /* download 专用（本质是 webhook 的变种，只是把响应写成文件） */
      savePath: resolveSavePath(it.savePath || it.savepath || ''),
      fileName: String(it.fileName || it.filename || '').trim(),
      onExists: String(it.onExists || '').toLowerCase() === 'overwrite' ? 'overwrite' : 'skip',
      backup: it.backup !== false,          /* 覆盖时默认留一份 .bak */
      reload: it.reload === true,           /* 下载完自动重载配置（拉取 config.json 用） */
      /* 运行时参数声明（webhook 的模板变量，app/cmd 可省略） */
      params: Array.isArray(it.params) ? it.params.filter(p => p && p.name).map(p => ({
        name: String(p.name),
        label: p.label || '',
        placeholder: p.placeholder || '',
        default: p.default == null ? '' : String(p.default),
        optional: p.optional === true && p.required !== true,
        /* 可选：path / dir / file —— 声明后 Tab 一定按目录补全，webhook 参数也能用 */
        type: p.type ? String(p.type) : ''
      })) : []
    };
  }

  function applyConfig(cfg) {
    if (typeof cfg === 'string') {
      try { cfg = JSON.parse(cfg); } catch (e) { cfg = { items: [] }; }
    }
    /* 定时调度要从原始配置里取 schedules；老式的顶层数组没有这段，就当没配 */
    state.cfg = (cfg && !Array.isArray(cfg) && typeof cfg === 'object') ? cfg : null;
    const items = cfg && (Array.isArray(cfg) ? cfg : cfg.items);
    /* 停用的条目在「进 state.all 之前」就剔掉：搜索、分组、置顶、命令行
       （ql list / ql run）全都读 state.all，一处过滤等于处处生效，不用在
       每个入口各写一遍。归一化在前、过滤在后 —— id 缺省值是按原始下标生成的，
       先过滤会让后面条目的 id 悄悄变样。 */
    /* 模板体检放在归一化之后 —— 要拿到归一化后的 params 才能判断哪个变量是拼错的。
       这里只挂标记，执行时（launch）再拦：不把条目藏起来，否则用户对着配置
       找半天也看不出「为什么它不见了」。 */
    const norm = (arr) => arr.map((raw, i) => {
      const it = normalizeItem(raw, i);
      const t = templateIssues(it);
      it.tplErr = t.err;
      it.tplWarn = t.warn;
      if (t.err.length) console.warn('[QuickLaunch] ' + it.id + '：' + t.err.join('；'));
      return it;
    });
    const on = (arr) => arr.filter(it => it.enabled);
    if (!items) {
      state.groups = DEMO_GROUPS;
      state.all = on(norm(DEMO_ITEMS));
    } else {
      state.groups = (cfg && Array.isArray(cfg.groups) ? cfg.groups : [])
        .filter(g => g && g.id)
        .map(g => ({ id: String(g.id), name: String(g.name || g.id) }));
      state.all = on(norm(items));
    }
    state.offCount = items ? items.length - state.all.length : 0;
    /* 模板写错的条目（启用中的）：重载时汇总提示一声，执行时还会逐个拦 */
    state.tplBad = state.all.filter(x => x.tplErr.length);
    /* 有 {{x}} 但没声明 params：不拦，只提醒 —— 也可能它就是给别的工具用的字面量 */
    state.tplWarn = state.all.filter(x => x.tplWarn.length);

    state.pinned = state.all.filter(x => x.pinned);
    if (!state.pinned.length) state.pinned = state.all.slice(0, 5);
    state.sel = 0;
    state.param = null;
    state.noSplit = false;
    state.histIdx = null;
    if (els.subjChip) els.subjChip.hidden = true;
    if (els.q) els.q.placeholder = PLACEHOLDER;
    state.requested.clear();
    state.iconMap = {};
    state.index = {};                     /* 条目内容可能变了，拼音索引一起作废 */
    state.result = null;
    state.pending.clear();
    if (els.result) els.result.hidden = true;

    render();
    postSchedules();          /* 配置换了，排程表整张重装 */
  }

  /* ---------------------------------------------------------- 定时调度

     配置在 config.json 的 schedules 里（顶层，和 items / groups 平级）。
     这里只做「校验 + 规范化」，逐条上报给 AHK —— 排程和触发由 AHK 的
     原生定时器负责：窗口平时是藏着的，Chromium 对隐藏页面的 setTimeout
     会做后台节流，靠页面自己计时根本不准。

     规范化后的每条任务是"扁平字段"，AHK 用现有的 JsonStr / JsonNum 就能取，
     不用为它写一套嵌套 JSON 解析：
       { id, q, args, first, mode:'at'|'every', days:'1,2,3', times:'093000,180000', every:秒 }
     写错的条目不在页面里报错（多半是无人值守时才发现），而是带上 err 一起
     报给 AHK，由它写进 sched.log —— 那条被跳过，不影响别的任务。
     ---------------------------------------------------------- */

  const DAY_MAP = {
    sun: 0, sunday: 0, 周日: 0, 周天: 0, 日: 0,
    mon: 1, monday: 1, 周一: 1, 一: 1,
    tue: 2, tuesday: 2, 周二: 2, 二: 2,
    wed: 3, wednesday: 3, 周三: 3, 三: 3,
    thu: 4, thursday: 4, 周四: 4, 四: 4,
    fri: 5, friday: 5, 周五: 5, 五: 5,
    sat: 6, saturday: 6, 周六: 6, 六: 6
  };

  /* 星期 → "0,1,2,3,4,5,6" 这种逗号串（0 = 周日，跟 AHK 的 WDay 对齐）。
     写法不对返回 null，由调用方决定怎么报错。 */
  function parseDays(v) {
    if (v == null || v === '') return '0,1,2,3,4,5,6';
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === '*' || s === 'daily' || s === '每天' || s === 'all') return '0,1,2,3,4,5,6';
      if (s === 'weekdays' || s === 'workday' || s === '工作日') return '1,2,3,4,5';
      if (s === 'weekend' || s === '周末') return '0,6';
      if (!(s in DAY_MAP)) return null;
      return String(DAY_MAP[s]);
    }
    if (!Array.isArray(v) || !v.length) return null;
    const set = [];
    v.forEach(x => {
      const k = typeof x === 'number' ? x : DAY_MAP[String(x).trim().toLowerCase()];
      if (k == null || k < 0 || k > 6 || set.indexOf(k) >= 0) return;
      set.push(k);
    });
    if (!set.length) return null;
    return set.sort().join(',');
  }

  /* 时刻 → "HHMMSS,HHMMSS"（数组表示一天跑多次）。支持 "9:30" / "09:30:15" */
  function parseAt(v) {
    const arr = Array.isArray(v) ? v : [v];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(String(arr[i] == null ? '' : arr[i]).trim());
      if (!m) return null;
      const h = +m[1], mi = +m[2], se = m[3] == null ? 0 : +m[3];
      if (h > 23 || mi > 59 || se > 59) return null;
      const t = ('0' + h).slice(-2) + ('0' + mi).slice(-2) + ('0' + se).slice(-2);
      if (out.indexOf(t) < 0) out.push(t);
    }
    return out.length ? out.sort().join(',') : null;
  }

  /* 间隔 → 秒。写数字按秒算；带单位时支持 s/m/h（也认秒/分/小时）。
     下限 30 秒：再小没意义，还容易把一个手滑的 "0m" 变成狂刷。 */
  function parseEvery(v) {
    let sec = NaN;
    if (typeof v === 'number') {
      sec = v;
    } else {
      const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|秒|分|分钟|小时)?$/i.exec(String(v == null ? '' : v).trim());
      if (!m) return null;
      const n = parseFloat(m[1]);
      const u = (m[2] || 's').toLowerCase();
      sec = u === 'h' || u === '小时' ? n * 3600
        : u === 'm' || u === '分' || u === '分钟' ? n * 60
          : n;
    }
    if (!isFinite(sec)) return null;
    sec = Math.round(sec);
    if (sec < 30 || sec > 2592000) return null;      /* 30 秒 ~ 30 天 */
    return sec;
  }

  /* 把 config.schedules 变成一组可执行的任务；写错的条目保留 id + err，
     好让 AHK 在日志里说清楚是哪一条、错在哪。 */
  function normalizeSchedules(cfg) {
    const out = [];
    const list = cfg && Array.isArray(cfg.schedules) ? cfg.schedules : [];
    list.forEach((raw, i) => {
      const s = (raw && typeof raw === 'object') ? raw : {};
      const run = String(s.run == null ? '' : s.run).trim();
      const title = String(s.id || run || ('#' + (i + 1))).trim();
      if (s.enabled === false) return;               /* 显式停用：不装，也不报错 */
      if (!run) { out.push({ id: title, err: '缺少 run（要执行的条目）' }); return; }

      const hasAt = s.at != null && String(s.at).trim() !== '';
      const hasEvery = s.every != null && String(s.every).trim() !== '';
      if (hasAt === hasEvery) {
        out.push({ id: title, err: hasAt ? 'at 与 every 只能写一个' : 'at 与 every 至少要写一个' });
        return;
      }

      const first = s.first === false ? 0 : 1;
      const args = s.args == null ? '' : String(s.args);

      if (hasEvery) {
        if (s.days != null) { out.push({ id: title, err: 'days 只能和 at 一起用' }); return; }
        const every = parseEvery(s.every);
        if (every == null) {
          out.push({ id: title, err: 'every 写法不对（示例 "30s" / "15m" / "2h"，最小 30 秒）' });
          return;
        }
        out.push({ id: title, q: run, args: args, first: first, mode: 'every', every: every });
        return;
      }

      const times = parseAt(s.at);
      if (times == null) {
        out.push({ id: title, err: 'at 写法不对（示例 "09:30" 或 "09:30:00"）' });
        return;
      }
      const days = parseDays(s.days);
      if (days == null) {
        out.push({ id: title, err: 'days 写法不对（示例 ["mon","fri"] / "weekdays" / "weekend"）' });
        return;
      }
      out.push({ id: title, q: run, args: args, first: first, mode: 'at', days: days, times: times });
    });
    return out;
  }

  /* 一条一条发：每条都是扁平对象，AHK 那边不用解析数组。
     sched-begin / sched-end 把整批括起来，AHK 收到 end 才重装排程表。 */
  function postSchedules() {
    if (!HAS_BRIDGE) return;                         /* 浏览器预览：没有调度 */
    const list = normalizeSchedules(state.cfg);
    post({ type: 'sched-begin' });
    list.forEach(t => {
      if (t.err) { post({ type: 'sched-task', id: t.id, err: t.err }); return; }
      post({
        type: 'sched-task', id: t.id, q: t.q, args: t.args, first: t.first,
        mode: t.mode, days: t.days || '', times: t.times || '', every: t.every || 0
      });
    });
    post({ type: 'sched-end' });
  }

  /* ---------------------------------------------------------- 图标 */

  function iconFromExe(p) {
    if (!p || !/\.exe$/i.test(p)) return null;
    const hit = state.iconMap[p.toLowerCase()];
    if (hit) return hit;
    queueIcon(p);
    return null;
  }

  function resolveIconSrc(item) {
    const ic = (item.icon || '').trim();
    if (ic) {
      if (/^(https?:|data:)/i.test(ic)) return ic;
      if (isEmoji(ic)) return null;
      if (/\.(png|svg|jpe?g|gif|webp|ico|bmp)$/i.test(ic)) return fileUrl(absPath(ic));
      if (/\.exe$/i.test(ic)) return iconFromExe(absPath(ic));
    }
    /* webhook 没有可执行文件，默认用网络图标 */
    if (item.type === 'webhook') return null;
    return iconFromExe(item.target);
  }

  let iconQueue = new Set();
  let iconTimer = 0;
  function queueIcon(p) {
    if (state.requested.has(p)) return;
    state.requested.add(p);
    iconQueue.add(p);
    if (iconTimer) return;
    iconTimer = setTimeout(() => {
      const paths = Array.from(iconQueue);
      iconQueue.clear();
      iconTimer = 0;
      if (!HAS_BRIDGE) return;
      window.chrome.webview.postMessage({ type: 'icons', paths: paths });
    }, 40);
  }

  function makeIcon(item, size) {
    const el = document.createElement('span');
    el.className = 'ic';
    el.style.width = el.style.height = size + 'px';
    el.style.fontSize = Math.round(size * 0.46) + 'px';
    el.style.borderRadius = Math.round(size * 0.28) + 'px';

    const src = resolveIconSrc(item);
    if (src) {
      const img = new Image();
      img.decoding = 'async';
      img.onerror = () => {
        el.classList.add('ic-emoji');
        el.textContent = firstChar(item.name);
        el.style.color = '#6b7280';
      };
      img.src = src;
      el.appendChild(img);
      return el;
    }
    if (item.icon && isEmoji(item.icon)) {
      el.classList.add('ic-emoji');
      el.textContent = item.icon;
      return el;
    }
    if (item.type === 'webhook' && !item.icon) {
      el.classList.add('ic-emoji');
      el.innerHTML = '<svg width="' + Math.round(size * 0.56) + '" height="' + Math.round(size * 0.56) +
        '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/></svg>';
      el.style.color = item.accent || '#3b82f6';
      return el;
    }
    el.style.background = tint(item);
    el.style.color = '#fff';
    el.textContent = firstChar(item.name);
    return el;
  }

  /* ---------------------------------------------------------- 匹配

     每条目预算一组「待匹配字段」，各自有权重，搜索结果 = 各字段里的最高分：
       name 100 · 全拼 97 · 拼音首字母 93 · keywords 85 · 关键词拼音 80/76
       副标题 62 · target 58 · args 50

     拼音是压在名字旁边的，不用往 keywords 里手工堆拼音：
       "jishiben" / "jsb" → 记事本，  "cgw" → 查公网 IP

     加分规则（fieldQuality）：全等 1.0 > 前缀 0.92 > 子串 0.70~0.83 > 模糊子序列 ≤0.66。
     「真子串」永远压着「跳着命中」，否则 fzf 式的松散匹配会把精确结果挤下去。 */

  const PY = window.__PY__ || null;

  function pyCall(fn, s) {
    if (!PY || !fn || !s) return '';
    try { return fn(s); } catch (e) { return ''; }
  }

  function isBoundaryAt(s, i) {
    if (i <= 0) return true;
    return /[\s\-_/.\\\n]/.test(s.charAt(i - 1));
  }

  /* fzf 风格子序列打分：贪婪前向匹配，按「密度 + 词边界 + 是否从头开始」给分 */
  function subseqQuality(hay, needle) {
    const n = hay.length, m = needle.length;
    if (m < 2 || m > n) return 0;

    let pos = -1, first = -1, last = -1, bnd = 0;
    for (let i = 0; i < m; i++) {
      const j = hay.indexOf(needle.charAt(i), pos + 1);
      if (j < 0) return 0;                   /* 有一个字符找不到 → 整条不命中 */
      if (first < 0) first = j;
      if (isBoundaryAt(hay, j)) bnd++;
      pos = j;
      last = j;
    }

    const density = m / (last - first + 1);
    let q = 0.26 + 0.26 * density + 0.05 * Math.min(bnd, 3) / 3;
    if (first === 0) q += 0.10;
    return Math.min(0.66, q);
  }

  function fieldQuality(hay, needle, fz) {
    if (!hay || !needle) return 0;
    if (hay === needle) return 1;

    const at = hay.indexOf(needle);
    if (at === 0) return 0.92;
    if (at > 0) {
      let q = 0.80 - Math.min(0.10, (at - 1) * 0.01);
      if (isBoundaryAt(hay, at)) q += 0.03;
      return q;
    }
    if (!fz) return 0;
    return subseqQuality(hay, needle);
  }

  const FIELD_W = {
    name: 1, namePy: 0.97, nameInit: 0.93,
    kw: 0.85, kwPy: 0.80, kwInit: 0.76,
    sub: 0.62, target: 0.58, args: 0.50
  };

  /* 索引缓存：配置不变就不重算拼音（每次按键都算上百个字会明显掉帧） */
  function fieldsOf(item) {
    const hit = state.index[item.id];
    if (hit) return hit;

    const name = String(item.name || '').toLowerCase();
    const kws = item.keywords || [];
    const kw = kws.join('\n').toLowerCase();
    const list = [{ t: name, w: FIELD_W.name, fz: 1 }];

    const nPy = pyCall(PY && PY.full, item.name).toLowerCase();
    const nInit = pyCall(PY && PY.initials, item.name).toLowerCase();
    if (nPy && nPy !== name) list.push({ t: nPy, w: FIELD_W.namePy, fz: 1 });
    if (nInit && nInit !== name && nInit !== nPy) list.push({ t: nInit, w: FIELD_W.nameInit, fz: 1 });

    if (kw) {
      list.push({ t: kw, w: FIELD_W.kw, fz: 1 });
      const kAll = kws.join(' ');
      const kPy = pyCall(PY && PY.full, kAll).toLowerCase();
      const kInit = pyCall(PY && PY.initials, kAll).toLowerCase();
      if (kPy) list.push({ t: kPy, w: FIELD_W.kwPy, fz: 1 });
      if (kInit && kInit !== kPy) list.push({ t: kInit, w: FIELD_W.kwInit, fz: 1 });
    }

    if (item.subtitle) list.push({ t: String(item.subtitle).toLowerCase(), w: FIELD_W.sub });
    /* target / args 只做「全等 / 前缀 / 子串」：路径太长，放开模糊会满屏噪音 */
    if (item.target) list.push({ t: String(item.target).toLowerCase(), w: FIELD_W.target });
    if (item.args) list.push({ t: String(item.args).toLowerCase(), w: FIELD_W.args });

    state.index[item.id] = list;
    return list;
  }

  function scoreOne(item, q) {
    const needle = String(q == null ? '' : q).toLowerCase();
    if (!needle) return 0;
    const fields = fieldsOf(item);
    let best = 0;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const v = fieldQuality(f.t, needle, f.fz) * f.w;
      if (v > best) best = v;
      if (best >= 1) break;
    }
    return best > 0 ? Math.round(best * 100) : 0;
  }

  /* 多词按 AND 匹配：搜「查看 ip」也能命中「查看本机 IP」。
     没这条的话，带空格的输入既不会进参数态（词边界规则挡住了），
     又搜不到东西，等于死路。 */
  function scoreOf(item, q) {
    const terms = String(q == null ? '' : q).trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return 0;
    if (terms.length === 1) return scoreOne(item, terms[0]);

    let sum = 0;
    for (let i = 0; i < terms.length; i++) {
      const s = scoreOne(item, terms[i]);
      if (!s) return 0;
      sum += s;
    }
    return Math.round(sum / terms.length);
  }

  /* ---------------------------------------------------------- 渲染 */

  function render() {
    const parsed = parseQuery(state.q);
    let scope = parsed.scope;
    let term = parsed.term;
    const group = findGroup(parsed.groupId);

    /* 写了 @xxx 但没有这个分组：退回全量搜索，别让用户对着空列表发呆 */
    if ((scope === 'group' || scope === 'group-cmd') && !group)
      scope = term ? 'all' : 'group';

    state.scope = scope;
    state.groupId = group ? group.id : null;
    state.term = term;

    /* 出现空格、且前半截唯一命中一个「能吃参数」的条目 → 进参数态。
       state.param 一旦置上就锁定，后续输入全部算参数。 */
    if (!state.param && !state.noSplit) {
      const sp = splitArgs(state.q);
      if (sp) {
        state.param = { item: sp.item, head: sp.head };
        state.sel = 0;
        setInputTail(sp.tail);
      }
    }

    if (state.param) {
      state.results = [state.param.item];
      renderParamMode();
      return;
    }

    els.paramSection.hidden = true;
    els.listSection.hidden = false;
    renderNormal(scope, group, term);
  }

  function renderNormal(scope, group, term) {
    const base = sourceFor(scope, group);
    const q = term.toLowerCase();

    if (q) {
      state.results = base
        .map(it => {
          const s = scoreOf(it, q);
          /* 命中分 × 频率加成：只影响同档次的先后，不会让 60 分的条目翻过 100 分的 */
          return { it: it, s: s ? s * (1 + usageBoost(it.id) / 100) : 0 };
        })
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map(x => x.it);
    } else {
      /* 没关键词时按使用次数排；次数相同的保持配置顺序（Array#sort 是稳定的） */
      state.results = base.slice().sort((a, b) => usageCount(b.id) - usageCount(a.id));
    }
    if (state.sel >= state.results.length) state.sel = Math.max(0, state.results.length - 1);

    /* 常用卡片只在「全部视图 + 没有关键词」时出现 */
    const showPinned = !q && scope === 'all';
    els.pinnedSection.hidden = !showPinned;
    if (showPinned) renderPinned();

    renderChips();
    renderScopeTag();

    const titles = {
      'all': q ? '搜索结果' : '全部条目',
      'cmd': q ? '搜索结果 · 命令' : '命令',
      'group': q ? '搜索结果' : (group ? group.name : '分组'),
      'group-cmd': q ? '搜索结果' : (group ? group.name + ' · 命令' : '命令')
    };
    els.listTitle.textContent = titles[scope] || '全部条目';
    els.listCount.textContent = state.results.length + ' 项';

    renderList();
    updateHint();
  }

  /* ---------------------------------------------------------- 参数态渲染 */

  /* Windows 命令行里给单个 token 加引号（app / ahk 用；cmd 类型不加，原样拼）。
     规则和 launcher.ahk 的 QuoteArgv1 一致：反斜杠只在引号前面特殊，
     所以结尾的反斜杠必须翻倍，否则 `\\nas\share\` 会变成 `\\nas\share"`，
     把引号连同下一个参数一起吃掉（UNC 目录几乎都以反斜杠结尾）。 */
  function quoteWin(s) {
    const t = String(s == null ? '' : s);
    if (!t) return '""';
    if (!/[\s"]/.test(t)) return t;            /* 没有空白和引号就不用包 */
    let out = '', n = 0;
    for (const c of t) {
      if (c === '\\') { n++; continue; }
      if (c === '"') out += '\\'.repeat(2 * n) + '\\"';
      else out += '\\'.repeat(n) + c;
      n = 0;
    }
    out += '\\'.repeat(2 * n);
    return '"' + out + '"';
  }

  function baseName(p) {
    const s = String(p || '');
    const i = s.lastIndexOf('\\');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /* 参数态：输入框只放参数，主体变成左侧的 chip */
  function setInputTail(tail) {
    const item = state.param ? state.param.item : null;
    els.subjChip.hidden = false;
    els.subjName.textContent = item ? item.name : '';
    els.q.value = tail;
    els.q.placeholder = tailPlaceholder(item);
    try { els.q.setSelectionRange(tail.length, tail.length); } catch (e) {}
  }

  function tailPlaceholder(item) {
    const decl = (item && item.params) || [];
    if (!decl.length) return '参数，可留空';
    return '参数：' + decl.map(p => p.name).join(' ');
  }

  function setTail(v) {
    if (!state.param) return;
    els.q.value = v;
    state.q = state.param.head + ' ' + v;
    try { els.q.setSelectionRange(v.length, v.length); } catch (e) {}
    render();
  }

  /* 退出参数态：输入回到主体本身。
     为什么连参数一起丢掉：保留成 "记事本 x.txt" 的话，列表会按整串去搜，
     反而搜不到东西（实测 rows=0），而用户此刻想看的是主体还在不在。
     参数本身进了历史，重新打空格进参数态按 ↑ 就能取回。 */
  function exitParam() {
    if (!state.param) return;
    const head = state.param.head;
    state.param = null;
    state.noSplit = true;                 /* 否则 render 立刻又把它分回去 */
    state.histIdx = null;
    state.selTouched = false;
    els.subjChip.hidden = true;
    els.q.placeholder = PLACEHOLDER;
    els.q.value = head;
    state.q = head;
    try { els.q.setSelectionRange(head.length, head.length); } catch (e) {}
    render();
    els.q.focus();
  }

  function paramHistory(dir) {
    if (!state.param) return false;
    const list = historyOf(state.param.item.id);
    if (!list.length) return false;
    if (dir < 0 && els.q.value.trim() !== '') return false;   /* 有内容时别覆盖 */
    if (state.histIdx == null) state.histIdx = -1;
    state.histIdx += (dir < 0 ? 1 : -1);
    if (state.histIdx >= list.length) state.histIdx = 0;
    if (state.histIdx < 0) { state.histIdx = -1; setTail(''); return true; }
    setTail(list[state.histIdx]);
    return true;
  }

  /* ---------------------------------------------------------- 参数补全

     两种补全，都只在参数态生效：
       →   把「已输入的前缀」扩成最近一次完全匹配的历史（8.8 → 8.8.8.8）
       Tab 路径类参数补目录（C:\Win → C:\Windows\，多个候选先补公共前缀）

     Tab 需要读目录，页面没有文件系统权限，所以走 AHK：post {type:'fs'} →
     AHK 列目录 → 回 {type:'fs-result'}。请求带回 reqId，回来时如果输入已经变了
     就直接丢弃，避免"补到一半结果回来把用户新打的字覆盖掉"。 */

  const fsWait = new Map();
  let fsSeq = 0;

  function fsList(dir, cb) {
    if (!HAS_BRIDGE) { cb({ ok: false, err: '预览模式读不到目录，请在软件里试' }); return; }
    const id = 'f' + (++fsSeq);
    fsWait.set(id, cb);
    post({ type: 'fs', id: id, dir: dir });
    setTimeout(() => {
      if (!fsWait.has(id)) return;
      fsWait.delete(id);
      cb({ ok: false, err: '目录读取超时' });
    }, 3000);
  }

  function onFsResult(msg) {
    const cb = fsWait.get(msg.id);
    if (!cb) return;
    fsWait.delete(msg.id);
    cb({ ok: !!msg.ok, dir: msg.dir || '', err: msg.err || '', entries: msg.entries || [] });
  }

  /* tail 里最后一段（引号感知）的范围；尾随空格时 start === len，即"正在打新 token" */
  function lastTokenRange(s) {
    const str = String(s || '');
    let quote = '', start = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charAt(i);
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (/\s/.test(c)) {
        start = i + 1;
      }
    }
    return { start: start, end: str.length };
  }

  function joinPath(a, b) {
    const x = String(a || '').replace(/\//g, '\\');
    const y = String(b || '').replace(/\//g, '\\');
    if (!x) return y;
    if (!y) return x;
    return x.replace(/\\+$/, '') + '\\' + y.replace(/^\\+/, '');
  }

  /* 当前 token 拆成「要列哪个目录」+「已经打了的目录名前缀」 */
  function splitForComplete(tok, workdir) {
    const s = String(tok || '');
    const cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    const dirPart = cut >= 0 ? s.slice(0, cut + 1) : '';
    const prefix = cut >= 0 ? s.slice(cut + 1) : s;

    let base;
    if (/^[a-zA-Z]:/.test(dirPart) || dirPart.charAt(0) === '\\' || dirPart.charAt(0) === '/')
      base = dirPart;
    else
      base = joinPath(workdir, dirPart);

    return { base: base, prefix: prefix, dirPart: dirPart };
  }

  function longestCommonPrefix(list) {
    if (!list.length) return '';
    let p = list[0];
    for (let i = 1; i < list.length; i++) {
      let j = 0;
      while (j < p.length && j < list[i].length && p.charAt(j).toLowerCase() === list[i].charAt(j).toLowerCase()) j++;
      p = p.slice(0, j);
      if (!p) break;
    }
    return p;
  }

  /* 正在编辑的参数声明（只是给"这个参数是不是路径"做参考，取不到也不影响） */
  function currentParamDecl(item) {
    const decl = (item && item.params) || [];
    if (!decl.length) return null;
    const v = els.q.value;
    if (/\s$/.test(v)) return null;
    const i = splitQuoted(v).length - 1;
    return (i >= 0 && i < decl.length) ? decl[i] : null;
  }

  /* 这一段的输入看起来像路径吗？
     webhook 的参数默认不是路径（除非声明 type: "path"），其余动作型条目只要带分隔符就算 */
  function looksPathy(tok, item) {
    if (!tok) return false;
    const d = currentParamDecl(item);
    if (d && /^(path|dir|file)$/i.test(String(d.type || ''))) return true;
    if (item.type === 'webhook' && !(d && d.type)) return false;
    return /[\\/]/.test(tok) || /^[a-zA-Z]:/.test(tok) || /^\.{1,2}$/.test(tok);
  }

  /* 引号包裹的 token：拆出「引号 / 内容 / 是否已闭合」，补完再按原样拼回去。
     不拆的话 `"C:\Program Files` 会带着引号去解析，目录直接被拼成非法路径。 */
  function unquoteToken(raw) {
    const s = String(raw || '');
    const q = s.charAt(0);
    if (q !== '"' && q !== "'") return { q: '', tok: s, closed: false };
    const closed = s.length > 1 && s.charAt(s.length - 1) === q;
    return { q: q, tok: s.slice(1, closed ? s.length - 1 : s.length), closed: closed };
  }

  /* Tab：目录补全。返回 true 表示"已接管这次按键"（可能是异步的） */
  function completePath() {
    if (!state.param) return false;
    const item = state.param.item;
    const tail = els.q.value;
    const range = lastTokenRange(tail);
    const raw = tail.slice(range.start, range.end);
    const uq = unquoteToken(raw);
    const tok = uq.tok;
    if (!looksPathy(tok, item)) return false;

    const sp = splitForComplete(tok, item.workdir || scriptDir);
    const wrap = v => (uq.q || '') + v + (uq.closed ? uq.q : '');

    fsList(sp.base, res => {
      if (els.q.value !== tail) return;          /* 用户已经改了输入，结果作废 */
      if (!res.ok) { toast(res.err || '目录读取失败'); return; }

      const pre = sp.prefix.toLowerCase();
      const hits = res.entries.filter(e => String(e.n).toLowerCase().startsWith(pre));
      if (!hits.length) { setTail(tail + ' '); return; }   /* 没候选就当分隔空格 */

      if (hits.length === 1) {
        const e = hits[0];
        setTail(tail.slice(0, range.start) + wrap(sp.dirPart + e.n + (e.d ? '\\' : '')));
        return;
      }

      const cp = longestCommonPrefix(hits.map(e => String(e.n)));
      if (cp.length > sp.prefix.length) {
        setTail(tail.slice(0, range.start) + wrap(sp.dirPart + cp));
        const nd = hits.filter(e => e.d).length;
        toast('补到 "' + cp + '"，' + hits.length + ' 个候选（' + nd + ' 个目录）· 再按 Tab 看更多');
      } else {
        const head = hits.slice(0, 8).map(e => e.n + (e.d ? '\\' : '')).join('   ');
        toast('候选：' + head + (hits.length > 8 ? '  …' : ''), 3600);
      }
    });
    return true;
  }

  /* 光标是否停在末尾、且没选中一段文本 —— 此时空格抢键才不会吃掉用户正在编辑的内容 */
  function caretAtEnd() {
    try {
      const v = els.q.value;
      return els.q.selectionStart === v.length && els.q.selectionEnd === v.length;
    } catch (e) {
      return true;                        /* 取不到就按"在末尾"处理，老浏览器也能用 */
    }
  }

  /* →：用最近一次的历史把当前前缀补全。有多个可补时取最近的那条。 */
  function histComplete() {
    if (!state.param) return false;
    const v = els.q.value;
    if (!v) return false;
    try {
      if (els.q.selectionStart !== v.length || els.q.selectionEnd !== v.length) return false;
    } catch (e) {}

    const list = historyOf(state.param.item.id);
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      if (h !== v && h.length > v.length && h.toLowerCase().startsWith(v.toLowerCase())) {
        setTail(h);
        return true;
      }
    }
    return false;
  }

  function updateHint() {
    if (!els.hintArgs) return;
    const it = state.results[state.sel];
    els.hintArgs.hidden = !!(state.param || !it || !takesArgs(it));
  }

  function renderParamMode() {
    const item = state.param.item;
    els.pinnedSection.hidden = true;
    els.listSection.hidden = true;
    els.paramSection.hidden = false;
    els.chips.hidden = true;
    renderScopeTag();

    els.subjChip.hidden = false;
    els.subjName.textContent = item.name;
    els.paramName.textContent = item.name;
    els.paramKind.textContent = kindLabel(item);
    els.paramKind.className = 'pkind' + (item.type === 'webhook' ? ' pkind-http' : '');

    const decl = item.params || [];
    const tail = els.q.value;
    const table = els.paramTable;
    table.innerHTML = '';

    const assigned = decl.length ? assignTokens(item, tail) : { values: {}, extra: 0, extras: [] };
    const w = applyParams(item, tail);
    const applied = w.item;
    /* 参数态里「缺」要按声明算全，不看模板用没用到 —— 人在这儿就是要看清单 */
    const resolved = resolveParamValues(item, assigned.values);
    const missing = resolved.missing;

    if (decl.length) {
      decl.forEach(p => {
        const given = assigned.values[p.name];
        const has = given != null && given !== '';
        const val = has ? given : (resolved.args[p.name] || '');

        const row = document.createElement('div');
        row.className = 'pitem' + (missing.indexOf(p.name) >= 0 ? ' miss' : '');

        const key = document.createElement('span');
        key.className = 'pkey';
        key.textContent = p.name;

        const lbl = document.createElement('span');
        lbl.className = 'plbl';
        lbl.textContent = p.label || '';

        const v = document.createElement('span');
        v.className = 'pval' + (val ? '' : ' ph');
        v.textContent = val || (p.placeholder || (p.optional ? '可留空' : '必填'));

        const st = document.createElement('span');
        st.className = 'pstate';
        st.textContent = has ? '' : (val ? '默认' : (p.optional ? '可选' : '缺'));

        row.appendChild(key);
        row.appendChild(lbl);
        row.appendChild(v);
        row.appendChild(st);
        table.appendChild(row);
      });
    } else {
      const hint = document.createElement('div');
      hint.className = 'pfree';
      hint.textContent = decl.length
        ? '这些变量会被替换进 target / args：' + decl.map(p => '{{' + p.name + '}}').join(' ')
        : (item.type === 'cmd'
          ? '整段内容会原样追加到命令行末尾，引号和重定向都交给 cmd 解析'
          : '按空格分开的每个参数会各自加引号，再追加到程序后面');
      table.appendChild(hint);
    }

    /* 预览：把拼接结果直接摆出来，最省心的验证方式 */
    let head = '将执行';
    let preview = '';

    if (item.type === 'download') {
      head = '将下载';
      preview = 'GET ' + buildUrl(applied) +
        '  →  ' + (applied.savePath || '系统「下载」目录') + '\\' +
        (applied.fileName || '（沿用远端文件名）');
    } else if (item.type === 'webhook') {
      head = '将请求';
      preview = (item.method || 'GET') + ' ' + buildUrl(applied);
    } else if (item.type === 'cmd') {
      preview = applied.target + (w.argvRaw ? ' ' + w.argvRaw : '');
    } else if (item.type === 'ahk') {
      preview = 'AutoHotkey64.exe ' + quoteWin(baseName(applied.target)) +
        (applied.args ? ' ' + applied.args : '') +
        (w.argv.length ? ' ' + w.argv.map(quoteWin).join(' ') : '');
    } else {
      preview = baseName(applied.target) +
        (applied.args ? ' ' + applied.args : '') +
        (w.argv.length ? ' ' + w.argv.map(quoteWin).join(' ') : '');
    }

    els.paramPreviewLabel.textContent = head;
    els.paramPreview.textContent = preview || '（空）';
    els.paramLine.classList.toggle('bad', missing.length > 0);

    const bits = [];
    if (missing.length) bits.push('还缺：' + missing.join('、'));
    if (assigned.extra) bits.push(assigned.extra + ' 个多余参数会被忽略');
    if (!decl.length) bits.push('空格分隔多个参数，含空格用引号');
    if (!tail.trim()) {
      const hist = historyOf(item.id);
      if (hist.length) bits.push('↑ 上次：' + hist[0]);
    }
    const pathy = item.type === 'app' || item.type === 'cmd' || item.type === 'ahk' ||
      decl.some(p => /^(path|dir|file)$/i.test(String(p.type || '')));
    if (pathy) bits.push('Tab 补路径 · → 补上次');
    bits.push('Enter 运行 · Esc 退出参数');
    els.paramNote.textContent = bits.join(' · ');

    updateHint();
  }

  function renderChips() {
    const box = els.chips;
    if (!box) return;
    box.innerHTML = '';
    if (!state.groups.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    const mk = (label, gid) => {
      const b = document.createElement('button');
      b.className = 'chip' + (state.groupId === gid ? ' on' : '');
      b.textContent = label;
      b.addEventListener('click', () => setQuery(chipQuery(gid)));
      return b;
    };
    box.appendChild(mk('全部', null));
    state.groups.forEach(g => box.appendChild(mk(g.name, g.id)));
  }

  /* 点分组胶囊时保留命令模式与关键词，只换分组前缀 */
  function chipQuery(gid) {
    const keepCmd = state.scope === 'cmd' || state.scope === 'group-cmd';
    return (gid ? '@' + gid : '') + (keepCmd ? '>' : '') + (state.term || '');
  }

  function renderScopeTag() {
    const tag = els.scopeTag;
    if (!tag) return;
    if (state.scope === 'all') {
      tag.hidden = true;
      return;
    }
    tag.hidden = false;
    els.scopeText.textContent = state.scope === 'cmd' || state.scope === 'group-cmd' ? '命令' : '分组';
  }

  function setQuery(s) {
    state.param = null;
    state.noSplit = false;
    state.histIdx = null;
    if (els.subjChip) els.subjChip.hidden = true;
    if (els.q) els.q.placeholder = PLACEHOLDER;
    els.q.value = s;
    state.q = s;
    state.sel = 0;
    state.selTouched = false;
    render();
    els.q.focus();
  }

  function renderPinned() {
    const box = els.pinned;
    box.innerHTML = '';
    els.pinnedHint.textContent = state.pinned.length + ' 个置顶';
    state.pinned.forEach(item => {
      const card = document.createElement('div');
      card.className = 'card';
      card.title = `${item.name}\n${item.target}`;
      if (item.accent) card.style.setProperty('--tint', item.accent + '33');
      card.appendChild(makeIcon(item, 30));
      const nm = document.createElement('div');
      nm.className = 'card-name';
      nm.textContent = item.name;
      card.appendChild(nm);
      card.addEventListener('click', () => launch(item));
      box.appendChild(card);
    });
  }

  function renderList() {
    const box = els.list;
    box.innerHTML = '';

    if (!state.results.length) {
      els.empty.hidden = false;
      if (state.scope === 'cmd' || state.scope === 'group-cmd')
        els.emptyText.textContent = state.term ? '没有匹配的命令' : '这个范围里没有命令、请求或下载';
      else if (state.scope === 'group' && !state.term)
        els.emptyText.textContent = state.groupId ? '这个分组还没有条目' : '没有这个分组';
      else
        els.emptyText.textContent = state.q ? '没有匹配的结果' : '配置里还没有条目';
      return;
    }
    els.empty.hidden = true;

    const frag = document.createDocumentFragment();
    state.results.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'row' + (idx === state.sel ? ' sel' : '');
      row.dataset.idx = idx;

      row.appendChild(makeIcon(item, 26));

      const main = document.createElement('div');
      main.className = 'row-main';
      const nm = document.createElement('div');
      nm.className = 'row-name';
      nm.textContent = item.name;
      main.appendChild(nm);
      if (item.subtitle) {
        const sub = document.createElement('div');
        sub.className = 'row-sub';
        sub.textContent = item.subtitle;
        main.appendChild(sub);
      }
      row.appendChild(main);

      /* 无关键词浏览时露一下使用次数，让排序有据可查（只显示用过的） */
      const n = usageCount(item.id);
      if (!state.term && n > 0) {
        const use = document.createElement('span');
        use.className = 'row-use';
        use.textContent = n > 99 ? '99+' : '×' + n;
        use.title = '已使用 ' + n + ' 次';
        row.appendChild(use);
      }

      const kind = document.createElement('span');
      kind.className = 'row-kind'
        + (item.type === 'webhook' ? ' row-kind-http' : '')
        + (item.type === 'download' ? ' row-kind-dl' : '');
      kind.textContent = kindLabel(item);
      row.appendChild(kind);

      const ent = document.createElement('span');
      ent.className = 'row-enter';
      ent.textContent = '⏎';
      row.appendChild(ent);

      row.addEventListener('click', () => { state.sel = idx; doLaunch(); });
      /* 鼠标悬停只挪高亮，不置 selTouched：光标本来就可能停在列表上，
         一悬停就让空格变成"进参数态"，多词搜索会被莫名其妙地打断 */
      row.addEventListener('mouseenter', () => { state.sel = idx; highlight(); });
      frag.appendChild(row);
    });
    box.appendChild(frag);
    highlight();
  }

  function highlight() {
    const rows = els.list.children;
    for (let i = 0; i < rows.length; i++) {
      const on = i === state.sel;
      rows[i].classList.toggle('sel', on);
      if (on && rows[i].scrollIntoView) {
        rows[i].scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function moveSel(delta) {
    if (!state.results.length) return;
    state.sel = (state.sel + delta + state.results.length) % state.results.length;
    state.selTouched = true;              /* 空格从此对这个高亮行生效，见 spaceTarget */
    highlight();
  }

  /* ---------------------------------------------------------- 动作 */

  function launch(item, tail, opts) {
    if (!item) return false;
    const raw = tail == null ? '' : String(tail);
    /* 命令行发起的执行：缺参数时不能"送进参数态"（窗口多半是隐藏的，没人能接着敲），
       必须直接失败并把原因回给调用方 */
    const cli = !!(opts && opts.cli);
    /* 定时调度发起的执行：同样没人看着，而且不能动界面（不弹结果面板、不计使用频率） */
    const quiet = !!(opts && opts.quiet);

    /* 模板里写了个没声明的变量：宁可拒绝，也别悄悄替换成空串跑出个歪结果。
       载入配置时就查过一遍（见 templateIssues），这里是最后一道闸。 */
    if (item.tplErr && item.tplErr.length) {
      const msg = '配置有误：' + item.tplErr.join('；');
      if (cli) { cliDone(4, msg); return false; }
      toast(msg, 5000);
      return false;
    }

    /* 声明了 params 的条目：先把模板填好，再决定末尾还要追加什么 */
    const w = applyParams(item, raw);

    if (w.missing.length) {
      /* 点了没填参数的必填条目：别直接报错，把人送进参数态 */
      if (cli) { cliDone(3, '还缺参数：' + w.missing.join('、')); return false; }
      if (!raw.trim()) { enterParamFor(item); return false; }
      toast('还缺参数：' + w.missing.join('、'));
      return false;
    }

    if (item.type === 'webhook' || item.type === 'download') {
      if (item.type === 'download') runDownload(w.item, cli, quiet);
      else runWebhook(w.item, raw, cli, quiet);
      if (!quiet) bumpUsage(item);
      return true;
    }

    post({
      type: 'run',
      id: item.id,
      name: item.name,
      kind: item.type,
      target: w.item.target,
      args: w.item.args,
      workdir: w.item.workdir,
      argv: w.argv,
      /* cmd 类型要的是原文（引号、重定向都交给 cmd 自己解释） */
      argvRaw: item.type === 'cmd' ? w.argvRaw : '',
      /* 带 rid 时 AHK 会把启动结果回执回来（见 run-ack） */
      cli: cli && cliCur ? cliCur.rid : ''
    });
    /* 自动跑的不计入"使用频率"：否则每天定时跑的任务会把搜索排序顶到最前面 */
    if (!quiet) bumpUsage(item);
    return true;
  }

  /* 直接进入某条目的参数态：等价于替用户敲了「名字 + 空格」。
     以前是绕回文本（setQuery(item.name + ' ')）让 render 的拆分规则再接一手，
     同名条目会拆不开（exact > 1 → 不分裂），于是空格点下去像没反应。
     现在直接置参数态，不再依赖文本能不能重新拆回来。 */
  function enterParamFor(item) {
    if (!item) return;
    state.param = { item: item, head: item.name };
    state.noSplit = false;
    state.histIdx = null;
    state.sel = 0;
    state.selTouched = false;
    state.q = item.name + ' ';
    setInputTail('');                     /* 芯片写名字、输入框清空、占位符换成参数提示 */
    render();
    els.q.focus();
  }

  /* file:///C:/a%20b/拖入.txt → C:\a b\拖入.txt；file://server/share/x → \\server\share\x
     解 URL 放在页面做：`new URL` + decodeURIComponent 本来就干这个，
     宿主侧的 PathCreateFromUrlW 会把多字节字符按"一个字节一个字符"解，中文必乱。 */
  function fileUrlToPath(uri) {
    let u;
    try { u = new URL(String(uri || '')); } catch (e) { return ''; }
    if (String(u.protocol || '').toLowerCase() !== 'file:') return '';
    let p = u.pathname || '';
    try { p = decodeURIComponent(p); } catch (e) { /* 不是合法转义就按原文用 */ }
    const host = String(u.hostname || '');
    if (host && host.toLowerCase() !== 'localhost') {
      /* UNC：\\服务器\共享\… */
      return ('\\\\' + host + p).replace(/\//g, '\\');
    }
    /* 本地：pathname 一定以 / 开头，去掉它再换反斜杠（保留 \\?\ 这类前缀不管） */
    return p.replace(/^\//, '').replace(/\//g, '\\');
  }

  /* ---------------------------------------------------------- 拖文件进来

     WebView2 默认把"拖进窗口的文件"当成一次**顶层导航**（file:///C:/…），
     等于整个界面被换成文件内容 —— 看上去就像"程序拿它打开了文件"。
     页面自己救不了：DataTransfer 里的 File 只有名字、没有路径（Chromium 的安全设计），
     所以由 AHK 在 NavigationStarting 里把那次导航拦下，把 URI 送到这里
     （见 launcher.ahk 的 OnNavStarting）。

     落到哪里：等价于"把这段路径粘贴进参数"——
       · 已在参数态 → 补到参数末尾（含空格自动加引号，和手打一样）
       · 没在参数态 → 先为高亮的那一条进参数态（拖文件是个明确动作，不再要求先按过 ↑↓）
       · 高亮项不吃参数 → 就当普通文本插到光标处
     ---------------------------------------------------------- */
  function onDropped(uri) {
    const p = fileUrlToPath(uri);
    if (!p) return;
    const text = /\s/.test(p) ? '"' + p + '"' : p;
    try { els.q.focus(); } catch (e) {}

    if (!state.param) {
      const it = state.results[state.sel];
      if (it && takesArgs(it)) enterParamFor(it);
    }
    if (state.param) {
      const cur = els.q.value;
      setTail(cur + (cur && !/\s$/.test(cur) ? ' ' : '') + text);
    } else {
      insertAtCaret(text);
    }
    toast('已填入路径：' + (p.length > 60 ? p.slice(0, 58) + '…' : p), 2600);
  }

  /* 把一段文本"粘贴"进搜索框：走同一条 input 流程，光标停在插入内容之后 */
  function insertAtCaret(text) {
    const v = els.q.value;
    let s = v.length, e = v.length;
    try { s = els.q.selectionStart; e = els.q.selectionEnd; } catch (e2) {}
    els.q.value = v.slice(0, s) + text + v.slice(e);
    const pos = s + text.length;
    try { els.q.setSelectionRange(pos, pos); } catch (e2) {}
    els.q.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* Enter：参数态就带上参数，否则按老行为 */
  function doLaunch() {
    const item = state.results[state.sel];
    if (!item) return;
    const tail = state.param ? els.q.value : '';
    if (state.param) pushHistory(item.id, tail);

    const ok = launch(item, tail);
    /* 参数态启动成功就把输入清干净：否则下次唤出还停在参数态，
       新输入会被拼到旧主体后面（实测踩过）。
       非参数态的启动保持原行为（窗口隐藏，查询留着）。 */
    if (ok && state.param && item.type !== 'webhook' && item.type !== 'download') setQuery('');
  }

  /* ---------------------------------------------------------- Webhook */

  function toQueryString(q) {
    if (!q) return '';
    const pairs = [];
    if (Array.isArray(q)) {
      q.forEach(x => { if (x) pairs.push(String(x)); });
    } else if (typeof q === 'object') {
      Object.keys(q).forEach(k => {
        const v = q[k];
        if (v == null) return;
        pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      });
    } else {
      pairs.push(String(q));
    }
    return pairs.join('&');
  }

  function buildUrl(item) {
    const base = item.target || '';
    const qs = toQueryString(item.query);
    if (!qs) return base;
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + qs;
  }

  function buildBody(item) {
    const m = (item.method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD') return '';
    const b = item.body;
    if (b == null || b === '') return '';
    return typeof b === 'string' ? b : JSON.stringify(b);
  }

  function headerLines(item) {
    const h = item.headers;
    const lines = [];
    if (Array.isArray(h)) {
      h.forEach(x => { if (x) lines.push(String(x)); });
    } else if (h && typeof h === 'object') {
      Object.keys(h).forEach(k => lines.push(k + ': ' + h[k]));
    }
    /* 有请求体又没说 Content-Type，默认按 JSON 发 */
    const body = buildBody(item);
    if (body && !lines.some(l => /^content-type\s*:/i.test(l)))
      lines.push('Content-Type: application/json; charset=utf-8');
    return lines;
  }

  function runWebhook(item, raw, cli, quiet) {
    const id = 'r' + (++state.reqSeq).toString(36) + '-' + Date.now().toString(36);
    state.pending.set(id, { item: item, cli: !!cli, quiet: !!quiet });

    /* 定时调度触发的请求不碰结果面板：窗口是藏着的，占了面板反而让用户
       下次开窗看到一条莫名其妙的旧结果。结果摘要已经进 sched.log 了。 */
    if (!quiet) {
      state.result = {
        id: id, item: item, loading: true, ok: true,
        status: 0, ms: 0, body: '', error: '', truncated: 0, view: 'body'
      };
      renderResult();
    }

    if (!HAS_BRIDGE) {
      /* 浏览器预览：给一份假响应，方便调样式 */
      setTimeout(() => {
        state.pending.delete(id);
        state.result = {
          id: id, item: item, loading: false, ok: true,
          status: 200, ms: 128, body: DEMO_RESPONSE, error: '', truncated: 0, view: 'body'
        };
        renderResult();
      }, 320);
      return;
    }

    post({
      type: 'http',
      id: id,
      method: item.method,
      url: buildUrl(item),
      headers: headerLines(item),
      body: buildBody(item),
      timeout: item.timeout
    });
  }

  function onHttpResult(msg) {
    const pend = state.pending.get(msg.id);
    state.pending.delete(msg.id);
    const wasCli = !!(pend && pend.cli);
    if (pend && pend.quiet) {
      cliDone(msg.ok ? 0 : 4, msg.ok
        ? ('HTTP ' + (msg.status | 0) + ' · ' + (msg.ms | 0) + 'ms')
        : ('请求失败：' + (msg.error || '未知错误')));
      return;
    }
    if (!state.result || state.result.id !== msg.id) {   /* 过期结果直接丢 */
      if (wasCli) cliDone(4, '结果面板已被关闭，取不到这次请求的结果');
      return;
    }

    state.result = {
      id: msg.id,
      item: pend ? pend.item : state.result.item,
      loading: false,
      ok: !!msg.ok,
      status: msg.status | 0,
      ms: msg.ms | 0,
      body: msg.body || '',
      error: msg.error || '',
      truncated: msg.truncated | 0,
      view: 'body'
    };
    renderResult();

    if (wasCli) {
      cliDone(msg.ok ? 0 : 4, msg.ok
        ? ('HTTP ' + (msg.status | 0) + ' · ' + (msg.ms | 0) + 'ms')
        : ('请求失败：' + (msg.error || '未知错误')));
    }
  }

  /* ---------------------------------------------------------- Download */

  function runDownload(item, cli, quiet) {
    const id = 'd' + (++state.reqSeq).toString(36) + '-' + Date.now().toString(36);
    state.pending.set(id, { item: item, kind: 'download', cli: !!cli, quiet: !!quiet });

    if (!quiet) {
      state.result = {
        id: id, item: item, loading: true, ok: true, download: true,
        status: 0, ms: 0, error: '', url: buildUrl(item),
        file: '', name: '', size: 0, skipped: 0, backup: '', view: 'body'
      };
      renderResult();
    }

    if (!HAS_BRIDGE) {
      if (quiet) { state.pending.delete(id); return; }
      setTimeout(() => {
        state.pending.delete(id);
        state.result = Object.assign({}, state.result, {
          loading: false, status: 200, ms: 186, size: 20480,
          file: 'C:\\Users\\你\\Downloads\\示例文件.txt'
        });
        renderResult();
      }, 320);
      return;
    }

    post({
      type: 'download',
      id: id,
      url: buildUrl(item),
      headers: headerLines(item),
      savePath: item.savePath || '',
      fileName: item.fileName || '',
      timeout: item.timeout,
      onExists: item.onExists,
      backup: item.backup ? 1 : 0,
      reload: item.reload ? 1 : 0
    });
  }

  function onDownloadResult(msg) {
    /* 「拉取在线配置」不挂在结果面板上，只用 toast 报告 */
    if (msg.purpose === 'pull-config') {
      if (msg.ok) {
        toast('配置已拉取并重载' + (msg.backup ? '（原文件已备份为 config.json.bak）' : ''), 3600);
      } else {
        toast('拉取失败：' + (msg.error || '未知错误'), 4200);
      }
      return;
    }

    const pend = state.pending.get(msg.id);
    state.pending.delete(msg.id);
    const wasCli = !!(pend && pend.cli);
    if (pend && pend.quiet) {
      cliDone(msg.ok ? 0 : 4, msg.ok
        ? ((msg.skipped ? '文件已存在，已跳过：' : '已下载：') + (msg.file || ''))
        : ('下载失败：' + (msg.error || '未知错误')));
      return;
    }
    if (!state.result || state.result.id !== msg.id) {
      if (wasCli) cliDone(4, '结果面板已被关闭，取不到这次下载的结果');
      return;
    }

    state.result = Object.assign({}, state.result, {
      loading: false,
      ok: !!msg.ok,
      status: msg.status | 0,
      ms: msg.ms | 0,
      error: msg.error || '',
      file: msg.file || '',
      name: msg.name || '',
      size: msg.size | 0,
      skipped: msg.skipped | 0,
      backup: msg.backup || ''
    });
    renderResult();

    if (wasCli) {
      cliDone(msg.ok ? 0 : 4, msg.ok
        ? ((msg.skipped ? '文件已存在，已跳过：' : '已下载：') + (msg.file || ''))
        : ('下载失败：' + (msg.error || '未知错误')));
      return;
    }

    if (msg.ok) {
      toast(msg.skipped ? '文件已存在，已跳过' : ('已下载：' + baseName(msg.file || '')), 2600);
    } else {
      toast('下载失败：' + (msg.error || '未知错误'), 4000);
    }
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function downloadSummary(res) {
    if (res.loading) return '正在下载…';
    if (!res.ok) return netErrorText(res);
    if (res.skipped) return '文件已存在，按「跳过」处理：\n' + res.file;
    const lines = ['已保存：' + (res.file || '(未知路径)')];
    if (res.size) lines.push('大小：' + fmtBytes(res.size));
    if (res.ms) lines.push('用时：' + res.ms + ' ms');
    if (res.backup) lines.push('原文件已备份：' + res.backup);
    return lines.join('\n');
  }

  /* ---------------------------------------------------------- 结果分析 */

  /* 支持 data.items[0].name / $.data.total / data.rows[2] 这几种写法 */
  function getByPath(obj, path) {
    const p = String(path == null ? '' : path).trim();
    if (!p || p === '$') return { ok: true, value: obj };

    const body = p.replace(/^\$?\.?/, '').replace(/\[(\d+)\]/g, '.$1');
    const steps = body.split('.').filter(s => s !== '');
    let cur = obj;

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (cur == null) return { ok: false, error: `走到 "${s}" 时上一级是空值` };
      if (Array.isArray(cur)) {
        const n = Number(s);
        if (!Number.isInteger(n) || n < 0 || n >= cur.length)
          return { ok: false, error: `数组下标 ${s} 越界（长度 ${cur.length}）` };
        cur = cur[n];
      } else if (typeof cur === 'object') {
        if (!(s in cur)) return { ok: false, error: `没有字段 "${s}"` };
        cur = cur[s];
      } else {
        return { ok: false, error: `"${s}" 处不是对象或数组` };
      }
    }
    return { ok: true, value: cur };
  }

  function analyzeResult(res) {
    const out = { isJson: false, json: null, hasPath: false, extracted: undefined, pathError: '' };
    if (!res || !res.body) return out;
    try {
      out.json = JSON.parse(res.body);
      out.isJson = true;
    } catch (e) {
      return out;
    }
    const path = res.item && res.item.jsonPath;
    if (path) {
      out.hasPath = true;
      const r = getByPath(out.json, path);
      if (r.ok) out.extracted = r.value;
      else out.pathError = r.error;
    }
    return out;
  }

  function prettyValue(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }

  function highlightJson(src) {
    const re = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
    let out = '', last = 0, m;
    while ((m = re.exec(src)) !== null) {
      out += esc(src.slice(last, m.index));
      if (m[1] !== undefined) {
        out += m[2]
          ? '<span class="jt-key">' + esc(m[1]) + '</span><span class="jt-p">' + esc(m[2]) + '</span>'
          : '<span class="jt-str">' + esc(m[1]) + '</span>';
      } else if (m[3] !== undefined) {
        out += '<span class="jt-num">' + esc(m[3]) + '</span>';
      } else {
        out += '<span class="jt-lit">' + esc(m[4]) + '</span>';
      }
      last = m.index + m[0].length;
    }
    return out + esc(src.slice(last));
  }

  const STATUS_TEXT = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    301: 'Moved', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable', 429: 'Too Many Requests',
    500: 'Internal Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable'
  };

  /* ---------------------------------------------------------- 结果面板 */

  function statusClass(res) {
    if (res.loading) return 'st-wait';
    if (!res.ok) return 'st-err';
    if (res.status >= 200 && res.status < 300) return 'st-ok';
    if (res.status >= 300 && res.status < 400) return 'st-warn';
    return 'st-err';
  }

  /* 连接层失败（一个字节的响应都没拿到）时的提示。
     关键是要和 4xx/5xx 区分开：限流会返回状态码和正文，不会走到这里。 */
  function netErrorText(res) {
    const err = String(res.error || '请求失败').trim();
    const lines = ['请求没有完成，没有拿到任何 HTTP 响应。', '', '  ' + err, ''];

    if (/超时/.test(err)) {
      lines.push('目标没有在限定时间内响应，可能是服务太慢，也可能链路根本不通。');
      lines.push('先把 timeout 调大再试；若仍超时，按下面的网络问题排查。');
      return lines.join('\n');
    }

    lines.push('这类错误发生在「还没拿到响应」的阶段（DNS / 连接 / TLS 握手），');
    lines.push('不是服务端限流——限流会返回 429、503 这样的状态码和响应正文。');
    lines.push('');
    lines.push('常见原因');
    lines.push('  1. 目标域名在当前网络被阻断：TCP 能连上，TLS 握手一发出去就被断开');
    lines.push('  2. 需要代理才能访问，而代理没启动、端口不通或规则没覆盖这个域名');
    lines.push('  3. 域名拼错、DNS 被污染，或目标服务临时故障');
    lines.push('');
    lines.push('可以试');
    lines.push('  · 用浏览器直接打开这个地址，确认本机网络到底能不能访问');
    lines.push('  · 换一个功能等价、网络可达的接口（例如 api.ipify.org → api64.ipify.org）');
    lines.push('  · 需要代理时先确认系统代理已开启，本工具走 WinHttp 的默认代理设置');
    return lines.join('\n');
  }

  /* 状态徽标只放短标签，长句交给正文和 title —— 一行 80 字的错误会把 URL 挤成 "htt..." */
  function shortErrLabel(err) {
    const s = String(err || '');
    const code = (s.match(/0x[0-9A-Fa-f]{8}/) || [''])[0];
    let label = '请求失败';
    if (/超时/.test(s)) label = '请求超时';
    else if (/解析|DNS/.test(s)) label = '域名解析失败';
    else if (/中断|重置/.test(s)) label = '连接被中断';
    else if (/无法连接|端口不可达/.test(s)) label = '连接失败';
    else if (/TLS|SSL|证书/.test(s)) label = 'TLS 握手失败';
    else if (/进程/.test(s)) label = '请求进程异常';
    return code ? label + ' ' + code : label;
  }

  function renderResult() {
    const res = state.result;
    const box = els.result;
    if (!box) return;
    if (!res) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    const item = res.item || {};
    const isDl = !!res.download;
    els.rMethod.textContent = isDl ? 'GET' : (item.method || 'GET').toUpperCase();
    els.rMethod.className = 'rmethod m-' + (isDl ? 'get' : (item.method || 'GET').toLowerCase());
    /* 显示最终请求地址（含 query 串），否则用户会以为 query 没生效 */
    const fullUrl = res.url || buildUrl(item) || '';
    els.rUrl.textContent = fullUrl;
    els.rUrl.title = fullUrl;

    /* 状态行 */
    if (res.loading) {
      els.rStatus.className = 'rstat st-wait';
      els.rStatus.textContent = isDl ? '下载中…' : '请求中…';
    } else if (!res.ok) {
      els.rStatus.className = 'rstat st-err';
      els.rStatus.textContent = shortErrLabel(res.error);
      els.rStatus.title = res.error || '';
    } else if (isDl) {
      /* 下载没有"状态码文案"的需求，跳过/成功更直观 */
      const txt = res.skipped ? '已跳过（文件已存在）' : (res.status ? String(res.status) : '完成');
      els.rStatus.className = 'rstat ' + (res.skipped ? 'st-warn' : statusClass(res));
      els.rStatus.textContent = txt + (res.ms ? ' · ' + res.ms + 'ms' : '');
    } else {
      const txt = (STATUS_TEXT[res.status] ? res.status + ' ' + STATUS_TEXT[res.status] : res.status ? String(res.status) : '无状态码');
      els.rStatus.className = 'rstat ' + statusClass(res);
      els.rStatus.textContent = txt + (res.ms ? ' · ' + res.ms + 'ms' : '');
    }

    /* 正文：优先显示 jsonPath 提取结果，可切到完整响应 */
    const an = analyzeResult(res);
    let text = res.body || '';
    let isJsonView = false;

    if (isDl) {
      text = downloadSummary(res);
    } else if (res.view === 'body' && an.hasPath) {
      if (an.pathError) {
        text = '取路径失败：' + an.pathError;
      } else {
        text = prettyValue(an.extracted);
        isJsonView = typeof an.extracted !== 'string';
      }
    } else if (an.isJson) {
      text = JSON.stringify(an.json, null, 2);
      isJsonView = true;
    }

    if (res.loading) {
      els.rPre.innerHTML = '<span class="jt-p">' + (isDl ? '正在下载…' : '等待响应…') + '</span>';
    } else if (!res.ok && !res.body && !isDl) {
      els.rPre.textContent = netErrorText(res);
    } else if (isJsonView) {
      els.rPre.innerHTML = highlightJson(text);
    } else {
      els.rPre.textContent = text || '（空响应）';
    }

    els.rPre.classList.toggle('rpre-json', isJsonView);

    /* 元信息 */
    const bits = [];
    if (isDl) {
      if (res.backup) bits.push('原文件已备份');
      if (res.skipped) bits.push('onExists: skip');
    } else {
      if (an.hasPath && res.view === 'body' && !an.pathError)
        bits.push('jsonPath: ' + (item.jsonPath || ''));
      if (an.hasPath && an.pathError) bits.push('取路径失败');
      if (res.truncated) bits.push('响应过大已截断');
      if (!an.isJson && !res.loading && res.body) bits.push('非 JSON，按原文显示');
    }
    els.rMeta.textContent = bits.join(' · ');
    els.rMeta.hidden = !bits.length;

    /* 按钮 */
    els.rToggle.hidden = isDl || !an.hasPath;
    els.rToggle.textContent = res.view === 'body' ? '完整响应' : '只看结果';

    state.viewText = text;
  }

  function closeResult() {
    state.result = null;
    if (els.result) els.result.hidden = true;
  }

  function copyResult() {
    const text = state.viewText || '';
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('已复制 ' + text.length + ' 字符'),
        () => fallbackCopy(text)
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败'); }
    document.body.removeChild(ta);
  }

  /* ---------------------------------------------------------- 拉取在线配置 */

  const PULL_KEY = 'ql.pullUrl';

  function openPull() {
    if (!els.pullDlg) return;
    let last = '';
    try { last = localStorage.getItem(PULL_KEY) || ''; } catch (e) {}
    els.pullUrl.value = last;
    els.pullErr.hidden = true;
    els.pullOk.disabled = false;
    els.pullDlg.hidden = false;
    els.pullUrl.focus();
    els.pullUrl.select();
  }

  function closePull() {
    if (!els.pullDlg) return;
    els.pullDlg.hidden = true;
    if (els.q) els.q.focus();
  }

  function showPullErr(text) {
    els.pullErr.textContent = text;
    els.pullErr.hidden = false;
  }

  function submitPull() {
    const raw = String(els.pullUrl.value || '').trim();
    if (!raw) { showPullErr('请填写配置文件的网址'); return; }
    if (/\s/.test(raw)) { showPullErr('网址里不能有空格'); return; }
    /* 允许直接粘 example.com/x.json，协议头由这里（和 AHK 侧）补齐 */
    const url = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(url)) {
      showPullErr('网址格式不对，例如 https://example.com/quicklaunch/config.json');
      return;
    }

    try { localStorage.setItem(PULL_KEY, url); } catch (e) {}
    els.pullOk.disabled = true;
    closePull();
    post({ type: 'pull-config', url: url });
    toast('正在拉取配置…', 2200);
  }

  /* ---------------------------------------------------------- 事件绑定 */

  function bind() {
    els.q = $('q');
    els.list = $('list');
    els.listSection = $('listSection');
    els.subjChip = $('subjChip');
    els.subjName = $('subjName');
    els.paramSection = $('paramSection');
    els.paramName = $('paramName');
    els.paramKind = $('paramKind');
    els.paramTable = $('paramTable');
    els.paramNote = $('paramNote');
    els.paramLine = $('paramLine');
    els.paramPreviewLabel = $('paramPreviewLabel');
    els.paramPreview = $('paramPreview');
    els.hintArgs = $('hintArgs');
    els.pinned = $('pinned');
    els.pinnedSection = $('pinnedSection');
    els.pinnedHint = $('pinnedHint');
    els.listTitle = $('listTitle');
    els.listCount = $('listCount');
    els.empty = $('empty');
    els.emptyText = $('emptyText');
    els.toast = $('toast');
    els.chips = $('chips');
    els.scopeTag = $('scopeTag');
    els.scopeText = $('scopeText');
    els.result = $('result');
    els.rMethod = $('rMethod');
    els.rUrl = $('rUrl');
    els.rStatus = $('rStatus');
    els.rPre = $('rPre');
    els.rMeta = $('rMeta');
    els.rToggle = $('rToggle');
    els.pullDlg = $('pullDlg');
    els.pullUrl = $('pullUrl');
    els.pullErr = $('pullErr');
    els.pullOk = $('pullOk');

    els.q.addEventListener('input', () => {
      state.noSplit = false;
      state.histIdx = null;
      state.sel = 0;
      state.selTouched = false;           /* 一打字就回到"文字说了算"，空格还是普通字符 */
      /* 参数态：输入框里只有参数，主体在 chip 上 */
      state.q = state.param ? (state.param.head + ' ' + els.q.value) : els.q.value;
      render();
    });

    els.q.addEventListener('keydown', e => {
      /* 输入法正在组字：空格/回车/方向键此刻都是在跟候选词打交道，一个都别抢 */
      if (e.isComposing) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!paramHistory(1)) moveSel(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!paramHistory(-1)) moveSel(-1);
      } else if (e.key === 'ArrowRight') {
        /* 只在补全真发生时抢键，否则保持"移动光标"的原生行为 */
        if (histComplete()) e.preventDefault();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        doLaunch();
      } else if (e.key === ' ' || e.code === 'Space') {
        /* 空格：高亮行是用户自己挪过去的，就为他进参数态（修"空格永远跳第一条"）。
           光标不在末尾、或选了一段文本时不动，让空格老老实实当字符用。 */
        const target = spaceTarget(state.results[state.sel], state.param, state.selTouched);
        if (target && caretAtEnd()) {
          e.preventDefault();
          enterParamFor(target);
        }
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (!state.param) { toggleCmd(); return; }
        /* 参数态：路径 → 补目录；不补就退回原来的「补一个分隔空格」 */
        if (!completePath()) setTail(els.q.value + ' ');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
      } else if (e.key === 'Backspace' && state.param && els.q.value === '') {
        e.preventDefault();
        exitParam();
      } else if (e.key === 'k' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault(); els.q.select();
      }
    });

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      /* 弹层开着时 Esc 只关弹层，别顺手把窗口也藏了 */
      if (els.pullDlg && !els.pullDlg.hidden) { closePull(); return; }
      if (document.activeElement !== els.q) onEscape();
    });

    /* 作用域胶囊：点一下清掉前缀，退回上层的搜索词 */
    $('scopeClear').addEventListener('click', () => setQuery(state.term || ''));
    $('subjClear').addEventListener('click', () => exitParam());
    $('rClose').addEventListener('click', closeResult);
    $('rCopy').addEventListener('click', copyResult);
    els.rToggle.addEventListener('click', () => {
      if (!state.result) return;
      state.result.view = state.result.view === 'body' ? 'full' : 'body';
      renderResult();
    });

    // 标题栏拖拽
    const bar = $('titlebar');
    if (NATIVE_DRAG) {
      /* 交给 WebView2 / Windows：这块区域被上报成 HTCAPTION，系统自己跑移动循环。
         不用再往 AHK 发 drag-start，因此也不会有轮询 g.Move 造成的闪烁和漂移。 */
      bar.classList.add('nc-drag');
    } else {
      /* 兜底：不支持原生拖拽时，页面只发「开始/结束」，由 AHK 跟随鼠标移动窗口 */
      let dragging = false;
      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        post({ type: 'drag-end' });
      };
      bar.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('.wbtn')) return;
        dragging = true;
        post({ type: 'drag-start' });
        try { bar.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      bar.addEventListener('pointerup', endDrag);
      bar.addEventListener('pointercancel', endDrag);
      window.addEventListener('blur', endDrag);
    }

    $('btnHide').addEventListener('click', () => post({ type: 'hide' }));
    /* ✕ 只隐藏到托盘，不退出进程 —— 否则全局热键就再也唤不出窗口了 */
    $('btnExit').addEventListener('click', () => post({ type: 'close' }));
    $('btnReload').addEventListener('click', () => post({ type: 'reload' }));
    $('btnOpenCfg').addEventListener('click', () => post({ type: 'open-config' }));
    $('btnPullCfg').addEventListener('click', openPull);
    $('pullCancel').addEventListener('click', closePull);
    $('pullOk').addEventListener('click', submitPull);
    els.pullUrl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submitPull(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePull(); }
    });
    /* 点遮罩 = 关掉；点弹层内部不关 */
    els.pullDlg.addEventListener('mousedown', e => {
      if (e.target === els.pullDlg) closePull();
    });

    document.addEventListener('contextmenu', e => e.preventDefault());
  }

  /* Tab：在「全量」和「命令模式」之间切，关键词保留。
     注意 @net 后面直接接关键词必须留空格，否则 @netip 会被当成一个分组 id */
  function toggleCmd() {
    const isCmd = state.scope === 'cmd' || state.scope === 'group-cmd';
    const gid = state.groupId;
    const term = state.term || '';
    /* 切范围不该把人选好的行切没了：记下 id，换完再找回来（找不回才回第一行） */
    const keep = state.results[state.sel];
    const keepId = keep ? keep.id : '';

    let q = gid ? '@' + gid : '';
    if (isCmd) {
      if (gid && term) q += ' ';
      q += term;
    } else {
      q += '>' + term;
    }
    setQuery(q);

    const idx = selIndexById(state.results, keepId);
    if (idx > 0) {
      state.sel = idx;
      /* 找回来了，就等于"用户仍然选着这一行"：接着按空格可以直接填参数 */
      state.selTouched = true;
      highlight();
      updateHint();
    }
  }

  /* Esc 分层退：结果面板 -> 查询串 -> 隐藏窗口 */
  function onEscape() {
    if (state.result) { closeResult(); return; }
    if (state.param) { exitParam(); return; }
    if (state.q) { setQuery(''); return; }
    post({ type: 'hide' });
  }

  /* ---------------------------------------------------------- 命令行接口

     AHK 把一个请求原样转成 window.__cli({rid, mode, q, args, first})：
       search —— 打开窗口并把查询填好（和手敲完全等价）
       list   —— 只返回候选，不动界面
       run    —— 直接执行，参数按参数态那套原文分配

     每条请求都必须以 cliDone 收尾（AHK 在等这条回执，--wait 的调用方也在等）。
     慢请求（webhook / download）由结果回调收尾，期间 cliBusy 一直为真，
     后面的请求排在队里 —— 命令行本来就该一条一条来。
     ---------------------------------------------------------- */

  const cliQ = [];
  let cliBusy = false;
  let cliCur = null;

  /* 一次 CLI 不可能同时跑两条，所以"当前请求"用一个槽就够 */
  function cliDone(code, text, payload) {
    const req = cliCur;
    if (!req || !cliBusy) return;
    cliBusy = false;
    cliCur = null;
    const body = Object.assign(
      { ok: code === 0, code: code, text: text || '' },
      payload || {}
    );
    post({
      type: 'cli-result',
      rid: req.rid,
      code: code,
      text: body.text,
      json: JSON.stringify(body)
    });
    setTimeout(cliPump, 0);
  }

  function cliPump() {
    if (cliBusy || !cliQ.length) return;
    const req = cliQ.shift();
    cliBusy = true;
    cliCur = req;
    try {
      cliExec(req);
    } catch (e) {
      cliDone(4, '内部错误：' + ((e && e.message) || e));
    }
  }

  function cliExec(req) {
    const mode = String(req.mode || 'search');

    if (mode === 'search') {
      setQuery(String(req.q || ''));
      post({ type: 'cli-applied', rid: req.rid });
      cliDone(0, req.q ? ('已打开查询：' + req.q) : '已打开启动器', { q: String(req.q || '') });
      return;
    }

    if (mode === 'list') {
      const hit = cliRank(String(req.q || '')).slice(0, 80);
      if (!hit.length) { cliDone(1, '没有匹配的条目：' + (req.q || '')); return; }
      const items = hit.map(x => ({
        id: x.it.id, name: x.it.name, type: x.it.type,
        subtitle: x.it.subtitle, score: Math.round(x.s)
      }));
      const lines = items.map(x => x.id + '\t' + x.name + '\t' + x.type);
      cliDone(0, lines.join('\n'), { items: items });
      return;
    }

    /* run */
    const r = cliResolve(String(req.q || ''), !!req.first);
    if (r.none) {
      cliDone(1, '没找到匹配的条目：' + (req.q || ''));
      return;
    }
    if (r.amb) {
      const list = r.amb.slice(0, 12);
      const items = list.map(it => ({ id: it.id, name: it.name, type: it.type }));
      const lines = items.map(x => x.id + '\t' + x.name + '\t' + x.type);
      cliDone(2, '有多个条目匹配，请写全 id 或名称，或加 --first 取第一条：\n'
        + lines.join('\n'), { items: items });
      return;
    }

    const item = r.item;
    req._item = item;
    /* 先让 AHK 决定要不要把窗口显示出来，再执行 */
    post({ type: 'cli-applied', rid: req.rid });

    const ok = launch(item, String(req.args || ''), { cli: true, quiet: !!req.quiet });
    if (!ok) return;                 /* launch 内部已经 cliDone */
    if (item.type === 'webhook' || item.type === 'download') return;  /* 结果回调收尾 */
    /* app / cmd / ahk / folder / url：等 AHK 的 run-ack 收尾 */
  }

  /* 打分排序：和界面上 renderNormal 完全同一套（同一个 scoreOf + 频率加成） */
  function cliRank(q) {
    const parsed = parseQuery(q || '');
    let scope = parsed.scope;
    const group = findGroup(parsed.groupId);
    if ((scope === 'group' || scope === 'group-cmd') && !group)
      scope = parsed.term ? 'all' : 'group';
    const base = sourceFor(scope, group);
    const term = String(parsed.term || '').toLowerCase();
    if (!term) return base.map(it => ({ it: it, s: 0 }));
    return base
      .map(it => {
        const s = scoreOf(it, term);
        return { it: it, s: s ? s * (1 + usageBoost(it.id) / 100) : 0 };
      })
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s);
  }

  /* 解析顺序：id 全等 → name 全等 → 搜索。有多个候选一律算歧义，
     不替用户猜 —— 脚本里静默跑错条目比报错难查得多。 */
  function cliResolve(q, first) {
    const s = String(q || '').trim();
    if (!s) return { none: true };
    const low = s.toLowerCase();

    const byId = state.all.filter(it => String(it.id || '').toLowerCase() === low);
    if (byId.length === 1) return { item: byId[0] };
    const byName = state.all.filter(it => String(it.name || '').toLowerCase() === low);
    if (byName.length === 1) return { item: byName[0] };
    if (byId.length > 1) return { amb: byId };
    if (byName.length > 1) return { amb: byName };

    const ranked = cliRank(s).map(x => x.it);
    if (!ranked.length) return { none: true };
    if (ranked.length === 1) return { item: ranked[0] };
    if (first) return { item: ranked[0] };
    return { amb: ranked };
  }

  window.__cli = function (req) {
    if (!req || !req.rid) return false;
    cliQ.push(req);
    cliPump();
    return true;
  };

  /* ---------------------------------------------------------- AHK -> JS */

  function bindBridge() {
    if (!HAS_BRIDGE) {
      $('badge').textContent = '预览模式';
      return;
    }
    /* 页面里的异常默认只打在 DevTools 里，用户看不到；
       转发到 AHK 写进 launcher.log，白屏/点不动这类问题才有据可查 */
    window.addEventListener('error', e => {
      post({ type: 'log', text: 'JS error: ' + e.message + ' @' + (e.filename || '') + ':' + e.lineno });
    });
    window.addEventListener('unhandledrejection', e => {
      const r = e.reason;
      post({ type: 'log', text: 'JS reject: ' + ((r && (r.stack || r.message)) || r) });
    });

    window.chrome.webview.addEventListener('message', ev => {
      const msg = typeof ev.data === 'string' ? safeParse(ev.data) : ev.data;
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'icons': {
          const map = msg.map || {};
          Object.keys(map).forEach(k => { state.iconMap[k.toLowerCase()] = map[k]; });
          render();
          break;
        }
        case 'toast':
          toast(msg.text || '');
          break;
        case 'http-result':
          onHttpResult(msg);
          break;
        case 'download-result':
          onDownloadResult(msg);
          break;
        case 'fs-result':
          onFsResult(msg);
          break;
        case 'dropped':
          /* 拖进来的文件：AHK 拦下 file:/// 导航后把原始 URI 送过来 */
          onDropped(msg.uri || '');
          break;
        case 'run-ack':
          /* AHK 那边真正起了进程（或报了错），命令行执行的收尾回执 */
          if (cliBusy && cliCur && cliCur.rid === msg.rid) {
            const nm = cliCur._item ? cliCur._item.name : '';
            cliDone(msg.ok ? 0 : 4, msg.ok ? ('已启动：' + nm) : ('启动失败：' + (msg.msg || '')));
          }
          break;
      }
    });
  }

  function safeParse(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  /* 由 AHK 调用 */
  window.__onShow = function () {
    els.q.focus();
    els.q.select();
  };

  window.__applyConfig = function (cfg) {
    applyConfig(cfg);
    let msg = '配置已更新，共 ' + state.all.length + ' 项'
      + (state.offCount ? '（另有 ' + state.offCount + ' 项已停用）' : '');
    if (state.tplBad.length) msg += '；有 ' + state.tplBad.length + ' 个条目的模板变量写错了';
    else if (state.tplWarn.length) msg += '；有 ' + state.tplWarn.length + ' 个条目用了 {{…}} 但没声明 params';
    toast(msg, state.tplBad.length || state.tplWarn.length ? 6000 : 2000);
  };

  /* 测试用：暴露纯函数，方便 node 侧抽出来跑用例 */
  window.__qlTest = {
    parseQuery, getByPath, highlightJson, buildUrl, toQueryString,
    scoreOf: scoreOf, scoreOne: scoreOne, fieldQuality: fieldQuality,
    subseqQuality: subseqQuality, lastTokenRange: lastTokenRange,
    splitForComplete: splitForComplete, histComplete: histComplete,
    cliRank: cliRank, cliResolve: cliResolve,
    parseAt: parseAt, parseEvery: parseEvery, parseDays: parseDays,
    normalizeSchedules: normalizeSchedules,
    fillTemplate: fillTemplate, tplVars: tplVars, templateIssues: templateIssues,
    applyParams: applyParams, joinTokens: joinTokens
  };

  /* ---------------------------------------------------------- 启动 */

  function init() {
    bind();
    bindBridge();

    /* 使用记录先就位：render 里的排序和角标都要读它 */
    state.usage = loadUsage();

    const cfg = boot && boot.config;
    if (cfg) {
      applyConfig(cfg);
    } else {
      applyConfig(null);
      toast('预览模式：直接用浏览器打开了界面', 2600);
    }

    els.q.focus();
    post({ type: 'ready' });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
