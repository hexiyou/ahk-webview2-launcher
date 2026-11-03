/* jsonfile 类型（读本地 JSON 文件）在前端的用例：
   目标解析、类型标签、是否接受运行时参数、必填校验、Tab 补全的路径判定
   （函数体同样从 ui/app.js 抽取，见 tests/harness.js）

   没有覆盖的部分：真正去读文件的是 AHK（DoReadJson / FileTargetPath），
   那一段由 tools\probe-jsonfile.ahk 验，node 这边抽不出来。 */
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

console.log('— target 原样保留');
/* 这几种写法全都由 AHK 的 FileTargetPath 解释，前端一个字都不能改：
   一旦当成相对路径去 absPath，file:// 就会被拼到脚本目录后面 */
eq('file:// + 反斜杠盘符原样保留',
  T.resolveTarget('jsonfile', 'file://c:\\example\\data.json'), 'file://c:\\example\\data.json');
eq('file:/// 三斜杠原样保留',
  T.resolveTarget('jsonfile', 'file:///C:/example/data.json'), 'file:///C:/example/data.json');
eq('裸绝对路径原样保留',
  T.resolveTarget('jsonfile', 'C:\\example\\data.json'), 'C:\\example\\data.json');
eq('UNC 原样保留',
  T.resolveTarget('jsonfile', '\\\\nas01\\share\\x.json'), '\\\\nas01\\share\\x.json');
eq('相对路径不被前端改写（按程序目录算是 AHK 的事）',
  T.resolveTarget('jsonfile', 'data\\x.json'), 'data\\x.json');
eq('空值还是空值', T.resolveTarget('jsonfile', '  '), '');

console.log('— 类型标签');
const j1 = T.normalizeItem({
  id: 'jf', name: '查看配置', type: 'jsonfile', target: 'file://c:\\example\\data.json'
}, 0);
eq('行内徽标显示 FILE', T.kindLabel(j1), 'FILE');
eq('type 被保住', j1.type, 'jsonfile');
eq('target 没被改写', j1.target, 'file://c:\\example\\data.json');
eq('jsonPath 默认空', j1.jsonPath, '');
eq('小写别名 jsonpath 也认',
  T.normalizeItem({ id: 'a', name: 'a', type: 'jsonfile', target: 'x', jsonpath: 'items[0]' }, 1).jsonPath,
  'items[0]');

console.log('— 运行时参数');
eq('没有 params 就不吃参数', T.takesArgs(j1), false);
const jp = T.normalizeItem({
  id: 'jf2', name: '看 JSON', type: 'jsonfile', target: 'file://{{path}}',
  params: [{ name: 'path', label: '文件', type: 'path' }]
}, 2);
eq('声明了 params 才接受参数', T.takesArgs(jp), true);

const w = T.applyParams(jp, 'C:\\example\\data.json');
eq('target 模板被替换', w.item.target, 'file://C:\\example\\data.json');
eq('没缺参数', w.missing, []);
/* 和 cmd 不同：jsonfile 的路径就是功能主体，缺了必须拦下来（applyParams 里
   jsonfile 和 webhook 一样算"网络型"，必填全校验） */
eq('缺必填会报缺', T.applyParams(jp, '').missing, ['path']);

console.log('— Tab 补全按路径处理');
const p1 = { name: 'path', type: 'path' };
eq('声明 type:path 就是路径', T.looksPathy('C:\\a', jp), true);
eq('带分隔符的输入算路径', T.looksPathy('data\\x.json', j1), true);
eq('盘符开头算路径', T.looksPathy('C:x', j1), true);
eq('纯词不算路径', T.looksPathy('abc', j1), false);

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
