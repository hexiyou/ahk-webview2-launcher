/* ============================================================
   控制台输出实测：确认"真控制台"下命令能打印出东西

   背景：`ql list` / `ql --help` 在 cmd 窗口里一个字都不打，但所有自动化测试
   都是绿的 —— 因为 spawn 给的 stdout 是**管道**，而管道与真控制台是两种句柄，
   FileAppend(..., '*') 在后者上会失败且被 try 吞掉。

   本脚本把 tools/out-probe.ahk 注入 launcher.ahk 副本，让探针自己 AllocConsole
   造一个真控制台，调用被测的 StdOut()，再把屏幕缓冲区读回来逐字比对。

   用法：node tools/out-check.js
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const GEN = path.join(ROOT, '_launcher_out.ahk');
const LOG = path.join(ROOT, '_out.log');

function build() {
  let src = fs.readFileSync(path.join(ROOT, 'launcher.ahk'), 'utf8');
  src = src.replace('#SingleInstance Force', '#SingleInstance Off');
  /* 换掉单例键：不然会和用户正在跑的实例抢锁，自己变成客户端直接退出 */
  src = src.replace(/global INST_KEY\s*:=.*/, "global INST_KEY   := 'out-run'");
  src = src.replace(/global DATA_DIR\s*:=.*/, "global DATA_DIR   := '" + path.join(os.tmpdir(), 'ql-out-webview2') + "'");

  const anchor = 'RegisterHotkey(settings.hotkey)';
  if (!src.includes(anchor)) throw new Error('找不到注入点：' + anchor);
  src = src.replace(anchor, anchor + '\n\nSetTimer(OutProbe, -400)');

  const probe = fs.readFileSync(path.join(__dirname, 'out-probe.ahk'), 'utf8');
  fs.writeFileSync(GEN, src + '\n' + probe, 'utf8');
}

function main() {
  build();
  try { fs.unlinkSync(LOG); } catch (e) {}

  const r = spawnSync(AHK, ['/ErrorStdOut', '/force', GEN], {
    cwd: ROOT, timeout: 60000, encoding: 'utf8'
  });
  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '(没有生成 _out.log)';
  process.stdout.write(log);
  if ((r.stderr || '').trim())
    console.log('\n[AHK stderr]\n' + r.stderr.trim());

  /* 没跑完（被信号杀掉）也必须算失败，不能用"没有 FAIL 行"冒充通过 */
  const bad = !/RESULT PASS/.test(log) || r.status !== 0;
  if (!log.includes('RESULT PASS') && r.status === 0)
    console.log('\n探针跑完了但没通过 —— 控制台下确实打不出字');
  console.log('\n' + (bad ? '控制台输出：失败' : '控制台输出：通过（中文、ASCII、换行都对）'));
  process.exit(bad ? 1 : 0);
}

main();
