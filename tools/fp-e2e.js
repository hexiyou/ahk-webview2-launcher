/* ============================================================
   设备指纹的端到端验证（真进程 / 真 WebView2 / 真 HTTP 请求）

   tests/finger.test.js 验的是「算法本身」—— 同一份信号进来，出去的是不是同一个值。
   这里验另一半，也是单测永远覆盖不到的：

     · {{#machine}} 真的由 AHK 在**发送前**展开（它走的是 HdrExpand，不是页面模板）
     · {{@fp}} 真的由页面算出来（走 fillTemplate，用 WebView2 里真实的 navigator）
     · 两者出现在同一个请求里时互不干扰
     · 机器码与命令行 --machine 的输出一致（同一份缓存）
     · {{#machine}} 能嵌套进 hmac（单花括号 {machine} 那条路）

   用法：node tools/fp-e2e.js（会短暂起一个真实窗口，跑完自己关）
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const SANDBOX = path.join(os.tmpdir(), 'ql-fp-e2e', 'app');

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

/* ---------------- 本地回显服务 ---------------- */
const got = {};                       /* path → { body, headers } */
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    got[req.url] = { body: Buffer.concat(chunks).toString('utf8'), headers: req.headers };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

function prep(port) {
  fs.rmSync(path.join(os.tmpdir(), 'ql-fp-e2e'), { recursive: true, force: true });
  fs.mkdirSync(path.join(SANDBOX, 'runtime'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'launcher.ahk'), path.join(SANDBOX, 'launcher.ahk'));
  fs.copyFileSync(AHK, path.join(SANDBOX, 'runtime', 'AutoHotkey64.exe'));
  copyDir(path.join(ROOT, 'ui'), path.join(SANDBOX, 'ui'));
  copyDir(path.join(ROOT, 'lib'), path.join(SANDBOX, 'lib'));
  fs.writeFileSync(path.join(SANDBOX, 'launcher.ini'),
    '[General]\r\nHotkey=^!F9\r\nWidth=820\r\nHeight=580\r\nCornerRadius=14\r\n'
    + 'AlwaysOnTop=1\r\nHideOnBlur=0\r\nHideAfterLaunch=1\r\nShowOnStart=0\r\nDevTools=0\r\n');

  const base = 'http://127.0.0.1:' + port;
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
    name: 'QL Fingerprint Check', version: 1,
    groups: [{ id: 't', name: '测试' }],
    items: [
      /* 两套指纹一次拿全：身体里放页面算的（{{@fp}}），头里放 AHK 算的（{{#machine}}） */
      {
        id: 'all', name: '两套指纹', type: 'webhook', group: 't',
        target: base + '/all', method: 'POST',
        headers: [
          'X-Device: {{#machine}}',
          'X-Mc-Short: {{#machine:short}}',
          /* 机器码参与签名：单花括号是 HdrInline 的嵌套写法 */
          'X-Sig: {{#hmac:demo:{machine}}}'
        ],
        body: {
          machine: '{{#machine}}',
          fp: '{{@fp}}',
          bound: '{{@fp.bound}}',
          short: '{{@fp.short}}',
          parts: '{{@fp.parts}}'
        }
      },
      /* 再发一次，验「同一台机器两次请求值不变」 */
      {
        id: 'again', name: '再发一次', type: 'webhook', group: 't',
        target: base + '/again', method: 'POST',
        body: { machine: '{{#machine}}', fp: '{{@fp}}' }
      },
      /* 拼错的内置变量：必须在发请求之前被拦下 */
      {
        id: 'typo', name: '拼错', type: 'webhook', group: 't',
        target: base + '/typo', method: 'POST',
        body: { fp: '{{@fnger}}' }
      }
    ]
  }, null, 2), 'utf8');
}

const MC_RE = /^MC1-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/;
const FP_RE = /^FP1-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/;
const FPB_RE = /^FPB1-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/;

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  prep(server.address().port);

  /* 先跑 --machine 拿权威值：后面比对，同时把 machine.ini 的缓存热起来 */
  console.log('— 命令行的机器码');
  let m = await run(['--machine']);
  let mc = null;
  try { mc = JSON.parse(m.out); } catch (e) {}
  ok('--machine 打出 JSON', mc && mc.ok === 1, m.out || m.err);
  ok('机器码形状 MC1-4×8', mc && MC_RE.test(mc.code), mc && mc.code);
  ok('来源可追溯（本机是 NVMe，序列号是占位值，应降级到 disk-pnp）',
    mc && /^disk-|^volume-|^guid\+/.test(mc.source), mc && mc.source);

  console.log('— 一次请求里同时带两套');
  let t = await run(['run', 'all', '--wait']);
  ok('请求到了', !!got['/all'], t.out + ' | ' + t.err);
  const h = got['/all'] ? got['/all'].headers : {};
  let b = {};
  try { b = JSON.parse(got['/all'].body); } catch (e) {}

  ok('正文里是合法 JSON', !!got['/all'] && Object.keys(b).length > 0, got['/all'] && got['/all'].body.slice(0, 300));

  eq('body 里的机器码 = 命令行输出', b.machine, mc && mc.code);
  ok('请求头里的机器码也展开了', MC_RE.test(h['x-device'] || ''), h['x-device']);
  eq('头与 body 是同一个值', h['x-device'], b.machine);
  eq('{{#machine:short}} 是前三段', h['x-mc-short'],
    (mc && mc.code || '').split('-').slice(0, 3).join('-'));

  ok('指纹形状 FP1-4×8', FP_RE.test(b.fp || ''), b.fp);
  ok('{{@fp.short}} 是前三段', /^FP1-[0-9a-f]{8}-[0-9a-f]{8}$/.test(b.short || ''), b.short);
  ok('{{@fp.bound}} 带 FPB1 前缀', FPB_RE.test(b.bound || ''), b.bound);
  ok('bound 与 fp 不同（沙箱里有本机盐）', b.bound !== b.fp, b.fp + ' / ' + b.bound);
  ok('明细串里有信号值', /(^|\|)os=[^|]+/.test(b.parts || '') && /cores=/.test(b.parts || ''), b.parts);
  ok('明细里没有 {{#（不会被 HdrExpand 误伤）', (b.parts || '').indexOf('{{#') < 0);

  ok('hmac 用上了机器码（64 位十六进制）',
    /^[0-9a-f]{64}$/.test(h['x-sig'] || '') && h['x-sig'] !== '0'.repeat(64), h['x-sig']);

  console.log('— 第二次请求：同一台机器必须给出同一个值');
  t = await run(['run', 'again', '--wait']);
  ok('请求到了', !!got['/again'], t.out);
  let b2 = {};
  try { b2 = JSON.parse(got['/again'].body); } catch (e) {}
  eq('机器码不变', b2.machine, b.machine);
  eq('指纹不变', b2.fp, b.fp);

  console.log('— 拼错的指纹变量要拦在发请求之前');
  t = await run(['run', 'typo', '--wait']);
  ok('一个请求都没发', !got['/typo']);
  ok('报的是模板问题', /不认识|模板|config/.test(t.out + t.err), t.out + ' | ' + t.err);

  server.close();
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
