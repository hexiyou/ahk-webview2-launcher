/* ============================================================
   multipart 上传 + 模板读文件的端到端验证（真进程 / 真 WebView2 / 真 HTTP）

   tools/hdr-check.js 只验证「函数算得对」（文本、base64、摘要），
   这里验证另一半：这些值真的拼进了请求体、由 --webhook 子进程发出去，
   以及 multipart 的字节流有没有在某个环节被字符集转换弄坏。

   做法：沙箱副本 + 本地回显服务，服务端把收到的原始字节全存下来，
   再和磁盘上的 fixture 逐字节比对 —— 只比长度是不够的，损坏的 PNG
   长度可能一模一样。

   用法：node tools/mp-e2e.js
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const SANDBOX = path.join(os.tmpdir(), 'ql-mp-e2e');
const FIX = path.join(SANDBOX, 'fixtures');

/* 1x1 透明 PNG。用真 PNG 而不是随便几个字节：服务端/中间层若按魔数识别，
   坏掉的包会更早暴露；而且它有 0x89 和 0x0A，正好能撞出换行/编码类的问题 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64');
const JSON_BODY = Buffer.from(JSON.stringify({
  title: '夜间备份', count: 3, tags: ['中文', 'nightly'], nested: { ok: true }
}, null, 2) + '\n', 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '\n         ' + extra : '')); }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.webview2') continue;      /* 被 WebView2 进程锁着，复制必炸 */
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else { try { fs.copyFileSync(a, b); } catch (err) { /* 被占用就跳过 */ } }
  }
}

function prepare(port) {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  copyDir(path.join(ROOT, 'ui'), path.join(SANDBOX, 'ui'));
  copyDir(path.join(ROOT, 'lib'), path.join(SANDBOX, 'lib'));
  copyDir(path.join(ROOT, 'runtime'), path.join(SANDBOX, 'runtime'));
  fs.copyFileSync(path.join(ROOT, 'launcher.ahk'), path.join(SANDBOX, 'launcher.ahk'));

  fs.mkdirSync(FIX, { recursive: true });
  fs.writeFileSync(path.join(FIX, 'pixel.png'), PNG);
  fs.writeFileSync(path.join(FIX, 'data.json'), JSON_BODY);
  fs.writeFileSync(path.join(FIX, 'note.txt'), '上传备注：来自本地文件\n第二行\n', 'utf8');
  fs.writeFileSync(path.join(FIX, 'token.txt'), 'tok-abc-123\n', 'utf8');

  const U = 'http://127.0.0.1:' + port;
  const P = (f) => path.join(FIX, f);

  const cfg = {
    items: [
      {
        id: 'mp-one', name: '传一个文件', type: 'webhook', group: 'net',
        target: U + '/up', method: 'POST', timeout: 20,
        multipart: {
          fields: { note: '中文备注 {{who}}', plain: 'no-template' },
          files: [{ field: 'photo', path: P('pixel.png') }]
        },
        params: [{ name: 'who', default: '默认人' }]
      },
      {
        id: 'mp-two', name: '传两个文件', type: 'webhook', group: 'net',
        target: U + '/up2', method: 'POST', timeout: 20,
        multipart: {
          files: [
            { field: 'json', path: P('data.json'), type: 'application/json' },
            { field: 'txt', path: P('note.txt'), filename: '改过的名字.txt' }
          ]
        }
      },
      {
        id: 'file-body', name: '整个 body 来自文件', type: 'webhook', group: 'net',
        target: U + '/raw', method: 'POST', timeout: 20,
        headers: ['Content-Type: application/json; charset=utf-8'],
        body: '{{#file:' + P('data.json') + '}}'
      },
      {
        id: 'file-raw', name: 'raw 保留尾部换行', type: 'webhook', group: 'net',
        target: U + '/raw2', method: 'POST', timeout: 20,
        body: '{{#file-raw:' + P('data.json') + '}}'
      },
      {
        id: 'file-b64', name: 'base64 塞进 JSON', type: 'webhook', group: 'net',
        target: U + '/b64', method: 'POST', timeout: 20,
        body: '{"name":"pixel.png","data":"{{#filebase64:' + P('pixel.png') + '}}"}'
      },
      {
        id: 'file-hash', name: '摘要进请求头', type: 'webhook', group: 'net',
        target: U + '/hash', method: 'GET', timeout: 20,
        headers: [
          'X-Sha256: {{#filehash:sha256:' + P('data.json') + '}}',
          'X-Token: {{#file:' + P('token.txt') + '}}'
        ]
      },
      {
        id: 'file-param', name: '路径来自参数', type: 'webhook', group: 'net',
        target: U + '/param', method: 'POST', timeout: 20,
        body: '{{#file:{{p}}}}',
        params: [{ name: 'p', type: 'path' }]
      },
      {
        id: 'file-bin-reject', name: '二进制误用文本模板', type: 'webhook', group: 'net',
        target: U + '/reject', method: 'POST', timeout: 20,
        body: '{{#file:' + P('pixel.png') + '}}'
      }
    ]
  };
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  fs.writeFileSync(path.join(SANDBOX, 'launcher.ini'),
    '[General]\nHotkey=\nWidth=820\nHeight=580\nCornerRadius=14\nAlwaysOnTop=0\nHideOnBlur=0\nHideAfterLaunch=0\nShowOnStart=0\nDevTools=0\n', 'utf8');
}

function runCli(args, timeout = 90000) {
  return new Promise(resolve => {
    const p = spawn(AHK, [path.join(SANDBOX, 'launcher.ahk')].concat(args),
      { cwd: SANDBOX, windowsHide: true });
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
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      hits.set(req.url, { headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });

  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    prepare(port);
    console.log('沙箱：' + SANDBOX + '  回显服务：127.0.0.1:' + port + '\n');

    const runs = {};
    const argsFor = { 'file-param': ['--args', path.join(FIX, 'data.json')] };
    for (const id of ['mp-one', 'mp-two', 'file-body', 'file-raw', 'file-b64', 'file-hash', 'file-param', 'file-bin-reject']) {
      const r = await runCli(['run', id].concat(argsFor[id] || []).concat(['--wait', '--json', '--ephemeral']));
      runs[id] = r;
      console.log(id + ' -> ' + r.out.slice(0, 160) + (r.err ? '  [stderr] ' + r.err.slice(0, 120) : ''));
      await new Promise(res => setTimeout(res, 400));
    }

    server.close();

    /* ---------------- multipart：一个文件 + 两个字段 ---------------- */
    console.log('\n== multipart：一个文件 + 文本字段 ==');
    const up = hits.get('/up');
    ok('请求到达服务端', !!up);
    if (up) {
      const ct = up.headers['content-type'] || '';
      ok('Content-Type 是 multipart/form-data', /^multipart\/form-data; boundary=/.test(ct), ct);
      const boundary = (ct.match(/boundary=(.+)$/) || [])[1] || '';
      ok('boundary 有这个包的前缀', boundary.startsWith('----QuickLaunch'), boundary);
      ok('包以边界开头', up.body.slice(0, boundary.length + 2).toString() === '--' + boundary);
      ok('包以 --边界-- 收尾', up.body.slice(-(boundary.length + 6)).toString().trim() === '--' + boundary + '--');

      const text = up.body.toString('utf8');
      ok('文本字段 note 在', text.indexOf('name="note"') >= 0);
      ok('note 的值带中文且模板已展开', text.indexOf('中文备注 默认人') >= 0);
      ok('另一个字段 plain 也在', text.indexOf('name="plain"') >= 0);
      ok('文件段带 filename', text.indexOf('name="photo"; filename="pixel.png"') >= 0);
      ok('PNG 的 MIME 猜对了', text.indexOf('Content-Type: image/png') >= 0);
      ok('二进制原样躺在包里（逐字节）', up.body.includes(PNG));
      /* 只比长度不够：坏掉的 PNG 往往长度一样。改成验结构 ——
         文件字节后面必须紧跟 \r\n--边界，说明包没在二进制中间被截断 */
      ok('文件段之后紧跟 CRLF + 边界',
        up.body.indexOf(Buffer.concat([PNG, Buffer.from('\r\n--')])) >= 0);
    }

    /* ---------------- multipart：两个文件 ---------------- */
    console.log('\n== multipart：两个文件 ==');
    const up2 = hits.get('/up2');
    ok('请求到达服务端', !!up2);
    if (up2) {
      const text = up2.body.toString('utf8');
      ok('两个文件段都在',
        text.indexOf('name="json"; filename="data.json"') >= 0 &&
        text.indexOf('name="txt"; filename="改过的名字.txt"') >= 0);
      ok('JSON 的字节一致', up2.body.includes(JSON_BODY));
      ok('中文文件名没被搞坏', text.indexOf('改过的名字.txt') >= 0);
      ok('用户指定的 MIME 覆盖了按扩展名猜的',
        text.indexOf('Content-Type: application/json') >= 0);
      ok('没指定 MIME 的按扩展名猜成 text/plain',
        text.indexOf('Content-Type: text/plain') >= 0);
    }

    /* ---------------- 整个 body 来自文件 ---------------- */
    console.log('\n== {{#file}} 当整个 body ==');
    const raw = hits.get('/raw');
    ok('请求到达服务端', !!raw);
    if (raw) {
      /* {{#file:}} 默认裁尾部换行，所以这里比的是「去掉最后一个 \n」的字节 */
      ok('body 与文件字节一致（尾部换行按设计裁掉）', raw.body.equals(JSON_BODY.slice(0, -1)),
        raw.body.length + ' vs ' + (JSON_BODY.length - 1));
      ok('多行 JSON 没被 HdrLine 的换行检查拦下', raw.body.toString().indexOf('\n') >= 0);
      ok('中文没坏', raw.body.toString('utf8').indexOf('夜间备份') >= 0);
    }

    /* ---------------- file-raw 保留原样 ---------------- */
    console.log('\n== {{#file-raw}} 保留原样 ==');
    const raw2 = hits.get('/raw2');
    ok('请求到达服务端', !!raw2);
    if (raw2) {
      ok('字节完全一致（连尾部那个换行都在）', raw2.body.equals(JSON_BODY),
        raw2.body.length + ' vs ' + JSON_BODY.length);
    }

    /* ---------------- base64 ---------------- */
    console.log('\n== {{#filebase64}} 塞进 JSON ==');
    const b64 = hits.get('/b64');
    ok('请求到达服务端', !!b64);
    if (b64) {
      let j = null;
      try { j = JSON.parse(b64.body.toString('utf8')); } catch (e) {}
      ok('body 仍是合法 JSON', !!j, b64.body.toString('utf8').slice(0, 80));
      if (j) {
        ok('data 与 PNG 的 base64 一致', j.data === PNG.toString('base64'), j.data && j.data.slice(0, 24));
        ok('能解回原始字节', Buffer.from(j.data, 'base64').equals(PNG));
      }
    }

    /* ---------------- 摘要 + 文本进请求头 ---------------- */
    console.log('\n== {{#filehash}} / {{#file}} 进请求头 ==');
    const hash = hits.get('/hash');
    ok('请求到达服务端', !!hash);
    if (hash) {
      ok('X-Sha256 与 crypto 算的一致',
        hash.headers['x-sha256'] === crypto.createHash('sha256').update(JSON_BODY).digest('hex'),
        hash.headers['x-sha256']);
      ok('X-Token 来自文件且裁掉了尾部换行',
        hash.headers['x-token'] === 'tok-abc-123', hash.headers['x-token']);
    }

    /* ---------------- 路径来自参数 ---------------- */
    console.log('\n== 路径来自运行时参数 ==');
    const par = runs['file-param'];
    ok('命令行报成功', /"ok"\s*:\s*true/.test(par.out) || /200/.test(par.out), par.out.slice(0, 120));
    const pm = hits.get('/param');
    ok('请求到达服务端', !!pm);
    if (pm) {
      ok('body 就是参数指向的那个文件', pm.body.equals(JSON_BODY.slice(0, -1)),
        pm.body.length + ' vs ' + (JSON_BODY.length - 1));
    }

    /* ---------------- 二进制误用要被拒 ---------------- */
    console.log('\n== 二进制进文本模板：必须拒发 ==');
    ok('服务端没收到这个请求', !hits.has('/reject'));
    const rej = runs['file-bin-reject'];
    ok('命令行给出了明确的失败原因', /二进制|filebase64/.test(rej.out), rej.out.slice(0, 160));

    console.log('\n' + (fail ? 'multipart 端到端：失败 ' + fail + ' 项' : 'multipart 端到端：全部通过')
      + '（' + pass + ' 项）');
    process.exit(fail ? 1 : 0);
  });
}

main();
