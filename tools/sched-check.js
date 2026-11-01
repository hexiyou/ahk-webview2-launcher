/* ============================================================
   定时调度的真进程检查

   把 launcher.ahk + ui + lib + runtime 复制到临时目录，配一份专用 config.json
   （条目只指向本工具自己的 mark.ahk，绝不碰用户真实配置），然后真的跑起来等它
   按时刻触发，验证：
     · at（精确到秒）与 every 两条任务各执行一次
     · 写错的条目只跳过自己，并在 sched.log 里说清原因
     · enabled:false 的任务不装
     · 调度执行不弹窗、不写结果面板、不计入使用频率
     · 配置里没有 schedules 时，一条任务都不装，连 sched.log 都不产生

   用法：node tools/sched-check.js
   注意：大约要跑 1 分钟（在等真实的时间点）。
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const BASE = path.join(os.tmpdir(), 'ql-sched-check');
const SANDBOX = path.join(BASE, 'app');
const PROBE = path.join(SANDBOX, 'probe.ahk');
const PROBE_LOG = path.join(SANDBOX, 'probe.log');
const MARK = path.join(SANDBOX, 'mark.log');
const SCHED_LOG = path.join(SANDBOX, 'sched.log');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '\n         ' + extra : '')); }
}
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  ok(label, a === b, 'got  ' + a + '\n         want ' + b);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 本地 HTTP 服务：验证"定时跑 webhook"这条最典型的用法（不联网） */
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

function read(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { return ''; }
}
function drop(p) { try { fs.unlinkSync(p); } catch (e) {} }

/* "HH:MM:SS" → 当天的秒数，用来核对触发精度 */
function secOfDay(hms) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(hms).trim());
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : NaN;
}
function hmsNow(offsetSec) {
  const d = new Date(Date.now() + (offsetSec || 0) * 1000);
  const p = n => ('0' + n).slice(-2);
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ---------------- 沙箱 ---------------- */

function prep() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(SANDBOX, 'runtime'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'launcher.ahk'), path.join(SANDBOX, 'launcher.ahk'));
  fs.copyFileSync(AHK, path.join(SANDBOX, 'runtime', 'AutoHotkey64.exe'));
  copyDir(path.join(ROOT, 'ui'), path.join(SANDBOX, 'ui'));
  copyDir(path.join(ROOT, 'lib'), path.join(SANDBOX, 'lib'));
  try { fs.copyFileSync(path.join(ROOT, 'pinyin.txt'), path.join(SANDBOX, 'pinyin.txt')); } catch (e) {}

  fs.writeFileSync(path.join(SANDBOX, 'launcher.ini'),
    '[General]\r\nHotkey=^!F8\r\nWidth=820\r\nHeight=580\r\nCornerRadius=14\r\n'
    + 'AlwaysOnTop=1\r\nHideOnBlur=0\r\nHideAfterLaunch=1\r\nShowOnStart=0\r\nDevTools=0\r\n');

  /* 被调度的条目：把自己的参数和触发时刻写一行，事后核对 */
  fs.writeFileSync(path.join(SANDBOX, 'mark.ahk'), [
    '#Requires AutoHotkey v2.0',
    "line := ''",
    'for a in A_Args',
    "    line .= a '|'",
    "FileAppend(FormatTime(A_Now, 'HH:mm:ss') ' ' line '`n', A_ScriptDir '\\mark.log', 'UTF-8')",
    'ExitApp(0)'
  ].join('\r\n') + '\r\n');

  /* 只看「属于这个进程」的 QuickLaunch 窗口：本机可能还开着用户自己的实例，
     按标题找会找到别人家的窗口，结论就不可信了 */
  fs.writeFileSync(PROBE, [
    '#Requires AutoHotkey v2.0',
    'SetTitleMatchMode(3)',
    /* 窗口平时是藏着的，不开这个开关 WinExist 根本看不见它（会误判成"没有窗口"） */
    'DetectHiddenWindows(true)',
    'pid := A_Args.Length ? Integer(A_Args[1]) : 0',
    "mw := pid ? WinExist('QuickLaunch ahk_pid ' pid) : 0",
    "vis := mw ? DllCall('user32\\IsWindowVisible', 'ptr', mw) : -1",
    'alive := pid ? ProcessExist(pid) : 0',
    "FileAppend('alive=' alive ' visible=' vis '`n', A_ScriptDir '\\probe.log', 'UTF-8')",
    'ExitApp(0)'
  ].join('\r\n') + '\r\n');
}

/* 换成要跑的配置。atSec = 从"现在"起多少秒后触发那条 at 任务 */
function writeConfig(withSchedules) {
  const base = 'http://127.0.0.1:' + server.address().port;
  const cfg = {
    name: 'QL Sched Check', version: 1,
    groups: [{ id: 't', name: '测试' }],
    items: [
      { id: 'marker', name: '标记', subtitle: '写一行日志', type: 'ahk', target: 'mark.ahk', group: 't', pinned: true },
      /* hidden:true 只影响界面，定时器必须照旧能调到它 —— 这正是 hidden 的
         典型用法（后台维护任务：平时不想在搜索框里看见，但每天要跑） */
      { id: 'quiet', name: '静默后台任务', type: 'ahk', target: 'mark.ahk', group: 't', hidden: true },
      { id: 'hook', name: '测试请求', type: 'webhook', target: base + '/ping', group: 't' }
    ]
  };
  if (withSchedules) {
    cfg.schedules = [
      { id: 'at-task', run: 'marker', args: 'from-at', at: AT_TIME },
      { id: 'every-task', run: 'marker', args: 'from-every', every: '30s' },
      /* runOnStart：不等排程，启动后应该马上跑一次。every 故意放长到 10 分钟，
         这样"启动跑一次"和"到点再跑"在观察窗口里不会混在一起 */
      { id: 'boot-task', run: 'marker', args: 'from-boot', every: '10m', runOnStart: true },
      /* hidden 条目 + 启动即跑：一次就够，既能证明"定时器找得到它"，
         又不会在观察窗口里反复触发把行数搅乱 */
      { id: 'hidden-task', run: 'quiet', args: 'from-quiet', every: '10m', runOnStart: true },
      { id: 'hook-task', run: 'hook', every: '30s' },
      { id: 'bad-at', run: 'marker', at: '99:99' },
      { id: 'both', run: 'marker', at: '09:00', every: '1h' },
      { id: 'no-run', at: '09:00' },
      { id: 'off', run: 'marker', args: 'from-off', every: '30s', enabled: false }
    ];
  }
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
}

/* ---------------- 进程 ---------------- */

let child = null;

function start() {
  /* --hide：常驻实例，但不显示窗口（等价于在后台跑着） */
  child = spawn(AHK, [path.join(SANDBOX, 'launcher.ahk'), '--hide'],
    { cwd: SANDBOX, windowsHide: true, stdio: 'ignore' });
  return child.pid;
}

async function stop() {
  if (!child) return;
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true }); } catch (e) {}
  child = null;
  await sleep(800);
}

function probe(pid) {
  drop(PROBE_LOG);
  spawnSync(AHK, [PROBE, String(pid)], { cwd: SANDBOX, windowsHide: true, timeout: 20000 });
  const t = read(PROBE_LOG);
  const v = /visible=(-?\d+)/.exec(t);
  const a = /alive=(\d+)/.exec(t);
  return { visible: v ? Number(v[1]) : -2, alive: a ? Number(a[1]) : 0 };
}

/* ---------------- 主流程 ---------------- */

const AT_OFFSET = 25;              /* at 任务定在 25 秒后，给页面启动留足余量 */
let AT_TIME = '';

async function phaseWithSchedules() {
  console.log('— 装了定时任务：真的会到点执行吗');
  AT_TIME = hmsNow(AT_OFFSET);
  writeConfig(true);
  drop(MARK); drop(SCHED_LOG);
  const pid = start();

  /* runOnStart 先单独等：它不该等 30 秒那趟排程，启动后一两秒就该出一行。
     这也是它和普通 every 任务唯一的区别，所以要卡"早"这个特征。 */
  const tb = Date.now();
  let bootSeen = '';
  while (Date.now() - tb < 12000) {
    bootSeen = read(MARK);
    if (/from-boot/.test(bootSeen)) break;
    await sleep(200);
  }
  const bootMs = Date.now() - tb;
  ok('runOnStart 在启动后立刻执行', /from-boot/.test(bootSeen), bootSeen.slice(0, 200));
  ok('比第一次排程（30s）早得多', bootMs < 12000, bootMs + 'ms');

  /* 等四条任务都跑完：every 是安装后 30 秒，at 是开机后 25 秒 */
  const t0 = Date.now();
  let lines = [];
  while (Date.now() - t0 < 75000) {
    lines = read(MARK).split('\n').filter(x => x.trim());
    if (lines.length >= 4) break;
    await sleep(500);
  }

  const marks = lines.join('\n');
  ok('at 任务执行了', /from-at/.test(marks), 'mark.log:\n' + marks);
  ok('every 任务执行了', /from-every/.test(marks), 'mark.log:\n' + marks);
  ok('runOnStart 任务执行了', /from-boot/.test(marks), 'mark.log:\n' + marks);
  ok('hidden 条目照样被定时器执行了', /from-quiet/.test(marks), 'mark.log:\n' + marks);
  ok('enabled:false 的任务没执行', !/from-off/.test(marks), 'mark.log:\n' + marks);
  ok('只跑了四次（runOnStart 没有重复触发）', lines.length === 4, '实际 ' + lines.length + ' 行：\n' + marks);
  ok('runOnStart 只跑了一次', lines.filter(x => /from-boot/.test(x)).length === 1, marks);

  /* 精度：mark 里记的触发时刻 vs 目标时刻 */
  const atLine = lines.find(x => /from-at/.test(x)) || '';
  const atFired = secOfDay((atLine.split(' ')[0] || '').trim());
  const atWant = secOfDay(AT_TIME);
  ok('at 到点误差 ≤ 2 秒',
    Math.abs(atFired - atWant) <= 2,
    '目标 ' + AT_TIME + '，实际 ' + (atLine.split(' ')[0] || '?'));

  /* 定时跑 webhook：这是最典型的用法，确认请求真的发出去了、结果进了日志 */
  const t1 = Date.now();
  while (hits < 1 && Date.now() - t1 < 25000) await sleep(300);
  ok('定时触发的 webhook 真的发出去了', hits >= 1, '服务端命中 ' + hits + ' 次');

  /* 服务端命中只说明请求到了，日志是在响应回来、页面回执之后才写的。
     这里必须轮询等那一行，不能读一次就断言 —— 差几百毫秒就会假失败。 */
  const t2 = Date.now();
  let log = read(SCHED_LOG);
  while (!/ok\s+hook-task\s+HTTP 200/.test(log) && Date.now() - t2 < 15000) {
    await sleep(300);
    log = read(SCHED_LOG);
  }
  ok('webhook 的结果摘要写进了日志', /ok\s+hook-task\s+HTTP 200/.test(log), log);
  ok('sched.log 有安装记录', /plan\s+at-task/.test(log) && /plan\s+every-task/.test(log), log);
  /* 描述里的时刻是 "HH:MM"（整分时省掉秒），所以两种形式都得认 */
  const atText = AT_TIME.endsWith(':00') ? AT_TIME.slice(0, 5) : AT_TIME;
  ok('at 任务的描述带上了目标时刻', /plan\s+at-task[^\n]*/.test(log)
    && log.split('\n').some(l => /plan\s+at-task/.test(l) && l.indexOf(atText) > 0), log);
  ok('执行成功记了 ok', /ok\s+at-task/.test(log) && /ok\s+every-task/.test(log), log);
  ok('日志里有实际命中的条目名', /已启动：标记/.test(log), log);

  ok('写错的 at 被跳过', /bad\s+bad-at.*at 写法不对/.test(log), log);
  ok('at/every 同时写被跳过', /bad\s+both.*只能写一个/.test(log), log);
  ok('缺 run 被跳过', /bad\s+no-run.*缺少 run/.test(log), log);
  ok('停用的任务不出现在日志里', !/\boff\b/.test(log), log);
  /* runOnStart 那次在日志里单独记一行 boot，和按时刻触发的 ok 区分开 */
  ok('runOnStart 在日志里记成 boot', /boot\s+boot-task/.test(log), log);
  /* hidden 条目被排程调起来时，日志里该有它的名字 —— 界面藏了，日志不藏 */
  ok('hidden 任务的执行记了日志', /ok\s+hidden-task[^\n]*静默后台任务/.test(log),
    log.split('\n').filter(l => /hidden-task/.test(l)).join('\n') || log);

  /* 不显示窗口 */
  const st = probe(pid);
  ok('进程还活着', st.alive !== 0, 'probe=' + JSON.stringify(st));
  eq('调度全程没有把窗口弹出来', st.visible, 0);

  /* 不计使用频率：usage.json 里不该留下 marker */
  const usage = read(path.join(SANDBOX, 'usage.json'));
  ok('调度不计入使用频率', !/marker/.test(usage), 'usage.json = ' + (usage || '(没有这个文件)'));

  await stop();
}

async function phaseWithoutSchedules() {
  console.log('— 没配 schedules：应当和以前完全一样');
  writeConfig(false);
  drop(MARK); drop(SCHED_LOG); drop(path.join(SANDBOX, 'usage.json'));
  const pid = start();
  await sleep(9000);

  ok('没有产生 mark.log', !fs.existsSync(MARK), read(MARK));
  ok('没有产生 sched.log', !fs.existsSync(SCHED_LOG), read(SCHED_LOG));
  const st = probe(pid);
  ok('进程正常常驻', st.alive !== 0, 'probe=' + JSON.stringify(st));
  eq('窗口仍然是藏着的', st.visible, 0);

  await stop();
}

(async () => {
  if (!fs.existsSync(AHK)) {
    console.log('找不到 ' + AHK);
    process.exit(1);
  }
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  prep();
  try {
    await phaseWithSchedules();
    await phaseWithoutSchedules();
  } finally {
    await stop();
    server.close();
  }
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
