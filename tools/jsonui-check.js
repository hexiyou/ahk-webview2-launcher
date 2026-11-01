/* ============================================================
   JSON 树的真实渲染检查（真 WebView2 / 真 DOM）

   tests/json.test.js 只覆盖"行模型算得对不对"。这一层要回答另一个问题：
   把这些行画进页面之后，折叠、搜索、复制按钮到底有没有按预期出现、
   有没有互相打架 —— 这些只有真的把页面跑起来才知道。

   做法和 e2e.js 一样：生成一份改过单例键的 launcher 脚本，页面就绪后注入
   一段 JS，在真实的 #rJson 上渲染、点击、搜索，结果经 log 消息写进文件。

   用法：node tools/jsonui-check.js
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const BASE = path.join(os.tmpdir(), 'ql-jsonui');
const SANDBOX = path.join(BASE, 'app');
const DATA_DIR = path.join(BASE, 'data');
const GEN = path.join(SANDBOX, '_launcher_jsonui.ahk');
const JS_FILE = path.join(os.tmpdir(), 'ql-jsonui-probe.js');
const LOG = path.join(SANDBOX, '_jsonui.log');
const SHOT = process.argv.includes('--shot');   /* 跑完不退，留 60 秒给外面截图 */

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.webview2') continue;          /* 上一轮的 WebView2 缓存还被锁着 */
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else { try { fs.copyFileSync(a, b); } catch (err) {} }
  }
}

/* 本地服务：返回一份够大的嵌套 JSON，用来验证"真实响应也走树视图" */
const server = http.createServer((req, res) => {
  const data = { meta: { page: 1, total: 40, note: '来自本地服务' }, data: [] };
  for (let i = 0; i < 40; i++) {
    data.data.push({ id: i, name: 'live-' + i, tags: ['a', 'b'], nest: { deep: { v: i } } });
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
});

function prepare(port) {
  fs.rmSync(BASE, { recursive: true, force: true });
  copyDir(path.join(ROOT, 'ui'), path.join(SANDBOX, 'ui'));
  copyDir(path.join(ROOT, 'lib'), path.join(SANDBOX, 'lib'));
  copyDir(path.join(ROOT, 'runtime'), path.join(SANDBOX, 'runtime'));
  fs.copyFileSync(path.join(ROOT, 'launcher.ahk'), path.join(SANDBOX, 'launcher.ahk'));

  /* 一条可见 + 一条 hidden：这个工具关心结果面板，顺带守住 hidden 的两件事
     —— 界面里不出现，但命令行仍然解析得到（hidden 条目故意写了 pinned，
     用来验证它不会从常用卡片里冒出来） */
  const cfg = {
    items: [
      {
        id: 'jsonui', name: 'JSON 渲染检查', type: 'webhook', group: 'net',
        target: 'http://127.0.0.1:' + port + '/big', method: 'GET', timeout: 10
      },
      {
        id: 'quiet', name: '静默后台任务', type: 'cmd', target: 'echo hi',
        group: 'net', hidden: true, pinned: true
      }
    ]
  };
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  fs.writeFileSync(path.join(SANDBOX, 'launcher.ini'),
    '[General]\nHotkey=\nWidth=880\nHeight=620\nCornerRadius=14\nAlwaysOnTop=0\n'
    + 'HideOnBlur=0\nHideAfterLaunch=0\nShowOnStart=1\nDevTools=0\n', 'utf8');
}

const PAGE_JS = `(async () => {
  const $ = id => document.getElementById(id);
  const log = t => chrome.webview.postMessage({ type: 'log', text: t });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let P = 0, F = 0;
  const ok = (n, c, x) => { if (c) { P++; log('ok ' + n); } else { F++; log('FAIL ' + n + (x !== undefined ? ' :: ' + x : '')); } };
  const disp = el => getComputedStyle(el).display;

  try {
    const T = window.__qlTest;
    if (!T || !T.jsonRows || !T.renderJsonTree) throw new Error('__qlTest 里没有 JSON 树接口');
    const host = $('rJson');
    if (!host) throw new Error('找不到 #rJson');

    /* 一份"够大"的响应：40 条记录，每条带数组和三层嵌套 */
    const big = { meta: { page: 1, total: 40, note: '测试数据' }, data: [] };
    for (let i = 0; i < 40; i++) {
      big.data.push({ id: i, name: 'item-' + i, tags: ['a', 'b'], nest: { deep: { v: i * 2 } } });
    }

    const got = T.jsonRows(big);
    ok('行模型没截断', !got.truncated, got.rows.length);

    const t0 = performance.now();
    T.renderJsonTree(host, got.rows);
    const cost = Math.round(performance.now() - t0);
    log('info 渲染 ' + got.rows.length + ' 行用了 ' + cost + 'ms（含布局）');

    const lines = host.querySelectorAll('.jline');
    const want = got.rows.length;
    ok('每行都画出来了', lines.length === want, lines.length + ' 行 vs 模型 ' + want + ' 行');
    ok('渲染耗时可接受（< 3s）', cost < 3000, cost + 'ms');

    const nodes = host.querySelectorAll('.jnode');
    ok('生成了可折叠节点', nodes.length > 0, nodes.length);
    const collapsed0 = host.querySelectorAll('.jnode.collapsed').length;
    ok('大 JSON 默认折叠深层节点', collapsed0 > 0, collapsed0 + ' 个已折叠');
    ok('浅层没有全折叠（否则等于没显示）', collapsed0 < nodes.length, collapsed0 + '/' + nodes.length);

    /* 折叠真的藏住了子树吗 */
    const node = host.querySelector('.jnode.collapsed');
    const body = node.querySelector('.jchildren');
    ok('折叠节点子树 display:none', disp(body) === 'none', disp(body));

    /* 点三角：展开 → 再点折叠 */
    const caret = node.firstElementChild.querySelector('.jcaret');
    ok('折叠行有三角', !!caret && caret.textContent === '▾');
    caret.click();
    ok('点三角后展开', !node.classList.contains('collapsed') && disp(body) !== 'none');
    caret.click();
    ok('再点又折叠', node.classList.contains('collapsed') && disp(body) === 'none');

    /* 折叠摘要：只在折叠时出现。注意 .jline 是 flex 容器，子元素的 display:inline
       会被计算成 block —— 判断"有没有显示"只能比 none / 非 none */
    const sum = node.firstElementChild.querySelector('.jsum');
    node.classList.remove('collapsed');
    ok('展开时摘要不占位', disp(sum) === 'none', disp(sum));
    node.classList.add('collapsed');
    ok('折叠时摘要露出来', disp(sum) !== 'none', disp(sum));
    ok('摘要里写着数量', /\\d+/.test(sum.textContent), sum.textContent);

    /* 搜索：命中要自动展开祖先，否则搜到了也看不见 */
    host.querySelectorAll('.jnode').forEach(n => n.classList.add('collapsed'));
    T.jsonFind('item-7');
    const hits = host.querySelectorAll('.jline.hit');
    ok('能搜到', hits.length > 0, hits.length + ' 处');
    ok('命中行的祖先都展开了', Array.prototype.every.call(hits, el => {
      let p = el.parentElement;
      while (p && p !== host) {
        if (p.classList && p.classList.contains('jnode') && p.classList.contains('collapsed')) return false;
        p = p.parentElement;
      }
      return true;
    }));
    ok('计数是 1 / N', $('rFindCount').textContent === '1 / ' + hits.length, JSON.stringify($('rFindCount').textContent));
    ok('第一处有当前标记', host.querySelectorAll('.jline.hit-cur').length === 1);
    ok('搜值也能命中（不是只搜键）', (function () {
      T.jsonFind('item-9');
      return host.querySelectorAll('.jline.hit').length > 0;
    })());

    /* 搜不到时要说清楚，而不是静悄悄地什么都没变 */
    T.jsonFind('绝对不存在的字符串zzz');
    ok('搜不到时提示"没有匹配"', $('rFindCount').textContent === '没有匹配', JSON.stringify($('rFindCount').textContent));
    ok('搜不到时没有残留高亮', host.querySelectorAll('.jline.hit').length === 0);
    ok('搜不到时计数标红', $('rFindCount').classList.contains('none'));
    T.clearFind();
    ok('清空后输入框也空了', $('rFindInput').value === '');

    /* 复制按钮：除收尾括号行外，每行都该有一个 */
    const copyCount = host.querySelectorAll('.jcopy').length;
    const copyable = got.rows.filter(r => r.kind !== 'close').length;
    ok('复制按钮与可复制行一一对应', copyCount === copyable, copyCount + ' vs ' + copyable);
    ok('对象节点的按钮提示写着字段名', (function () {
      const b = host.querySelector('.jline .jcopy[title*="data"]');
      return !!b && /data/.test(b.getAttribute('title'));
    })());

    /* 边界：空容器、标量根、单行字符串 */
    T.renderJsonTree(host, T.jsonRows({ a: {}, b: [], c: 1 }).rows);
    ok('空容器渲染成 [ ] / { }', /\\{\\s*\\}/.test(host.textContent) && /\\[\\s*\\]/.test(host.textContent), host.textContent.replace(/\\s+/g, ' ').slice(0, 80));
    /* 根节点不是空的，它当然有三角；要看的是那两个空容器自己 */
    ok('空容器行没有三角（不该能展开）', Array.prototype.every.call(host.querySelectorAll('.jline'), l => {
      const isBrace = /\\{\\s*\\}|\\[\\s*\\]/.test(l.textContent);
      const c = l.querySelector('.jcaret');
      return !isBrace || (!!c && c.classList.contains('jcaret-none'));
    }));

    T.renderJsonTree(host, T.jsonRows(42).rows);
    const only = host.textContent.replace('⧉', '').trim();   /* 复制按钮的图标不算正文 */
    ok('标量根也画得出来', host.querySelectorAll('.jline').length === 1 && only === '42', only);

    T.renderJsonTree(host, T.jsonRows('一段很长的中文文本').rows);
    ok('字符串根显示成带引号的串', host.textContent.indexOf('一段很长的中文文本') >= 0);

    /* 数据路径：折叠/调试靠它定位 */
    T.renderJsonTree(host, got.rows);
    ok('行上带 data-path', !!host.querySelector('[data-path="$.data[0].name"]'), (host.querySelector('[data-path]') || {}).getAttribute);

    /* 面板上的搜索按钮只在树视图时露出来（用真实渲染路径确认一处） */
    ok('搜索按钮存在', !!$('rFind'));
    ok('搜索栏默认收起', $('rFindBar').hidden === true);

    /* ---------- 真实链路：__cli 发一次请求，看面板是不是自动画成树 ---------- */
    window.__cli({ rid: 'ui-live', mode: 'run', q: 'jsonui' });
    await wait(3500);
    ok('结果面板打开了', !$('result').hidden);
    ok('状态码 200', /200/.test($('rStatus').textContent), $('rStatus').textContent);
    ok('真实响应走的是树视图', !$('rJson').hidden && $('rPre').hidden,
      'rJson.hidden=' + $('rJson').hidden + ' rPre.hidden=' + $('rPre').hidden);
    const liveRows = $('rJson').querySelectorAll('.jline').length;
    ok('真实响应画出了行', liveRows > 20, liveRows);
    ok('真实响应的搜索按钮露出来了', !$('rFind').hidden);
    ok('真实响应里能搜到字段', (function () {
      window.__qlTest.jsonFind('live-9');
      return $('rJson').querySelectorAll('.jline.hit').length > 0;
    })());
    window.__qlTest.clearFind();

    /* 缩进是 CSS 算出来的（padding-left: calc(2px + var(--d) * 14px)），
       光看 DOM 结构看不出它有没有生效 —— 直接读计算值。
       注意不能量 offsetLeft：padding 在盒子内部，改它不会动 offsetLeft。 */
    $('rJson').querySelectorAll('.jnode.collapsed').forEach(n => n.classList.remove('collapsed'));
    const shallow = $('rJson').querySelector('[data-path="$.data[0].id"]');
    const deep = $('rJson').querySelector('[data-path="$.data[0].nest.deep.v"]');
    const pad = el => parseFloat(getComputedStyle(el).paddingLeft) || 0;
    if (shallow && deep) {
      ok('层级越深，缩进越大', pad(deep) > pad(shallow),
        'shallow=' + pad(shallow) + 'px deep=' + pad(deep) + 'px');
      ok('每层缩进 14px', Math.abs((pad(deep) - pad(shallow)) - 28) < 1.5,
        '差 ' + Math.round(pad(deep) - pad(shallow)) + 'px（3 层）');
    } else {
      ok('找得到深浅两行（能量缩进）', false, 'shallow=' + !!shallow + ' deep=' + !!deep);
    }

    /* ---------- hidden：界面里不出现，命令行照样调得到 ----------
       这两种"看不见"必须分开验：jsonui-check 的配置里同时有一条 normal 和
       一条 hidden（而且 hidden 那条故意写了 pinned），任何一处漏过滤都会在这里露馅 */
    const qi = $('q');
    const typeIn = v => { qi.value = v; qi.dispatchEvent(new Event('input')); };
    const rowNames = () => Array.from($('list').querySelectorAll('.row-name')).map(e => e.textContent);

    typeIn('');
    ok('列表里没有 hidden 条目', rowNames().indexOf('静默后台任务') < 0, rowNames().join(' | '));
    ok('可见条目照常列出', rowNames().indexOf('JSON 渲染检查') >= 0, rowNames().join(' | '));

    /* 写了 pinned 也不该冒到卡片上 —— 否则藏起来就白藏了 */
    const pinnedNames = Array.from(document.querySelectorAll('#pinned .card-name')).map(e => e.textContent);
    ok('常用卡片里也没有它', pinnedNames.indexOf('静默后台任务') < 0, pinnedNames.join(' | '));

    typeIn('静默');
    ok('搜它的名字也搜不到', $('list').querySelectorAll('.row').length === 0,
      $('list').querySelectorAll('.row').length + ' 行');
    ok('空列表时说清了有几条被藏起来', /hidden/.test($('emptyText').textContent),
      $('emptyText').textContent);
    typeIn('');

    /* 界面上藏了，命令行这条路必须还通 —— 定时任务走的也是这条 */
    const cr = T.cliResolve('静默后台任务', false);
    ok('命令行仍然解析得到它', !!(cr && cr.item && cr.item.id === 'quiet'),
      JSON.stringify(cr && cr.item ? cr.item.id : cr));
  } catch (e) {
    log('EXCEPTION ' + ((e && e.stack) || e));
  }
  log('DONE ' + P + ' ' + F);
  /* --shot：故意不退，留时间给外面截图，然后由 node 侧把进程杀掉 */
  if (window.__qlShot) { await wait(60000); }
  else { chrome.webview.postMessage({ type: 'exit' }); }
})();
`;

/* AHK 的反引号在 JS 模板串里会打架，按行拼更省事 */
const AHK_TAIL = [
  '',
  '; ===== JSON 渲染检查的引导（只存在于生成出来的脚本里） =====',
  '',
  'JsonUi_Start() {',
  '    static tries := 0',
  '    global wv, uiReady, SCRIPT_DIR',
  '    if (!uiReady || !wv) {',
  '        tries++',
  '        if (tries > 40) {',
  "            FileAppend('页面 20 秒还没就绪，放弃`n', SCRIPT_DIR '\\_jsonui.log', 'UTF-8')",
  '            ExitApp(1)',
  '        }',
  '        SetTimer(JsonUi_Start, -500)',
  '        return',
  '    }',
  "    js := FileRead(A_Temp '\\ql-jsonui-probe.js', 'UTF-8')",
  '    try',
  "        wv.ExecuteScriptAsync('window.__qlShot=" + (SHOT ? '1' : '0') + "; void ' js)",
  '    catch as e',
  "        FileAppend('注入失败：' e.Message '`n', SCRIPT_DIR '\\_jsonui.log', 'UTF-8')",
  '}',
  ''
].join('\n');

function build() {
  let src = fs.readFileSync(path.join(ROOT, 'launcher.ahk'), 'utf8');

  /* 别和用户正在跑的实例抢单例锁，也别共用同一个 WebView2 数据目录 */
  src = src.replace('#SingleInstance Force', '#SingleInstance Off');
  src = src.replace(/global INST_KEY\s*:=.*/, "global INST_KEY   := 'jsonui-run'");
  src = src.replace(/global DATA_DIR\s*:=.*/, "global DATA_DIR   := '" + DATA_DIR + "'");
  src = src.replaceAll("SCRIPT_DIR '\\launcher.log'", "SCRIPT_DIR '\\_jsonui.log'");

  const anchor = 'RegisterHotkey(settings.hotkey)';
  if (!src.includes(anchor)) throw new Error('找不到注入点：' + anchor);
  src = src.replace(anchor, anchor + '\n\nSetTimer(JsonUi_Start, -1200)');

  fs.writeFileSync(GEN, src + AHK_TAIL, 'utf8');
  fs.writeFileSync(JS_FILE, PAGE_JS, 'utf8');
}

function runProcess() {
  /* 必须用异步的 spawn：spawnSync 会把 node 的事件循环一起堵住，
     而本地 HTTP 服务就活在这个循环里 —— 用它等于让自己发不出响应。 */
  return new Promise(resolve => {
    const p = require('child_process').spawn(AHK, ['/ErrorStdOut', '/force', GEN],
      { cwd: ROOT, windowsHide: true });
    let err = '';
    p.stderr.on('data', b => { err += b.toString('utf8'); });
    /* --shot 时页面会故意停住，给外面留出截图时间；到点照杀，免得留个孤儿进程 */
    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} }, SHOT ? 30000 : 60000);
    p.on('close', code => { clearTimeout(timer); resolve({ code: code, stderr: err }); });
  });
}

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  prepare(port);
  build();
  try { fs.unlinkSync(LOG); } catch (e) {}

  const r = await runProcess();
  server.close();

  const out = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '(没有生成 _jsonui.log)';
  process.stdout.write(out);
  const stderr = (r.stderr || '').trim();
  if (stderr) console.log('\n[AHK stderr]\n' + stderr);

  const m = /DONE (\d+) (\d+)/.exec(out);
  const failed = m ? Number(m[2]) : -1;
  const pass = m ? Number(m[1]) : 0;
  const bad = /FAIL |EXCEPTION /.test(out);

  console.log('\n' + (m && failed === 0 && !bad
    ? '渲染检查：通过 ' + pass + ' 项'
    : '渲染检查：有异常（通过 ' + pass + '，失败 ' + (failed < 0 ? '任务没跑完' : failed) + '）'));
  process.exit(m && failed === 0 && !bad ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
