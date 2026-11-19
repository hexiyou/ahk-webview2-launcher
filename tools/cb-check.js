/* ============================================================
   回调（_ql_callback）端到端检查 —— 真进程、真窗口、真 WebView2

   和 cli-check.js 同一套路：把 launcher.ahk + ui + lib + runtime 复制到临时目录，
   配一份只指向本地 HTTP 服务的 config.json（绝不碰用户真实配置），
   然后逐条 `ql run … --wait`，用 mark.log / launcher.log 断言"到底做了什么"。

   为什么非要真跑：这条链横跨 AHK（切片）+ 页面（解析派发）+ AHK（弹框/起进程），
   任何一段的自检都覆盖不到"消息真的从 WebView2 传到宿主、回调真的起了进程"。

   用法：node tools/cb-check.js
   注意：会短暂拉起一个隐藏实例，并弹两个 1 秒自动关的成功/错误提示框。
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const SANDBOX = path.join(os.tmpdir(), 'ql-cb-check', 'app');
const MARK = path.join(SANDBOX, 'mark.log');
const LOG = path.join(SANDBOX, 'launcher.log');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '\n         ' + extra : '')); }
}
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  ok(label, a === b, 'got  ' + a + '\n         want ' + b);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

function run(args, timeout = 60000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(AHK, [path.join(SANDBOX, 'launcher.ahk')].concat(args),
      { cwd: SANDBOX, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.stderr.on('data', d => { err += d.toString('utf8'); });
    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} }, timeout);
    p.on('close', code => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim(), ms: Date.now() - t0 });
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function readLog() { try { return fs.readFileSync(LOG, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { return ''; } }
function readMark() { try { return fs.readFileSync(MARK, 'utf8').replace(/^\uFEFF/, '').trim(); } catch (e) { return ''; } }
function clearMark() { try { fs.unlinkSync(MARK); } catch (e) {} }
function markCount() { return readMark() ? readMark().split(/\r?\n/).length : 0; }
const has = s => readLog().indexOf(s) >= 0;

/* ---------------- 本地服务：每种响应形状一个端点 ---------------- */
const server = http.createServer((req, res) => {
  const send = obj => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  switch (req.url.split('?')[0]) {
    case '/cb-ok':
      return send({
        ok: true,
        _ql_callback: {
          actions: [
            { type: 'run', id: 'marker' },
            { type: 'msg', level: 'success', title: '回调自检', text: 'ok 分支', timeout: 1 }
          ]
        }
      });
    case '/cb-chain':
      /* 回调再调一条 webhook：链上第二跳自己的回调要照常执行 */
      return send({ ok: true, _ql_callback: { actions: [{ type: 'run', id: 'hook-ok' }] } });
    case '/cb-loop':
      /* 自己调自己：第一步就该被阻断 */
      return send({ ok: true, _ql_callback: { actions: [{ type: 'run', id: 'hook-loop' }] } });
    case '/cb-nested':
      /* 只在深层出现：按设计不触发 */
      return send({ ok: true, data: { _ql_callback: { actions: [{ type: 'run', id: 'marker' }] } } });
    case '/cb-none':
      return send({ ok: true, n: 1 });
    case '/cb-bad':
      /* 根上有这个键，但值不完整：切不出来，要留一行日志 */
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end('{"_ql_callback": "abc');
    case '/cb-text':
      return send({
        _ql_callback: {
          actions: [
            { type: 'msg', level: 'error', text: '错误提示', timeout: 1 },
            { type: 'run', id: 'nope-1' },
            { type: 'run', id: 'nope-2' },
            { type: 'run', id: 'nope-3' },
            { type: 'run', id: 'nope-4' },
            { type: 'run', id: 'nope-5' }
          ]
        }
      });
    default:
      res.writeHead(404); res.end('nope');
  }
});

function prep() {
  fs.rmSync(path.join(os.tmpdir(), 'ql-cb-check'), { recursive: true, force: true });
  fs.mkdirSync(path.join(SANDBOX, 'runtime'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'launcher.ahk'), path.join(SANDBOX, 'launcher.ahk'));
  fs.copyFileSync(AHK, path.join(SANDBOX, 'runtime', 'AutoHotkey64.exe'));
  copyDir(path.join(ROOT, 'ui'), path.join(SANDBOX, 'ui'));
  copyDir(path.join(ROOT, 'lib'), path.join(SANDBOX, 'lib'));
  try { fs.copyFileSync(path.join(ROOT, 'pinyin.txt'), path.join(SANDBOX, 'pinyin.txt')); } catch (e) {}

  fs.writeFileSync(path.join(SANDBOX, 'launcher.ini'),
    '[General]\r\nHotkey=^!F9\r\nWidth=820\r\nHeight=580\r\nCornerRadius=14\r\n'
    + 'AlwaysOnTop=1\r\nHideOnBlur=0\r\nHideAfterLaunch=1\r\nShowOnStart=0\r\nDevTools=0\r\n');

  fs.writeFileSync(path.join(SANDBOX, 'mark.ahk'), [
    '#Requires AutoHotkey v2.0',
    "FileAppend('hit`n', A_ScriptDir '\\mark.log', 'UTF-8')",
    'ExitApp(0)'
  ].join('\r\n') + '\r\n');

  const base = 'http://127.0.0.1:' + server.address().port;
  const hook = (id, name, ep) => ({ id: id, name: name, type: 'webhook', target: base + ep, group: 't' });

  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
    name: 'QL Callback Check', version: 1,
    groups: [{ id: 't', name: '测试' }],
    items: [
      { id: 'marker', name: '写标记', type: 'ahk', target: 'mark.ahk', group: 't' },
      hook('hook-ok', '回调成功', '/cb-ok'),
      hook('hook-chain', '回调链', '/cb-chain'),
      hook('hook-loop', '回调环', '/cb-loop'),
      hook('hook-nested', '深层同名', '/cb-nested'),
      hook('hook-none', '没有回调', '/cb-none'),
      hook('hook-bad', '坏块', '/cb-bad'),
      hook('hook-text', '超限', '/cb-text')
    ]
  }, null, 2), 'utf8');
}

function killInstance(pid) { if (pid) { try { process.kill(pid); } catch (e) {} } }

async function instancePid() {
  /* 收件箱窗口的标题含脚本目录哈希，找它就是找实例。用 AHK 现算，避免
     node 的短路径（ADMINI~1）和 A_ScriptDir 长路径算不出同一个哈希。 */
  const probe = path.join(SANDBOX, 'pid-probe.ahk');
  fs.writeFileSync(probe, [
    '#Requires AutoHotkey v2.0',
    'SetTitleMatchMode(3)',
    'DetectHiddenWindows(true)',
    'h := 5381',
    'Loop Parse, StrLower(A_ScriptDir)',
    '    h := Mod((h * 33) + Ord(A_LoopField), 0x7FFFFFFF)',
    "title := 'QuickLaunch/ipc/' Format('{:08x}', h)",
    'w := WinExist(title)',
    "FileAppend(w ? WinGetPID('ahk_id ' w) : 0, A_ScriptDir '\\pid.txt', 'UTF-8')",
    'ExitApp(0)'
  ].join('\r\n') + '\r\n');
  try { fs.unlinkSync(path.join(SANDBOX, 'pid.txt')); } catch (e) {}
  await new Promise(res => { const p = spawn(AHK, [probe], { cwd: SANDBOX, windowsHide: true }); p.on('close', res); });
  try { return Number(fs.readFileSync(path.join(SANDBOX, 'pid.txt'), 'utf8').replace(/^\uFEFF/, '').trim()) || 0; }
  catch (e) { return 0; }
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  prep();

  console.log('— 回调：成功分支（run 本地命令 + 成功提示框）');
  const t1 = await run(['run', 'hook-ok', '--wait']);
  eq('退出码 0', t1.code, 0);
  await sleep(800);
  eq('回调真的拉起了一个条目', markCount(), 1);
  ok('日志里有执行记录', has('执行 marker（链 hook-ok→marker）'), readLog().slice(-600));
  ok('日志里有消息框记录', has('消息框 success：ok 分支'), readLog().slice(-600));

  console.log('— 回调：链（webhook 回调另一条 webhook）');
  clearMark();
  const t2 = await run(['run', 'hook-chain', '--wait']);
  eq('退出码 0', t2.code, 0);
  await sleep(1500);                       /* 第二跳还要再跑一次请求 */
  ok('第二跳真的执行了', markCount() >= 1, 'count=' + markCount());
  ok('日志里有第一跳', has('执行 hook-ok（链 hook-chain→hook-ok）'), readLog().slice(-800));
  ok('第二跳自己的回调也执行了（链上带着祖先）',
    has('执行 marker（链 hook-chain→hook-ok→marker）'), readLog().slice(-800));
  ok('人工触发的链仍然弹提示框（quiet 只表示"不占面板"）',
    !has('安静模式'), readLog().slice(-800));

  console.log('— 防环');
  clearMark();
  const n0 = markCount();
  const t3 = await run(['run', 'hook-loop', '--wait']);
  eq('退出码 0（被阻断不是错误）', t3.code, 0);
  await sleep(600);
  ok('日志里明确写了环已阻断', has('环已阻断（hook-loop→hook-loop）'), readLog().slice(-600));
  eq('没有执行任何条目', markCount(), n0);

  console.log('— 深层同名不触发');
  clearMark();
  const n1 = markCount();
  await run(['run', 'hook-nested', '--wait']);
  await sleep(400);
  ok('日志里没有这条请求的回调记录', !has('执行 marker（链 hook-nested'), readLog().slice(-400));
  eq('条目没被执行', markCount(), n1);

  console.log('— 没有这个键：行为完全不变');
  const t5 = await run(['run', 'hook-none', '--wait', '--json']);
  eq('退出码 0', t5.code, 0);
  ok('响应体照常回给调用方', /"ok":true/.test(t5.out), t5.out);
  ok('日志里没有 hook-none 的回调记录', !has('hook-none'), readLog().slice(-400));

  console.log('— 坏块（切不出来）');
  await run(['run', 'hook-bad', '--wait']);
  await sleep(400);
  ok('留了一行"切不出来"的日志', has('切不出来'), readLog().slice(-400));

  console.log('— 上限与跳过');
  await run(['run', 'hook-text', '--wait']);
  await sleep(1500);
  ok('动作数超上限有日志', has('动作数超过上限 5'), readLog().slice(-800));
  ok('不存在的 id 静默跳过', has('跳过 nope-1：config.json 里没有这个 id'), readLog().slice(-800));
  ok('错误提示框也走通了', has('消息框 error：错误提示'), readLog().slice(-800));

  console.log('— 回执不被消息框堵住');
  /* 消息框是模态的。回调的副作用必须排在命令行回执后面，否则脚本里的
     `ql run x --wait` 要等用户点了确定才拿到结果（超时还没到的话就一直挂着）。
     对比两条暖启动：带 1 秒提示框的那条不该比不带的慢出一个提示框的时间。 */
  await run(['run', 'hook-none', '--wait']);
  const ta = await run(['run', 'hook-none', '--wait']);
  const tb = await run(['run', 'hook-ok', '--wait']);
  ok('带提示框的回执没有被堵在框后面（' + tb.ms + 'ms vs ' + ta.ms + 'ms）',
    tb.ms < ta.ms + 800);

  killInstance(await instancePid());
  server.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})().catch(e => {
  console.error('崩溃：', e);
  killInstance(0);
  process.exit(1);
});
