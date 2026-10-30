/* ============================================================
   QuickLaunch 前端逻辑
   - 数据源：window.__BOOTSTRAP__（由 AHK 在文档创建时注入 config.json 原文）
   - 与 AHK 通信：chrome.webview.postMessage / window.chrome.webview.addEventListener
   - 直接在浏览器打开时进入「预览模式」，用内置示例数据渲染

   查询串语法（见 parseQuery）：
     >ip        命令模式：只搜 cmd / ahk / webhook 三类「动作」条目
     @net       只看 net 分组；term 为空 = 列出整组（就是二级菜单）
     @net>ip    分组 + 命令模式
     其它       全量搜索
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
    { id: 'f', name: '示例请求', subtitle: '示例数据 · 预览返回假响应', icon: '🌐', type: 'webhook', target: 'https://example.com/api', method: 'GET', pinned: true, group: 'net', jsonPath: 'data.items[0]' }
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
    noSplit: false        /* 刚按 Esc 退出参数态，别立刻又自动进去 */
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
    if (type === 'cmd' || type === 'url' || type === 'webhook') return s;
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

  const KIND_LABEL = { app: '应用', cmd: '命令', url: '链接', folder: '目录', ahk: '脚本', webhook: '请求' };

  function kindLabel(item) {
    /* webhook 直接显示请求方法，比"请求"两个字信息量大 */
    if (item.type === 'webhook') return (item.method || 'GET').toUpperCase();
    return KIND_LABEL[item.type] || '应用';
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

  const CMD_TYPES = { cmd: 1, ahk: 1, webhook: 1 };

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

  /* 谁接受运行时参数：动作型条目；webhook 还要显式声明 params（否则不知道该往哪填） */
  function takesArgs(item) {
    if (!item) return false;
    if (item.type === 'app' || item.type === 'cmd' || item.type === 'ahk') return true;
    if (item.type === 'webhook') return (item.params || []).length > 0;
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
      }
    });
    return { values: values, extra: extra, tokens: tokens };
  }

  const TPL_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

  function fillTemplate(v, args) {
    if (typeof v === 'string')
      return v.replace(TPL_RE, (m, k) => (args[k] == null ? '' : String(args[k])));
    if (Array.isArray(v)) return v.map(x => fillTemplate(x, args));
    if (v && typeof v === 'object') {
      const o = {};
      Object.keys(v).forEach(k => { o[k] = fillTemplate(v[k], args); });
      return o;
    }
    return v;
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

  /* 把参数灌进条目，返回一个"本次请求专用"的副本 */
  function withArgs(item, values) {
    if (!(item.params || []).length) return { item: item, missing: [], args: {} };
    const r = resolveParamValues(item, values);
    return {
      args: r.args,
      missing: r.missing,
      item: Object.assign({}, item, {
        target: fillTemplate(item.target, r.args),
        query: fillQuery(item.query, r.args),
        headers: fillTemplate(item.headers, r.args),
        body: fillTemplate(item.body, r.args)
      })
    };
  }

  /* 参数历史：每条目最近 5 次，存在 localStorage */
  const HIST_KEY = 'ql.args';

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HIST_KEY);
      const o = raw ? JSON.parse(raw) : null;
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }

  function historyOf(id) {
    const all = loadHistory();
    return Array.isArray(all[id]) ? all[id] : [];
  }

  function pushHistory(id, tail) {
    const s = String(tail || '').trim();
    if (!s) return;
    const all = loadHistory();
    const list = (Array.isArray(all[id]) ? all[id] : []).filter(x => x !== s);
    list.unshift(s);
    all[id] = list.slice(0, 5);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(all)); } catch (e) {}
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
      accent: it.accent || '',
      group: it.group ? String(it.group) : '',
      /* webhook 专用 */
      method: (it.method || 'GET').toUpperCase(),
      headers: it.headers || null,
      query: it.query || null,
      body: it.body,
      timeout: Number(it.timeout) > 0 ? Math.min(Number(it.timeout), 120) : 15,
      jsonPath: it.jsonPath || it.jsonpath || '',
      /* 运行时参数声明（webhook 的模板变量，app/cmd 可省略） */
      params: Array.isArray(it.params) ? it.params.filter(p => p && p.name).map(p => ({
        name: String(p.name),
        label: p.label || '',
        placeholder: p.placeholder || '',
        default: p.default == null ? '' : String(p.default),
        optional: p.optional === true && p.required !== true
      })) : []
    };
  }

  function applyConfig(cfg) {
    if (typeof cfg === 'string') {
      try { cfg = JSON.parse(cfg); } catch (e) { cfg = { items: [] }; }
    }
    const items = cfg && (Array.isArray(cfg) ? cfg : cfg.items);
    if (!items) {
      state.groups = DEMO_GROUPS;
      state.all = DEMO_ITEMS.map(normalizeItem);
    } else {
      state.groups = (cfg && Array.isArray(cfg.groups) ? cfg.groups : [])
        .filter(g => g && g.id)
        .map(g => ({ id: String(g.id), name: String(g.name || g.id) }));
      state.all = items.map(normalizeItem);
    }

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
    state.result = null;
    state.pending.clear();
    if (els.result) els.result.hidden = true;

    render();
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

  /* ---------------------------------------------------------- 匹配 */

  function scoreOne(item, q) {
    const name = (item.name || '').toLowerCase();
    if (name === q) return 100;
    if (name.startsWith(q)) return 80;
    if (name.includes(q)) return 60;
    if (item.keywords.some(k => String(k).toLowerCase().startsWith(q))) return 50;
    const hay = [item.name, item.subtitle, item.keywords.join(' '), item.target, item.args]
      .join(' ').toLowerCase();
    if (hay.includes(q)) return 30;
    return 0;
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
        .map(it => ({ it, s: scoreOf(it, q) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map(x => x.it);
    } else {
      state.results = base.slice();
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

  /* Windows 命令行里给单个 token 加引号（app / ahk 用；cmd 类型不加，原样拼） */
  function quoteWin(s) {
    return '"' + String(s == null ? '' : s).replace(/"/g, '\\"') + '"';
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

    const assigned = decl.length ? assignTokens(item, tail) : { values: {}, extra: 0 };
    const w = withArgs(item, assigned.values);
    const applied = w.item;
    const missing = w.missing;
    const resolved = resolveParamValues(item, assigned.values);

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
      hint.textContent = item.type === 'cmd'
        ? '整段内容会原样追加到命令行末尾，引号和重定向都交给 cmd 解析'
        : '按空格分开的每个参数会各自加引号，再追加到程序后面';
      table.appendChild(hint);
    }

    /* 预览：把拼接结果直接摆出来，最省心的验证方式 */
    let head = '将执行';
    let preview = '';
    const toks = splitQuoted(tail);

    if (item.type === 'webhook') {
      head = '将请求';
      preview = (item.method || 'GET') + ' ' + buildUrl(applied);
    } else if (item.type === 'cmd') {
      const extra = tail.trim();
      preview = applied.target + (extra ? ' ' + extra : '');
    } else if (item.type === 'ahk') {
      preview = 'AutoHotkey64.exe ' + quoteWin(baseName(applied.target)) +
        (applied.args ? ' ' + applied.args : '') +
        (toks.length ? ' ' + toks.map(quoteWin).join(' ') : '');
    } else {
      preview = baseName(applied.target) +
        (applied.args ? ' ' + applied.args : '') +
        (toks.length ? ' ' + toks.map(quoteWin).join(' ') : '');
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
        els.emptyText.textContent = state.term ? '没有匹配的命令' : '这个范围里没有命令或请求';
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

      const kind = document.createElement('span');
      kind.className = 'row-kind' + (item.type === 'webhook' ? ' row-kind-http' : '');
      kind.textContent = kindLabel(item);
      row.appendChild(kind);

      const ent = document.createElement('span');
      ent.className = 'row-enter';
      ent.textContent = '⏎';
      row.appendChild(ent);

      row.addEventListener('click', () => { state.sel = idx; doLaunch(); });
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
    highlight();
  }

  /* ---------------------------------------------------------- 动作 */

  function launch(item, tail) {
    if (!item) return false;
    const raw = tail == null ? '' : String(tail);

    if (item.type === 'webhook') {
      const assigned = assignTokens(item, raw);
      const w = withArgs(item, assigned.values);
      if (w.missing.length) {
        /* 点了没填参数的必填条目：别直接报错，把人送进参数态 */
        if (!raw.trim()) { enterParamFor(item); return false; }
        toast('还缺参数：' + w.missing.join('、'));
        return false;
      }
      runWebhook(w.item, raw);
      return true;
    }

    post({
      type: 'run',
      id: item.id,
      name: item.name,
      kind: item.type,
      target: item.target,
      args: item.args,
      workdir: item.workdir,
      argv: splitQuoted(raw),
      /* cmd 类型要的是原文（引号、重定向都交给 cmd 自己解释） */
      argvRaw: item.type === 'cmd' ? raw.trim() : ''
    });
    return true;
  }

  /* 直接进入某条目的参数态：等价于替用户敲了「名字 + 空格」 */
  function enterParamFor(item) {
    setQuery(item.name + ' ');
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
    if (ok && state.param && item.type !== 'webhook') setQuery('');
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

  function runWebhook(item) {
    const id = 'r' + (++state.reqSeq).toString(36) + '-' + Date.now().toString(36);
    state.pending.set(id, { item: item });

    state.result = {
      id: id, item: item, loading: true, ok: true,
      status: 0, ms: 0, body: '', error: '', truncated: 0, view: 'body'
    };
    renderResult();

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
    if (!state.result || state.result.id !== msg.id) return;   /* 过期结果直接丢 */

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
    els.rMethod.textContent = (item.method || 'GET').toUpperCase();
    els.rMethod.className = 'rmethod m-' + (item.method || 'GET').toLowerCase();
    /* 显示最终请求地址（含 query 串），否则用户会以为 query 没生效 */
    const fullUrl = buildUrl(item) || '';
    els.rUrl.textContent = fullUrl;
    els.rUrl.title = fullUrl;

    /* 状态行 */
    if (res.loading) {
      els.rStatus.className = 'rstat st-wait';
      els.rStatus.textContent = '请求中…';
    } else if (!res.ok) {
      els.rStatus.className = 'rstat st-err';
      els.rStatus.textContent = shortErrLabel(res.error);
      els.rStatus.title = res.error || '';
    } else {
      const txt = (STATUS_TEXT[res.status] ? res.status + ' ' + STATUS_TEXT[res.status] : res.status ? String(res.status) : '无状态码');
      els.rStatus.className = 'rstat ' + statusClass(res);
      els.rStatus.textContent = txt + (res.ms ? ' · ' + res.ms + 'ms' : '');
    }

    /* 正文：优先显示 jsonPath 提取结果，可切到完整响应 */
    const an = analyzeResult(res);
    let text = res.body || '';
    let isJsonView = false;

    if (res.view === 'body' && an.hasPath) {
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
      els.rPre.innerHTML = '<span class="jt-p">等待响应…</span>';
    } else if (!res.ok && !res.body) {
      els.rPre.textContent = netErrorText(res);
    } else if (isJsonView) {
      els.rPre.innerHTML = highlightJson(text);
    } else {
      els.rPre.textContent = text || '（空响应）';
    }

    els.rPre.classList.toggle('rpre-json', isJsonView);

    /* 元信息 */
    const bits = [];
    if (an.hasPath && res.view === 'body' && !an.pathError)
      bits.push('jsonPath: ' + (item.jsonPath || ''));
    if (an.hasPath && an.pathError) bits.push('取路径失败');
    if (res.truncated) bits.push('响应过大已截断');
    if (!an.isJson && !res.loading && res.body) bits.push('非 JSON，按原文显示');
    els.rMeta.textContent = bits.join(' · ');
    els.rMeta.hidden = !bits.length;

    /* 按钮 */
    els.rToggle.hidden = !an.hasPath;
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

    els.q.addEventListener('input', () => {
      state.noSplit = false;
      state.histIdx = null;
      state.sel = 0;
      /* 参数态：输入框里只有参数，主体在 chip 上 */
      state.q = state.param ? (state.param.head + ' ' + els.q.value) : els.q.value;
      render();
    });

    els.q.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!paramHistory(1)) moveSel(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!paramHistory(-1)) moveSel(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        doLaunch();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        /* 参数态下 Tab 只补一个分隔空格，不去切命令模式（免得误触） */
        if (state.param) setTail(els.q.value + ' ');
        else toggleCmd();
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
      if (e.key === 'Escape' && document.activeElement !== els.q) onEscape();
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

    document.addEventListener('contextmenu', e => e.preventDefault());
  }

  /* Tab：在「全量」和「命令模式」之间切，关键词保留。
     注意 @net 后面直接接关键词必须留空格，否则 @netip 会被当成一个分组 id */
  function toggleCmd() {
    const isCmd = state.scope === 'cmd' || state.scope === 'group-cmd';
    const gid = state.groupId;
    const term = state.term || '';

    let q = gid ? '@' + gid : '';
    if (isCmd) {
      if (gid && term) q += ' ';
      q += term;
    } else {
      q += '>' + term;
    }
    setQuery(q);
  }

  /* Esc 分层退：结果面板 -> 查询串 -> 隐藏窗口 */
  function onEscape() {
    if (state.result) { closeResult(); return; }
    if (state.param) { exitParam(); return; }
    if (state.q) { setQuery(''); return; }
    post({ type: 'hide' });
  }

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
    toast('配置已更新，共 ' + state.all.length + ' 项');
  };

  /* 测试用：暴露纯函数，方便 node 侧抽出来跑用例 */
  window.__qlTest = { parseQuery, getByPath, highlightJson, buildUrl, toQueryString };

  /* ---------------------------------------------------------- 启动 */

  function init() {
    bind();
    bindBridge();

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
