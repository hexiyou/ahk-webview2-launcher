/* ============================================================
   请求头动态值实测：{{#ts}} {{#uuid}} {{#nonce:N}} {{#env:NAME}}
                      {{#md5|sha1|sha256|sha384|sha512}} {{#base64[url]}} {{#hmac[-算法]}}

   这些函数只存在于 AHK 侧，前端跑不到，所以不能像 app.js 那样直接 require。
   做法与 out-check.js 一致：从 launcher.ahk 里把函数体抽出来拼成一个探针跑，
   再把结果交回 node，用 crypto 独立算一遍 HMAC/SHA-256 做对照。

   用法：node tools/hdr-check.js
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AHK = path.join(ROOT, 'runtime', 'AutoHotkey64.exe');
const GEN = path.join(os.tmpdir(), 'ql_hdr_probe.ahk');
const LOG = path.join(os.tmpdir(), 'ql_hdr_probe.log');

function extractFn(src, name) {
  const tag = '\n' + name + '(';
  const s = src.indexOf(tag);
  if (s < 0) throw new Error('launcher.ahk 里找不到函数 ' + name);
  /* 函数体里的 } 都有缩进，行首顶格的 } 只有函数结束那一个 */
  const e = src.indexOf('\n}\n', s);
  if (e < 0) throw new Error(name + ' 没有闭合');
  return src.slice(s + 1, e + 2);
}

function build() {
  const src = fs.readFileSync(path.join(ROOT, 'launcher.ahk'), 'utf8');

  const keys = /global SIG_KEYS := Map\([\s\S]*?\n\)/.exec(src);
  if (!keys) throw new Error('找不到 SIG_KEYS 定义');

  const fns = ['HdrExpand', 'HdrEval', 'HdrInline', 'HdrEnv', 'HashAlgo', 'HdrLine'
    , 'UuidV4', 'RandAlnum', 'HashHex', 'B64Encode']
    .map(n => extractFn(src, n)).join('\n\n');

  const driver = `
#Requires AutoHotkey v2.0
#Warn All, Off

${keys[0]}

${fns}

Log(s) {
    FileAppend(s . "\`n", "${LOG.replace(/\\/g, '\\\\')}", 'UTF-8-RAW')
}

TryEval(expr) {
    try
        return expr()
    catch as e
        return 'ERR:' e.Message
}

try FileDelete("${LOG.replace(/\\/g, '\\\\')}")
Log('ts=' HdrExpand('{{#ts}}'))
Log('tsms=' HdrExpand('{{#tsms}}'))
Log('uuid=' HdrExpand('{{#uuid}}'))
Log('nonce16=' HdrExpand('{{#nonce}}'))
Log('nonce8=' HdrExpand('{{#nonce:8}}'))
Log('nonce_big=' HdrExpand('{{#nonce:999}}'))
Log('sha256_abc=' HdrExpand('{{#sha256:abc}}'))
Log('sha256_empty=' HdrExpand('{{#sha256:}}'))
Log('hmac_abc=' HdrExpand('{{#hmac:demo:abc}}'))
Log('hmac_empty=' HdrExpand('{{#hmac:demo:}}'))
Log('nested=' HdrExpand('{{#hmac:demo:{ts}}}'))
Log('nested_ts=' HdrExpand('{{#ts}}'))
Log('unknown=' HdrExpand('{{#foo:bar}}'))
Log('unknown2=' HdrExpand('{{#noColon}}'))
Log('literal=' HdrExpand('X-Test: hello world'))
Log('mixed=Bearer x' HdrExpand('{{#ts}}'))
Log('badkey=' TryEval(() => HdrExpand('{{#hmac:nope:abc}}')))
Log('badhmac=' TryEval(() => HdrExpand('{{#hmac:noColonAtAll}}')))
Log('whole=' HdrExpand('Authorization: Bearer {{#hmac:demo:{ts}}}'))
Log('case=' HdrExpand('{{#TS}}'))
Log('nospaced=' HdrExpand('{{#ts}}{{#ts}}'))

EnvSet('QL_HDR_ENV', 'hello-env')
EnvSet('QL_HDR_NL', 'a' Chr(13) Chr(10) 'b')
Log('env=' HdrExpand('{{#env:QL_HDR_ENV}}'))
Log('env_missing=' TryEval(() => HdrExpand('{{#env:QL_HDR_NOPE}}')))
Log('env_noname=' TryEval(() => HdrExpand('{{#env:}}')))
Log('line_ok=' HdrLine('X-Ok: {{#env:QL_HDR_ENV}}'))
Log('line_crlf=' TryEval(() => HdrLine('X-Bad: {{#env:QL_HDR_NL}}')))
Log('md5=' HdrExpand('{{#md5:abc}}'))
Log('sha1=' HdrExpand('{{#sha1:abc}}'))
Log('sha384=' HdrExpand('{{#sha384:abc}}'))
Log('sha512=' HdrExpand('{{#sha512:abc}}'))
Log('hmac_md5=' HdrExpand('{{#hmac-md5:demo:abc}}'))
Log('hmac_sha1=' HdrExpand('{{#hmac-sha1:demo:abc}}'))
Log('hmac_sha512=' HdrExpand('{{#hmac-sha512:demo:abc}}'))
Log('b64=' HdrExpand('{{#base64:abc}}'))
Log('b64_cn=' HdrExpand('{{#base64:中文}}'))
Log('b64_empty=' HdrExpand('{{#base64:}}'))
Log('b64url=' HdrExpand('{{#base64url:??>}}'))
Log('b64url_pad=' HdrExpand('{{#base64url:ab}}'))
Log('b64_ts=' HdrExpand('{{#base64:{ts}}}'))
Log('b64_ts_v=' HdrExpand('{{#ts}}'))
Log('sha3=' HdrExpand('{{#sha3:abc}}'))
ExitApp(0)
`;

  fs.writeFileSync(GEN, driver, 'utf8');
}

let fails = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
    fails++;
  }
}

function main() {
  build();
  try { fs.unlinkSync(LOG); } catch (e) {}

  const r = spawnSync(AHK, ['/ErrorStdOut', '/force', GEN], { timeout: 60000, encoding: 'utf8' });
  if ((r.stderr || '').trim()) console.log('[AHK stderr] ' + r.stderr.trim());
  if (!fs.existsSync(LOG)) {
    console.log('探针没有产出日志，AHK 可能没跑起来（status=' + r.status + '）');
    process.exit(1);
  }

  const kv = {};
  fs.readFileSync(LOG, 'utf8').split(/\r?\n/).forEach(line => {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  });

  const now = Math.floor(Date.now() / 1000);
  const SECRET = 'ql-demo-2026-secret';

  console.log('\n== 时间戳 / 随机 ==');
  check('{{#ts}} 是 10 位数字', /^\d{10}$/.test(kv.ts || ''), kv.ts);
  check('{{#ts}} 与系统时间相差 < 120s', Math.abs(Number(kv.ts) - now) < 120, kv.ts + ' vs ' + now);
  check('{{#tsms}} 是 13 位数字', /^\d{13}$/.test(kv.tsms || ''), kv.tsms);
  check('{{#tsms}} 与系统时间相差 < 120s', Math.abs(Number(kv.tsms) / 1000 - now) < 120);
  check('{{#uuid}} 是 v4 形态', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(kv.uuid || ''), kv.uuid);
  check('{{#nonce}} 默认 16 位', /^[a-z0-9]{16}$/.test(kv.nonce16 || ''), kv.nonce16);
  check('{{#nonce:8}} 是 8 位', /^[a-z0-9]{8}$/.test(kv.nonce8 || ''), kv.nonce8);
  check('{{#nonce:999}} 回落到 16 位', /^[a-z0-9]{16}$/.test(kv.nonce_big || ''), kv.nonce_big);

  console.log('\n== 摘要 ==');
  const sha = crypto.createHash('sha256').update('abc').digest('hex');
  check('{{#sha256:abc}} 与 crypto 一致', kv.sha256_abc === sha, kv.sha256_abc + ' vs ' + sha);
  const shaEmpty = crypto.createHash('sha256').update('').digest('hex');
  check('{{#sha256:}} 空串也能算', kv.sha256_empty === shaEmpty, kv.sha256_empty);
  const hmac = crypto.createHmac('sha256', SECRET).update('abc').digest('hex');
  check('{{#hmac:demo:abc}} 与 crypto 一致', kv.hmac_abc === hmac, kv.hmac_abc + ' vs ' + hmac);
  const hmacEmpty = crypto.createHmac('sha256', SECRET).update('').digest('hex');
  check('{{#hmac:demo:}} 空载荷也能算', kv.hmac_empty === hmacEmpty, kv.hmac_empty);

  console.log('\n== 嵌套与整行 ==');
  /* 两次 {{#ts}} 是分别取的，跨秒就会差 1，所以用 ±2 秒的容差比对 */
  const nestedTs = Number((kv.nested_ts || '').trim());
  const nestedOk = [-2, -1, 0, 1, 2].some(d =>
    kv.nested === crypto.createHmac('sha256', SECRET).update(String(nestedTs + d)).digest('hex'));
  check('{{#hmac:demo:{ts}}} 里层先展开', nestedOk, kv.nested + ' vs ts=' + nestedTs);
  const wholeOk = [-2, -1, 0, 1, 2].some(d =>
    kv.whole === 'Authorization: Bearer ' +
      crypto.createHmac('sha256', SECRET).update(String(nestedTs + d)).digest('hex'));
  check('整行「Authorization: Bearer …」拼对', wholeOk, kv.whole);
  check('同一行两个 {{#ts}} 都展开', /^\d{10}\d{10}$/.test(kv.nospaced || ''), kv.nospaced);

  console.log('\n== 边界 ==');
  check('未知函数原样保留', kv.unknown === '{{#foo:bar}}', kv.unknown);
  check('未知无冒号变量原样保留', kv.unknown2 === '{{#noColon}}', kv.unknown2);
  check('普通文本不动', kv.literal === 'X-Test: hello world', kv.literal);
  check('不认识的密钥名报错', /^ERR:.*未知的签名密钥名/.test(kv.badkey || ''), kv.badkey);
  check('hmac 缺参数报错', /^ERR:.*hmac 少了参数/.test(kv.badhmac || ''), kv.badhmac);
  check('大写 {{#TS}} 不认识（不误伤）', kv.case === '{{#TS}}', kv.case);
  check('不认识的算法原样保留', kv.sha3 === '{{#sha3:abc}}', kv.sha3);

  console.log('\n== 环境变量 ==');
  check('{{#env:NAME}} 取到环境变量', kv.env === 'hello-env', kv.env);
  check('变量没定义时报错（不给空串）', /^ERR:.*没有定义/.test(kv.env_missing || ''), kv.env_missing);
  check('env 没写变量名报错', /^ERR:.*少了变量名/.test(kv.env_noname || ''), kv.env_noname);
  check('正常值原样进请求头', kv.line_ok === 'X-Ok: hello-env', kv.line_ok);
  check('值里带 CRLF 时拒发（换行注入）', /^ERR:.*换行/.test(kv.line_crlf || ''), kv.line_crlf);

  console.log('\n== 其它摘要算法 ==');
  for (const [k, algo] of [['md5', 'md5'], ['sha1', 'sha1'], ['sha384', 'sha384'], ['sha512', 'sha512']]) {
    const want = crypto.createHash(algo).update('abc').digest('hex');
    check('{{#' + k + ':abc}} 与 crypto 一致', kv[k] === want, kv[k] + ' vs ' + want);
  }
  for (const [k, algo] of [['hmac_md5', 'md5'], ['hmac_sha1', 'sha1'], ['hmac_sha512', 'sha512']]) {
    const want = crypto.createHmac(algo, SECRET).update('abc').digest('hex');
    check('{{#' + k.replace('_', '-') + ':demo:abc}} 与 crypto 一致', kv[k] === want,
      kv[k] + ' vs ' + want);
  }

  console.log('\n== Base64 ==');
  check('{{#base64:abc}} = YWJj', kv.b64 === 'YWJj', kv.b64);
  check('中文按 UTF-8 编码', kv.b64_cn === Buffer.from('中文', 'utf8').toString('base64'), kv.b64_cn);
  check('空串给空串（不报错）', kv.b64_empty === '', JSON.stringify(kv.b64_empty));
  check('base64url 把 + 换成 -', kv.b64url === 'Pz8-', kv.b64url);
  check('base64url 去掉补位 =', kv.b64url_pad === 'YWI', kv.b64url_pad);
  const b64ts = Number((kv.b64_ts_v || '').trim());
  check('{{#base64:{ts}}} 里层先展开', [-2, -1, 0, 1, 2].map(d =>
    Buffer.from(String(b64ts + d), 'utf8').toString('base64')).includes(kv.b64_ts),
    kv.b64_ts + ' vs ts=' + b64ts);

  console.log('\n' + (fails ? '请求头动态值：失败 ' + fails + ' 项' : '请求头动态值：全部通过'));
  process.exit(fails ? 1 : 0);
}

main();
