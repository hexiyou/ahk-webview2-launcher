/* ============================================================
   download / 拉取在线配置 真机实测
   ------------------------------------------------------------
   把 launcher.ahk 原样复制一份，注入 tools/dl-probe.ahk 里的检查逻辑，
   用真 AutoHotkey 跑一遍完整链路（含 webhook.ahk 子进程写盘）。

   用法：node tools/dl-check.js
   说明：本地起一个临时 HTTP 服务提供测试文件，跑完自动关；测试文件落在
        %TEMP%\ql-dl-test，不碰仓库里的任何真实文件。
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const GEN = path.join(ROOT, '_launcher_dl.ahk');
const LOG = path.join(ROOT, '_dl.log');
const DATA_DIR = path.join(os.tmpdir(), 'ql-dl-webview2');
const OUT = path.join(os.tmpdir(), 'ql-dl-test');
const PORT = 18082;

/* 源文件：包含全部 256 种字节值 + 中文，任何"按文本读"的实现都会把它弄坏 */
const PAYLOAD = Buffer.concat([
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  Buffer.from('二进制测试 PNG头', 'utf8'),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
]);
const PAYLOAD2 = Buffer.from('第二个版本的内容 second revision', 'utf8');
const REMOTE_CFG = '{"items":[],"remote":1}';

function build() {
  let src = fs.readFileSync(path.join(ROOT, 'launcher.ahk'), 'utf8');
  src = src.replace('#SingleInstance Force', '#SingleInstance Off');
  src = src.replace(/global DATA_DIR\s*:=.*/, "global DATA_DIR   := '" + DATA_DIR.replace(/\\/g, '\\\\') + "'");

  /* 别真的把仓库里的 config.json 换掉：测试用的 CFG_PATH 在 %TEMP% 下 */
  const anchor = 'RegisterHotkey(settings.hotkey)';
  if (!src.includes(anchor)) throw new Error('找不到注入点：' + anchor);
  src = src.replace(anchor, anchor + '\n\nSetTimer(DL_Probe, -600)');

  const probe = fs.readFileSync(path.join(__dirname, 'dl-probe.ahk'), 'utf8');
  fs.writeFileSync(GEN, src + '\n' + probe, 'utf8');
}

function serve() {
  return http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/file.bin') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': PAYLOAD.length,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent('远程 文件.bin')
      });
      return res.end(PAYLOAD);
    }
    if (url === '/plain.bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': PAYLOAD.length });
      return res.end(PAYLOAD);
    }
    if (url === '/file2.bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': PAYLOAD2.length });
      return res.end(PAYLOAD2);
    }
    if (url === '/config.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(REMOTE_CFG);
    }
    if (url === '/needtoken') {
      if ((req.headers['x-token'] || '') !== 'abc') {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('forbidden');
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': PAYLOAD2.length });
      return res.end(PAYLOAD2);
    }
    if (url === '/bad-config') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><html><body>请先登录</body></html>');
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
}

function runAhk() {
  return new Promise(resolve => {
    const p = spawn(AHK, ['/ErrorStdOut', '/force', GEN], {
      cwd: ROOT,
      timeout: 90000,
      env: Object.assign({}, process.env, { QL_DL_BASE: 'http://127.0.0.1:' + PORT })
    });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', code => resolve({ code, err }));
  });
}

const eq = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b;

async function main() {
  build();
  try { fs.unlinkSync(LOG); } catch (e) {}

  const srv = serve();
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));

  const t0 = Date.now();
  const r = await runAhk();
  srv.close();

  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '(没有生成 _dl.log)';
  process.stdout.write(log + '\n');
  if (r.err.trim()) console.log('[AHK stderr]\n' + r.err.trim());

  /* ---------------- 逐项核对 ---------------- */
  const checks = [];
  const read = f => { try { return fs.readFileSync(path.join(OUT, f)); } catch (e) { return null; } };
  const has = f => fs.existsSync(path.join(OUT, f));

  checks.push(['T1 Content-Disposition 文件名生效', has('远程 文件.bin')]);
  checks.push(['T1 二进制逐字节一致', eq(read('远程 文件.bin'), PAYLOAD)]);
  checks.push(['T2 无 CD 时用 URL 最后一段', has('plain.bin') && eq(read('plain.bin'), PAYLOAD)]);
  checks.push(['T3 skip 时未覆盖原文件', eq(read('skip.bin'), PAYLOAD)]);
  checks.push(['T4 overwrite 后是新内容', eq(read('over.bin'), PAYLOAD2)]);
  checks.push(['T4 备份的是旧内容', eq(read('over.bin.bak'), PAYLOAD)]);
  checks.push(['T5 404 不落盘', !has('nope.bin')]);
  checks.push(['T6 %TEMP% 展开且自动建多级目录',
    fs.existsSync(path.join(OUT, 'env', 'deep', 'plain.bin'))]);
  checks.push(['T7 非法字符被清洗', has('a_b_.bin')]);
  checks.push(['T8 配置被替换成远端内容',
    fs.existsSync(path.join(OUT, 'config.local.json')) &&
    fs.readFileSync(path.join(OUT, 'config.local.json'), 'utf8').includes('"remote":1')]);
  checks.push(['T8 本地配置留了 .bak',
    fs.existsSync(path.join(OUT, 'config.local.json.bak')) &&
    fs.readFileSync(path.join(OUT, 'config.local.json.bak'), 'utf8').includes('"local":1')]);
  checks.push(['T9 HTML 错误页没覆盖配置',
    fs.readFileSync(path.join(OUT, 'config.local.json'), 'utf8').includes('"remote":1')]);
  checks.push(['T11 自定义请求头生效', eq(read('token.bin'), PAYLOAD2)]);
  checks.push(['T12 缺请求头时 403 不落盘', !has('token2.bin')]);

  let bad = 0;
  checks.forEach(([name, ok]) => {
    if (!ok) bad++;
    console.log((ok ? '  ✅ ' : '  ❌ ') + name);
  });

  console.log('\n退出码 ' + r.code + ' · 耗时 ' + Math.round((Date.now() - t0) / 1000) + 's · ' +
    (checks.length - bad) + '/' + checks.length + ' 项通过');
  process.exit(bad ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
