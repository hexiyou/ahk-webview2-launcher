/* ============================================================
   命令行端到端检查（真进程、真窗口、真 WebView2）

   把 launcher.ahk + ui + lib + runtime 复制到临时目录，配一份专用 config.json
   （条目只指向本工具自己的 mark.ahk 和一个本地 HTTP 服务，绝不碰用户真实配置），
   然后用 spawn 逐个跑 CLI，验证：退出码、stdout、条目真的被执行、单实例不被重启。

   用法：node tools/cli-check.js
   注意：会短暂拉起一个隐藏实例（跑完自动结束）。
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const SANDBOX = path.join(os.tmpdir(), 'ql-cli-check', 'app');
const PROBE = path.join(SANDBOX, 'probe.ahk');
const PROBE_LOG = path.join(SANDBOX, 'probe.log');
const MARK = path.join(SANDBOX, 'mark.log');

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

/* 直接问系统：收件箱窗口还在不在、属于哪个进程、主窗口是不是露着 */
async function probeState() {
  try { fs.unlinkSync(PROBE_LOG); } catch (e) {}
  await new Promise(res => {
    const p = spawn(AHK, [PROBE], { cwd: SANDBOX, windowsHide: true });
    p.on('close', res);
  });
  try {
    const t = fs.readFileSync(PROBE_LOG, 'utf8').replace(/^\uFEFF/, '');
    const p = /pid=(\d+)/.exec(t);
    const v = /visible=(\d+)/.exec(t);
    return { pid: p ? Number(p[1]) : 0, visible: v ? Number(v[1]) : 0 };
  } catch (e) { return { pid: 0, visible: 0 }; }
}

async function instancePid() {
  return (await probeState()).pid;
}

function readMark() {
  try { return fs.readFileSync(MARK, 'utf8').replace(/^\uFEFF/, '').trim(); }
  catch (e) { return ''; }
}
function clearMark() { try { fs.unlinkSync(MARK); } catch (e) {} }
/* mark.ahk 是另一个进程，CLI 返回时它可能还没写完（进程调度慢了能拖到 1 秒以上），
   所以轮询等它落盘，别用固定 sleep —— 那玩意儿在 CI 机器上一定翻车 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitMark(want, ms = 5000) {
  const t0 = Date.now();
  let v = readMark();
  while (v !== want && Date.now() - t0 < ms) {
    await sleep(100);
    v = readMark();
  }
  return v;
}

/* ---------------- 本地 HTTP 服务：给 webhook / download 用 ---------------- */
const BINARY = Buffer.alloc(256).map((_, i) => i);
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
    return;
  }
  if (req.url.startsWith('/file')) {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': BINARY.length,
      'Content-Disposition': 'attachment; filename="cli-check.bin"'
    });
    res.end(BINARY);
    return;
  }
  res.writeHead(404); res.end('nope');
});

function prep() {
  fs.rmSync(path.join(os.tmpdir(), 'ql-cli-check'), { recursive: true, force: true });
  fs.mkdirSync(path.join(SANDBOX, 'runtime'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'launcher.ahk'), path.join(SANDBOX, 'launcher.ahk'));
  fs.copyFileSync(path.join(ROOT, 'webhook.ahk'), path.join(SANDBOX, 'webhook.ahk'));
  fs.copyFileSync(AHK, path.join(SANDBOX, 'runtime', 'AutoHotkey64.exe'));
  copyDir(path.join(ROOT, 'ui'), path.join(SANDBOX, 'ui'));
  copyDir(path.join(ROOT, 'lib'), path.join(SANDBOX, 'lib'));
  try { fs.copyFileSync(path.join(ROOT, 'pinyin.txt'), path.join(SANDBOX, 'pinyin.txt')); } catch (e) {}

  fs.writeFileSync(path.join(SANDBOX, 'launcher.ini'),
    '[General]\r\nHotkey=^!F9\r\nWidth=820\r\nHeight=580\r\nCornerRadius=14\r\n'
    + 'AlwaysOnTop=1\r\nHideOnBlur=0\r\nHideAfterLaunch=1\r\nShowOnStart=0\r\nDevTools=0\r\n');

  fs.writeFileSync(path.join(SANDBOX, 'mark.ahk'), [
    '#Requires AutoHotkey v2.0',
    "s := ''",
    'for a in A_Args',
    "    s .= a '|'",
    "FileAppend('args=[' s ']`n', A_ScriptDir '\\mark.log', 'UTF-8')",
    'ExitApp(0)'
  ].join('\r\n') + '\r\n');

  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
    name: 'QL CLI Check', version: 1,
    groups: [{ id: 't', name: '测试' }],
    items: [
      { id: 'marker', name: '标记一', type: 'ahk', target: 'mark.ahk', group: 't', pinned: true },
      { id: 'marker2', name: '标记二', type: 'ahk', target: 'mark.ahk', group: 't' },
      { id: 'dupA', name: '重复 一', type: 'ahk', target: 'mark.ahk', group: 't' },
      { id: 'dupB', name: '重复 二', type: 'ahk', target: 'mark.ahk', group: 't' },
      /* enabled:false 的条目：搜索、list、run 都不该看见它；
         下面那条显式写 true，用来验证"写了也不影响" */
      { id: 'hidden', name: '停用条目', type: 'ahk', target: 'mark.ahk', group: 't', enabled: false },
      { id: 'shown', name: '显式启用', type: 'ahk', target: 'mark.ahk', group: 't', enabled: true },
      { id: 'badtarget', name: '坏目标', type: 'app', target: 'C:\\nope\\missing.exe', group: 't' },
      {
        id: 'hook', name: '测试请求', type: 'webhook', group: 't',
        target: base + '/api?q={{q}}', params: [{ name: 'q', label: '关键词' }]
      },
      {
        id: 'dl', name: '测试下载', type: 'download', group: 't',
        target: base + '/file', savePath: SANDBOX, fileName: 'cli-check.bin',
        onExists: 'overwrite'
      }
    ]
  }, null, 2), 'utf8');

  /* 标题里的哈希由探针自己算：node 的 os.tmpdir() 可能给的是 8.3 短路径
     （ADMINI~1），而 AHK 的 A_ScriptDir 是长路径，两边各算各的永远对不上。
     让探针用自己所在的目录复算一遍，形式自然一致。 */
  fs.writeFileSync(PROBE, [
    '#Requires AutoHotkey v2.0',
    'SetTitleMatchMode(3)',
    'DetectHiddenWindows(true)',
    'h := 5381',
    'Loop Parse, StrLower(A_ScriptDir)',
    '    h := Mod((h * 33) + Ord(A_LoopField), 0x7FFFFFFF)',
    "title := 'QuickLaunch/ipc/' Format('{:08x}', h)",
    'w := WinExist(title)',
    'pid := w ? WinGetPID("ahk_id " w) : 0',
    "mw := WinExist('QuickLaunch')",
    "vis := mw ? DllCall('user32\\IsWindowVisible', 'ptr', mw) : 0",
    "FileAppend('pid=' pid ' visible=' vis '`n', A_ScriptDir '\\probe.log', 'UTF-8')",
    'ExitApp(0)'
  ].join('\r\n') + '\r\n');
}

function killInstances(pid) {
  if (!pid) return;
  try { process.kill(pid); } catch (e) {}
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  prep();
  const dlFile = path.join(SANDBOX, 'cli-check.bin');
  try { fs.unlinkSync(dlFile); } catch (e) {}

  console.log('— 冷启动');
  const t1 = await run(['list', '标记', '--json']);
  const pid1 = await instancePid();
  ok('list 冷启动退出码 0', t1.code === 0, 'code=' + t1.code + ' err=' + t1.err);
  ok('自动拉起了实例', pid1 > 0, 'pid=' + pid1);
  let items = [];
  try { items = JSON.parse(t1.out).items || []; } catch (e) {}
  eq('list 返回两条候选', items.map(x => x.id), ['marker', 'marker2']);
  ok('冷启动耗时 (ms) = ' + t1.ms, true);

  console.log('— 暖启动');
  const t2 = await run(['list', '标记', '--json']);
  eq('暖启动退出码 0', t2.code, 0);
  eq('实例没有被重启', await instancePid(), pid1);
  ok('暖启动比冷启动快（' + t2.ms + 'ms < ' + t1.ms + 'ms）', t2.ms < t1.ms);

  console.log('— 直接执行');
  clearMark();
  const t3 = await run(['run', 'marker', '--wait']);
  eq('run 退出码 0', t3.code, 0);
  eq('stdout 有回执', t3.out, '已启动：标记一');
  eq('条目确实执行了', await waitMark('args=[]'), 'args=[]');

  clearMark();
  await run(['run', 'marker', '--args', 'a b', '--wait']);
  eq('--args 按空白切成两个参数', await waitMark('args=[a|b|]'), 'args=[a|b|]');

  clearMark();
  await run(['run', 'marker', '--wait', '--', '--weird', 'x y', '\\\\nas\\share']);
  eq('-- 之后的原文保留分组', await waitMark('args=[--weird|x y|\\\\nas\\share|]'),
    'args=[--weird|x y|\\\\nas\\share|]');

  console.log('— 歧义与找不到');
  const t4 = await run(['run', '重复', '--wait']);
  eq('歧义退出码 2', t4.code, 2);
  ok('把候选列出来', /dupA/.test(t4.out) && /dupB/.test(t4.out), t4.out);
  const t5 = await run(['run', '重复', '--first', '--wait']);
  eq('--first 直接取第一条', t5.code, 0);
  const t6 = await run(['run', '压根没有这条', '--wait']);
  eq('找不到退出码 1', t6.code, 1);
  const t7 = await run(['run']);
  eq('写法不对退出码 6', t7.code, 6);
  ok('打印了用法', /用法：ql/.test(t7.out + t7.err), t7.out + t7.err);

  /* enabled:false 的语义就是"当它不存在"：不列、不搜、不执行。
     完全按外部调用方的视角验，而不是只看页面里过滤了没。 */
  console.log('— enabled: false');
  const t6a = await run(['list', '停用条目', '--json']);
  eq('list 看不到停用的条目', t6a.code, 1);
  ok('提示没有匹配', /没有匹配的条目/.test(t6a.out + t6a.err), t6a.out + t6a.err);

  clearMark();
  await sleep(600);                    /* 上一条用例的 mark 可能还在路上，先让路 */
  const t6b = await run(['run', 'hidden', '--wait']);
  eq('按 id run 停用条目退出码 1', t6b.code, 1);
  ok('提示没找到', /没找到匹配的条目/.test(t6b.out + t6b.err), t6b.out + t6b.err);
  await sleep(600);
  eq('停用条目确实没被执行', readMark(), '');

  const t6c = await run(['run', '停用条目', '--wait', '--first']);
  eq('按名称 run 停用条目也是 1', t6c.code, 1);
  await sleep(600);
  eq('--first 也不会去碰它', readMark(), '');

  const t6d = await run(['run', 'shown', '--wait']);
  eq('显式 enabled:true 照常执行', t6d.code, 0);
  eq('显式启用的条目真的跑了', await waitMark('args=[]'), 'args=[]');
  const t6e = await run(['list', '显式', '--json']);
  eq('显式启用的条目能被 list 到', (() => {
    try { return (JSON.parse(t6e.out).items || []).map(x => x.id); } catch (e) { return []; }
  })(), ['shown']);

  console.log('— 参数与目标错误');
  const t8 = await run(['run', 'hook', '--wait']);
  eq('缺必填参数退出码 3', t8.code, 3);
  ok('提示缺哪个参数', /q/.test(t8.out), t8.out);
  const t9 = await run(['run', 'badtarget', '--wait']);
  eq('目标不存在退出码 4', t9.code, 4);

  console.log('— 网络类型（无窗口也要真发出去）');
  const t10 = await run(['run', 'hook', '--args', 'hello', '--wait', '--json']);
  eq('webhook 退出码 0', t10.code, 0);
  ok('结果是 HTTP 200', /HTTP 200/.test(t10.out) || /"ok":true/.test(t10.out), t10.out);
  const t11 = await run(['run', 'dl', '--wait', '--json']);
  eq('download 退出码 0', t11.code, 0);
  let got = null;
  try { got = fs.readFileSync(dlFile); } catch (e) {}
  ok('文件已落盘', !!got, 'file=' + dlFile);
  ok('256 字节逐字节一致', !!got && got.length === 256 && got.equals(BINARY),
    'len=' + (got ? got.length : -1));

  console.log('— 单实例');
  const t12 = await run([]);                       // 双击 run.bat 的效果
  eq('无参数启动退出码 0', t12.code, 0);
  eq('仍然只有一个实例', await instancePid(), pid1);

  const both = await Promise.all([
    run(['run', 'marker', '--wait']),
    run(['run', 'marker2', '--wait'])
  ]);
  eq('并发两个客户端都成功', both.map(x => x.code), [0, 0]);
  eq('并发之后还是一个实例', await instancePid(), pid1);

  /* 可见性必须从冷状态重测。上面「单实例」那段最后一步是 `run([])`，
     它的语义就是唤醒窗口 —— 那一跑窗口早就露出来了，再断言"不露窗"必然失败。
     所以先杀掉实例，再分别冷启动 run / list / search 各看一眼。 */
  console.log('— 窗口可见性');
  killInstances(await instancePid());
  await new Promise(r => setTimeout(r, 800));
  eq('清掉实例，从冷状态重测', await instancePid(), 0);

  clearMark();
  eq('冷启动 run 照样执行', (await run(['run', 'marker', '--wait'])).code, 0);
  await sleep(400);
  eq('run 不露窗', (await probeState()).visible, 0);

  eq('冷启动 list 退出码 0', (await run(['list', '标记', '--json'])).code, 0);
  await sleep(300);
  eq('list 不露窗', (await probeState()).visible, 0);

  await run(['标记']);                          // search 模式：应该把窗口露出来
  await sleep(800);
  eq('search 会把窗口显示出来', (await probeState()).visible, 1);

  console.log('— --ephemeral');
  killInstances(await instancePid());
  await new Promise(r => setTimeout(r, 800));
  eq('实例已被清掉', await instancePid(), 0);
  clearMark();
  const t13 = await run(['run', 'marker', '--ephemeral', '--wait']);
  eq('--ephemeral 退出码 0', t13.code, 0);
  eq('条目执行过', await waitMark('args=[]'), 'args=[]');
  await new Promise(r => setTimeout(r, 800));
  eq('处理完自己退场，没有残留进程', await instancePid(), 0);

  console.log('— 用法');
  const t14 = await run(['--help']);
  eq('--help 退出码 0', t14.code, 0);
  ok('--help 有内容', /ql run/.test(t14.out), t14.out);

  const left = await instancePid();
  killInstances(left);
  server.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})().catch(e => {
  console.error('崩溃：', e);
  process.exit(1);
});
