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

function build() {
  let src = fs.readFileSync(path.join(ROOT, 'launcher.ahk'), 'utf8');
  src = src.replace('#SingleInstance Force', '#SingleInstance Off');
  src = src.replace(/global DATA_DIR\s*:=.*/, "global DATA_DIR   := '" + DATA_DIR + "'");

  const anchor = 'RegisterHotkey(settings.hotkey)';
  if (!src.includes(anchor)) throw new Error('找不到注入点：' + anchor);
  src = src.replace(anchor, anchor + '\n\nSetTimer(UNC_Probe, -400)');

  const probe = fs.readFileSync(path.join(__dirname, 'unc-probe.ahk'), 'utf8');
  fs.writeFileSync(GEN, src + '\n' + probe, 'utf8');
}

function main() {
  build();
  try { fs.unlinkSync(LOG); } catch (e) {}

  const r = spawnSync(AHK, ['/ErrorStdOut', '/force', GEN], {
    cwd: ROOT,
    timeout: 25000,
    encoding: 'utf8'
  });

  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '(没有生成 _unc.log)';
  process.stdout.write(log);

  if (r.status !== 0) console.log('[AHK 退出码] ' + r.status + '  signal=' + (r.signal || '-'));
  const stderr = (r.stderr || '').trim();
  if (stderr) console.log('\n[AHK stderr]\n' + stderr);

  const bad = /FAIL|THROW/.test(log);
  console.log('\n' + (bad ? '有异常项，见上面 FAIL/THROW 行' : '全部通过'));
  process.exit(bad ? 1 : 0);
}

main();
