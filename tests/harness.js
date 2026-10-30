/* 测试夹具：从 ui/app.js 里抽取「真实函数体」拼成一个可调用对象。
   用例一律跑实现本身，不复制一份逻辑，避免用例和实现悄悄漂移。 */
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'ui', 'app.js');

function readSrc() {
  return fs.readFileSync(APP, 'utf8');
}

function grab(src, name) {
  const m = new RegExp('^  function ' + name + '\\(', 'm').exec(src);
  if (!m) throw new Error('找不到函数 ' + name);
  const rest = src.slice(m.index);
  const i = rest.search(/\n  \}\n/);
  if (i < 0) throw new Error('函数未闭合 ' + name);
  return rest.slice(0, i + 4);
}

function grabConst(src, re, label) {
  const m = re.exec(src);
  if (!m) throw new Error('找不到常量 ' + label);
  return m[0];
}

const DEFAULT_NAMES = [
  /* 匹配 / 拼音 */
  'pyCall', 'isBoundaryAt', 'subseqQuality', 'fieldQuality', 'fieldsOf', 'scoreOne', 'scoreOf',
  /* 查询解析 + 参数切分 */
  'splitQuoted', 'takesArgs', 'uniqueMatch', 'splitArgs', 'parseQuery', 'sourceFor', 'findGroup',
  /* 参数取值 */
  'resolveParamValues', 'assignTokens', 'fillTemplate', 'fillQuery', 'withArgs',
  /* 使用记录 */
  'usageRec', 'usageCount', 'historyOf', 'usageBoost',
  /* 补全 */
  'lastTokenRange', 'joinPath', 'splitForComplete', 'longestCommonPrefix', 'unquoteToken'
];

/* state: 需要预置 groups / all；PY: 拼音模块（可传 null 验证降级）
   extra: 额外要抽出来的函数名 */
function build(state, PY, extra) {
  const src = readSrc();
  const names = DEFAULT_NAMES.concat(extra || []);

  const consts = [
    grabConst(src, /const CMD_TYPES = \{[^}]*\};/, 'CMD_TYPES'),
    grabConst(src, /const TPL_RE = .*;/, 'TPL_RE'),
    grabConst(src, /const FIELD_W = \{[\s\S]*?\n  \};/, 'FIELD_W')
  ].join('\n');

  const code = consts + '\n' + names.map(n => grab(src, n)).join('\n') +
    '\nreturn {' + names.join(',') + '};';

  return new Function('state', 'PY', code)(state, PY || null);
}

module.exports = { build, readSrc, grab, grabConst };
