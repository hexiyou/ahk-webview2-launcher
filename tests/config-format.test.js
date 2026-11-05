/* YAML / TOML 预览的纯函数用例：解析分派、规范化（Date / 循环引用）、报错定位。
   函数体从 ui/app.js 抽取（见 tests/harness.js），解析器用 ui/vendor 下的真文件，
   而不是另装一份 npm 版 —— 用例必须验的就是"装进项目的那两个文件"。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { build } = require('./harness');

const VENDOR = path.join(__dirname, '..', 'ui', 'vendor');

/* 按浏览器的样子加载：沙箱里没有 module / exports / define，逼它走"挂全局"那条分支 */
function loadVendor(file, globalName) {
  const sb = { console };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(VENDOR, file), 'utf8'), sb);
  if (!sb[globalName]) throw new Error(file + ' 没有挂出全局 ' + globalName);
  return sb[globalName];
}

const state = {
  groups: [], all: [],
  scriptDir: 'C:\\Tools\\launcher',
  els: { q: { value: '' } },
  __yaml: loadVendor('js-yaml.min.js', 'jsyaml'),
  __toml: loadVendor('smol-toml.js', 'smolToml')
};

const T = build(state, null,
  ['getByPath', 'plainData', 'parseStructured', 'describeParseError', 'analyzeResult'],
  'var window = { jsyaml: state.__yaml, smolToml: state.__toml };\n'
  + 'var FORMAT_LABEL = { json: "JSON", yaml: "YAML", toml: "TOML" };');

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

console.log('— 规范化：TOML 的 Date 不能画成 {}');
eq('Date 变 ISO 字符串', T.plainData(new Date('2024-01-02T03:04:05Z')), '2024-01-02T03:04:05.000Z');
eq('嵌在对象里的 Date', T.plainData({ born: new Date('2024-01-02T03:04:05Z') }),
  { born: '2024-01-02T03:04:05.000Z' });
eq('非法 Date 退成字符串', typeof T.plainData(new Date('nope')), 'string');

console.log('— 规范化：YAML 的循环引用');
const cyc = { name: 'a' };
cyc.self = cyc;
const fixed = T.plainData(cyc);
eq('自引用替换成提示', fixed.self, '（循环引用）');
eq('其余字段还在', fixed.name, 'a');
/* 同一个对象被两个键引用（锚点复用）是合法的，不是环，应该各自展开成两份 */
const shared = { k: 1 };
eq('共享引用不算环', T.plainData({ a: shared, b: shared }), { a: { k: 1 }, b: { k: 1 } });
/* 深一点的环：a → b → a */
const A = {}, B = { A: A };
A.B = B;
eq('间接环也能拦住', T.plainData(A).B.A, '（循环引用）');

console.log('— 规范化：其它');
eq('嵌套过深被截断', T.plainData({ a: { b: { c: 1 } } }, 1).a.b, '…（嵌套超过 1 层，已省略）');
eq('null / 数字 / 布尔原样',
  [null, 1, true].map(v => T.plainData(v)), [null, 1, true]);
eq('数组保持顺序', T.plainData([3, 1, 2]), [3, 1, 2]);

console.log('— 解析分派');
eq('JSON', T.parseStructured('{"a":1}', 'json'), { value: { a: 1 }, docs: 1 });
const y1 = T.parseStructured('a: 1\nb:\n  - x\n  - y\n', 'yaml');
eq('YAML 单文档', y1.value, { a: 1, b: ['x', 'y'] });
eq('YAML 单文档 docs=1', y1.docs, 1);
eq('未知格式按 JSON 兜底', T.parseStructured('{"a":1}', 'ini'), { value: { a: 1 }, docs: 1 });

console.log('— YAML 多文档');
const y2 = T.parseStructured('a: 1\n---\nb: 2\n---\nc: 3\n', 'yaml');
eq('三个文档包成数组', y2.value, [{ a: 1 }, { b: 2 }, { c: 3 }]);
eq('docs 计数', y2.docs, 3);
eq('标记 multi', y2.multi, true);
const y3 = T.parseStructured('---\na: 1\n---\nb: 2\n', 'yaml');
eq('开头带 --- 也算多文档', y3.docs, 2);

console.log('— 空文件');
eq('空 YAML 不抛错，标记 empty', T.parseStructured('', 'yaml'), { value: null, docs: 0, empty: true });
eq('只有注释的 YAML 也是 empty', T.parseStructured('# 全是注释\n', 'yaml').empty, true);
eq('空 TOML 是合法的空对象', T.parseStructured('', 'toml'), { value: {}, docs: 1 });

console.log('— TOML');
const t1 = T.parseStructured('title = "x"\n[owner]\nname = "Tom"\n[[items]]\nid = 1\n[[items]]\nid = 2\n', 'toml');
eq('表与数组表', t1.value, { title: 'x', owner: { name: 'Tom' }, items: [{ id: 1 }, { id: 2 }] });
const t2 = T.parseStructured('born = 2024-01-02T03:04:05Z\n', 'toml');
eq('TOML 日期已规范化成字符串', typeof t2.value.born, 'string');
ok('TOML 日期是 ISO 形状', t2.value.born.indexOf('2024-01-02') === 0, t2.value.born);

console.log('— 报错定位');
try { T.parseStructured('a: [1,\n  b: 2\n', 'yaml'); } catch (e) {
  const msg = T.describeParseError(e, 'yaml', '');
  ok('YAML 报错带行号', /第 3 行/.test(msg), msg);
  ok('YAML 报错带原因', /indent|indentation|flow/i.test(msg), msg);
}
try { T.parseStructured('a = 1\nb = [1,\n', 'toml'); } catch (e) {
  const msg = T.describeParseError(e, 'toml', '');
  ok('TOML 报错带行号', /第 3 行/.test(msg), msg);
  ok('TOML 报错去掉 "Invalid TOML document:" 前缀', !/^Invalid TOML/.test(msg), msg);
}
try { T.parseStructured('{\n  "a": 1,\n  "b" 2\n}', 'json'); } catch (e) {
  const msg = T.describeParseError(e, 'json', '{\n  "a": 1,\n  "b" 2\n}');
  ok('JSON 报错换算成行列', /第 3 行/.test(msg), msg);
}

console.log('— analyzeResult 走的是哪条路');
const baseItem = { jsonPath: '' };
const mk = (extra) => Object.assign({ body: '', item: baseItem, file: true, format: 'json' }, extra);

const a1 = T.analyzeResult(mk({ body: '{"a":1}', format: 'json' }));
eq('JSON 文件 isData', a1.isData, true);
eq('JSON 文件 format', a1.format, 'json');
const a2 = T.analyzeResult(mk({ body: 'a: 1', format: 'yaml' }));
eq('YAML 文件走 yaml', [a2.format, a2.isData, a2.data], ['yaml', true, { a: 1 }]);
const a3 = T.analyzeResult(mk({ body: 'a: 1', format: 'yaml', item: { jsonPath: 'a' } }));
eq('jsonPath 在 YAML 上同样可用', a3.extracted, 1);

/* 解析失败：不能把内容吞掉，正文还得能看原文 */
const a4 = T.analyzeResult(mk({ body: 'a: [1,', format: 'yaml' }));
eq('解析失败 isData=false', a4.isData, false);
ok('解析失败有 parseError', !!a4.parseError, a4.parseError);
eq('解析失败时 format 仍然保留（用来提示"不是 YAML"）', a4.format, 'yaml');

/* 网络响应没有 file / format 字段，一律按 JSON */
const a5 = T.analyzeResult({ body: '{"x":1}', item: baseItem });
eq('webhook 响应默认按 JSON', [a5.format, a5.isData], ['json', true]);

/* 空正文：不是错误 */
const a6 = T.analyzeResult(mk({ body: '' }));
eq('空正文标记 empty', [a6.empty, a6.parseError], [true, '']);

/* 格式字段缺失时按 JSON 说话（老回执 / 浏览器预览） */
const a7 = T.analyzeResult({ body: '{"a":1}', item: baseItem, file: true });
eq('缺 format 时按 JSON', a7.format, 'json');

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
