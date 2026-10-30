/* 拼音 / 模糊打分 / 频率加成 / 参数补全 用例
   （函数体同样从 ui/app.js 抽取，见 tests/harness.js） */
const { build } = require('./harness');
const PY = require('../ui/pinyin.js');

const state = { groups: [], all: [], index: {}, usage: {} };
const T = build(state, PY);

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b); }
}
function truth(label, v) { eq(label, !!v, true); }

/* ---------- 数据 ---------- */
const nb = {
  id: 'notepad', name: '记事本', subtitle: '快速记录文本',
  keywords: ['notepad', 'txt', '文本'], type: 'app',
  target: 'C:\\Windows\\System32\\notepad.exe'
};
const vs = {
  id: 'vscode', name: 'VS Code', keywords: ['code', 'vsc'], type: 'app',
  target: 'C:\\Program Files\\Microsoft VS Code\\Code.exe'
};
const ipw = {
  id: 'ip', name: '查公网 IP', keywords: ['ip', '公网', '地址'], type: 'webhook',
  target: 'https://api64.ipify.org'
};
const lookip = {
  id: 'lookip', name: '查看本机 IP', keywords: ['ipconfig'], type: 'cmd',
  target: 'ipconfig /all'
};
state.all = [nb, vs, ipw, lookip];

console.log('— 拼音表');
eq('全拼', PY.full('记事本'), 'jishiben');
eq('首字母', PY.initials('记事本'), 'jsb');
eq('混排（拉丁原样保留）', PY.full('查公网 IP'), 'chagongwangip');
eq('混排首字母', PY.initials('查公网 IP'), 'cgwip');
eq('空格被吃掉', PY.full('VS Code'), 'vscode');
eq('ü 记作 v', PY.full('绿'), 'lv');
eq('生僻字返回空（不抛异常）', PY.full('\u{20BB7}'), '');
eq('空串', PY.full(''), '');

console.log('— fieldQuality 档位');
eq('全等 = 1', T.fieldQuality('记事本', '记事本', 1), 1);
eq('前缀 = 0.92', T.fieldQuality('记事本', '记事', 1), 0.92);
truth('子串 ≥ 0.7', T.fieldQuality('记事本', '事本', 1) >= 0.7);
truth('子串 < 前缀', T.fieldQuality('记事本', '事本', 1) < 0.92);
eq('关闭模糊时子序列不算命中', T.fieldQuality('notepad', 'npad', 0), 0);
truth('打开模糊时子序列命中', T.fieldQuality('notepad', 'npad', 1) > 0);
truth('模糊分上限 0.66', T.subseqQuality('notepad', 'npad') <= 0.66);
truth('连续命中比跳字给分高',
  T.subseqQuality('notepad', 'note') > T.subseqQuality('nxxoxxtxe', 'note'));

console.log('— 打分（拼音也参与）');
eq('中文全等 100', T.scoreOf(nb, '记事本'), 100);
eq('全拼 = 97', T.scoreOf(nb, 'jishiben'), 97);
eq('首字母 = 93', T.scoreOf(nb, 'jsb'), 93);
eq('拉丁名字压平后全等', T.scoreOf(vs, 'vscode'), 97);
eq('拉丁前缀', T.scoreOf(vs, 'vsc'), 89);
eq('跳字命中', T.scoreOf(nb, 'npad') > 0, true);
eq('拼音前缀（chagong）', T.scoreOf(ipw, 'chagong') > 0, true);
eq('全拼压过普通子串', T.scoreOf(nb, 'jishiben') > T.scoreOf(nb, '事本'), true);
eq('完全无关 = 0', T.scoreOf(nb, 'zzz'), 0);
eq('首字母前缀 = 0.92×0.93 ≈ 86', T.scoreOf(ipw, 'cgw'), 86);
eq('中文关键词照旧', T.scoreOf(nb, '文本') > 0, true);

console.log('— 多词 AND 仍然成立');
eq('「查看 ip」命中「查看本机 IP」', T.scoreOf(lookip, '查看 ip') > 0, true);
eq('有一词不中就整条不中', T.scoreOf(lookip, '查看 zzz'), 0);
eq('「查 ip」不会误伤到完全无关的条目', T.scoreOf(nb, '查 ip'), 0);

console.log('— 使用频率加成');
const now = Math.floor(Date.now() / 1000);
state.usage = {};
eq('没用过 = 0', T.usageBoost('x'), 0);
state.usage = { x: { n: 0, t: now, args: [] } };
eq('n=0 = 0', T.usageBoost('x'), 0);
state.usage = { x: { n: 50, t: now, args: [] }, y: { n: 1, t: now, args: [] } };
truth('用得多加分更多', T.usageBoost('x') > T.usageBoost('y'));
truth('加成封顶 8%', T.usageBoost('x') <= 8);
truth('至少能拉开差距', T.usageBoost('y') > 2);
state.usage.z = { n: 50, t: now - 365 * 86400, args: [] };
truth('长期不用会衰减', T.usageBoost('z') < T.usageBoost('x'));
eq('前缀 92 分 + 满额加成仍输给全等 100', Math.round(92 * (1 + 8 / 100)), 99);

console.log('— 参数补全：取当前 token');
eq('普通情形', T.lastTokenRange('a b'), { start: 2, end: 3 });
eq('尾随空格 = 正在打新 token', T.lastTokenRange('a '), { start: 2, end: 2 });
eq('引号内空格不断开', T.lastTokenRange('x "b c'), { start: 2, end: 6 });
eq('闭合引号后', T.lastTokenRange('x "b c" d'), { start: 8, end: 9 });
eq('空串', T.lastTokenRange(''), { start: 0, end: 0 });

console.log('— 参数补全：路径拆分');
eq('相对路径按 workdir 展开',
  [T.splitForComplete('src\\ap', 'C:\\w').base,
   T.splitForComplete('src\\ap', 'C:\\w').prefix,
   T.splitForComplete('src\\ap', 'C:\\w').dirPart],
  ['C:\\w\\src\\', 'ap', 'src\\']);
eq('盘符绝对路径不拼 workdir',
  [T.splitForComplete('D:\\Pr', 'C:\\w').base, T.splitForComplete('D:\\Pr', 'C:\\w').prefix],
  ['D:\\', 'Pr']);
eq('根目录保留反斜杠',
  [T.splitForComplete('C:\\', 'C:\\w').base, T.splitForComplete('C:\\', 'C:\\w').prefix],
  ['C:\\', '']);
eq('只有文件名',
  [T.splitForComplete('ap', 'C:\\w').base, T.splitForComplete('ap', 'C:\\w').prefix],
  ['C:\\w', 'ap']);
eq('正斜杠同样识别',
  [T.splitForComplete('src/ap', 'C:\\w').base, T.splitForComplete('src/ap', 'C:\\w').prefix],
  ['C:\\w\\src\\', 'ap']);

console.log('— 参数补全：引号包裹的 token');
eq('未闭合的引号', [T.unquoteToken('"C:\\Program Files').q, T.unquoteToken('"C:\\Program Files').tok,
  T.unquoteToken('"C:\\Program Files').closed], ['"', 'C:\\Program Files', false]);
eq('已闭合的引号', [T.unquoteToken('"C:\\a b"').tok, T.unquoteToken('"C:\\a b"').closed],
  ['C:\\a b', true]);
eq('单引号', T.unquoteToken("'x'").q, "'");
eq('没有引号', [T.unquoteToken('C:\\a').q, T.unquoteToken('C:\\a').tok], ['', 'C:\\a']);
eq('只有一个引号', T.unquoteToken('"').tok, '');

console.log('— 参数补全：工具函数');
eq('joinPath 去掉重复分隔符', T.joinPath('C:\\w\\', '\\src'), 'C:\\w\\src');
eq('joinPath 空参数', T.joinPath('', 'a'), 'a');
eq('公共前缀', T.longestCommonPrefix(['abc', 'abd', 'abz']), 'ab');
eq('公共前缀大小写不敏感（返回第一个串的大小写）', T.longestCommonPrefix(['ABC', 'abd']), 'AB');
eq('没有公共前缀', T.longestCommonPrefix(['a', 'b']), '');
eq('空列表', T.longestCommonPrefix([]), '');

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
