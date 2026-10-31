/* 条目停用（`"enabled": false`）的归一化用例
   （函数体从 ui/app.js 抽取，见 tests/harness.js）

   这条属性的语义只有一句：**当它不存在**。搜索不出、`ql list` 不列、
   `ql run` 报"没找到"。所以过滤点必须只在一处（进 state.all 之前），
   下面的用例守的就是这个归一化规则本身。

   另外守一条容易被人"顺手优化"掉的东西：归一化在前、过滤在后。
   因为缺省 id 是按原始下标生成的（'item-' + i），先过滤会让后面条目的
   id 悄悄变样 —— 现有配置里没写 id 的条目全都会错位。 */
const { build } = require('./harness');

const state = { groups: [], all: [], index: {}, usage: {} };

/* normalizeItem 依赖这几个模块级函数，这里给最小替身：
   用例关心的是 enabled 归一化，不是路径解析 */
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

console.log('— 缺省即启用');
eq('不写 enabled → true', T.normalizeItem({ id: 'a', name: 'A' }, 0).enabled, true);
eq('空的条目对象 → true', T.normalizeItem({}, 0).enabled, true);
eq('null 条目 → true（不炸）', T.normalizeItem(null, 0).enabled, true);
eq('undefined 条目 → true（不炸）', T.normalizeItem(undefined, 0).enabled, true);

console.log('— 只有布尔 false 才算停用');
eq('enabled: false → 停用', T.normalizeItem({ id: 'a', enabled: false }, 0).enabled, false);
eq('enabled: true → 启用', T.normalizeItem({ id: 'a', enabled: true }, 0).enabled, true);
/* 手写 JSON 很容易写成字符串，这时候"猜"成停用会让条目莫名消失，
   不如当成写错、照常启用 —— 宁可多跑一条，也别让人对着配置找半天 */
eq('enabled: "false"（字符串）→ 仍启用', T.normalizeItem({ id: 'a', enabled: 'false' }, 0).enabled, true);
eq('enabled: 0 → 仍启用', T.normalizeItem({ id: 'a', enabled: 0 }, 0).enabled, true);
eq('enabled: null → 仍启用', T.normalizeItem({ id: 'a', enabled: null }, 0).enabled, true);

console.log('— 过滤顺序：先归一化，再筛');
const raw = [
  { id: 'keep', name: '留着' },
  { name: '没有 id 的停用条目', enabled: false },
  { name: '没有 id 的启用条目' }
];
const norm = raw.map(T.normalizeItem);
const on = norm.filter(it => it.enabled);
eq('停用的被剔掉', on.map(it => it.name), ['留着', '没有 id 的启用条目']);
/* 第 3 条（原始下标 2）依然拿到 item-2；若先过滤再归一化，它会变成 item-1 */
eq('缺省 id 仍按原始下标生成', on[1].id, 'item-2');
eq('停用条目的 id 也不占位', norm[1].id && norm[1].enabled, false);

console.log('— 其它字段不受影响');
const full = T.normalizeItem({ id: 'x', name: 'X', enabled: false, type: 'cmd', target: 'echo 1', pinned: true }, 0);
eq('停用不影响其余字段', [full.id, full.name, full.type, full.target, full.pinned],
  ['x', 'X', 'cmd', 'echo 1', true]);

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
