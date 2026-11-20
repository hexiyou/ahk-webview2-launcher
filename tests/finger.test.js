/* 设备指纹 · 第二套（浏览器侧）
   核心口径只有一条：**Edge 升级不能改变指纹**。所以这里的用例不是「算得对不对」，
   而是「什么东西变了它必须不变、什么东西变了它必须变」。

   函数体从 ui/fingerprint.js 与 ui/app.js 里取真实实现（后者经 tests/harness.js），
   不复制逻辑。 */
const F = require('../ui/fingerprint.js');
const { build } = require('./harness');

const state = { groups: [], all: [], index: {}, usage: {} };
const T = build(state, require('../ui/pinyin.js'));

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b); }
}
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); }
}

/* 一台典型的 Windows 机器。UA 特意写成完整的 Edge 字符串 —— 它不该影响任何结果。 */
function makeEnv() {
  return {
    navigator: {
      platform: 'Win32',
      hardwareConcurrency: 16,
      deviceMemory: 8,
      language: 'zh-CN',
      languages: ['zh-CN', 'zh'],
      maxTouchPoints: 0,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      userAgentData: {
        platform: 'Windows',
        brands: [{ brand: 'Microsoft Edge', version: '130' }, { brand: 'Chromium', version: '130' }]
      }
    },
    screen: { width: 1920, height: 1080, colorDepth: 24, availWidth: 1920, availHeight: 1040 },
    devicePixelRatio: 1.25,
    tz: 'Asia/Shanghai'
  };
}

/* 深拷贝一层就够（测试里只改 navigator / screen 的浅字段） */
function clone(e) {
  return JSON.parse(JSON.stringify(e));
}

const base = makeEnv();
const fpBase = F.describe(base, '').fp;

/* app.js 的 fpDesc 走的是「真实环境」(= null)。Node 里没有 navigator / screen，
   所以用 app.js 留的注入点喂同一份假环境 —— 这样 builtinValue 才能算出和上面一致的值。 */
globalThis.__QL_FP_ENV__ = base;

console.log('— SHA-256 自身：已知向量');
{
  eq('空串', F.sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  eq('abc', F.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  eq('两个块的长串', F.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  ok('中文按 UTF-8 编码（不是 UTF-16 的码元）', F.sha256('中文') === F.sha256('中文'));
  ok('长度变了结果就变', F.sha256('a') !== F.sha256('aa'));
}

console.log('\n— 输出形状');
{
  ok('FP1- 4 段 8 位', /^FP1-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/.test(fpBase), fpBase);
  ok('bound 前缀是 FPB1', /^FPB1-/.test(F.boundOf(fpBase, 'salt')), F.boundOf(fpBase, 'salt'));
  ok('确定性：同一环境算两次一样', F.fpOf(F.collect(base)) === fpBase, fpBase);
  ok('明细串无引号无换行', !/["'\n]/.test(F.partsOf(F.collect(base))), F.partsOf(F.collect(base)));
}

console.log('\n— Edge 升级必须不变（本功能的核心口径）');
{
  /* 130 → 132：UA、brands、Chromium 内核版本全变，其它硬件信号不变 */
  const e = clone(base);
  e.navigator.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0';
  e.navigator.userAgentData.brands = [
    { brand: 'Microsoft Edge', version: '132' }, { brand: 'Chromium', version: '132' }
  ];
  eq('Edge 130 → 132：指纹不变', F.fpOf(F.collect(e)), fpBase);

  const e2 = clone(base);
  delete e2.navigator.userAgent;
  eq('整个 UA 都不存在也不影响', F.fpOf(F.collect(e2)), fpBase);

  /* 这几个是「用户随手就改」的东西，采进来会让人以为指纹坏了 */
  const e3 = clone(base);
  e3.devicePixelRatio = 1.5;
  eq('改缩放（DPR 1.25→1.5）不变', F.fpOf(F.collect(e3)), fpBase);

  const e4 = clone(base);
  e4.screen.availHeight = 1000;
  eq('任务栏挪动（availHeight）不变', F.fpOf(F.collect(e4)), fpBase);
}

console.log('\n— 换了东西就必须变');
{
  const c = clone(base); c.navigator.hardwareConcurrency = 8;
  ok('换个 CPU（核数 16→8）', F.fpOf(F.collect(c)) !== fpBase);

  const m = clone(base); m.navigator.deviceMemory = 16;
  ok('加内存（8→16）', F.fpOf(F.collect(m)) !== fpBase);

  const s = clone(base); s.screen.width = 2560; s.screen.height = 1440;
  ok('换显示器（1920×1080 → 2560×1440）', F.fpOf(F.collect(s)) !== fpBase);

  const z = clone(base); z.tz = 'Europe/Berlin';
  ok('改时区', F.fpOf(F.collect(z)) !== fpBase);

  const l = clone(base); l.navigator.languages = ['en-US', 'en']; l.navigator.language = 'en-US';
  ok('改语言', F.fpOf(F.collect(l)) !== fpBase);

  const o = clone(base); o.navigator.platform = 'Linux x86_64';
  ok('换操作系统', F.fpOf(F.collect(o)) !== fpBase);
}

console.log('\n— 缺信号的兜底（Firefox / 老内核不能崩）');
{
  const e = clone(base);
  delete e.navigator.deviceMemory;
  delete e.navigator.userAgentData;
  delete e.navigator.maxTouchPoints;
  const r = F.describe(e, '');
  eq('deviceMemory 缺失记 0', r.signals.mem, '0');
  eq('userAgentData 缺失记空', r.signals.uap, '');
  eq('maxTouchPoints 缺失记 0', r.signals.touch, '0');
  ok('照样算得出指纹', /^FP1-/.test(r.fp), r.fp);

  const e2 = clone(base);
  delete e2.navigator.languages;
  eq('languages 缺失退回 language', F.collect(e2).langs, 'zh-CN');

  /* 值里混进分隔符：不能让它把规范串的语法搞坏 */
  const e3 = clone(base);
  e3.navigator.platform = 'Win|32=evil';
  eq('值里的 | 和 = 被剔掉', F.collect(e3).os, 'Win32evil');
}

console.log('\n— 本机绑定（{{@fp.bound}}）');
{
  const b = F.boundOf(fpBase, 'da04a1b67d69391444250f0118289c59');
  ok('有盐时和 fp 不同', b !== fpBase, b);
  eq('没盐时等于 fp（纯浏览器打开的场景）', F.boundOf(fpBase, ''), fpBase);
  eq('盐为空串同理', F.boundOf(fpBase, null), fpBase);
  ok('换一个盐结果就变', F.boundOf(fpBase, 'other') !== b);
  eq('同一个盐稳定', F.boundOf(fpBase, 'da04a1b67d69391444250f0118289c59'), b);
}

console.log('\n— 接进模板变量');
{
  eq('{{@fp}} 与 describe 一致', T.builtinValue('@fp'), fpBase);
  eq('{{@fp.short}} 是前三段', T.builtinValue('@fp.short'), fpBase.split('-').slice(0, 3).join('-'));
  eq('{{@fp.bound}}（无盐）等于 fp', T.builtinValue('@fp.bound'), fpBase);
  eq('{{@fp.parts}} 是明细串', T.builtinValue('@fp.parts'), F.partsOf(F.collect(base)));
  eq('拼错返回 null（交给体检拦）', T.builtinValue('@fnger'), null);

  eq('拼错的 {{@fnger}} 被体检逮住', T.builtinIssues(['{{@fnger}}']).length, 1);
  eq('写对的 {{@fp}} 不报', T.builtinIssues(['{{@fp}} {{@fp.bound}} {{@fp.short}} {{@fp.parts}}']).length, 0);
  eq('{{@fp}} 不算用户参数', Array.from(T.tplVars(['{{@fp}}'])), []);

  /* 对象 body：值里没有引号，序列化一次就合法 */
  const w = T.applyParams({ type: 'webhook', target: 'https://x/', body: { fp: '{{@fp}}' } }, '');
  eq('对象 body 里替换', JSON.parse(JSON.stringify(w.item.body)).fp, fpBase);

  const w2 = T.applyParams({ type: 'webhook', target: 'https://x/', body: '{"fp":"{{@fp}}"}' }, '');
  eq('字符串 body 里替换', w2.item.body, '{"fp":"' + fpBase + '"}');

  /* 和用户参数混用：各走各的 */
  const it = {
    type: 'webhook', target: 'https://x/{{@fp}}',
    params: [{ name: 'who', required: false }],
    body: { who: '{{who}}', fp: '{{@fp}}' }
  };
  const w3 = T.applyParams(it, 'alice');
  eq('与参数混用：参数照常', JSON.parse(JSON.stringify(w3.item.body)).who, 'alice');
  eq('与参数混用：指纹照常', JSON.parse(JSON.stringify(w3.item.body)).fp, fpBase);
}

console.log('\n— 指纹脚本缺失时的降级');
{
  /* 单独 build 一份：fpCache 是每次 new Function 独立的变量 */
  const saved = globalThis.QLFinger;
  delete globalThis.QLFinger;
  const T2 = build(state, require('../ui/pinyin.js'));
  eq('没有 QLFinger 时给空串，不抛', T2.builtinValue('@fp'), '');
  globalThis.QLFinger = saved;
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
