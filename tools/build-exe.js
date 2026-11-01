/* ============================================================
   把 launcher.ahk 编译成 QuickLaunch.exe，并按「能直接跑」组装 dist 目录

   为什么需要这一步：SIG_KEYS（请求头签名密钥）在 launcher.ahk 里，
   编译后不再是明文文本；config.json 只留 {{hmac:demo:...}} 这样的引用。
   HTML/JS/CSS 仍然是外部文件（方便改界面，不用每次重编译）。

   用法：
     node tools/build-exe.js             编译并组装 dist\
     node tools/build-exe.js --out D:\x  指定输出目录

   Ahk2Exe 从哪来（按顺序找）：
     1. 环境变量 AHK2EXE
     2. tools\Ahk2Exe.exe
     3. %ProgramFiles%\AutoHotkey\Compiler\Ahk2Exe.exe
     4. %LOCALAPPDATA%\Programs\AutoHotkey\Compiler\Ahk2Exe.exe
   下载：https://github.com/AutoHotkey/Ahk2Exe/releases
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const OUT = path.resolve(arg('--out', path.join(ROOT, 'dist')));
const EXE = path.join(OUT, 'QuickLaunch.exe');

function findCompiler() {
  const cands = [
    process.env.AHK2EXE,
    path.join(ROOT, 'tools', 'Ahk2Exe.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'AutoHotkey', 'Compiler', 'Ahk2Exe.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'AutoHotkey', 'Compiler', 'Ahk2Exe.exe')
  ].filter(Boolean);
  for (const c of cands)
    if (fs.existsSync(c)) return c;
  return '';
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

function main() {
  const compiler = findCompiler();
  if (!compiler) {
    console.error('找不到 Ahk2Exe.exe。装一个或设环境变量 AHK2EXE 指向它：');
    console.error('  https://github.com/AutoHotkey/Ahk2Exe/releases');
    process.exit(2);
  }
  if (!fs.existsSync(BASE)) {
    console.error('找不到 base 文件：' + BASE + '（脚本版用的那个 runtime\\AutoHotkey64.exe）');
    process.exit(2);
  }

  fs.mkdirSync(OUT, { recursive: true });
  /* 正在运行的 exe 会被锁，写不进去 —— 先说清楚，别让人对着 EPERM 猜 */
  if (fs.existsSync(EXE)) {
    try { fs.renameSync(EXE, EXE + '.old'); fs.unlinkSync(EXE + '.old'); }
    catch (e) {
      console.error('输出文件被占用：' + EXE);
      console.error('先把正在运行的启动器退掉（托盘 → 退出软件），再编译。');
      process.exit(3);
    }
  }

  console.log('编译器：' + compiler);
  console.log('base  ：' + BASE);
  console.log('输出  ：' + EXE);

  /* 不加 /silent：silent 模式在这套参数下会莫名返回 3 且不产出文件（实测）。
     出错时会弹一个模态框，所以带超时，超时就当失败。 */
  const r = spawnSync(compiler, [
    '/in', path.join(ROOT, 'launcher.ahk'),
    '/out', EXE,
    '/base', BASE
  ], { timeout: 180000, encoding: 'utf8' });

  if ((r.stderr || '').trim()) console.log('[stderr] ' + r.stderr.trim());
  if (!fs.existsSync(EXE)) {
    console.error('编译失败（很可能弹了个错误框）。用 Ahk2Exe 的图形界面打开 launcher.ahk 看具体报错。');
    process.exit(4);
  }
  console.log('编译产物：' + (fs.statSync(EXE).size / 1024).toFixed(0) + ' KB');

  /* ---- 组装运行目录 ----
     ui 必须外置（改界面不用重编译）；lib 只要 WebView2Loader.dll
     （WebView2.ahk / ComVar.ahk / Promise.ahk 已经编进 exe 了）。
     runtime 解释器是为了 webhook / download / ahk 类型 —— 见 AhkInterp()。 */
  copyDir(path.join(ROOT, 'ui'), path.join(OUT, 'ui'));
  fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'lib', 'WebView2Loader.dll'),
    path.join(OUT, 'lib', 'WebView2Loader.dll'));
  fs.mkdirSync(path.join(OUT, 'runtime'), { recursive: true });
  fs.copyFileSync(BASE, path.join(OUT, 'runtime', 'AutoHotkey64.exe'));
  fs.copyFileSync(path.join(ROOT, 'webhook.ahk'), path.join(OUT, 'webhook.ahk'));
  /* 两个入口脚本：它们会自己判断「同目录有没有 QuickLaunch.exe」 */
  for (const f of ['ql.cmd', 'run.bat'])
    fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));

  /* 配置只在第一次生成，之后重编译不动它 —— 别把用户改过的条目冲掉 */
  for (const f of ['config.json', 'launcher.ini']) {
    const dst = path.join(OUT, f);
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(path.join(ROOT, f), dst);
      console.log('初始配置：' + f);
    } else {
      console.log('保留已有：' + f);
    }
  }

  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push([path.relative(OUT, p), fs.statSync(p).size]);
    }
  })(OUT);
  const total = files.reduce((a, f) => a + f[1], 0);
  console.log('\ndist 内容（共 ' + (total / 1024 / 1024).toFixed(2) + ' MB，' + files.length + ' 个文件）：');
  files.sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(f => console.log('  ' + (f[1] / 1024).toFixed(0).padStart(6) + ' KB  ' + f[0]));
  console.log('\n跑起来：' + EXE);
}

main();
