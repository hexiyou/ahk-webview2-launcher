/* 参数 / 查询语义用例（函数体从 ui/app.js 抽取，见 tests/harness.js） */
const { build } = require('./harness');

const state = {
  groups: [{ id: 'net', name: '网络' }, { id: 'dev', name: '开发' }],
  all: [],
  index: {}
};

const T = build(state, require('../ui/pinyin.js'));

/* ---------- 测试数据 ---------- */
state.all = [
  { id: 'vscode', name: 'VS Code', keywords: ['code', 'vsc'], type: 'app', group: 'dev', target: 'C:\\Program Files\\Microsoft VS Code\\Code.exe' },
  { id: 'ip', name: '查公网 IP', keywords: ['ip', 'webhook'], type: 'webhook', group: 'net', target: 'https://api64.ipify.org', params: [{ name: 'ip' }, { name: 'lang', optional: true }] },
  { id: 'ipq', name: '指定 IP', keywords: ['ipq'], type: 'webhook', group: 'net', target: 'http://ip-api.com/json/{{ip}}', params: [{ name: 'ip' }] },
  { id: 'dir', name: '工具目录', keywords: ['dir'], type: 'folder', group: 'dev', target: 'C:\\tools' },
  { id: 'cmd', name: '内网探测', keywords: ['ping'], type: 'cmd', group: 'net', target: 'ping 127.0.0.1' },
  { id: 'lookip', name: '查看本机 IP', keywords: ['ipconfig'], type: 'cmd', group: 'net', target: 'ipconfig /all' },
  { id: 'dup1', name: '同名', keywords: [], type: 'app', target: 'a.exe' },
  { id: 'dup2', name: '同名', keywords: [], type: 'app', target: 'b.exe' }
];

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b); }
}

console.log('— splitQuoted');
eq('普通切分', T.splitQuoted('a b  c'), ['a', 'b', 'c']);
eq('双引号保空格', T.splitQuoted('a "b c" d'), ['a', 'b c', 'd']);
eq('单引号', T.splitQuoted("a 'b c'"), ['a', 'b c']);
eq('路径带空格', T.splitQuoted('"C:\\my dir\\a.txt" --flag'), ['C:\\my dir\\a.txt', '--flag']);
eq('空串', T.splitQuoted('   '), []);
eq('未闭合引号', T.splitQuoted('a "b c'), ['a', 'b c']);

console.log('— takesArgs');
eq('app 可以', T.takesArgs(state.all[0]), true);
eq('folder 不行', T.takesArgs(state.all[3]), false);
eq('webhook 有 params 可以', T.takesArgs(state.all[1]), true);

console.log('— splitArgs 分界');
let r = T.splitArgs('vs code src/app.js');
eq('名字带空格取最长 head', r && [r.head, r.tail], ['vs code', 'src/app.js']);
eq('命中条目', r && r.item.id, 'vscode');

r = T.splitArgs('vs code ');
eq('尾随空格 tail 为空', r && [r.head, r.tail], ['vs code', '']);

r = T.splitArgs('vs ');
eq('唯一前缀也能进', r && r.item.id, 'vscode');

eq('中文前缀不在词边界 → 不分裂', T.splitArgs('查看 ip'), null);
r = T.splitArgs('查看本机 ');
eq('前缀落在词边界 → 分裂', r && r.item.id, 'lookip');
eq('没空格不分裂', T.splitArgs('ip'), null);
eq('folder 不分裂', T.splitArgs('工具目录 D:\\x'), null);
eq('同名歧义不分裂', T.splitArgs('同名 a.txt'), null);

r = T.splitArgs('@net>ip 8.8.8.8');
eq('带分组+命令前缀', r && [r.head, r.tail, r.item.id], ['@net>ip', '8.8.8.8', 'ip']);

r = T.splitArgs('指定 IP 1.1.1.1');
eq('中文名带空格', r && [r.head, r.tail], ['指定 IP', '1.1.1.1']);

r = T.splitArgs('ping 8.8.8.8');
eq('keyword 精确命中', r && r.item.id, 'cmd');

console.log('— 多词搜索（AND）');
const look = state.all.find(x => x.id === 'lookip');
eq('「查看 ip」能搜到「查看本机 IP」', T.scoreOf(look, '查看 ip') > 0, true);
eq('有一个词不命中就整条不命中', T.scoreOf(look, '查看 zzz'), 0);
eq('单词仍然正常', T.scoreOf(look, '查看') > 0, true);

console.log('— assignTokens');
const web = state.all[1];
let a = T.assignTokens(web, '8.8.8.8 en');
eq('位置式按声明顺序', a.values, { ip: '8.8.8.8', lang: 'en' });
a = T.assignTokens(web, 'lang=en');
eq('命名式跳过第一个', a.values, { lang: 'en' });
a = T.assignTokens(web, '8.8.8.8 x y');
eq('多余 token 计数', [a.values, a.extra], [{ ip: '8.8.8.8', lang: 'x' }, 1]);
a = T.assignTokens(web, '"8.8.8.8" en');
eq('引号包裹的参数', a.values, { ip: '8.8.8.8', lang: 'en' });
a = T.assignTokens(web, '1.2.3.4 ip=9.9.9.9');
eq('命名式覆盖位置值', a.values, { ip: '9.9.9.9' });

console.log('— resolveParamValues / withArgs');
let w = T.withArgs(web, {});
eq('必填缺失', w.missing, ['ip']);
w = T.withArgs(web, { ip: '1.1.1.1' });
eq('填了就不缺', w.missing, []);

const withDefault = { params: [{ name: 'lang', default: 'zh-CN' }, { name: 'fmt', optional: true }] };
w = T.withArgs(withDefault, {});
eq('默认值生效', w.args, { lang: 'zh-CN', fmt: '' });
eq('可选空不算缺', w.missing, []);

const ipq = state.all[2];
w = T.withArgs(ipq, { ip: '8.8.8.8' });
eq('target 模板替换', w.item.target, 'http://ip-api.com/json/8.8.8.8');
w = T.withArgs(ipq, {});
eq('空值保留路径', w.item.target, 'http://ip-api.com/json/');

console.log('— fillQuery 丢空键');
const qItem = {
  params: [{ name: 'lang' }],
  query: { lang: '{{lang}}', page: '1' }
};
w = T.withArgs(qItem, {});
eq('空模板键被丢弃', w.item.query, { page: '1' });
w = T.withArgs(qItem, { lang: 'en' });
eq('有值保留', w.item.query, { lang: 'en', page: '1' });

console.log('— 无 params 的条目原样返回');
const plain = { type: 'app', target: 'x.exe' };
eq('不声明就不改', T.withArgs(plain, { a: '1' }).item, plain);

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
