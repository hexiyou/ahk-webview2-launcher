/* ============================================================
   请求头动态值的端到端验证（真进程 / 真 WebView2 / 真 HTTP 请求）

   tools/hdr-check.js 只验证「函数算得对」，这里验证另一半：
   这些值真的被写进 h.txt、由 webhook.ahk 发到了服务端。

   做法：沙箱副本 + 本地回显服务，config.json 里的 headers 写成
   {{ts}} / {{nonce:12}} / {{hmac:demo:{{ts}}}}，然后看服务端收到什么。

   用法：node tools/hdr-e2e.js
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const DIST = path.join(ROOT, 'dist');
const USE_EXE = process.argv.includes('--exe');   /* 测编译版：dist\QuickLaunch.exe */
const SANDBOX = path.join(os.tmpdir(), 'ql-hdr-e2e', USE_EXE ? 'exe' : 'app');
const SECRET = 'ql-demo-2026-secret';

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '\n         ' + extra : '')); }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    /* 上一轮残留的 .webview2 还被 WebView2 进程锁着，复制必炸 —— 跳过 */
    if (e.name === '.webview2') continue;
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else { try { fs.copyFileSync(a, b); } catch (err) { /* 被占用就跳过 */ } }
  }
}

function prepare(port) {
  try { fs.rmSync(path.join(os.tmpdir(), 'ql-hdr-e2e'), { recursive: true, force: true }); }
  catch (e) {}                       /* 上一轮残留的 .webview2 可能还被占着，覆盖写就行 */
  if (USE_EXE) {
    /* 编译版：整个 dist 搬过来，一次验证「依赖够不够」 */
    copyDir(DIST, SANDBOX);
  } else {
    copyDir(path.join(ROOT, 'ui'), path.join(SANDBOX, 'ui'));
    copyDir(path.join(ROOT, 'lib'), path.join(SANDBOX, 'lib'));
    copyDir(path.join(ROOT, 'runtime'), path.join(SANDBOX, 'runtime'));
    for (const f of ['launcher.ahk', 'webhook.ahk'])
      fs.copyFileSync(path.join(ROOT, f), path.join(SANDBOX, f));
  }

  const cfg = {
    items: [
      {
        id: 'sig-test', name: '签名测试', type: 'webhook', group: 'net',
        target: 'http://127.0.0.1:' + port + '/echo', method: 'GET',
        headers: [
          'X-Ts: {{#ts}}',
          'X-Nonce: {{#nonce:12}}',
          'X-Sign: {{#hmac:demo:{ts}}}',
          'X-Fixed: {{#hmac:demo:hello}}',
          'X-Plain: untouched {{#foo:bar}}',
          'X-Who: {{who}}'
        ],
        /* 声明 params 之后前端会走 fillTemplate —— 正是要确认它不会把
           {{hmac:demo:{{ts}}}} 里的 {{ts}} 当参数替换掉 */
        params: [{ name: 'who', optional: true, default: 'default-who' }],
        timeout: 20
      }
    ]
  };
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  fs.writeFileSync(path.join(SANDBOX, 'launcher.ini'),
    '[General]\nHotkey=\nWidth=820\nHeight=580\nCornerRadius=14\nAlwaysOnTop=0\nHideOnBlur=0\nHideAfterLaunch=0\nShowOnStart=0\nDevTools=0\n', 'utf8');
}

function runCli(args, timeout = 90000) {
  return new Promise(resolve => {
    const p = USE_EXE
      ? spawn(path.join(SANDBOX, 'QuickLaunch.exe'), args, { cwd: SANDBOX, windowsHide: true })
      : spawn(AHK, [path.join(SANDBOX, 'launcher.ahk')].concat(args), { cwd: SANDBOX, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.stderr.on('data', d => { err += d.toString('utf8'); });
    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} }, timeout);
    p.on('close', code => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
  });
}

function main() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });

  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    prepare(port);
    console.log('沙箱：' + SANDBOX + '  回显服务：127.0.0.1:' + port);
    console.log('版本：' + (USE_EXE ? '编译版 dist\\QuickLaunch.exe' : '脚本版 launcher.ahk') + '\n');

    const r1 = await runCli(['run', 'sig-test', '--args', 'alice', '--wait', '--json', '--ephemeral']);
    console.log('第 1 次：' + r1.out);
    if (r1.err) console.log('[stderr] ' + r1.err);

    await new Promise(res => setTimeout(res, 600));
    const r2 = await runCli(['run', 'sig-test', '--args', 'bob', '--wait', '--json', '--ephemeral']);
    console.log('第 2 次：' + r2.out + '\n');

    server.close();

    ok('两次请求都到达服务端', hits.length === 2, '实际 ' + hits.length + ' 次');
    if (!hits.length) { console.log('\n请求头动态值端到端：失败'); process.exit(1); }

    const h = hits[0];
    console.log('服务端收到的头：');
    ['x-ts', 'x-nonce', 'x-sign', 'x-fixed', 'x-plain', 'x-who'].forEach(k => console.log('  ' + k + ' = ' + h[k]));

    console.log('');
    ok('X-Ts 是 10 位时间戳', /^\d{10}$/.test(h['x-ts'] || ''), h['x-ts']);
    ok('X-Nonce 是 12 位', /^[a-z0-9]{12}$/.test(h['x-nonce'] || ''), h['x-nonce']);

    /* 同一行里的 {{ts}} 各自展开，可能差 1 秒，校验时放宽到 ±2 秒 */
    const raw = (h['x-sign'] || '').trim();
    const base = Number(h['x-ts']);
    const near = [-2, -1, 0, 1, 2].map(d =>
      crypto.createHmac('sha256', SECRET).update(String(base + d)).digest('hex'));
    ok('X-Sign 是对应时间戳的 HMAC-SHA256', near.includes(raw), raw);
    ok('X-Fixed 是 hello 的 HMAC', (h['x-fixed'] || '') ===
      crypto.createHmac('sha256', SECRET).update('hello').digest('hex'), h['x-fixed']);
    ok('认不出来的占位符原样发出', h['x-plain'] === 'untouched {{#foo:bar}}', h['x-plain']);
    ok('params 变量与函数式占位符共存', h['x-who'] === 'alice', h['x-who']);

    /* 动态性：两次请求的签名必须不一样（同一秒内也会因 nonce/ts 不同而不同） */
    const h2 = hits[1] || {};
    ok('两次请求的 nonce 不同', h['x-nonce'] !== h2['x-nonce'], h['x-nonce'] + ' / ' + h2['x-nonce']);
    ok('签名随每次请求变化（不是常量）', h['x-sign'] !== h2['x-sign']);

    /* 沙箱里的 .webview2 还被 WebView2 的进程占着，删不掉是常态 —— 不是测试失败。
       下次启动会先 rmSync 一次，删不掉就直接覆盖写。 */
    try { fs.rmSync(path.join(os.tmpdir(), 'ql-hdr-e2e'), { recursive: true, force: true }); }
    catch (e) { console.log('（沙箱目录没删掉：' + e.code + '，不影响结论）'); }
    console.log('\n' + (fail ? '请求头动态值端到端：失败 ' + fail + ' 项' : '请求头动态值端到端：全部通过'));
    process.exit(fail ? 1 : 0);
  });
}

main();
