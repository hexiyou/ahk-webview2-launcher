/* ============================================================
   jsonfile 类型的真实链路检查（真 WebView2 / 真 DOM / 真读盘）

   tests/jsonfile.test.js 只覆盖前端的纯函数（target 原样保留、类型标签、
   参数校验）。这一层要回答的是另一半问题：
     · 点下去之后 AHK 真的读到文件了吗？面板上的 FILE / 路径 / 已读取 对不对？
     · JSON 树、Ctrl+F、jsonPath 这些是不是原样复用上了？
     · 文件不存在时说的是"读取失败"，而不是那一大段 DNS / TLS 排查？
     · 手动刷新真的会重新读盘（文件改了内容也跟着变）？
   最后一条只能真跑：JS 侧点按钮的同时，node 侧把磁盘上的文件改掉。

   用法：node tools/jsonfile-check.js
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const BASE = path.join(os.tmpdir(), 'ql-jsonfile-check');
const SANDBOX = path.join(BASE, 'app');
const DATA_DIR = path.join(BASE, 'data');
const GEN = path.join(SANDBOX, '_launcher_jsonfile.ahk');
const JS_FILE = path.join(os.tmpdir(), 'ql-jsonfile-probe.js');
const LOG = path.join(SANDBOX, '_jsonfile.log');
const FIXTURE = path.join(BASE, 'data.json');
const PLAIN = path.join(BASE, 'note.txt');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.webview2') continue;
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else { try { fs.copyFileSync(a, b); } catch (err) {} }
  }
}

function writeFixture(mark) {
  const data = {
    name: '示例配置',
    版本: 3,
    启用: true,
    items: [
      { id: 'a', title: mark + '-第一项', tags: ['中文', 'test'] },
      { id: 'b', title: mark + '-第二项', tags: [] }
    ],
    nested: { deep: { value: 12345, note: '嵌套三层' } }
  };
  fs.writeFileSync(FIXTURE, JSON.stringify(data, null, 2), 'utf8');
}

function prepare() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
  copyDir(path.join(ROOT, 'ui'), path.join(SANDBOX, 'ui'));
  copyDir(path.join(ROOT, 'lib'), path.join(SANDBOX, 'lib'));
  copyDir(path.join(ROOT, 'runtime'), path.join(SANDBOX, 'runtime'));
  fs.copyFileSync(path.join(ROOT, 'launcher.ahk'), path.join(SANDBOX, 'launcher.ahk'));

  writeFixture('首读');
  fs.writeFileSync(PLAIN, '这是一份纯文本，不是 JSON。\n第二行。\n', 'utf8');

  const cfg = {
    items: [
      {
        id: 'jf', name: '看本地 JSON（只看一个字段）', type: 'jsonfile', group: 'net',
        /* 故意用用户最常写的两斜杠 + 反斜杠形式 */
        target: 'file://' + FIXTURE,
        jsonPath: 'nested.deep.value'
      },
      {
        id: 'jftree', name: '看本地 JSON（整棵树）', type: 'jsonfile', group: 'net',
        target: 'file://' + FIXTURE
      },
      {
        id: 'jfmissing', name: '看一个不存在的文件', type: 'jsonfile', group: 'net',
        target: 'file://' + path.join(BASE, 'nope', 'missing.json')
      },
      {
        id: 'jfplain', name: '看一个纯文本', type: 'jsonfile', group: 'net',
        target: 'file://' + PLAIN
      }
    ]
  };
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  fs.writeFileSync(path.join(SANDBOX, 'launcher.ini'),
    '[General]\nHotkey=\nWidth=880\nHeight=620\nCornerRadius=14\nAlwaysOnTop=0\n'
    + 'HideOnBlur=0\nHideAfterLaunch=0\nShowOnStart=1\nDevTools=0\n', 'utf8');
}

/* 路径要按页面上显示的样子比：AHK 返回的是 Windows 反斜杠绝对路径 */
const WANT_PATH = JSON.stringify(FIXTURE);

const PAGE_JS = `(async () => {
  const $ = id => document.getElementById(id);
  const log = t => chrome.webview.postMessage({ type: 'log', text: t });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let P = 0, F = 0;
  const ok = (n, c, x) => { if (c) { P++; log('ok ' + n); } else { F++; log('FAIL ' + n + (x !== undefined ? ' :: ' + x : '')); } };
  const rows = () => $('rJson').querySelectorAll('.jline').length;

  try {
    if (!window.__cli) throw new Error('没有 __cli');
    if (!window.__qlTest) throw new Error('没有 __qlTest');

    /* ---------------- 正常读一份 JSON：整棵树 ---------------- */
    window.__cli({ rid: 'a1', mode: 'run', q: 'jftree' });
    await wait(1500);

    ok('结果面板打开了', !$('result').hidden);
    ok('方法徽标是 FILE', $('rMethod').textContent === 'FILE', $('rMethod').textContent);
    ok('徽标挂了 m-file 样式', $('rMethod').className.indexOf('m-file') >= 0, $('rMethod').className);
    ok('地址行是解析后的绝对路径', $('rUrl').textContent === ${WANT_PATH},
      $('rUrl').textContent);
    ok('状态行说"已读取"', /已读取/.test($('rStatus').textContent), $('rStatus').textContent);
    ok('状态行报了体积', /B|KB|MB/.test($('rStatus').textContent), $('rStatus').textContent);
    ok('没有出现 HTTP 状态码 200', !/200/.test($('rStatus').textContent), $('rStatus').textContent);
    ok('走的是树视图（不是纯文本）', !$('rJson').hidden && $('rPre').hidden,
      'rJson.hidden=' + $('rJson').hidden + ' rPre.hidden=' + $('rPre').hidden);
    ok('树里画出了行', rows() > 6, rows());
    ok('中文键名显示出来了', $('rJson').textContent.indexOf('版本') >= 0);
    ok('本地文件也露出搜索按钮', !$('rFind').hidden);
    ok('刷新按钮可见', !$('rRefresh').hidden);
    ok('元信息提示可以刷新', /刷新/.test($('rMeta').textContent), $('rMeta').textContent);
    ok('没配 jsonPath 就没有切换按钮', $('rToggle').hidden === true, 'hidden=' + $('rToggle').hidden);

    /* 搜索复用 webhook 那一套 */
    window.__qlTest.jsonFind('第二项');
    ok('能在本地文件里搜到内容', $('rJson').querySelectorAll('.jline.hit').length > 0);
    window.__qlTest.clearFind();

    /* ---------------- 配了 jsonPath：默认只看提取到的值 ---------------- */
    window.__cli({ rid: 'a1b', mode: 'run', q: 'jf' });
    await wait(1200);
    const valView = $('rJson').hidden ? $('rPre').textContent : $('rJson').textContent;
    ok('jsonPath 生效：只显示提取到的值', valView.indexOf('12345') >= 0, valView.slice(0, 40));
    ok('配了 jsonPath 就有"完整响应"按钮', $('rToggle').hidden === false,
      'hidden=' + $('rToggle').hidden);
    if (!$('rToggle').hidden) {
      $('rToggle').click();
      await wait(150);
      const full = $('rJson').hidden ? $('rPre').textContent : $('rJson').textContent;
      ok('切到完整内容后能看到别的字段', full.indexOf('示例配置') >= 0, full.slice(0, 60));
      $('rToggle').click();
      await wait(150);
    }

    /* ---------------- 文件不存在 ---------------- */
    window.__cli({ rid: 'a2', mode: 'run', q: 'jfmissing' });
    await wait(1200);
    ok('不存在的文件：状态是读取失败', $('rStatus').textContent.indexOf('读取失败') >= 0,
      $('rStatus').textContent);
    ok('不存在的文件：正文说清了原因', $('rPre').textContent.indexOf('没能读到这个文件') >= 0,
      $('rPre').textContent.slice(0, 60));
    ok('不存在的文件：没有套用网络排查文案',
      $('rPre').textContent.indexOf('DNS') < 0 && $('rPre').textContent.indexOf('TLS') < 0);
    ok('不存在的文件：正文里带着路径',
      $('rPre').textContent.indexOf('missing.json') >= 0);
    ok('出错时刷新按钮还在（改好路径能重来）', !$('rRefresh').hidden);

    /* ---------------- 非 JSON 按原文显示 ---------------- */
    window.__cli({ rid: 'a3', mode: 'run', q: 'jfplain' });
    await wait(1200);
    ok('纯文本也读出来了', $('rStatus').textContent.indexOf('已读取') >= 0, $('rStatus').textContent);
    ok('纯文本按原文显示', $('rPre').textContent.indexOf('这是一份纯文本') >= 0,
      $('rPre').textContent.slice(0, 40));
    ok('纯文本没有硬画成树', $('rJson').hidden === true);
    ok('元信息标注了"非 JSON"', $('rMeta').textContent.indexOf('非 JSON') >= 0,
      $('rMeta').textContent);

    /* ---------------- 手动刷新：真的重新读盘 ---------------- */
    window.__cli({ rid: 'a4', mode: 'run', q: 'jftree' });
    await wait(1500);
    ok('刷新前是旧内容', $('rJson').textContent.indexOf('首读') >= 0);

    /* 通知 node 侧改文件，再点刷新 */
    log('REFRESH-WANT');
    await wait(900);
    $('rRefresh').click();
    await wait(1500);
    ok('点刷新后读到了新内容', $('rJson').textContent.indexOf('改过') >= 0,
      $('rJson').textContent.slice(0, 80));
    ok('刷新后状态仍然是已读取', $('rStatus').textContent.indexOf('已读取') >= 0, $('rStatus').textContent);
  } catch (e) {
    log('EXCEPTION ' + ((e && e.stack) || e));
  }
  log('DONE ' + P + ' ' + F);
  chrome.webview.postMessage({ type: 'exit' });
})();
`;

const AHK_TAIL = [
  '',
  '; ===== jsonfile 检查的引导（只存在于生成出来的脚本里） =====',
  '',
  'JfCheck_Start() {',
  '    static tries := 0',
  '    global wv, uiReady, SCRIPT_DIR',
  '    if (!uiReady || !wv) {',
  '        tries++',
  '        if (tries > 40) {',
  "            FileAppend('页面 20 秒还没就绪，放弃`n', SCRIPT_DIR '\\_jsonfile.log', 'UTF-8')",
  '            ExitApp(1)',
  '        }',
  '        SetTimer(JfCheck_Start, -500)',
  '        return',
  '    }',
  "    js := FileRead(A_Temp '\\ql-jsonfile-probe.js', 'UTF-8')",
  '    try',
  "        wv.ExecuteScriptAsync('void ' js)",
  '    catch as e',
  "        FileAppend('注入失败：' e.Message '`n', SCRIPT_DIR '\\_jsonfile.log', 'UTF-8')",
  '}',
  ''
].join('\n');

function build() {
  let src = fs.readFileSync(path.join(ROOT, 'launcher.ahk'), 'utf8');
  src = src.replace('#SingleInstance Force', '#SingleInstance Off');
  src = src.replace(/global INST_KEY\s*:=.*/, "global INST_KEY   := 'jsonfile-run'");
  src = src.replace(/global DATA_DIR\s*:=.*/, "global DATA_DIR   := '" + DATA_DIR + "'");
  src = src.replaceAll("SCRIPT_DIR '\\launcher.log'", "SCRIPT_DIR '\\_jsonfile.log'");

  const anchor = 'RegisterHotkey(settings.hotkey)';
  if (!src.includes(anchor)) throw new Error('找不到注入点：' + anchor);
  src = src.replace(anchor, anchor + '\n\nSetTimer(JfCheck_Start, -1200)');

  fs.writeFileSync(GEN, src + AHK_TAIL, 'utf8');
  fs.writeFileSync(JS_FILE, PAGE_JS, 'utf8');
}

function run() {
  return new Promise(resolve => {
    const p = require('child_process').spawn(AHK, ['/ErrorStdOut', '/force', GEN],
      { cwd: ROOT, windowsHide: true });
    let err = '';
    p.stderr.on('data', b => { err += b.toString('utf8'); });

    /* 页面里点刷新之前会往日志写 REFRESH-WANT，看到就把磁盘上的文件改掉，
       这样才能证明"刷新"真的重新读了盘，而不是重画了一遍内存里的旧数据 */
    let swapped = false;
    const poll = setInterval(() => {
      if (swapped || !fs.existsSync(LOG)) return;
      const text = fs.readFileSync(LOG, 'utf8');
      if (text.indexOf('REFRESH-WANT') >= 0) {
        swapped = true;
        writeFixture('改过');
      }
    }, 120);

    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} }, 60000);
    p.on('close', code => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ code: code, stderr: err, swapped: swapped });
    });
  });
}

async function main() {
  prepare();
  build();
  try { fs.unlinkSync(LOG); } catch (e) {}

  const r = await run();

  const out = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '(没有生成 _jsonfile.log)';
  process.stdout.write(out);
  if (!r.swapped) console.log('\n[注意] 页面没走到刷新那一步，文件没被改过');
  const stderr = (r.stderr || '').trim();
  if (stderr) console.log('\n[AHK stderr]\n' + stderr);

  const done = /DONE (\d+) (\d+)/.exec(out);
  if (!done) { console.log('\n没拿到结果（进程退出码 ' + r.code + '）'); process.exit(1); }
  console.log('\n合计：' + done[1] + ' 通过，' + done[2] + ' 失败');
  process.exit(Number(done[2]) ? 1 : 0);
}

main();
