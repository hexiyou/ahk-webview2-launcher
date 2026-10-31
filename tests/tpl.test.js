/* 模板变量（{{x}}）的四条边界用例。函数体全部从 ui/app.js 抽取，见 tests/harness.js。
   这四条是本功能的设计口径，改实现时先看这里：
     1. 只有声明了 params 的条目才替换，没声明整条不替换
     2. 被模板消耗掉的参数不再往末尾追加
     3. 拼错的变量在执行前就报错，不静默变成空串
     4. {{{{ 和 }}}} 是字面量逃生口 */
const { build } = require('./harness');

const state = { groups: [], all: [], index: {}, usage: {} };
const T = build(state, require('../ui/pinyin.js'));

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b); }
}

console.log('— 边界 1：没声明 params 就整条不替换');
{
  const cmd = { type: 'cmd', target: 'echo in cmd3 && echo {{cmdline}}' };
  const w = T.applyParams(cmd, '55555');
  eq('target 原样留着', w.item.target, 'echo in cmd3 && echo {{cmdline}}');
  eq('item 就是原对象（没做副本）', w.item === cmd, true);
  eq('参数照旧追加', w.argvRaw, '55555');
  eq('used 为空', w.used.size, 0);

  /* 这才是这次要治的那个现象：同一个 target，加上 params 就该被替换 */
  const cmd2 = Object.assign({ params: [{ name: 'cmdline' }] }, cmd);
  const w2 = T.applyParams(cmd2, '55555');
  eq('声明了 params 就替换', w2.item.target, 'echo in cmd3 && echo 55555');
  eq('消耗掉的不再追加', w2.argvRaw, '');
}

console.log('— 边界 2：被模板消耗的参数不再追加');
{
  const it = {
    type: 'cmd', target: 'tool --out {{out}}',
    params: [{ name: 'out' }, { name: 'flag', optional: true }]
  };
  let w = T.applyParams(it, '"a b.txt" --verbose');
  eq('消耗的进模板', w.item.target, 'tool --out a b.txt');
  eq('没消耗的才追加', w.argvRaw, '--verbose');
  eq('含空格的 token 补回引号', T.joinTokens(['a b', 'c']), '"a b" c');

  /* 一个模板都不用：行为必须和以前一模一样（全部按顺序追加） */
  const plain = { type: 'cmd', target: 'echo', params: [{ name: 'a' }, { name: 'b', optional: true }] };
  w = T.applyParams(plain, 'x y');
  eq('全不消耗时按声明顺序追加', w.argvRaw, 'x y');
  eq('没消耗就不会有 missing', w.missing, []);
}

console.log('— 边界 2b：多余 token 仍然追加');
{
  const it = { type: 'cmd', target: 'run {{a}}', params: [{ name: 'a' }] };
  const w = T.applyParams(it, '1 2 3');
  eq('模板只吃 a', w.item.target, 'run 1');
  eq('多出来的 2 3 追加', w.argvRaw, '2 3');
}

console.log('— 边界 3：拼错的变量提前报错');
{
  const bad = { id: 'cmd3', type: 'cmd', target: 'echo {{Cmldine}}', params: [{ name: 'cmdline' }] };
  const t = T.templateIssues(bad);
  eq('抓到了', t.err.length, 1);
  eq('文案里带变量名', /Cmldine/.test(t.err[0]), true);

  /* 大小写写反了才给「是不是想写」的提示；单纯拼错（字母顺序不对）不猜，
     免得指到另一个变量上去 —— 错误消息里已经列了变量名，对照 params 一眼就能看出来 */
  const cs = { type: 'cmd', target: 'echo {{CmdLine}}', params: [{ name: 'cmdline' }] };
  eq('大小写不同给提示', /是不是想写 cmdline/.test(T.templateIssues(cs).err[0]), true);
  eq('纯拼错就不瞎猜', /是不是想写/.test(t.err[0]), false);

  const typo = { type: 'cmd', target: 'echo {{nope}}', params: [{ name: 'cmdline' }] };
  eq('完全不认识的变量也报', T.templateIssues(typo).err.length, 1);
  eq('没有近似项就不瞎猜', /是不是想写/.test(T.templateIssues(typo).err[0]), false);

  eq('拼对了就不报', T.templateIssues(
    { type: 'cmd', target: 'echo {{cmdline}}', params: [{ name: 'cmdline' }] }).err, []);
}

console.log('— 边界 3b：没声明 params 但有 {{…}} → 只警告不拦');
{
  const t = T.templateIssues({ type: 'cmd', target: 'echo {{cmdline}}' });
  eq('不报错', t.err, []);
  eq('只警告', t.warn, ['cmdline']);
  eq('同一变量只警告一次', T.templateIssues(
    { type: 'app', target: 'a {{x}}', args: 'b {{x}}' }).warn, ['x']);
}

console.log('— 边界 4：字面量逃生口');
{
  const esc = { type: 'cmd', target: 'jinja --tpl "{{{{name}}}}"', params: [{ name: 'name' }] };
  eq('{{{{x}}}} 还原成字面 {{x}}', T.applyParams(esc, 'v').item.target, 'jinja --tpl "{{name}}"');
  eq('转义写法不算引用变量', T.tplVars(esc.target).size, 0);
  eq('所以不会被判成拼错', T.templateIssues(esc).err, []);

  eq('单独的字面 {{{{', T.fillTemplate('a {{{{ b', {}), 'a {{ b');
  eq('单独的字面 }}}}', T.fillTemplate('a }}}} b', {}), 'a }} b');
  eq('混着来', T.fillTemplate('{{x}} {{{{x}}}}', { x: '1' }), '1 {{x}}');
}

console.log('— 模板生效的字段');
{
  const it = {
    type: 'app', target: 'C:\\{{tool}}.exe', args: '--dir {{dir}}',
    params: [{ name: 'tool' }, { name: 'dir' }]
  };
  const w = T.applyParams(it, 'code C:\\work');
  eq('target', w.item.target, 'C:\\code.exe');
  eq('args', w.item.args, '--dir C:\\work');
  eq('两个都被消耗，不追加', w.argv, []);

  /* workdir 不参与模板：它早在 normalizeItem 里就按"相对脚本目录"展开成绝对路径了，
     再替换只会得到 D:\app\C:\work 这种四不像。写进来就原样不管。 */
  const wd = { type: 'cmd', target: 'x', workdir: 'C:\\{{dir}}', params: [{ name: 'dir' }] };
  eq('workdir 不做替换', T.applyParams(wd, 'w').item.workdir, 'C:\\{{dir}}');
  eq('也不把它算成引用', T.templateIssues(wd).err, []);
}

console.log('— 必填校验的范围');
{
  /* 非网络类型：只有模板真的用到的那个才拦，没用到的照旧放过 */
  const net = { type: 'webhook', target: 'https://x/{{a}}', params: [{ name: 'a' }, { name: 'b' }] };
  eq('网络类型照旧全查', T.applyParams(net, '').missing, ['a', 'b']);

  const cmd = { type: 'cmd', target: 'echo {{a}}', params: [{ name: 'a' }, { name: 'b' }] };
  eq('cmd 只查模板用到的', T.applyParams(cmd, '').missing, ['a']);

  const unused = { type: 'cmd', target: 'echo', params: [{ name: 'b' }] };
  eq('一个模板都没用就不查', T.applyParams(unused, '').missing, []);
}

console.log('— 默认值参与替换');
{
  const it = { type: 'cmd', target: 'ping {{host}}', params: [{ name: 'host', default: '127.0.0.1' }] };
  eq('缺省值填进去', T.applyParams(it, '').item.target, 'ping 127.0.0.1');
  eq('也被算作消耗，不追加', T.applyParams(it, '').argvRaw, '');
}

console.log('— 含空格的取值自动补引号（只对 app / ahk 的 args）');
{
  const it = { type: 'app', target: 'C:\\notepad.exe', args: '{{file}}', params: [{ name: 'file' }] };
  eq('独占一个位置才补', T.applyParams(it, '"C:\\my dir\\a.txt"').item.args, '"C:\\my dir\\a.txt"');
  eq('没空格就不补', T.applyParams(it, 'a.txt').item.args, 'a.txt');

  const inline = Object.assign({}, it, { args: '--dir={{file}}' });
  eq('嵌在参数里不补', T.applyParams(inline, '"C:\\my dir"').item.args, '--dir=C:\\my dir');

  const quoted = Object.assign({}, it, { args: '-f "{{file}}"' });
  eq('已经写了引号就不重复加', T.applyParams(quoted, '"C:\\my dir"').item.args, '-f "C:\\my dir"');

  const cmd = { type: 'cmd', target: 'echo {{msg}}', params: [{ name: 'msg' }] };
  eq('cmd 不补（echo 会把引号打出来）', T.applyParams(cmd, '"a b"').item.target, 'echo a b');
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
