/* ============================================================
   内置模板变量 {{@config}} 的端到端验证（真进程 / 真 WebView2 / 真 HTTP 请求）

   tests/tpl.test.js 验的是「拼出来的字符串对不对」，这里验另一半：
   这段文本真的原样到了服务端 —— 尤其是 AHK 的 HdrExpand 没有把它改掉。
   config.json 里故意写一条 `X-T: {{#ts}}`，这样「配置原文」里就含 {{#…}}，
   如果哨兵没生效，服务端收到的 {{#ts}} 会被展开成一个时间戳。

   用法：node tools/cfg-e2e.js
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const SANDBOX = path.join(os.tmpdir(), 'ql-cfg-e2e', 'app');

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
  fs.rmSync(path.join(os.tmpdir(), 'ql-cfg-e2e'), { recursive: true, force: true });
  fs.mkdirSync(path.join(SANDBOX, 'runtime'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'launcher.ahk'), path.join(SANDBOX, 'launcher.ahk'));
  fs.copyFileSync(AHK, path.join(SANDBOX, 'runtime', 'AutoHotkey64.exe'));
  copyDir(path.join(ROOT, 'ui'), path.join(SANDBOX, 'ui'));
  copyDir(path.join(ROOT, 'lib'), path.join(SANDBOX, 'lib'));
  try { fs.copyFileSync(path.join(ROOT, 'pinyin.txt'), path.join(SANDBOX, 'pinyin.txt')); } catch (e) {}

  fs.writeFileSync(path.join(SANDBOX, 'launcher.ini'),
    '[General]\r\nHotkey=^!F9\r\nWidth=820\r\nHeight=580\r\nCornerRadius=14\r\n'
    + 'AlwaysOnTop=1\r\nHideOnBlur=0\r\nHideAfterLaunch=1\r\nShowOnStart=0\r\nDevTools=0\r\n');

  const base = 'http://127.0.0.1:' + port;
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
    name: 'QL Config-Snapshot Check', version: 1,
    groups: [{ id: 't', name: '测试' }],
    items: [
      /* 这一条的存在就是为了让「配置原文」里带一段 {{#…}}：
         页面注入时它必须被哨兵挡住，否则备份到服务端会变成一个时间戳 */
      {
        id: 'signer', name: '带签名的接口', type: 'webhook', group: 't',
        target: base + '/signer', method: 'GET',
        headers: ['X-T: {{#ts}}']
      },
      /* 对象 body：最推荐的写法，最后会被 JSON.stringify 一次 */
      {
        id: 'obj', name: '对象体', type: 'webhook', group: 't',
        target: base + '/obj', method: 'POST',
        body: { who: 'own', snapshot: '{{@config}}' }
      },
      /* 字符串 body：手写 JSON，内置变量按 JSON 字符串内容给 */
      {
        id: 'str', name: '字符串体', type: 'webhook', group: 't',
        target: base + '/str', method: 'POST',
        body: '{"snapshot":"{{@config}}"}'
      },
      /* 请求头：只有 b64 能安全过（单行 + 纯 ASCII） */
      {
        id: 'b64', name: '头里带快照', type: 'webhook', group: 't',
        target: base + '/b64', method: 'GET',
        headers: ['X-Config: {{@config.b64}}']
      },
      /* 和运行时参数混用，验证两者各走各的 */
      {
        id: 'mix', name: '混合', type: 'webhook', group: 't',
        target: base + '/mix', method: 'POST',
        body: { who: '{{user}}', snapshot: '{{@config}}' },
        params: [{ name: 'user' }]
      },
      /* 拼错：必须在执行前被拦，一个请求都不该发出去 */
      {
        id: 'typo', name: '拼错', type: 'webhook', group: 't',
        target: base + '/typo', method: 'POST',
        body: '{"snapshot":"{{@confg}}"}'
      }
    ]
  }, null, 2), 'utf8');
}

const CFG_PATH = path.join(SANDBOX, 'config.json');
const restore = s => s.split('\uE000{#').join('{{#');

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  prep(server.address().port);
  const raw = fs.readFileSync(CFG_PATH, 'utf8').trim();

  console.log('— 对象 body（推荐写法）');
  let t = await run(['run', 'obj', '--wait']);
  ok('请求到了', !!got['/obj'], t.out);
  if (got['/obj']) {
    let b = null;
    try { b = JSON.parse(got['/obj'].body); } catch (e) {}
    ok('服务端收到的是合法 JSON', b !== null, got['/obj'].body.slice(0, 200));
    eq('快照还原后与磁盘原文一字不差', restore(b && b.snapshot), raw);
    eq('同层的其它字段没被牵连', b && b.who, 'own');
    eq('没用上哨兵（原文已还原）', /\uE000/.test(b && b.snapshot), false);
    eq('配置里的 {{#ts}} 没被展开成时间戳',
      /\{\{#ts\}\}/.test(b && b.snapshot), true);
  }

  console.log('— 字符串 body（手写 JSON）');
  t = await run(['run', 'str', '--wait']);
  ok('请求到了', !!got['/str'], t.out);
  if (got['/str']) {
    let b = null;
    try { b = JSON.parse(got['/str'].body); } catch (e) {}
    ok('服务端收到的是合法 JSON', b !== null, got['/str'].body.slice(0, 200));
    eq('快照还原后与磁盘原文一字不差', restore(b && b.snapshot), raw);
    eq('配置里的 {{#ts}} 没被展开', /\{\{#ts\}\}/.test(b && b.snapshot), true);
  }

  console.log('— 请求头里的 base64');
  t = await run(['run', 'b64', '--wait']);
  ok('请求到了', !!got['/b64'], t.out);
  if (got['/b64']) {
    const v = got['/b64'].headers['x-config'] || '';
    eq('解出来就是磁盘原文',
      Buffer.from(v, 'base64').toString('utf8').trim(), raw);
    ok('头部值全是可见 ASCII', /^[\x20-\x7e]*$/.test(v), JSON.stringify(v.slice(0, 80)));
  }

  console.log('— 和运行时参数混用');
  t = await run(['run', 'mix', '--args', 'alice', '--wait']);
  ok('请求到了', !!got['/mix'], t.out);
  if (got['/mix']) {
    const b = JSON.parse(got['/mix'].body);
    eq('参数照常', b.who, 'alice');
    eq('快照照常', restore(b.snapshot), raw);
  }

  console.log('— 拼错的内置变量要拦在发请求之前');
  t = await run(['run', 'typo', '--wait']);
  ok('一个请求都没发', !got['/typo']);
  ok('命令行报的是配置问题', /config|不认识|模板/.test(t.out + t.err), t.out + ' | ' + t.err);

  server.close();
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
