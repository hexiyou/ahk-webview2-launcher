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
    result: null
  };

  const $ = id => document.getElementById(id);
  const els = {};

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
      jsonPath: it.jsonPath || it.jsonpath || ''
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

  function scoreOf(item, q) {
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

      row.addEventListener('click', () => { state.sel = idx; launch(item); });
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

  function launch(item) {
    if (!item) return;
    if (item.type === 'webhook') {
      runWebhook(item);
      return;
    }
    post({
      type: 'run',
      id: item.id,
      name: item.name,
      kind: item.type,
      target: item.target,
      args: item.args,
      workdir: item.workdir
    });
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
    els.rUrl.textContent = item.target || '';
    els.rUrl.title = buildUrl(item) || '';

    /* 状态行 */
    if (res.loading) {
      els.rStatus.className = 'rstat st-wait';
      els.rStatus.textContent = '请求中…';
    } else if (!res.ok) {
      els.rStatus.className = 'rstat st-err';
      els.rStatus.textContent = res.error || '请求失败';
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
      els.rPre.innerHTML = '<span class="jt-lit">' + esc(res.error || '请求失败') + '</span>';
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
      state.q = els.q.value;
      state.sel = 0;
      render();
    });

    els.q.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); launch(state.results[state.sel]); }
      else if (e.key === 'Tab') { e.preventDefault(); toggleCmd(); }
      else if (e.key === 'Escape') { e.preventDefault(); onEscape(); }
      else if (e.key === 'k' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); els.q.select(); }
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.activeElement !== els.q) onEscape();
    });

    /* 作用域胶囊：点一下清掉前缀，退回上层的搜索词 */
    $('scopeClear').addEventListener('click', () => setQuery(state.term || ''));
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
