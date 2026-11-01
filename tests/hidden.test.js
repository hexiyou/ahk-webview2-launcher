/* 条目隐藏（`"hidden": true`）的用例
   （函数体从 ui/app.js 抽取，见 tests/harness.js）

   这条属性和 enabled 的语义**刻意不同**，用例守的就是这个差别：

     enabled:false —— 当它不存在。搜不到、ql list 不列、ql run 报没找到。
                      所以它是在「进 state.all 之前」就剔掉的。
     hidden:true   —— 只在界面里不出现。ql list 照样列、ql run 照样跑、
                      定时任务照样触发。所以它**必须**留在 state.all 里，
                      只有在交互入口（sourceFor 的 interactive）才被滤掉。

   一旦有人"顺手"把 hidden 也挪到 state.all 之前过滤，命令行和定时器会
   一起失灵 —— 而且界面上看不出任何异常，只是后台任务悄悄不跑了。
   下面几组用例就是钉这个的。 */
const { build } = require('./harness');

const state = { groups: [], all: [], vis: [], index: {}, usage: {} };

const prelude = [
  "const scriptDir = 'C:\\\\app';",
  'function absPath(p) { return p || \'\'; }',
  'function resolveTarget(t, p) { return p || \'\'; }',
  'function resolveSavePath(p) { return p || \'\'; }'
].join('\n');

const T = build(state, null, ['normalizeItem'], prelude);

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b); }
}

console.log('— 缺省不隐藏');
eq('不写 hidden → false', T.normalizeItem({ id: 'a', name: 'A' }, 0).hidden, false);
eq('空条目 → false', T.normalizeItem({}, 0).hidden, false);
eq('null 条目 → false（不炸）', T.normalizeItem(null, 0).hidden, false);
eq('undefined 条目 → false（不炸）', T.normalizeItem(undefined, 0).hidden, false);

console.log('— 只有布尔 true 才算隐藏');
eq('hidden: true → 隐藏', T.normalizeItem({ id: 'a', hidden: true }, 0).hidden, true);
eq('hidden: false → 不隐藏', T.normalizeItem({ id: 'a', hidden: false }, 0).hidden, false);
/* 和 enabled 相反的方向：这里"写错"一律当没写。
   理由是不对称的 —— enabled 写错成启用只是多跑一条；hidden 写错成隐藏，
   用户会在界面上彻底找不到这条，连"我明明配了"都搜不出来 */
eq('hidden: "true"（字符串）→ 不隐藏', T.normalizeItem({ id: 'a', hidden: 'true' }, 0).hidden, false);
eq('hidden: 1 → 不隐藏', T.normalizeItem({ id: 'a', hidden: 1 }, 0).hidden, false);
eq('hidden: "false" → 不隐藏', T.normalizeItem({ id: 'a', hidden: 'false' }, 0).hidden, false);
eq('hidden: null → 不隐藏', T.normalizeItem({ id: 'a', hidden: null }, 0).hidden, false);

console.log('— visibleOf：可见池');
const mixed = [
  { id: 'v1', name: '看得见', type: 'app' },
  { id: 'h1', name: '后台维护', type: 'cmd', hidden: true },
  { id: 'v2', name: '也看得见', type: 'app' }
].map((raw, i) => T.normalizeItem(raw, i));
eq('可见池剔掉 hidden', T.visibleOf(mixed).map(x => x.id), ['v1', 'v2']);
eq('原数组不动（不是原地 filter）', mixed.length, 3);
eq('空数组不炸', T.visibleOf([]), []);
eq('undefined 不炸', T.visibleOf(undefined), []);

console.log('— sourceFor：交互池 vs 命令行池');
const pool = [
  { id: 'show', name: '显示条目', type: 'app', group: 'g1' },
  { id: 'hide', name: '显示条目（后台）', type: 'cmd', group: 'g1', hidden: true },
  { id: 'hide2', name: '另一个后台任务', type: 'webhook', hidden: true }
].map((raw, i) => T.normalizeItem(raw, i));

state.all = pool;
state.vis = T.visibleOf(pool);
state.groups = [{ id: 'g1', name: '一组' }];

eq('交互：全量里没有 hidden', T.sourceFor('all', null, true).map(x => x.id), ['show']);
eq('命令行：全量里有 hidden', T.sourceFor('all', null).map(x => x.id), ['show', 'hide', 'hide2']);
eq('交互 + 命令模式：hide 是 cmd 也不出现', T.sourceFor('cmd', null, true).map(x => x.id), []);
eq('命令行 + 命令模式：两条都在（cmd 与 webhook 都算命令）', T.sourceFor('cmd', null).map(x => x.id), ['hide', 'hide2']);
eq('交互 + 分组：只剩可见的', T.sourceFor('group', { id: 'g1' }, true).map(x => x.id), ['show']);
eq('命令行 + 分组：两条都在', T.sourceFor('group', { id: 'g1' }).map(x => x.id), ['show', 'hide']);

/* 交互时直接用 state.vis（预计算）；没预计算（测试夹具 / 老状态）就现算。
   这两条路结果必须一致，否则界面和命令行会各说一套 */
state.vis = undefined;
eq('没有 state.vis 时退回现算', T.sourceFor('all', null, true).map(x => x.id), ['show']);
state.vis = T.visibleOf(pool);

console.log('— 与 enabled 的组合');
const both = [
  { id: 'on-hidden', name: '启用但隐藏', enabled: true, hidden: true },
  { id: 'off-shown', name: '停用但显示', enabled: false, hidden: false },
  { id: 'off-hidden', name: '停用且隐藏', enabled: false, hidden: true }
].map((raw, i) => T.normalizeItem(raw, i));
const enabledOnly = both.filter(it => it.enabled);     /* applyConfig 里那一步 */
eq('停用的两条都进不了 state.all', enabledOnly.map(x => x.id), ['on-hidden']);
eq('enabled + hidden 仍留在 state.all', enabledOnly.length, 1);
eq('但它不在可见池里', T.visibleOf(enabledOnly).map(x => x.id), []);
/* 也就是说：enabled:false 优先，hidden 管不到停用的条目 —— 两条一起写等于停用 */
eq('两条一起写 = 彻底不出现（连 ql 也找不到）', T.visibleOf(enabledOnly).length, 0);

console.log('— 其余字段不受影响');
const full = T.normalizeItem({
  id: 'x', name: 'X', hidden: true, type: 'cmd', target: 'echo 1',
  pinned: true, keywords: ['k'], args: '/c', enabled: true
}, 0);
eq('hidden 不影响其余字段',
  [full.id, full.name, full.type, full.target, full.pinned, full.enabled, full.args],
  ['x', 'X', 'cmd', 'echo 1', true, true, '/c']);
eq('keywords 照旧', full.keywords, ['k']);

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
