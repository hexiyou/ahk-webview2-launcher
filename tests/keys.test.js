/* 空格键语义 / 切范围保选择（函数体从 ui/app.js 抽取，见 tests/harness.js）

   这一组的由来：空格只认文字（uniqueMatch）不认高亮行，`cmd␣` 里 "cmd" 精确
   命中的是 id 为 cmd 的「命令提示符」，于是不论高亮停在第三行还是第四行，
   空格都把参数态钉到第一条 —— 带参数调用后面几条永远是做不到的。 */
const { build } = require('./harness');

const state = {
  groups: [{ id: 'net', name: '网络' }, { id: 'dev', name: '开发' }],
  all: [],
  index: {}
};

const T = build(state, require('../ui/pinyin.js'));

/* 复刻事故现场：一条 id 恰好叫 cmd 的 app，加两条同样带 cmd 关键词的 cmd 条目 */
state.all = [
  { id: 'cmd', name: '命令提示符', keywords: ['cmd'], type: 'app', target: 'cmd.exe' },
  { id: 'x1', name: '示例甲 cmd 一条', keywords: ['cmd'], type: 'cmd', target: 'echo a' },
  { id: 'x2', name: '示例乙 cmd 两条', keywords: ['cmd'], type: 'cmd', target: 'echo b' },
  { id: 'dir', name: '工具目录', keywords: ['dir'], type: 'folder', target: 'C:\\tools' }
];

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b); }
}

console.log('— 事故现场：文字判据永远落回第一条');
const sp = T.splitArgs('cmd ');
eq('cmd␣ 的文字判据命中 id=cmd', sp && sp.item.id, 'cmd');
eq('与高亮哪一行无关（判据只吃文字）', sp && sp.head, 'cmd');

console.log('— spaceTarget：认高亮行');
const x2 = state.all[2];
eq('选中第三条 + 空格 → 进第三条的参数态', T.spaceTarget(x2, false, true), x2);
eq('没挪过选择 → 空格还是普通字符', T.spaceTarget(x2, false, false), null);
eq('已在参数态 → 空格就是空格', T.spaceTarget(x2, true, true), null);
eq('folder 不吃参数 → 不抢', T.spaceTarget(state.all[3], false, true), null);
eq('没有高亮行 → 不抢', T.spaceTarget(undefined, false, true), null);
eq('app 也能带参数', T.spaceTarget(state.all[0], false, true), state.all[0]);

console.log('— spaceTarget 不破多词搜索');
/* 「查看 ip」这类两段式搜索：只要用户没动过选择，空格必须还是分隔符 */
const multi = T.spaceTarget(x2, false, false);
eq('未挪选择时多词搜索不受影响', multi, null);

console.log('— selIndexById：Tab 切范围后找回原选中项');
const list = state.all.slice();
eq('按 id 找位置', T.selIndexById(list, 'x2'), 2);
eq('找不到返回 -1', T.selIndexById(list, 'nope'), -1);
eq('空 id 返回 -1', T.selIndexById(list, ''), -1);
eq('空列表返回 -1', T.selIndexById([], 'x2'), -1);
eq('undefined 列表不炸', T.selIndexById(undefined, 'x2'), -1);

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
