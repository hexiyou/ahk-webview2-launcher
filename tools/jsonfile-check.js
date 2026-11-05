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
const YAML1 = path.join(BASE, 'svc.yml');
const YAML2 = path.join(BASE, 'multi.yaml');
const TOML1 = path.join(BASE, 'cfg.toml');
const YAMLBAD = path.join(BASE, 'broken.yml');
const BIGYAML = path.join(BASE, 'big.yml');
const BIGTXT = path.join(BASE, 'big.txt');

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

  /* YAML：中文键、嵌套、数组、日期、以及一个足够深的层级用来验展开/折叠 */
  fs.writeFileSync(YAML1, [
    '服务名: 网关',
    'replicas: 3',
    '启用: true',
    '启动于: 2024-06-01',
    '端口:',
    '  - 8080',
    '  - 8443',
    '数据库:',
    '  host: db.local',
    '  pool: 8',
    '  认证:',
    '    user: admin',
    '    from: env',
    '标签:',
    '  - 生产',
    '  - 上海',
    ''
  ].join('\n'), 'utf8');

  /* 多文档：元信息要标"3 个文档"，树根得是数组 */
  fs.writeFileSync(YAML2, [
    '---',
    'kind: Service',
    'name: alpha',
    '---',
    'kind: Deployment',
    'name: beta',
    'replicas: 2',
    '---',
    'kind: ConfigMap',
    'name: gamma',
    ''
  ].join('\n'), 'utf8');

  /* TOML：表 + 数组表 + 日期（日期是最容易画成 {} 的那种值） */
  fs.writeFileSync(TOML1, [
    'title = "演示"',
    'port = 8080',
    '',
    '[owner]',
    'name = "张三"',
    'joined = 2024-01-02T03:04:05Z',
    '',
    '[[items]]',
    'id = 1',
    'title = "第一项"',
    '',
    '[[items]]',
    'id = 2',
    'title = "第二项"',
    ''
  ].join('\n'), 'utf8');

  /* 语法坏掉的 YAML：要退回纯文本，而不是白屏或者报"文件读不了" */
  fs.writeFileSync(YAMLBAD, 'a: [1,\n  b: 2\n', 'utf8');

  /* 3.6MB：同一个体积，.yml 该被 2MB 上限拦下，.txt 该照 8MB 放行 ——
     这两条一起才说明"上限是按格式分的"，而不是把全局上限改小了 */
  const big = 'k: value\n'.repeat(400000);
  fs.writeFileSync(BIGYAML, big, 'utf8');
  fs.writeFileSync(BIGTXT, big, 'utf8');

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
      },
      {
        id: 'yfone', name: '看 YAML', type: 'jsonfile', group: 'net',
        target: 'file://' + YAML1
      },
      {
        id: 'yfmulti', name: '看多文档 YAML', type: 'jsonfile', group: 'net',
        target: 'file://' + YAML2
      },
      {
        id: 'tfone', name: '看 TOML', type: 'jsonfile', group: 'net',
        target: 'file://' + TOML1
      },
      {
        id: 'yfbad', name: '看坏掉的 YAML', type: 'jsonfile', group: 'net',
        target: 'file://' + YAMLBAD
      },
      {
        id: 'yfpath', name: 'YAML 只取一个字段', type: 'jsonfile', group: 'net',
        target: 'file://' + YAML1, jsonPath: '数据库.认证.user'
      },
      {
        id: 'yfbig', name: '看一个巨大的 YAML', type: 'jsonfile', group: 'net',
        target: 'file://' + BIGYAML
      },
      {
        id: 'txbig', name: '看一个同样大的文本', type: 'jsonfile', group: 'net',
        target: 'file://' + BIGTXT
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
    ok('元信息标注了"不是 JSON"', $('rMeta').textContent.indexOf('不是 JSON') >= 0,
      $('rMeta').textContent);
    /* .txt 本来就不是 JSON，试解析失败不能报成"解析失败"，那是在制造问题 */
    ok('纯文本不被说成"解析失败"', $('rMeta').textContent.indexOf('解析失败') < 0,
      $('rMeta').textContent);

    /* ---------------- YAML：按扩展名选解析器，照样进同一棵树 ---------------- */
    window.__cli({ rid: 'b1', mode: 'run', q: 'yfone' });
    await wait(1500);
    ok('YAML 读出来了', $('rStatus').textContent.indexOf('已读取') >= 0, $('rStatus').textContent);
    ok('YAML 走树视图', !$('rJson').hidden && $('rPre').hidden,
      'rJson.hidden=' + $('rJson').hidden);
    ok('YAML 中文键显示出来', $('rJson').textContent.indexOf('服务名') >= 0,
      $('rJson').textContent.slice(0, 60));
    ok('YAML 数组元素显示出来', $('rJson').textContent.indexOf('8080') >= 0);
    ok('元信息标注了 YAML', $('rMeta').textContent.indexOf('YAML') >= 0, $('rMeta').textContent);
    ok('YAML 没被说成"不是 YAML"', $('rMeta').textContent.indexOf('不是 YAML') < 0, $('rMeta').textContent);
    /* 日期是 YAML/TOML 最容易画错的值：规范化没做对就会变成 {} */
    ok('YAML 日期显示成原文', $('rJson').textContent.indexOf('2024-06-01') >= 0,
      $('rJson').textContent.slice(0, 80));

    /* 展开/折叠：按钮要出现，点了要真的改变可见行数 */
    ok('展开全部按钮可见', $('rExpand').hidden === false);
    ok('折叠全部按钮可见', $('rCollapse').hidden === false);

    const visRows = () => Array.prototype.filter.call(
      $('rJson').querySelectorAll('.jline'), el => el.offsetParent !== null).length;

    const rowsOpen = visRows();
    $('rCollapse').click();
    await wait(120);
    const rowsClosed = visRows();
    ok('折叠全部后可见行变少', rowsClosed < rowsOpen, rowsOpen + ' -> ' + rowsClosed);
    ok('折叠全部仍保留顶层字段', rowsClosed >= 3, rowsClosed);
    const topNode = $('rJson').querySelector('.jroot > .jnode');
    ok('折叠全部不折最外层（否则整屏只剩一行）',
      !!topNode && !topNode.classList.contains('collapsed'));

    $('rExpand').click();
    await wait(120);
    const rowsReopen = visRows();
    ok('展开全部后行都回来了', rowsReopen >= rowsOpen, rowsOpen + ' -> ' + rowsReopen);
    ok('展开全部后深处节点也露出来', $('rJson').textContent.indexOf('env') >= 0);

    /* ---------------- 多文档 YAML ---------------- */
    window.__cli({ rid: 'b2', mode: 'run', q: 'yfmulti' });
    await wait(1500);
    ok('多文档走树视图', !$('rJson').hidden);
    ok('元信息标了文档数', $('rMeta').textContent.indexOf('3 个文档') >= 0, $('rMeta').textContent);
    ok('三个文档都在树里',
      ['alpha', 'beta', 'gamma'].every(s => $('rJson').textContent.indexOf(s) >= 0),
      $('rJson').textContent.slice(0, 80));

    /* ---------------- TOML ---------------- */
    window.__cli({ rid: 'b3', mode: 'run', q: 'tfone' });
    await wait(1500);
    ok('TOML 走树视图', !$('rJson').hidden && $('rPre').hidden);
    ok('元信息标注了 TOML', $('rMeta').textContent.indexOf('TOML') >= 0, $('rMeta').textContent);
    ok('TOML 表结构显示出来', $('rJson').textContent.indexOf('张三') >= 0);
    ok('TOML 数组表显示成 2 项', $('rJson').textContent.indexOf('2 项') >= 0,
      $('rJson').textContent.slice(0, 80));
    /* 这一条是重点：Date 不规范化就会渲染成 "{ }"，用户完全看不懂 */
    ok('TOML 日期显示成 ISO 串', $('rJson').textContent.indexOf('2024-01-02') >= 0,
      $('rJson').textContent.slice(0, 100));
    ok('TOML 日期没被画成空对象', $('rJson').textContent.indexOf('joined') >= 0
      && $('rJson').textContent.indexOf('{}') < 0 && $('rJson').textContent.indexOf('{ }') < 0,
      $('rJson').textContent.slice(0, 100));

    /* ---------------- 语法坏掉的 YAML：退回原文，但要说明坏在哪 ---------------- */
    window.__cli({ rid: 'b4', mode: 'run', q: 'yfbad' });
    await wait(1200);
    ok('坏 YAML 文件本身读到了', $('rStatus').textContent.indexOf('已读取') >= 0,
      $('rStatus').textContent);
    ok('坏 YAML 退回纯文本', $('rJson').hidden === true);
    ok('坏 YAML 正文还是原文', $('rPre').textContent.indexOf('b: 2') >= 0,
      $('rPre').textContent.slice(0, 40));
    ok('坏 YAML 元信息说了解析失败', /解析失败/.test($('rMeta').textContent), $('rMeta').textContent);
    /* 注意 \\d：这段脚本本身在模板字符串里，写 \d 会被模板字符串吃掉反斜杠 */
    ok('坏 YAML 报错带行号', /第 \\d+ 行/.test($('rMeta').textContent), $('rMeta').textContent);
    ok('坏 YAML 不显示展开/折叠', $('rExpand').hidden === true && $('rCollapse').hidden === true);

    /* ---------------- YAML 上的 jsonPath ---------------- */
    window.__cli({ rid: 'b5', mode: 'run', q: 'yfpath' });
    await wait(1200);
    const yv = $('rJson').hidden ? $('rPre').textContent : $('rJson').textContent;
    ok('YAML 的 jsonPath 提取生效（中文键）', yv.indexOf('admin') >= 0, yv.slice(0, 40));
    ok('配了 jsonPath 就有"完整响应"按钮', $('rToggle').hidden === false);

    /* ---------------- 上限按格式分：3.6MB 的 .yml 拒读，.txt 照读 ---------------- */
    window.__cli({ rid: 'b6', mode: 'run', q: 'yfbig' });
    await wait(1500);
    ok('超大 YAML 被拒读', $('rStatus').textContent.indexOf('读取失败') >= 0, $('rStatus').textContent);
    ok('超大 YAML 说清上限是 2MB', $('rPre').textContent.indexOf('2.00 MB') >= 0,
      $('rPre').textContent.slice(0, 90));
    ok('超大 YAML 说清"没有读取"', $('rPre').textContent.indexOf('没有读取') >= 0,
      $('rPre').textContent.slice(0, 90));

    window.__cli({ rid: 'b7', mode: 'run', q: 'txbig' });
    await wait(2500);
    ok('同样大的文本文件照常读（上限没有一刀切）',
      $('rStatus').textContent.indexOf('已读取') >= 0, $('rStatus').textContent);
    ok('大文本按原文显示', $('rPre').textContent.indexOf('k: value') >= 0);

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
