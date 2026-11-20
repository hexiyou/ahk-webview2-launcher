/* 回调（_ql_callback）用例

   这条链分两半，两边都得测：
     · launcher.ahk 那边只做一件事 —— 从响应正文里按**根对象**切出 _ql_callback
       的原始片段。切错了不会报错，只会"回调莫名其妙不执行"，所以夹具在这一层
       钉死：嵌套不误触、数组根不认、字符串里的 } 不能把括号配平带偏。
     · app.js 那边做解析和计划。这里跑的是实现本身（harness 从源码抽函数体），
       不复制一份逻辑 —— 复制出来的用例只能证明"复制品是对的"。
*/
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { build, readSrc, grabConst } = require('./harness');

const src = readSrc();
const prelude = [
  grabConst(src, /const CB_TEXT_MAX = \d+;/, 'CB_TEXT_MAX'),
  grabConst(src, /const CB_TITLE_MAX = \d+;/, 'CB_TITLE_MAX'),
  grabConst(src, /const CB_TPL_RE = .*;/, 'CB_TPL_RE')
].join('\n');

const state = { all: [], groups: [], index: {}, usage: {}, cfg: null };
const T = build(state, null, [
  'cbCfg', 'cbType', 'cbLevel', 'cbWhy', 'cbParse', 'cbFindItem', 'cbPlan',
  'cbValue', 'cbPick', 'cbFill', 'cbQuoteArg', 'cbActionArgs', 'cbSubstCtx'
], prelude);

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b); }
}
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '\n         ' + extra : '')); }
}

/* ---------------------------------------------------------- AHK：切片 */

console.log('— AHK 切片（launcher.ahk --selftest-callback）');

const root = path.join(__dirname, '..');
const ahk = path.join(root, 'runtime', 'AutoHotkey64.exe');
const launcher = path.join(root, 'launcher.ahk');
const dir = path.join(__dirname, 'callback');

let rows = new Map();
try {
  const out = execFileSync(ahk, [launcher, '--selftest-callback', dir], {
    encoding: 'utf8', timeout: 20000
  });
  out.split(/\r?\n/).forEach(line => {
    if (!line.trim() || line.trim() === '\uFEFF') return;
    let o;
    try { o = JSON.parse(line); } catch (e) { return; }
    if (o.file) rows.set(o.file, o);
  });
} catch (e) {
  fail++;
  console.log('  FAIL 切片自检没跑起来：' + (e.message || e));
}

const slice = name => rows.get(name) || { raw: '', why: '<missing>' };
const parsedSlice = name => {
  const r = slice(name);
  try { return { why: r.why, v: JSON.parse(r.raw) }; }
  catch (e) { return { why: r.why, v: '<not json>' }; }
};

ok('夹具全部被读到', rows.size >= 9, 'rows=' + rows.size);

eq('根对象上的 _ql_callback 能切出来',
  parsedSlice('ok-object.json'),
  {
    why: '',
    v: {
      v: 1,
      actions: [
        { type: 'run', id: 'open-backup-dir' },
        { type: 'msg', level: 'success', text: '已上传 3 个文件' }
      ]
    }
  });

eq('数组值原样切出', parsedSlice('ok-array.json').v, [{ type: 'msg', level: 'error', text: 'boom' }]);
eq('字符串值原样切出', parsedSlice('ok-string.json').v, 'hi');

eq('没有这个键 → none', slice('no-key.json').why, 'none');
eq('只在深层出现 → nested，不切', slice('nested-only.json'), { file: 'nested-only.json', raw: '', why: 'nested' });
eq('根是数组 → 不认', slice('array-root.json').why, 'nested');

eq('字符串里的转义引号不会提前收尾', parsedSlice('escaped.json').v,
  { actions: [{ type: 'msg', text: 'ok' }] });
eq('字符串里的 } { [ ] 不影响括号配平', parsedSlice('brace-in-string.json').v,
  { actions: [{ type: 'msg', text: 'a}b {c} [d]' }] });
eq('空白与紧贴冒号都认', parsedSlice('whitespace.json').v, { actions: [] });

/* ---------------------------------------------------------- JS：配置 */

console.log('— callback 配置块（config.json 顶层 callback）');

state.cfg = null;
eq('不写配置 → 默认开、上限 5/5、不限 id、安静走托盘、原生弹窗',
  T.cbCfg(),
  { enabled: true, max: 5, maxDepth: 5, allow: [], onQuiet: 'notify', popup: 'native' });

state.cfg = { callback: { enabled: false, max: 99, maxDepth: 0, allow: ['a', 2], onQuiet: 'POPUP' } };
eq('显式配置逐项生效（max/maxDepth 夹到 1~20）',
  T.cbCfg(),
  { enabled: false, max: 20, maxDepth: 1, allow: ['a', '2'], onQuiet: 'popup', popup: 'native' });

state.cfg = { items: [] };
eq('顶层没有 callback 段 → 仍是默认', T.cbCfg().max, 5);

/* 弹窗机制：只认 native / custom，写错回落 native（少写一个字母不该变成不弹） */
state.cfg = { callback: { popup: 'CUSTOM' } };
eq('popup 大小写不敏感 → custom', T.cbCfg().popup, 'custom');
state.cfg = { callback: { popup: 'gui' } };
eq('popup 的别名 gui → custom', T.cbCfg().popup, 'custom');
state.cfg = { callback: { popup: 'msgbox' } };
eq('popup 写不认识的值 → 回落 native', T.cbCfg().popup, 'native');
state.cfg = { callback: { popup: 1 } };
eq('popup 写成数字 → 回落 native', T.cbCfg().popup, 'native');
state.cfg = { callback: { popup: 'native' } };
eq('popup 显式 native', T.cbCfg().popup, 'native');

/* ---------------------------------------------------------- JS：解析 */

console.log('— cbParse：把这块 JSON 归一成动作');

const p1 = T.cbParse(JSON.stringify({
  v: 1,
  actions: [
    { type: 'run', id: 'notepad' },
    { type: 'msg', level: 'success', title: '好了', text: '第一行\n第二行' }
  ]
}));
eq('标准结构 → 两个动作', p1.actions.map(a => a.kind), ['run', 'msg']);
eq('msg 字段原样保留', p1.actions[1],
  { kind: 'msg', level: 'success', title: '好了', text: '第一行\n第二行', timeout: 0 });

eq('_ql_callback 直接是数组也能用', T.cbParse('[{"type":"run","id":"a"}]').actions,
  [{ kind: 'run', id: 'a' }]);
eq('单个动作对象（简写）', T.cbParse('{"type":"run","id":"a"}').actions,
  [{ kind: 'run', id: 'a' }]);
eq('actions 给成单个对象', T.cbParse('{"actions":{"type":"run","id":"a"}}').actions,
  [{ kind: 'run', id: 'a' }]);

eq('类型别名：popup / exec',
  T.cbParse('{"actions":[{"type":"popup","text":"x"},{"type":"exec","id":"b"}]}').actions.map(a => a.kind),
  ['msg', 'run']);
eq('级别别名：fail → error，没写 → success',
  T.cbParse('{"actions":[{"type":"msg","level":"fail","text":"x"},{"type":"msg","text":"y"}]}').actions.map(a => a.level),
  ['error', 'success']);

eq('不认识的动作类型丢掉', T.cbParse('{"actions":[{"type":"nope"},{"type":"run","id":"a"}]}').actions,
  [{ kind: 'run', id: 'a' }]);
eq('msg 没文本 → 丢掉（不弹空框）', T.cbParse('{"actions":[{"type":"msg","text":"   "}]}').actions, []);
eq('run 没 id → 丢掉', T.cbParse('{"actions":[{"type":"run"}]}').actions, []);
eq('非对象的元素跳过', T.cbParse('{"actions":[1,"x",null,{"type":"run","id":"a"}]}').actions,
  [{ kind: 'run', id: 'a' }]);

const longText = 'x'.repeat(5000);
eq('超长文本截到 2000', T.cbParse(JSON.stringify({ actions: [{ type: 'msg', text: longText }] })).actions[0].text.length, 2000);
eq('超时夹到 0~600',
  T.cbParse('{"actions":[{"type":"msg","text":"x","timeout":9999},{"type":"msg","text":"y","timeout":-3}]}')
    .actions.map(a => a.timeout),
  [600, 0]);

eq('v 缺省按 1 处理', T.cbParse('{"actions":[{"type":"run","id":"a"}]}').err, '');
ok('v 比 1 大 → 整块忽略', !!T.cbParse('{"v":2,"actions":[{"type":"run","id":"a"}]}').skip);
eq('v 写成字符串也认', T.cbParse('{"v":"1","actions":[{"type":"run","id":"a"}]}').actions.length, 1);

ok('坏 JSON → 报错而不是抛异常', !!T.cbParse('{').err);
eq('null / 数字 → 没有动作', T.cbParse('null').actions, []);

/* ---------------------------------------------------------- JS：计划 */

console.log('— cbPlan：该跑的跑、该拦的拦');

state.all = [
  { id: 'a', name: 'A', type: 'webhook' },
  { id: 'b', name: 'B', type: 'webhook' },
  { id: 'c', name: 'C', type: 'app' },
  { id: 'Fixed', name: 'F', type: 'app' }
];

const cfg = () => ({ enabled: true, max: 5, maxDepth: 5, allow: [], onQuiet: 'notify' });
const plan = (actions, path, c) => T.cbPlan(actions, {
  cfg: c || cfg(),
  chain: { path: path || [], depth: (path || []).length },
  find: T.cbFindItem
});

const run = id => ({ kind: 'run', id: id });

eq('正常调用 → run，链上加上自己',
  plan([run('b')], ['a']).map(s => [s.kind, s.item.id, s.chain.path]),
  [['run', 'b', ['a', 'b']]]);

eq('自己调自己 → 环，阻断',
  plan([run('a')], ['a']).map(s => [s.kind, s.why]),
  [['skip', 'loop']]);

eq('A→B→A → 阻断', plan([run('a')], ['a', 'b']).map(s => [s.kind, s.why]), [['skip', 'loop']]);
eq('A→B→C 放行', plan([run('c')], ['a', 'b']).map(s => s.kind), ['run']);

eq('兄弟不算环：同一条链上重复调 B 两次都放行',
  plan([run('b'), run('b')], ['a']).map(s => s.kind), ['run', 'run']);

eq('id 不存在 → 静默跳过（不报错）',
  plan([run('nope')], ['a']).map(s => [s.kind, s.why]), [['skip', 'not-found']]);

eq('大小写不同也能找到', plan([run('fixed')], ['a']).map(s => s.item.id), ['Fixed']);

const allowCfg = cfg();
allowCfg.allow = ['b'];
eq('白名单外的一律不跑',
  plan([run('a'), run('b')], [], allowCfg).map(s => [s.kind, s.why || s.item.id]),
  [['skip', 'allow'], ['run', 'b']]);
eq('白名单不分大小写', (() => {
  const c = cfg(); c.allow = ['B'];
  return plan([run('b')], [], c).map(s => s.kind);
})(), ['run']);

const depthCfg = cfg();
depthCfg.maxDepth = 2;
eq('链深到上限 → 阻断',
  plan([run('c')], ['a', 'b'], depthCfg).map(s => [s.kind, s.why]),
  [['skip', 'depth']]);
eq('差一跳还能跑', plan([run('c')], ['a'], depthCfg).map(s => s.kind), ['run']);

const maxCfg = cfg();
maxCfg.max = 2;
eq('动作数超上限 → 只保留前 N 个',
  plan([run('b'), run('c'), run('b')], [], maxCfg).length, 2);

eq('msg 原样透传（不查 id、不占链）',
  plan([{ kind: 'msg', level: 'success', text: 'x', title: '', timeout: 0 }], ['a'])[0].kind, 'msg');

/* 链上的请求一律不占结果面板，但"有没有人在看"要一路传下去：
   定时任务触发的链，第三跳也不该半夜弹模态框 */
eq('quiet 从链上传给下一跳', plan([run('b')], ['a'])[0].chain.quiet, false);
eq('定时链的 quiet 一直带着',
  T.cbPlan([run('b')], {
    cfg: cfg(), chain: { path: ['a'], depth: 0, quiet: true }, find: T.cbFindItem
  })[0].chain.quiet, true);

/* ---------------------------------------------------------- JS：动作参数 */

console.log('— 回调动作的运行时参数（args / params + 响应模板）');

eq('args 原样带进动作',
  T.cbParse(JSON.stringify({ actions: [{ type: 'run', id: 'x', args: 'a b' }] })).actions[0].args, 'a b');
eq('args 也可以是数组（不受空格切分影响）',
  T.cbParse(JSON.stringify({ actions: [{ type: 'run', id: 'x', args: ['a b', 'c'] }] })).actions[0].args,
  ['a b', 'c']);
eq('argv 是 args 的别名',
  T.cbParse(JSON.stringify({ actions: [{ type: 'run', id: 'x', argv: '-v' }] })).actions[0].args, '-v');
eq('params 的值统一成字符串',
  T.cbParse(JSON.stringify({ actions: [{ type: 'run', id: 'x', params: { n: 3, ok: true } }] }))
    .actions[0].params, { n: '3', ok: 'true' });
eq('params 写成数组就当没写',
  T.cbParse(JSON.stringify({ actions: [{ type: 'run', id: 'x', params: ['a'] }] })).actions[0].params,
  undefined);

const ctx = T.cbSubstCtx(
  { status: 200, ms: 42, body: JSON.stringify({ data: { path: 'C:\\a b\\c.txt', n: 2, list: ['x', 'y'] } }) },
  { item: { id: 'hook', name: '钩子' } });

eq('{{body.a.b}} 按点号取值', T.cbFill('{{body.data.path}}', ctx), 'C:\\a b\\c.txt');
eq('{{body.x}} 数字也转成字符串', T.cbFill('{{body.data.n}}', ctx), '2');
eq('数组下标 [1] 和 .1 都认',
  [T.cbFill('{{body.data.list[1]}}', ctx), T.cbFill('{{body.data.list.1}}', ctx)], ['y', 'y']);
eq('中间节点直接给 JSON', T.cbFill('{{body.data}}', ctx), '{"path":"C:\\\\a b\\\\c.txt","n":2,"list":["x","y"]}');
eq('{{status}} / {{ms}} / {{error}}', T.cbFill('{{status}}|{{ms}}|{{error}}', ctx), '200|42|');
eq('{{from.id}} / {{from.name}}', T.cbFill('{{from.id}}/{{from.name}}', ctx), 'hook/钩子');
eq('{{body}} 给正文原文', T.cbFill('{{body}}', ctx).slice(0, 5), '{"dat');
eq('{{{{ 与 }}}} 转义成字面量', T.cbFill('{{{{x}}}}', ctx), '{{x}}');
eq('取不到的变量按空串', T.cbFill('[{{body.nope}}]', ctx), '[]');
ok('取不到的变量记进 miss（日志要用）', ctx.miss.indexOf('body.nope') >= 0, JSON.stringify(ctx.miss));
eq('正文不是 JSON 也不抛异常', T.cbFill('{{body.a}}', T.cbSubstCtx({ body: 'not json' }, null)), '');

eq('含空格的值补引号（否则会被拆成两个参数）',
  T.cbFill('{{body.data.path}}', ctx, { quote: true }), '"C:\\a b\\c.txt"');
eq('不含空格的值不补引号', T.cbFill('{{status}}', ctx, { quote: true }), '200');

eq('args 字符串里的模板会被填，含空格自动加引号',
  T.cbActionArgs({ kind: 'run', id: 'x', args: '--dir={{body.data.path}} --n={{body.data.n}}' }, ctx).text,
  '--dir="C:\\a b\\c.txt" --n=2');
eq('args 数组逐项加引号',
  T.cbActionArgs({ kind: 'run', id: 'x', args: ['{{body.data.path}}', 'plain'] }, ctx).text,
  '"C:\\a b\\c.txt" plain');
eq('params 填模板但不加引号（按名字给值，不走文本切分）',
  T.cbActionArgs({ kind: 'run', id: 'x', params: { p: '{{body.data.path}}', k: 'v' } }, ctx).preset,
  { p: 'C:\\a b\\c.txt', k: 'v' });
eq('计划里带着 args / params 往下走',
  plan([{ kind: 'run', id: 'b', args: 'x', params: { k: 'v' } }], ['a']).map(s => [s.args, s.params]),
  [['x', { k: 'v' }]]);

/* preset 是"按名字给值"的旁路：值里的空格不该被当成参数分隔符 */
const upItem = {
  id: 'up', type: 'app', target: 'app.exe', args: '--file={{file}} --mode={{mode}}',
  params: [{ name: 'file' }, { name: 'mode', default: 'fast' }]
};
const w1 = T.applyParams(upItem, '', { file: 'C:\\a b\\c.txt' });
eq('preset 灌进模板，空格不再被拆开', w1.item.args, '--file=C:\\a b\\c.txt --mode=fast');
eq('preset 满足了必填，不再算缺参数', w1.missing, []);
eq('没有 preset 时照旧按文本判缺失', T.applyParams(upItem, '', null).missing, ['file']);

console.log('\n' + (fail ? 'FAIL ' + fail + ' 项' : '全部通过') + '，通过 ' + pass + ' 项');
process.exit(fail ? 1 : 0);
