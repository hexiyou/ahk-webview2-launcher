/* UNC 路径（\\server\share）在前端的处理用例：
   目标解析、相对路径拼接、Tab 补全拆解、file:// URL、参数是否被当路径
   （函数体同样从 ui/app.js 抽取，见 tests/harness.js） */
const { build } = require('./harness');

const WD = 'C:\\Tools\\launcher';

const state = {
  groups: [], all: [],
  scriptDir: WD,
  els: { q: { value: '' } }
};

const T = build(state, null,
  ['isProtocol', 'isAbsPath', 'absPath', 'resolveTarget', 'fileUrl', 'looksPathy', 'currentParamDecl', 'quoteWin'],
  'var scriptDir = (state && state.scriptDir) || "";\n' +
  'var els = (state && state.els) || { q: { value: "" } };');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b); }
}

const UNC = '\\\\nas01\\共享\\工具\\app.exe';

console.log('— 判定');
eq('UNC 不是协议头', T.isProtocol(UNC), false);
eq('UNC 里的盘符样片段不算协议', T.isProtocol('\\\\srv\\c:\\x'), false);
eq('UNC 是绝对路径', T.isAbsPath('\\\\nas01\\share'), true);
eq('正斜杠 UNC 也是绝对路径', T.isAbsPath('//nas01/share'), true);
eq('\\\\?\\UNC\\ 前缀也认', T.isAbsPath('\\\\?\\UNC\\nas01\\share'), true);
eq('普通盘符路径仍认', T.isAbsPath('D:\\x'), true);
eq('相对路径不认', T.isAbsPath('tools\\x'), false);

console.log('— absPath 不能被拼上脚本目录');
eq('UNC 原样保留', T.absPath(UNC), UNC);
eq('正斜杠 UNC 归一成反斜杠', T.absPath('//nas01/share/x'), '\\\\nas01\\share\\x');
eq('只有服务器名也不加前缀', T.absPath('\\\\nas01'), '\\\\nas01');
eq('\\\\?\\UNC 原样', T.absPath('\\\\?\\UNC\\nas01\\share\\a.txt'), '\\\\?\\UNC\\nas01\\share\\a.txt');
eq('相对路径照旧拼脚本目录', T.absPath('bin\\a.exe'), WD + '\\bin\\a.exe');

console.log('— resolveTarget(app / folder / ahk)');
eq('app 的 UNC 目标原样', T.resolveTarget('app', UNC), UNC);
eq('folder 的 UNC 目标原样', T.resolveTarget('folder', '\\\\nas01\\share'), '\\\\nas01\\share');
eq('ahk 的 UNC 目标原样', T.resolveTarget('ahk', '\\\\nas01\\share\\a.ahk'), '\\\\nas01\\share\\a.ahk');
eq('带 BOM 之外的首尾空格仍会 trim', T.resolveTarget('app', '  ' + UNC + '  '), UNC);
eq('裸命令名不受影响', T.resolveTarget('app', 'notepad.exe'), 'notepad.exe');
/* 历史遗留：cmd 的 target 是一整条命令行，不能被当路径改写 */
eq('cmd 原样（含 UNC 也不改写）', T.resolveTarget('cmd', 'dir \\\\nas01\\share'), 'dir \\\\nas01\\share');

console.log('— file:// URL（图标用）');
eq('UNC → file:/// 前缀 5 个斜杠', T.fileUrl('\\\\nas01\\share\\a b.png'),
  'file://///nas01/share/a%20b.png');

console.log('— Tab 补全：拆目录 / 前缀');
let sp = T.splitForComplete('\\\\nas01\\share\\docs\\rep', WD);
eq('UNC 目录部分原样', sp.base, '\\\\nas01\\share\\docs\\');
eq('UNC 已打前缀', sp.prefix, 'rep');
sp = T.splitForComplete('\\\\nas01\\share\\', WD);
eq('UNC 共享根：基准是共享根', sp.base, '\\\\nas01\\share\\');
eq('UNC 共享根：前缀为空', sp.prefix, '');
sp = T.splitForComplete('\\\\nas01\\share', WD);
eq('UNC 打到共享名：基准退回服务器', sp.base, '\\\\nas01\\');
eq('UNC 打到共享名：前缀是共享名', sp.prefix, 'share');
sp = T.splitForComplete('\\\\nas01', WD);
eq('UNC 只到服务器：基准是 \\\\', sp.base, '\\\\');
eq('UNC 只到服务器：前缀是服务器名', sp.prefix, 'nas01');
eq('UNC 不能被拼上 workdir', T.joinPath('\\\\nas01\\share', 'docs'), '\\\\nas01\\share\\docs');
eq('UNC token 算路径（会接管 Tab）', T.looksPathy('\\\\nas01\\share', { type: 'app' }), true);
eq('正斜杠 UNC 也算路径', T.looksPathy('//nas01/share', { type: 'app' }), true);

console.log('— 引号包裹的 UNC 参数');
let uq = T.unquoteToken('"\\\\nas01\\共享 目录\\a.txt"');
eq('引号拆掉只留内容', uq.tok, '\\\\nas01\\共享 目录\\a.txt');
eq('闭合标记', uq.closed, true);
uq = T.unquoteToken('"\\\\nas01\\共享 目录');
eq('未闭合时内容不带引号', uq.tok, '\\\\nas01\\共享 目录');
eq('未闭合标记', uq.closed, false);
eq('尾 token 范围（引号内空格不切）',
  T.lastTokenRange('app "\\\\nas01\\共享 目录\\a'), { start: 4, end: 20 });

console.log('— 参数切分：UNC 参数不能被拆成两半');
eq('引号包住的 UNC 带空格路径保留完整',
  T.splitQuoted('"\\\\nas01\\共享 目录\\a.txt" -x'), ['\\\\nas01\\共享 目录\\a.txt', '-x']);
eq('裸 UNC 参数（无空格）原样',
  T.splitQuoted('\\\\nas01\\share\\a.txt'), ['\\\\nas01\\share\\a.txt']);

/* 命令行引号规则：反斜杠只在引号前特殊。
   尾随反斜杠没翻倍的话，"\\nas\share\" 的闭合引号会被吃掉，参数和下一个参数黏在一起。 */
console.log('— 命令预览的引号（要和 exe 实际收到的一致）');
eq('尾随反斜杠但无空格 → 不加引号（没有歧义）', T.quoteWin('\\\\nas01\\share\\'), '\\\\nas01\\share\\');
eq('带空格的尾随反斜杠', T.quoteWin('\\\\nas01\\my share\\'), '"\\\\nas01\\my share\\\\"');
eq('普通 UNC（无需引号就不加）', T.quoteWin('\\\\nas01\\share\\a.txt'), '\\\\nas01\\share\\a.txt');
eq('带空格 → 加引号', T.quoteWin('\\\\nas01\\my share'), '"\\\\nas01\\my share"');
eq('盘符尾斜杠', T.quoteWin('C:\\Windows\\'), 'C:\\Windows\\');
eq('内嵌引号', T.quoteWin('a"b'), '"a\\"b"');
eq('引号前后有反斜杠', T.quoteWin('a\\\\"b'), '"a\\\\\\\\\\"b"');
eq('空参数', T.quoteWin(''), '""');

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
