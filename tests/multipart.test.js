/* multipart（等价 curl -F）在前端的用例：
   三种写法归一化、条目归一化、模板替换进 files/fields、空配置的报错、
   请求头不被补上 application/json、以及交给 AHK 的压平格式。

   真正拼包和发送在 AHK（BuildMultipart / WebhookMain），那一段由
   tools/mp-e2e.js 用真 WebView2 + 真服务端验，node 这边抽不出来。 */
const { build } = require('./harness');

const WD = 'C:\\Tools\\launcher';
const SEP = '\u0001';

const state = {
  groups: [], all: [],
  scriptDir: WD,
  els: { q: { value: '' } }
};

const T = build(state, null,
  ['isProtocol', 'isAbsPath', 'absPath', 'resolveTarget', 'resolveSavePath',
    'looksPathy', 'currentParamDecl', 'kindLabel', 'normalizeItem',
    'buildBody', 'headerLines', 'mpFlat'],
  'var scriptDir = (state && state.scriptDir) || "";\n' +
  'var els = (state && state.els) || { q: { value: "" } };\n' +
  "const MP_SEP = '\\u0001';");

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b); }
}

console.log('— 归一化：三种写法');
const a = T.normalizeMultipart({ files: [{ field: 'photo', path: 'C:\\a.png' }] });
eq('对象 + files', a.files.length, 1);
eq('field 原样保留', a.files[0].field, 'photo');
eq('path 原样保留', a.files[0].path, 'C:\\a.png');
eq('没写 filename 就留空（AHK 取磁盘上的名字）', a.files[0].filename, '');
eq('没写 type 就留空（AHK 按扩展名猜）', a.files[0].type, '');

const b = T.normalizeMultipart([{ field: 'f1', path: 'a.bin' }, { field: 'f2', path: 'b.bin' }]);
eq('顶层数组简写', b.files.length, 2);
eq('数组里第二个也认', b.files[1].field, 'f2');

const c = T.normalizeMultipart({ field: 'doc', path: 'x.pdf' });
eq('单文件简化写法', c.files.length, 1);
eq('单文件写法字段名对', c.files[0].field, 'doc');

const d = T.normalizeMultipart({ fields: { note: 'hello', tag: 42 } });
eq('只有 fields 也能用', d.files.length, 0);
eq('fields 字符串值保留', d.fields.note, 'hello');
eq('fields 数字值被转成字符串', d.fields.tag, '42');

console.log('— 归一化：写坏的');
eq('空对象当没配', T.normalizeMultipart({}), null);
eq('undefined 当没配', T.normalizeMultipart(undefined), null);
eq('null 当没配', T.normalizeMultipart(null), null);
eq('files 里没 path 的整条被丢掉', T.normalizeMultipart({ files: [{ field: 'x' }] }), null);
eq('field 缺省是 file', T.normalizeMultipart({ path: 'a.bin' }).files[0].field, 'file');

console.log('— 条目归一化');
const it = T.normalizeItem({
  id: 'up', type: 'webhook', target: 'https://api/up', method: 'post',
  multipart: { files: [{ field: 'file', path: '{{path}}' }] }
}, 0);
eq('multipart 挂到了条目上', !!it.multipart, true);
eq('method 归一成大写', it.method, 'POST');
eq('没有 mpErr', it.mpErr, '');

const bad = T.normalizeItem({ id: 'b', type: 'webhook', target: 'x', multipart: {} }, 1);
eq('写了空 multipart 会记错误', /没有可用的文件/.test(bad.mpErr), true);
eq('坏掉的 multipart 归一成 null', bad.multipart, null);
eq('没写 multipart 的条目没有 mpErr',
  T.normalizeItem({ id: 'c', type: 'webhook', target: 'x' }, 2).mpErr, '');

console.log('— 模板替换进 multipart');
const web = T.normalizeItem({
  id: 'up2', type: 'webhook', target: 'https://api/up', method: 'POST',
  multipart: {
    fields: { note: '来自 {{who}}' },
    files: [{ field: 'file', path: '{{path}}' }]
  },
  params: [{ name: 'path', type: 'path' }, { name: 'who' }]
}, 0);
const w = T.applyParams(web, 'C:\\x\\a.png 老王');
eq('文件路径被参数填上', w.item.multipart.files[0].path, 'C:\\x\\a.png');
eq('字段值里的参数也填上', w.item.multipart.fields.note, '来自 老王');
eq('两个必填都缺时会一起报', T.applyParams(web, '').missing.slice().sort(), ['path', 'who']);
eq('被模板点名的参数不再追加到末尾', w.argv, []);

console.log('— 模板体检');
eq('声明了就不报错', T.templateIssues(web).err, []);
const undecl = { ...web, multipart: { files: [{ field: 'f', path: '{{nope}}' }] }, params: [] };
eq('没声明参数时只提醒不拦', T.templateIssues(undecl).err, []);
eq('提醒里点名了 nope', T.templateIssues(undecl).warn, ['nope']);
eq('mpErr 会被并进 err', /没有可用的文件/.test(T.templateIssues(bad).err.join('')), true);

console.log('— 请求头');
eq('multipart 不自动补 Content-Type', T.headerLines(web).some(l => /content-type/i.test(l)), false);
const plain = { ...web, multipart: null, body: '{"a":1}' };
eq('普通 body 仍然补 JSON', T.headerLines(plain).some(l => /application\/json/i.test(l)), true);
const own = { ...web, headers: ['Content-Type: multipart/form-data; boundary=abc'] };
eq('用户自己写了就照旧只留一条',
  T.headerLines(own).filter(l => /content-type/i.test(l)).length, 1);

console.log('— 交给 AHK 的压平格式');
const flat = T.mpFlat(web);
eq('files 一条', flat.files.length, 1);
eq('files 用 SOH 分成四段（field/path/name/type）', flat.files[0].split(SEP).length, 4);
eq('files 第一段是字段名', flat.files[0].split(SEP)[0], 'file');
eq('fields 一条', flat.fields.length, 1);
eq('fields 用 SOH 分成两段（name/value）', flat.fields[0].split(SEP).length, 2);
eq('没有 multipart 时给空数组', T.mpFlat({ multipart: null }), { files: [], fields: [] });

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
