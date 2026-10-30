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

function build() {
  let src = fs.readFileSync(path.join(ROOT, 'launcher.ahk'), 'utf8');

  /* 别和用户正在跑的实例抢 SingleInstance，也别共用同一个 WebView2 数据目录 */
  src = src.replace('#SingleInstance Force', '#SingleInstance Off');
  src = src.replace(/global DATA_DIR\s*:=.*/, "global DATA_DIR   := '" + DATA_DIR + "'");

  /* 页面的 log 消息平时写 launcher.log，测试期间改写到 _e2e.log，方便一次性读取 */
  src = src.replace("SCRIPT_DIR '\\launcher.log'", "SCRIPT_DIR '\\_e2e.log'");

  const anchor = 'RegisterHotkey(settings.hotkey)';
  if (!src.includes(anchor)) throw new Error('找不到注入点：' + anchor);
  src = src.replace(anchor, anchor + '\n\nSetTimer(E2E_Start, -1200)');

  fs.writeFileSync(GEN, src + AHK_TAIL, 'utf8');
  fs.writeFileSync(JS_FILE, PAGE_JS, 'utf8');
}

function main() {
  build();
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

  const ok = /E2E DONE/.test(log) && /T9 → 补历史\s*-> "8\.8\.8\.8"/.test(log);
  console.log('\n' + (ok ? '端到端冒烟：通过' : '端到端冒烟：有异常，逐行看上面的输出'));
  process.exit(ok ? 0 : 1);
}

main();
