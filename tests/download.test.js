/* download 类型（webhook 的变种）在前端的用例：
   目标解析、保存路径解析、字段默认值、模板变量、是否接受运行时参数
   （函数体同样从 ui/app.js 抽取，见 tests/harness.js） */
const { build } = require('./harness');

const WD = 'C:\\Tools\\launcher';

const state = {
  groups: [], all: [],
  scriptDir: WD,
  els: { q: { value: '' } }
};

const T = build(state, null,
  ['isProtocol', 'isAbsPath', 'absPath', 'resolveTarget', 'resolveSavePath',
    'looksPathy', 'currentParamDecl', 'kindLabel', 'normalizeItem'],
  'var scriptDir = (state && state.scriptDir) || "";\n' +
  'var els = (state && state.els) || { q: { value: "" } };');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b); }
}

console.log('— 目标解析');
eq('download 的 target 是网址，原样保留',
  T.resolveTarget('download', 'https://example.com/a/b.json'), 'https://example.com/a/b.json');
eq('download 的 target 不会被拼上脚本目录',
  T.resolveTarget('download', 'http://x/y'), 'http://x/y');

console.log('— 保存路径');
eq('留空 = 交给 AHK 用系统「下载」目录', T.resolveSavePath(''), '');
eq('空值（null）同样视为留空', T.resolveSavePath(null), '');
/* %USERPROFILE% / %TEMP% 不能被前端当相对路径改写，否则展开就失效了 */
eq('%TEMP% 原样保留', T.resolveSavePath('%TEMP%\\ql'), '%TEMP%\\ql');
eq('%USERPROFILE% 原样保留', T.resolveSavePath('%USERPROFILE%\\Downloads'), '%USERPROFILE%\\Downloads');
eq('相对路径按脚本目录解析', T.resolveSavePath('downloads'), WD + '\\downloads');
eq('"." 就是脚本目录', T.resolveSavePath('.'), WD);
/* 尾部反斜杠前端原样保留，由 AHK 侧 RTrim —— 这里只保证"绝对路径不被改写" */
eq('绝对路径不动', T.resolveSavePath('D:\\dl\\'), 'D:\\dl\\');
eq('UNC 保存路径不动', T.resolveSavePath('\\\\nas01\\share\\dl'), '\\\\nas01\\share\\dl');
eq('正斜杠统一成反斜杠', T.resolveSavePath('D:/dl/x'), 'D:\\dl\\x');

console.log('— 字段默认值');
const d1 = T.normalizeItem({
  id: 'dl', name: '下载', type: 'download', target: 'https://x/y.txt'
}, 0);
eq('onExists 默认 skip', d1.onExists, 'skip');
eq('backup 默认 true（覆盖前先留 .bak）', d1.backup, true);
eq('reload 默认 false', d1.reload, false);
eq('fileName 默认空（用远端文件名）', d1.fileName, '');
eq('savePath 默认空（用系统下载目录）', d1.savePath, '');
eq('类型标签是「下载」', T.kindLabel(d1), '下载');

const d2 = T.normalizeItem({
  id: 'dl2', name: '下载2', type: 'download', target: 'https://x/y.txt',
  savePath: 'D:\\dl', fileName: '  a.zip  ', onExists: 'OverWrite',
  backup: false, reload: true
}, 1);
eq('onExists 大小写不敏感', d2.onExists, 'overwrite');
eq('fileName 去掉首尾空格', d2.fileName, 'a.zip');
eq('backup:false 生效', d2.backup, false);
eq('reload:true 生效', d2.reload, true);

const d3 = T.normalizeItem({
  id: 'dl3', name: '下载3', type: 'download', target: 'https://x/y.txt',
  savepath: '%TEMP%', filename: 'b.txt'
}, 2);
eq('小写别名 savepath 也认', d3.savePath, '%TEMP%');
eq('小写别名 filename 也认', d3.fileName, 'b.txt');

console.log('— 运行时参数');
eq('没有 params 就不吃参数（避免半截输入被吞）', T.takesArgs(d1), false);
const dp = T.normalizeItem({
  id: 'dl4', name: '下载4', type: 'download', target: 'https://x/{{file}}',
  fileName: '{{file}}', savePath: '%TEMP%\\{{dir}}',
  params: [{ name: 'file' }, { name: 'dir', optional: true, default: 'dl' }]
}, 3);
eq('声明了 params 才接受参数', T.takesArgs(dp), true);

const w = T.applyParams(dp, '报告.pdf');
eq('target 里的 {{file}} 被替换', w.item.target, 'https://x/报告.pdf');
eq('fileName 里的模板被替换', w.item.fileName, '报告.pdf');
eq('savePath 里的默认值也参与替换', w.item.savePath, '%TEMP%\\dl');
eq('缺必填时会被记成缺', T.applyParams(dp, '').missing, ['file']);
eq('必填项留空会报缺',
  T.applyParams(T.normalizeItem({
    id: 'x', name: 'x', type: 'download', target: 'https://x/{{f}}',
    params: [{ name: 'f' }]
  }, 4), '').missing, ['f']);

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
