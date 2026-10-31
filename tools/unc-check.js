/* ============================================================
   UNC 路径实测：把 launcher.ahk 原样复制一份，注入 tools/unc-probe.ahk 里的
   检查逻辑，用真 AutoHotkey 跑一遍 Launch / IconForExe / Loop Files，
   结果写进 _unc.log。

   用法：node tools/unc-check.js
   前置：需要有一个可访问的 SMB 共享（脚本里写死 \\localhost\Users\...，
        见 tools/unc-probe.ahk 顶部的 base）。没有共享时跳过即可。
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const GEN = path.join(ROOT, '_launcher_unc.ahk');
const LOG = path.join(ROOT, '_unc.log');
const DATA_DIR = path.join(os.tmpdir(), 'ql-unc-webview2');
/* 夹具目录和 tools/unc-probe.ahk 里的 base 保持一致 */
const UNC_DIR = '\\\\localhost\\Users\\Administrator\\AppData\\Local\\Temp\\unctest';

/* 夹具以前是手工放的，%TEMP% 一被清理，B1/B3/B4/E1 就会集体假失败 */
function prepareFixtures() {
  try {
    fs.mkdirSync(UNC_DIR, { recursive: true });
    const exe = path.join(UNC_DIR, 'cmd2.exe');
    if (!fs.existsSync(exe))
      fs.copyFileSync('C:////Windows////System32////cmd.exe', exe);
    const bat = path.join(UNC_DIR, 'probe.bat');
    if (!fs.existsSync(bat))
      fs.writeFileSync(bat, '@echo off\r\necho PROBE_OK>bat_out.txt\r\ncd>>bat_out.txt\r\n');
    return true;
  } catch (e) {
    console.log('[提示] 准备 UNC 夹具失败（这台机器可能没开 SMB 共享）：' + e.message);
    return false;
  }
}

function build() {
  let src = fs.readFileSync(path.join(ROOT, 'launcher.ahk'), 'utf8');
  src = src.replace('#SingleInstance Force', '#SingleInstance Off');
  /* 换掉单例键，否则会和用户正在跑的实例抢锁，把自己当客户端然后直接退出 */
  src = src.replace(/global INST_KEY\s*:=.*/, "global INST_KEY   := 'unc-run'");
  src = src.replace(/global DATA_DIR\s*:=.*/, "global DATA_DIR   := '" + DATA_DIR + "'");

  const anchor = 'RegisterHotkey(settings.hotkey)';
  if (!src.includes(anchor)) throw new Error('找不到注入点：' + anchor);
  src = src.replace(anchor, anchor + '\n\nSetTimer(UNC_Probe, -400)');

  const probe = fs.readFileSync(path.join(__dirname, 'unc-probe.ahk'), 'utf8');
  fs.writeFileSync(GEN, src + '\n' + probe, 'utf8');
}

function main() {
  prepareFixtures();
  build();
  try { fs.unlinkSync(LOG); } catch (e) {}

  const r = spawnSync(AHK, ['/ErrorStdOut', '/force', GEN], {
    cwd: ROOT,
    /* 25 秒不够：B/D 段每次 Launch 都要等子进程落盘（UWait 最长 6 秒），
       累积起来轻松破 30 秒，超时会被 SIGTERM 打断 —— 而打断时探针还没跑到
       后面几段，日志里自然没有 FAIL，看上去"全绿"，其实一半没测。 */
    timeout: 120000,
    encoding: 'utf8'
  });

  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '(没有生成 _unc.log)';
  process.stdout.write(log);

  const killed = r.status !== 0;
  if (killed) console.log('[AHK 退出码] ' + r.status + '  signal=' + (r.signal || '-'));
  const stderr = (r.stderr || '').trim();
  if (stderr) console.log('\n[AHK stderr]\n' + stderr);

  /* 被超时打断也必须算失败：日志不全 = 没测完，不能用"没有 FAIL 行"冒充通过 */
  const bad = /FAIL|THROW/.test(log) || killed;
  if (bad)
    console.log('\n' + (killed ? '没跑完（进程被中断，日志不完整）' : '有异常项，见上面 FAIL/THROW 行'));
  else
    console.log('\n全部通过');
  process.exit(bad ? 1 : 0);
}

main();
