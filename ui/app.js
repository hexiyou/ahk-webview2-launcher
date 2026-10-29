/* ============================================================
   QuickLaunch 前端逻辑
   - 数据源：window.__BOOTSTRAP__（由 AHK 在文档创建时注入 config.json 原文）
   - 与 AHK 通信：chrome.webview.postMessage / window.chrome.webview.addEventListener
   - 直接在浏览器打开时进入「预览模式」，用内置示例数据渲染
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
    { id: 'a', name: '记事本', subtitle: '示例数据 · 浏览器预览', icon: '📝', type: 'app', target: 'C:\\Windows\\System32\\notepad.exe', pinned: true },
    { id: 'b', name: '命令提示符', subtitle: '示例数据 · 浏览器预览', icon: '🖥', type: 'app', target: 'C:\\Windows\\System32\\cmd.exe', pinned: true },
    { id: 'c', name: '计算器', subtitle: '示例数据 · 浏览器预览', icon: '🧮', type: 'url', target: 'ms-calculator:', pinned: true },
    { id: 'd', name: '画图', subtitle: '示例数据 · 浏览器预览', icon: '🎨', type: 'app', target: 'C:\\Windows\\System32\\mspaint.exe', pinned: false },
    { id: 'e', name: '查看本机 IP', subtitle: '示例数据 · 浏览器预览', icon: '⚙', type: 'cmd', target: 'ipconfig /all', pinned: false }
  ];

  const state = {
    all: [],
    results: [],
    pinned: [],
    sel: 0,
    q: '',
    iconMap: {},
    requested: new Set()
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
    if (type === 'cmd' || type === 'url') return s;
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

  function kindLabel(item) {
    const m = { app: '应用', cmd: '命令', url: '链接', folder: '目录', ahk: '脚本' };
    return m[item.type] || '应用';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
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
    return {
      id: it.id || ('item-' + i),
      name: it.name || '未命名',
      subtitle: it.subtitle || it.desc || '',
      keywords: Array.isArray(it.keywords) ? it.keywords : [],
      icon: it.icon || '',
      type: it.type || 'app',
      target: resolveTarget(it.type || 'app', it.target),
      args: it.args || '',
      workdir: absPath(it.workdir || '') || scriptDir,
      pinned: it.pinned === true,
      accent: it.accent || ''
    };
  }

  function applyConfig(cfg) {
    if (typeof cfg === 'string') {
      try { cfg = JSON.parse(cfg); } catch (e) { cfg = { items: [] }; }
    }
    let items = cfg && (Array.isArray(cfg) ? cfg : cfg.items);
    if (!items) items = DEMO_ITEMS;
    state.all = items.map(normalizeItem);
    state.pinned = state.all.filter(x => x.pinned);
    if (!state.pinned.length) state.pinned = state.all.slice(0, 5);
    state.sel = 0;
    state.requested.clear();
    state.iconMap = {};
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
    if (!ic) return iconFromExe(item.target);
    if (/^(https?:|data:)/i.test(ic)) return ic;
    if (isEmoji(ic)) return null;
    if (/\.(png|svg|jpe?g|gif|webp|ico|bmp)$/i.test(ic)) return fileUrl(absPath(ic));
    if (/\.exe$/i.test(ic)) return iconFromExe(absPath(ic));
    return null;
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
    const q = state.q.trim().toLowerCase();
    if (q) {
      state.results = state.all
        .map(it => ({ it, s: scoreOf(it, q) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map(x => x.it);
    } else {
      state.results = state.all.slice();
    }
    if (state.sel >= state.results.length) state.sel = Math.max(0, state.results.length - 1);

    els.pinnedSection.hidden = !!q;
    els.listTitle.textContent = q ? '搜索结果' : '全部应用';
    els.listCount.textContent = state.results.length + ' 项';

    if (!q) renderPinned();
    renderList();
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
      kind.className = 'row-kind';
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

    els.q.addEventListener('input', () => {
      state.q = els.q.value;
      state.sel = 0;
      render();
    });

    els.q.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); launch(state.results[state.sel]); }
      else if (e.key === 'Escape') { e.preventDefault(); post({ type: 'hide' }); }
      else if (e.key === 'k' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); els.q.select(); }
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.activeElement !== els.q) {
        post({ type: 'hide' });
      }
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

  /* ---------------------------------------------------------- AHK -> JS */

  function bindBridge() {
    if (!HAS_BRIDGE) {
      $('badge').textContent = '预览模式';
      return;
    }
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

  /* ---------------------------------------------------------- 启动 */

  function init() {
    bind();
    bindBridge();

    const cfg = boot && boot.config;
    if (cfg) {
      applyConfig(cfg);
    } else {
      applyConfig({ items: DEMO_ITEMS });
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
