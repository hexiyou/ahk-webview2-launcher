/* 命令行条目解析（cliResolve / cliRank）用例
   （函数体同样从 ui/app.js 抽取，见 tests/harness.js）

   这一层决定 `ql run xxx` 到底跑哪条配置 —— 判错的代价是"静默跑错东西"，
   所以宁可报歧义也不替用户猜。 */
const { build } = require('./harness');
const PY = require('../ui/pinyin.js');

const state = { groups: [], all: [], index: {}, usage: {} };
const T = build(state, PY, ['cliRank', 'cliResolve']);

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b); }
}
function name(r) {
  if (r.none) return '(none)';
  if (r.amb) return 'amb:' + r.amb.map(x => x.id).join(',');
  return r.item.id;
}

/* ---------- 数据 ---------- */
state.groups = [{ id: 'sys', name: '系统' }, { id: 'net', name: '网络' }];
const mk = (id, nm, type, group, target, kw) => ({
  id: id, name: nm, type: type, group: group, keywords: kw || [],
  target: target || ('C:\\x\\' + id + '.exe'), params: []
});
state.all = [
  mk('notepad', '记事本', 'app', 'sys'),
  mk('cmd', '命令提示符', 'app', 'sys'),
  mk('ip', '查本机 IP', 'cmd', 'net', 'ipconfig /all'),
  mk('lookip', '查看公网 IP', 'cmd', 'net', 'curl ifconfig.me'),
  mk('marker', '标记一', 'ahk', 'sys'),
  mk('marker2', '标记二', 'ahk', 'sys'),
  Object.assign(mk('hook', '要参数的请求', 'webhook', 'net', 'https://example.com'),
    { params: [{ name: 'q', optional: false }] })
];

console.log('— id / 名称精确匹配');
eq('id 全等', name(T.cliResolve('notepad')), 'notepad');
eq('id 大小写不敏感', name(T.cliResolve('NotePad')), 'notepad');
eq('名称全等', name(T.cliResolve('记事本')), 'notepad');
eq('前后空白忽略', name(T.cliResolve('  marker  ')), 'marker');
eq('id 优先于名称（同值时先看 id）', name(T.cliResolve('cmd')), 'cmd');

console.log('— 没有精确命中时走打分');
eq('拼音首字母唯一命中', name(T.cliResolve('jsb')), 'notepad');
eq('前缀唯一命中', name(T.cliResolve('记事')), 'notepad');
eq('多候选 → 歧义', name(T.cliResolve('标记')), 'amb:marker,marker2');
eq('歧义里按分数排序', T.cliResolve('标记').amb.map(x => x.id), ['marker', 'marker2']);
eq('完全没有 → none', name(T.cliResolve('不存在的东西')), '(none)');
eq('空查询 → none', name(T.cliResolve('')), '(none)');
eq('只有空白 → none', name(T.cliResolve('   ')), '(none)');

console.log('— --first 的语义');
eq('--first 取最高分', name(T.cliResolve('标记', true)), 'marker');
eq('--first 不影响唯一命中', name(T.cliResolve('jsb', true)), 'notepad');
eq('--first 也救不了没命中', name(T.cliResolve('不存在的东西', true)), '(none)');

console.log('— 查询语法（> 命令模式 / @ 分组）');
eq('> 只搜动作型条目', name(T.cliResolve('>ip')), 'amb:ip,lookip');
eq('> 拼音首字母（请求 → qq）', name(T.cliResolve('>qq')), 'hook');
eq('> 真的没有就是没有', name(T.cliResolve('>zzzz')), '(none)');
const cmdIds = T.cliRank('>ip').map(x => x.it.id);
eq('> 把 app 类型排除在外', cmdIds.indexOf('notepad'), -1);
eq('@sys 分组内搜索', T.cliRank('@sys 标记').map(x => x.it.id), ['marker', 'marker2']);
eq('@net 分组内搜索', T.cliRank('@net ip').map(x => x.it.id).sort(), ['ip', 'lookip']);
eq('不存在的分组退回全量', T.cliRank('@nope marker').map(x => x.it.id), ['marker', 'marker2']);
eq('分组 + 命令模式', T.cliRank('@net>ip').map(x => x.it.id).sort(), ['ip', 'lookip']);

console.log('— 打分与频率加成');
const ranked = T.cliRank('ip').map(x => x.it.id);
eq('完全同分时保持配置顺序', ranked, ['ip', 'lookip']);
state.usage = { lookip: { n: 40, t: Math.floor(Date.now() / 1000) } };
eq('使用频率把同档次的顶上来', T.cliRank('ip').map(x => x.it.id), ['lookip', 'ip']);
state.usage = {};

console.log('— 空配置不炸');
const keep = state.all;
state.all = [];
eq('配置为空 → none', name(T.cliResolve('notepad')), '(none)');
eq('配置为空 → 空列表', T.cliRank('x').length, 0);
state.all = keep;

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
