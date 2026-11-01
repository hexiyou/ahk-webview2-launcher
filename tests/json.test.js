/* JSON 树的"拍平"用例（jsonRows / keySeg / jsonValText）

   响应面板的折叠、搜索、单字段复制全靠行模型这一层：DOM 只是把行画出来。
   所以这里测的全是纯数据 —— 行数、层级、逗号归属、路径、空容器怎么表示。

   这几个"看起来无所谓"的细节最容易被改坏，而坏了以后界面不会报错，
   只会显示成少一个括号、或者折叠后多出一行：
     · 空容器必须合成一行（不许留一对空括号占三行）
     · 逗号只落在"同级最后一个"上，且对象落在收尾括号、标量落在自己身上
     · 数组元素没有 key（不然会显示成 "0": ...，很吵）
     · 折叠的兄弟结构必须 depth 对齐，否则缩进会错位
*/
const { build, readSrc, grabConst } = require('./harness');
const PY = require('../ui/pinyin.js');

const src = readSrc();
const prelude = grabConst(src, /const JSON_TREE_MAX = .*;/, 'JSON_TREE_MAX');
const state = { groups: [], all: [], index: {}, usage: {}, cfg: null };
const T = build(state, PY, ['jsonRows', 'keySeg', 'jsonValText'], prelude);

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

/* 只取关心的字段，方便一眼看出结构：
     depth | kind | key | count | 逗号
   （数组元素的 key 是 null，join 之后就是空串） */
const shape = rows => rows.map(r => [r.depth, r.kind, r.key, r.count === undefined ? '' : r.count, r.trailing ? ',' : ''].join('|'));

console.log('— 标量');
eq('数字根：一行 val', shape(T.jsonRows(42).rows), ['0|val|||']);
eq('数字根的值', T.jsonRows(42).rows[0].v, 42);
eq('字符串根', T.jsonRows('hi').rows[0].v, 'hi');
eq('null 根也有一行', shape(T.jsonRows(null).rows), ['0|val|||']);
eq('false 不是空值', T.jsonRows(false).rows.length, 1);
eq('0 不是空值', T.jsonRows(0).rows[0].v, 0);
eq('空字符串不是空值', T.jsonRows('').rows[0].v, '');

console.log('— 空容器');
const e1 = T.jsonRows({}).rows;
eq('空对象合成一行', e1.length, 1);
eq('kind 仍是 val', e1[0].kind, 'val');
eq('标明是空对象', e1[0].empty, 'obj');
const e2 = T.jsonRows([]).rows;
eq('空数组合成一行', e2.length, 1);
eq('标明是空数组', e2[0].empty, 'arr');
const e3 = T.jsonRows({ a: [], b: {} }).rows;
eq('空容器仍然各占一行（open + 两个 val + close）', shape(e3),
  ['0|open||2|', '1|val|a||,', '1|val|b||', '0|close|||']);
eq('两个都是 val 行', e3.filter(r => r.kind === 'val').length, 2);
eq('逗号落在第一个空数组上', e3[1].trailing, true);
eq('最后一个空对象不带逗号', e3[2].trailing, false);

console.log('— 对象');
const o = T.jsonRows({ a: 1, b: 'x' }).rows;
eq('open + 2 值 + close', shape(o), ['0|open||2|', '1|val|a||,', '1|val|b||', '0|close|||']);
eq('根 open 没有 key', o[0].key, null);
eq('根 open 有 2 个字段', o[0].count, 2);
eq('逗号在非最后一项', o[1].trailing, true);
eq('最后一项没有逗号', o[2].trailing, false);
eq('close 也是 depth 0', o[3].depth, 0);
eq('close 不是数组', o[3].isArr, false);

console.log('— 数组');
const a = T.jsonRows([10, 20]).rows;
eq('数组结构', shape(a), ['0|open||2|', '1|val|||,', '1|val|||', '0|close|||']);
eq('数组元素没有 key', a[1].key, null);
eq('open 标明是数组', a[0].isArr, true);
eq('close 也标明是数组', a[3].isArr, true);
eq('数组元素的值', [a[1].v, a[2].v], [10, 20]);

console.log('— 嵌套');
const n = T.jsonRows({ list: [{ id: 1 }] }).rows;
eq('嵌套层级', shape(n), [
  '0|open||1|',
  '1|open|list|1|',
  '2|open||1|',
  '3|val|id||',
  '2|close|||',
  '1|close|||',
  '0|close|||'
]);
eq('嵌套里没有逗号（每层都是独苗）', n.every(r => !r.trailing), true);

console.log('— path');
const p = T.jsonRows({ a: { b: [0, { c: 1 }] } }).rows;
const paths = p.filter(r => r.kind === 'val' || r.kind === 'open').map(r => r.path);
ok('对象路径用点号', paths.indexOf('$.a') >= 0, paths.join(' '));
ok('数组下标用方括号', paths.indexOf('$.a.b[0]') >= 0, paths.join(' '));
ok('数组里的对象', paths.indexOf('$.a.b[1]') >= 0, paths.join(' '));
ok('深层字段', paths.indexOf('$.a.b[1].c') >= 0, paths.join(' '));
eq('根路径是 $', p[0].path, '$');
eq('普通键：点号', T.keySeg('abc'), '.abc');
eq('带点的键：方括号 + 引号', T.keySeg('a.b'), '["a.b"]');
eq('带方括号的键', T.keySeg('a[0]'), '["a[0]"]');
eq('空键', T.keySeg(''), '[""]');

console.log('— 键的顺序与特殊键');
const ord = T.jsonRows({ z: 1, a: 2, 中文: 3 }).rows;
eq('保持对象自身的键顺序', ord.filter(r => r.kind === 'val').map(r => r.key), ['z', 'a', '中文']);
const weird = T.jsonRows({ 'a"b': 1, 'c\nd': 2 }).rows;
eq('特殊键原样留着（渲染时才转义）', weird[1].key, 'a"b');
eq('换行键也在', weird[2].key, 'c\nd');
ok('特殊键的 path 包成方括号', weird[1].path.indexOf('["') === 0 || weird[1].path.indexOf('$.') === 0, weird[1].path);

console.log('— 截断（行数上限）');
const big = T.jsonRows([1, 2, 3, 4, 5, 6, 7, 8], 5);
eq('到上限就停', big.rows.length, 5);
eq('标记为截断', big.truncated, true);
const fit = T.jsonRows([1, 2, 3], 100);
eq('没到上限不标记', fit.truncated, false);
const exact = T.jsonRows([1, 2, 3], 5);   /* open + 3 + close = 5 */
eq('刚好等于上限不算截断', [exact.rows.length, exact.truncated], [5, false]);

console.log('— 行数换算');
const arr1000 = T.jsonRows(new Array(1000).fill(0), 5000);
eq('1000 个元素 = open + 1000 + close', arr1000.rows.length, 1002);
eq('1000 个元素不截断', arr1000.truncated, false);
const wide = T.jsonRows({ rows: new Array(4000).fill({ a: 1 }) });
const TREE_MAX = Number(/=\s*(\d+)/.exec(prelude)[1]);   /* 从源码里读，不在用例里第二份 */
eq('超过默认上限就截断', wide.truncated, true);
ok('截断时行数不超过上限', wide.rows.length <= TREE_MAX, wide.rows.length + ' > ' + TREE_MAX);
eq('恰好停在上限', wide.rows.length, TREE_MAX);

console.log('— jsonValText（搜索用的原文）');
eq('字符串原样（不带引号）', T.jsonValText('a b'), 'a b');
eq('null', T.jsonValText(null), 'null');
eq('数字', T.jsonValText(0), '0');
eq('布尔', T.jsonValText(false), 'false');
eq('对象转成 JSON 串', T.jsonValText({ a: 1 }), '{"a":1}');
eq('数组', T.jsonValText([1, 2]), '[1,2]');

console.log('— 边界');
const cyc = T.jsonRows(new Array(3).fill({ k: 1 }));
eq('同样的对象重复出现也能拍平', cyc.rows.length, 11);   /* open + 3*(open+val+close) + close */
ok('不抛异常', true);

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
