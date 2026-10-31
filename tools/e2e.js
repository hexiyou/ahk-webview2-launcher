/* ============================================================
   端到端冒烟：把 launcher.ahk 原样复制一份，注入一段「自动跑用例」的引导，
   由真实窗口 + 真实 WebView2 + 真实 AHK 桥接跑一遍，结果写进 _e2e.log 后自动退出。

   用途：验证那些只有跑起来才知道对不对的东西 ——
     拼音搜索、参数态、Tab 读目录、→ 补历史、usage.json 落盘。

   用法：node tools/e2e.js
   注意：会弹出一个真实窗口（跑完自己关），运行期间别关它。
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const GEN = path.join(ROOT, '_launcher_e2e.ahk');
const LOG = path.join(ROOT, '_e2e.log');
const JS_FILE = path.join(os.tmpdir(), 'ql-e2e.js');
const DATA_DIR = path.join(os.tmpdir(), 'ql-e2e-webview2');

const PAGE_JS = String.raw`
(async function () {
  const log = t => chrome.webview.postMessage({ type: 'log', text: 'E2E ' + t });
  const q = document.getElementById('q');
  const names = () => Array.from(document.querySelectorAll('#list .row-name')).map(e => e.textContent);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const setQ = v => { q.value = v; q.dispatchEvent(new Event('input', { bubbles: true })); };
  const setTail = v => { setQ(v); try { q.setSelectionRange(v.length, v.length); } catch (e) {} };
  const key = k => q.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

  try {
    log('T0 启动时的使用记录     -> ' + JSON.stringify((window.__BOOTSTRAP__ || {}).usage || '(无)'));

    setQ('jsb'); await wait(80);
    log('T1 首字母 jsb           -> ' + JSON.stringify(names().slice(0, 3)));

    setQ('jishiben'); await wait(80);
    log('T2 全拼 jishiben        -> ' + JSON.stringify(names().slice(0, 3)));

    setQ('npad'); await wait(80);
    log('T3 跳字 npad            -> ' + JSON.stringify(names().slice(0, 3)));

    setQ('记事本 '); await wait(80);
    log('T4 参数态 chip=' + JSON.stringify(document.getElementById('subjName').textContent) +
        ' 列表隐藏=' + document.getElementById('listSection').hidden +
        ' 参数面板=' + !document.getElementById('paramSection').hidden);

    setTail('C:\\Win'); await wait(40);
    key('Tab'); await wait(800);
    log('T5 Tab 补目录           -> ' + JSON.stringify(q.value));

    setTail('"C:\\Program Fi'); await wait(40);
    key('Tab'); await wait(800);
    log('T5b 引号路径补目录      -> ' + JSON.stringify(q.value));

    key('Escape'); await wait(120);
    log('T6 Esc 退出参数态       -> ' + JSON.stringify(q.value) +
        ' 参数面板=' + !document.getElementById('paramSection').hidden);

    setQ('归属地 8.8.8.8'); await wait(120);
    key('Enter'); await wait(1800);
    log('T7 带参运行 webhook     -> 结果面板=' + !document.getElementById('result').hidden +
        ' 使用记录=' + (localStorage.getItem('ql.usage') || '(空)'));

    key('Escape'); await wait(120);
    key('Escape'); await wait(120);
    log('T8 两次 Esc 后输入框    -> ' + JSON.stringify(q.value));

    setQ('归属地 '); await wait(120);
    setTail('8.8'); await wait(60);
    key('ArrowRight'); await wait(200);
    log('T9 → 补历史             -> ' + JSON.stringify(q.value));

    key('Escape'); await wait(120);       /* 参数态清空输入不会自己退出，先 Esc */
    setQ(''); await wait(120);
    log('T10 空查询按频率排序    -> ' + JSON.stringify(names().slice(0, 4)));

    const row = document.querySelector('#list .row');
    const badge = document.querySelector('#list .row-use');
    log('T11 行布局              -> 溢出=' + (row.scrollWidth > row.clientWidth + 1) +
        ' 角标=' + (badge ? badge.textContent : '(无)'));

    /* UNC：Tab 在 \\服务器\ 后面应该列出共享，而不是报"目录不存在" */
    setQ('记事本 '); await wait(120);
    setTail('\\\\localhost\\'); await wait(60);
    key('Tab'); await wait(1600);
    log('T12 Tab 补 UNC 共享     -> 输入=' + JSON.stringify(q.value) +
        ' 提示=' + JSON.stringify((document.getElementById('toast').textContent || '').slice(0, 48)));

    /* UNC 图标走 file://///… 这种五斜杠写法，浏览器认不认 */
    const imgRes = await new Promise(r => {
      const im = new Image();
      im.onload = () => r('ok ' + im.naturalWidth + 'x' + im.naturalHeight);
      im.onerror = () => r('FAIL 加载失败');
      setTimeout(() => r('超时'), 4000);
      im.src = 'file://///localhost/Users/Administrator/AppData/Local/Temp/unctest/icon%20test.png';
    });
    log('T13 file:///// UNC 图标  -> ' + imgRes);

    /* download 类型：列表徽标应该是「下载」而不是方法名。
       先退出参数态，否则列表 DOM 还是上一步的（参数态下列表是隐藏的，不会重绘） */
    key('Escape'); await wait(120);
    setQ('下载示例'); await wait(150);
    const dlRow = document.querySelector('#list .row');
    const dlKind = dlRow && dlRow.querySelector('.row-kind');
    log('T14 download 行徽标     -> 命中=' + JSON.stringify(names().slice(0, 2)) +
        ' 徽标=' + (dlKind ? dlKind.textContent : '(无)'));

    /* 「拉取在线配置」弹层：点开 / Esc 关 / 非法网址报错 */
    const dlg = document.getElementById('pullDlg');
    const input = document.getElementById('pullUrl');
    document.getElementById('btnPullCfg').click(); await wait(150);
    const opened = !dlg.hidden;
    const focused = document.activeElement === input;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(120);
    log('T15 拉取弹层           -> 打开=' + opened + ' 焦点=' + focused + ' Esc 后已关=' + dlg.hidden);

    document.getElementById('btnPullCfg').click(); await wait(120);
    input.value = '这不是网址';
    document.getElementById('pullOk').click(); await wait(150);
    log('T16 非法网址           -> 提示=' + JSON.stringify(
        (document.getElementById('pullErr').textContent || '').slice(0, 24)) + ' 仍打开=' + !dlg.hidden);

    /* 合法但必然连不上的地址：验证"JS → AHK → webhook.ahk → 回包 → toast"整条链路 */
    input.value = 'http://127.0.0.1:1/config.json';
    document.getElementById('pullOk').click(); await wait(250);
    const closed = dlg.hidden;
    let pullToast = '';
    for (let i = 0; i < 40; i++) {
      await wait(200);
      pullToast = document.getElementById('toast').textContent || '';
      if (/拉取失败|配置已拉取/.test(pullToast)) break;
    }
    log('T17 拉取失败回包       -> 弹层已关=' + closed + ' toast=' + JSON.stringify(pullToast.slice(0, 36)));

    /* download 的结果面板（临时配置，指向不存在的端口，不会真落盘） */
    window.__applyConfig({
      items: [{ id: 'tdl', name: '测试下载', type: 'download',
        target: 'http://127.0.0.1:1/x.bin', savePath: '%TEMP%', timeout: 5 }]
    });
    await wait(200);
    setQ('测试下载'); await wait(150);
    key('Enter');
    for (let i = 0; i < 30; i++) {
      await wait(200);
      if (!document.getElementById('result').hidden) {
        const stat = document.getElementById('rStatus').textContent || '';
        if (!/下载中/.test(stat)) break;
      }
    }
    log('T18 download 结果面板   -> 面板=' + !document.getElementById('result').hidden +
        ' 状态=' + JSON.stringify(document.getElementById('rStatus').textContent) +
        ' 正文=' + JSON.stringify((document.getElementById('rPre').textContent || '').slice(0, 30)));

    await wait(900);                      /* 等 usage.json 落盘（写盘有 400ms 防抖） */
    log('DONE');
  } catch (e) {
    log('EXCEPTION ' + ((e && e.stack) || e));
  }
  chrome.webview.postMessage({ type: 'exit' });
})();
`;

/* AHK 的反引号在 JS 模板串里会打架，这里按行拼，避免转义游戏 */
const AHK_TAIL = [
  '',
  '; ============================================================================',
  ';  E2E 引导（只存在于 _launcher_e2e.ahk，跑完自己退出）',
  '; ============================================================================',
  '',
  'E2E_Start() {',
  '    static tries := 0',
  '    global wv, uiReady, SCRIPT_DIR',
  '    if (!uiReady || !wv) {',
  '        tries++',
  '        if (tries > 40) {',
  "            FileAppend('页面 20 秒还没就绪，放弃`n', SCRIPT_DIR '\\_e2e.log', 'UTF-8')",
  '            ExitApp(1)',
  '        }',
  '        SetTimer(E2E_Start, -500)',
  '        return',
  '    }',
  "    js := FileRead(A_Temp '\\ql-e2e.js', 'UTF-8')",
  '    try',
  "        wv.ExecuteScriptAsync('void ' js)",
  '    catch as e',
  "        FileAppend('注入失败：' e.Message '`n', SCRIPT_DIR '\\_e2e.log', 'UTF-8')",
  '}',
  ''
].join('\n');

/* T13 要在 UNC 共享上放一张 png 来验证 file:///// 能不能加载。
   不依赖之前测试留下的文件：这里直接写一张 1×1 PNG 过去（失败就跳过那一步） */
const UNC_DIR = '\\\\localhost\\Users\\Administrator\\AppData\\Local\\Temp\\unctest';
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

function prepareUncIcon() {
  try {
    fs.mkdirSync(UNC_DIR + '\\子 目录', { recursive: true });
    fs.writeFileSync(UNC_DIR + '\\icon test.png', ONE_PX_PNG);
    return true;
  } catch (e) {
    console.log('[提示] 准备 UNC 图标测试文件失败（这台机器可能没开 SMB 共享）：' + e.message);
    return false;
  }
}

function build() {
  let src = fs.readFileSync(path.join(ROOT, 'launcher.ahk'), 'utf8');

  /* 别和用户正在跑的实例抢单例锁，也别共用同一个 WebView2 数据目录。
     单例键是从脚本目录算出来的，而生成出来的脚本就在同一个目录 —— 不换掉的话
     测试实例会把自己当成客户端，把"唤醒"投给用户那个进程然后退出。 */
  src = src.replace('#SingleInstance Force', '#SingleInstance Off');
  src = src.replace(/global INST_KEY\s*:=.*/, "global INST_KEY   := 'e2e-run'");
  src = src.replace(/global DATA_DIR\s*:=.*/, "global DATA_DIR   := '" + DATA_DIR + "'");

  /* 页面的 log 消息平时写 launcher.log，测试期间改写到 _e2e.log，方便一次性读取。
     注意要用 replaceAll：脚本里不止一处写这个路径（ReadyWatchdog 也有一处），
     只换第一处的话，真正打日志的那行会留在原地，_e2e.log 永远不出现。 */
  src = src.replaceAll("SCRIPT_DIR '\\launcher.log'", "SCRIPT_DIR '\\_e2e.log'");

  const anchor = 'RegisterHotkey(settings.hotkey)';
  if (!src.includes(anchor)) throw new Error('找不到注入点：' + anchor);
  src = src.replace(anchor, anchor + '\n\nSetTimer(E2E_Start, -1200)');

  fs.writeFileSync(GEN, src + AHK_TAIL, 'utf8');
  fs.writeFileSync(JS_FILE, PAGE_JS, 'utf8');
}

function main() {
  build();
  prepareUncIcon();
  try { fs.unlinkSync(LOG); } catch (e) {}

  const r = spawnSync(AHK, ['/ErrorStdOut', '/force', GEN], {
    cwd: ROOT,
    timeout: 45000,
    encoding: 'utf8'
  });

  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '(没有生成 _e2e.log)';
  process.stdout.write(log);
  if (r.status !== 0) console.log('[AHK 退出码] ' + r.status + '  signal=' + (r.signal || '-'));

  const stderr = (r.stderr || '').trim();
  if (stderr) console.log('\n[AHK stderr]\n' + stderr);

  const ok = /E2E DONE/.test(log) &&
    /T9 → 补历史\s*-> "8\.8\.8\.8"/.test(log) &&
    /T17 拉取失败回包\s*-> 弹层已关=true/.test(log) &&
    /T18 download 结果面板\s*-> 面板=true/.test(log);
  console.log('\n' + (ok ? '端到端冒烟：通过' : '端到端冒烟：有异常，逐行看上面的输出'));
  process.exit(ok ? 0 : 1);
}

main();
