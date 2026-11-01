/* file:// URI → 本地路径（函数体从 ui/app.js 抽取，见 tests/harness.js）

   为什么这件事归页面管：宿主侧的 PathCreateFromUrlW 会把 %E6%8B%96 解成
   U+00E6 U+008B U+0096（一个字节一个字符），中文路径必然乱码 —— 实测踩过。
   页面用 new URL + decodeURIComponent 才是对的，而且这样才能写用例。 */
const { build } = require('./harness');

const state = { groups: [], all: [], index: {} };
const T = build(state, require('../ui/pinyin.js'));

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b); }
}

console.log('— 本地路径');
eq('纯 ASCII', T.fileUrlToPath('file:///C:/Windows/win.ini'), 'C:\\Windows\\win.ini');
eq('%20 空格', T.fileUrlToPath('file:///C:/my%20dir/a.txt'), 'C:\\my dir\\a.txt');
eq('中文（UTF-8 多字节）', T.fileUrlToPath('file:///C:/%E6%8B%96%E5%85%A5/%E6%B5%8B%E8%AF%95.txt'),
  'C:\\拖入\\测试.txt');
eq('空格 + 中文混着来', T.fileUrlToPath('file:///C:/Temp/ql%20%E6%8B%96%E5%85%A5%20test.txt'),
  'C:\\Temp\\ql 拖入 test.txt');
eq('%23 是文件名里的井号，不是锚点', T.fileUrlToPath('file:///C:/a%23b.txt'), 'C:\\a#b.txt');
eq('盘符大小写原样', T.fileUrlToPath('file:///c:/x.txt'), 'c:\\x.txt');
eq('localhost 当本地', T.fileUrlToPath('file://localhost/C:/x.txt'), 'C:\\x.txt');

console.log('— UNC');
eq('file://server/share', T.fileUrlToPath('file://server/share/a.txt'), '\\\\server\\share\\a.txt');
eq('UNC 带空格', T.fileUrlToPath('file://nas/%E5%85%B1%E4%BA%AB/a%20b.txt'),
  '\\\\nas\\共享\\a b.txt');

console.log('— 不是文件 / 不合法');
eq('http 不放行', T.fileUrlToPath('https://example.com/x.txt'), '');
eq('空串', T.fileUrlToPath(''), '');
eq('undefined', T.fileUrlToPath(undefined), '');
eq('不是 URL 的一串话', T.fileUrlToPath('随便一段文字'), '');
eq('坏转义不抛异常', T.fileUrlToPath('file:///C:/a%zz.txt'), 'C:\\a%zz.txt');

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
