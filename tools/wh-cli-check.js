/* ============================================================
   --webhook 的命令行排查开关（--json / --body）

   这一路是给「人」用的：请求没按预期发生的时候，不想开界面、不想翻
   meta.ini，直接在终端跑一份 spec.ini 看结果。所以这里测的全是"打印什么"
   和"退出码是多少"，以及一条底线 —— 加了开关也不能改变写盘契约
   （meta.ini / body.txt 照旧，主进程那条路不受影响）。

   用法：
     node tools/wh-cli-check.js            脚本版
     node tools/wh-cli-check.js --exe      编译版（dist\QuickLaunch.exe）
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const DIST = path.join(ROOT, 'dist');
const USE_EXE = process.argv.includes('--exe');
const BASE = path.join(os.tmpdir(), 'ql-wh-cli', USE_EXE ? 'exe' : 'app');
const OUT = path.join(BASE, 'out');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '\n         ' + extra : '')); }
}
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  ok(label, a === b, 'got  ' + a + '\n         want ' + b);
}

/* 本地服务：/ok 回 200 + JSON，/bad 回 400，/bin 回二进制 */
const server = http.createServer((req, res) => {
  if (req.url === '/bad') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'nope' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, path: req.url, 中文: '值', list: [1, 2, 3] }));
});

/* 跑一次子进程，收 stdout 和退出码 */
function run(args, timeout = 60000) {
  return new Promise(resolve => {
    const cmd = USE_EXE
      ? path.join(DIST, 'QuickLaunch.exe')
      : AHK;
    const argv = USE_EXE ? args : [path.join(ROOT, 'launcher.ahk')].concat(args);
    const p = spawn(cmd, argv, { cwd: ROOT, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', b => { out += b.toString('utf8'); });
    p.stderr.on('data', b => { err += b.toString('utf8'); });
    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} }, timeout);
    p.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/* 写一份 spec.ini。传 null 表示"这个键不写"，用来造缺字段的坏 spec */
function writeSpec(name, o) {
  const dir = path.join(BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  const outDir = o.outDir === null ? null : (o.outDir || dir);
  const lines = ['[req]'];
  if (o.mode !== null) lines.push('Mode=' + (o.mode || 'http'));
  if (o.method !== null) lines.push('Method=' + (o.method || 'GET'));
  if (o.url !== null) lines.push('Url=' + (o.url || ''));
  if (o.timeout) lines.push('Timeout=' + o.timeout);
  if (outDir !== null) lines.push('OutDir=' + outDir);
  const spec = path.join(dir, 'spec.ini');
  fs.writeFileSync(spec, lines.join('\r\n') + '\r\n', 'utf8');
  return { spec, dir, outDir };
}

/* AHK 的 IniWrite 默认写 UTF-16 LE（带 BOM），FileAppend 写的 body.txt 是 UTF-8。
   读 INI 得按 BOM 判断编码，不然中文注释和键值全是乱码。 */
const readIni = p => {
  try {
    const b = fs.readFileSync(p);
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return b.toString('utf16le').replace(/^\uFEFF/, '');
    return b.toString('utf8').replace(/^\uFEFF/, '');
  } catch (e) { return ''; }
};

(async () => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const URL_OK = 'http://127.0.0.1:' + port + '/ok';

  const s1 = writeSpec('plain', { url: URL_OK });

  console.log('— 默认（不带开关）：行为与以前一致');
  let r = await run(['--webhook', s1.spec]);
  eq('stdout 为空', r.out, '');
  eq('退出码 0', r.code, 0);
  ok('meta.ini 照旧写了', /Status=200/.test(readIni(path.join(s1.outDir, 'meta.ini'))));
  ok('body.txt 照旧写了', readIni(path.join(s1.outDir, 'body.txt')).indexOf('"ok":true') >= 0);

  console.log('— --json');
  r = await run(['--webhook', s1.spec, '--json']);
  let j = null;
  try { j = JSON.parse(r.out); } catch (e) {}
  ok('输出是合法 JSON', !!j, r.out.slice(0, 200));
  eq('退出码 0', r.code, 0);
  if (j) {
    eq('ok', j.ok, true);
    eq('status', j.status, 200);
    eq('mode', j.mode, 'http');
    eq('method', j.method, 'GET');
    eq('url 是实际请求地址', j.url, URL_OK);
    eq('error 为空', j.error, '');
    ok('body 是原始响应正文', /"path":"\/ok"/.test(j.body), j.body);
    eq('len 与 body 长度一致', j.len, j.body.length);
    ok('中文原样保留（不被转义坏）', j.body.indexOf('"中文":"值"') >= 0, j.body);
    ok('ms 是数字', typeof j.ms === 'number' && j.ms >= 0, String(j.ms));
    ok('输出只有一行（便于管道）', r.out.trim().indexOf('\n') < 0, JSON.stringify(r.out));
  }
  ok('加了 --json 也照样写 meta.ini', /Status=200/.test(readIni(path.join(s1.outDir, 'meta.ini'))));

  console.log('— --body');
  r = await run(['--webhook', s1.spec, '--body']);
  ok('只打正文，能直接 JSON.parse', (() => { try { JSON.parse(r.out); return true; } catch (e) { return false; } })(), r.out.slice(0, 160));
  ok('没有多出的前缀/日志', r.out.trimStart().startsWith('{'), r.out.slice(0, 40));

  console.log('— 参数写法');
  r = await run(['--webhook=' + s1.spec, '--json']);
  ok('--webhook=<spec> 也认', (() => { try { return JSON.parse(r.out).status === 200; } catch (e) { return false; } })(), r.out.slice(0, 120));
  r = await run(['--webhook', '--json', s1.spec]);
  ok('开关写在 spec 前面也认', (() => { try { return JSON.parse(r.out).status === 200; } catch (e) { return false; } })(), r.out.slice(0, 120));
  r = await run(['--webhook', s1.spec, '--json', '--body']);
  ok('两个开关同时给：--json 优先', (() => { try { return JSON.parse(r.out).status === 200; } catch (e) { return false; } })(), r.out.slice(0, 120));

  console.log('— 出错时也要能被脚本消费');
  r = await run(['--webhook', path.join(BASE, 'nope', 'none.ini'), '--json']);
  j = null;
  try { j = JSON.parse(r.out); } catch (e) {}
  eq('spec 不存在：退出码 2', r.code, 2);
  ok('spec 不存在：仍然输出 JSON', !!j && j.ok === false, r.out);
  ok('spec 不存在：错误信息说清了原因', !!j && /不存在/.test(j.error), j && j.error);

  const s2 = writeSpec('noout', { url: URL_OK, outDir: null });
  r = await run(['--webhook', s2.spec, '--json']);
  eq('缺 OutDir：退出码 3', r.code, 3);
  ok('缺 OutDir：JSON 里有说明', (() => { try { return JSON.parse(r.out).ok === false; } catch (e) { return false; } })(), r.out);

  const s3 = writeSpec('refused', { url: 'http://127.0.0.1:9/x', timeout: 3 });
  r = await run(['--webhook', s3.spec, '--json']);
  j = null;
  try { j = JSON.parse(r.out); } catch (e) {}
  eq('连不上：退出码仍是 0（请求本身跑完了）', r.code, 0);
  ok('连不上：ok=false', !!j && j.ok === false, r.out);
  ok('连不上：error 非空', !!j && String(j.error).length > 0, j && j.error);

  /* 4xx 是"连接成功、服务端说不行"，和"没拿到响应"必须分开 —— 前者要能继续看正文 */
  const s4 = writeSpec('bad', { url: 'http://127.0.0.1:' + port + '/bad' });
  r = await run(['--webhook', s4.spec, '--json']);
  j = null;
  try { j = JSON.parse(r.out); } catch (e) {}
  eq('HTTP 400：status 如实上报', j && j.status, 400);
  ok('HTTP 400：ok 仍为 true（拿到了响应）', !!j && j.ok === true, r.out);
  ok('HTTP 400：正文照样给出来', !!j && /nope/.test(j.body), j && j.body);

  console.log('— download 模式');
  const s5 = writeSpec('dl', { url: URL_OK, mode: 'download' });
  fs.writeFileSync(path.join(s5.dir, 'spec.ini'),
    fs.readFileSync(path.join(s5.dir, 'spec.ini'), 'utf8')
    + '[dl]\r\nSaveDir=' + path.join(s5.dir, 'dl') + '\r\nSaveName=one.json\r\n', 'utf8');
  r = await run(['--webhook', s5.spec, '--json']);
  j = null;
  try { j = JSON.parse(r.out); } catch (e) {}
  ok('download：有 file 字段', !!j && /one\.json$/.test(j.file || ''), j && j.file);
  ok('download：文件真的写出来了', fs.existsSync(path.join(s5.dir, 'dl', 'one.json')));
  ok('download：没有 body 字段（正文进了文件）', !!j && j.body === undefined, r.out.slice(0, 160));

  server.close();
  console.log('\n' + (USE_EXE ? '编译版' : '脚本版') + '：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
