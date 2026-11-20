/* 测试夹具：从 ui/app.js 里抽取「真实函数体」拼成一个可调用对象。
   用例一律跑实现本身，不复制一份逻辑，避免用例和实现悄悄漂移。 */
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'ui', 'app.js');

/* 设备指纹模块：它把自己挂到全局对象上，app.js 的 fpDesc 就是这么找它的。
   在这里 require 一次，eval 出来的函数就看得见 globalThis.QLFinger。 */
require(path.join(__dirname, '..', 'ui', 'fingerprint.js'));

function readSrc() {
  /* 统一换行：Windows 上 git 可能把工作区签出成 CRLF，
     而抽取函数体用的是 "\n  }\n" 这种锚点，CRLF 会让它匹配不到 */
  return fs.readFileSync(APP, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
}

function grab(src, name) {
  const m = new RegExp('^  function ' + name + '\\(', 'm').exec(src);
  if (!m) throw new Error('找不到函数 ' + name);
  const rest = src.slice(m.index);
  /* 单行函数（`function f(x) { return …; }`）：只取那一行。
     不加这个判断的话，"找下一个 \n  }\n" 会一路吞到**下一个多行函数**的结尾，
     把中间的函数和变量声明一起带进来 —— 踩过：被吞进一段 `let` 声明，
     生成出来的代码直接报 "Identifier has already been declared"。 */
  const nl = rest.indexOf('\n');
  if (nl > 0 && /[;{]\s*\}\s*$/.test(rest.slice(0, nl)))
    return rest.slice(0, nl + 1);
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
  'splitQuoted', 'takesArgs', 'uniqueMatch', 'splitArgs', 'parseQuery', 'sourceFor', 'visibleOf', 'findGroup',
  /* 空格语义 / 切范围保选择 */
  'spaceTarget', 'selIndexById',
  /* 拖文件进来：file:// URI → 本地路径 */
  'fileUrlToPath',
  /* 参数取值 */
  'resolveParamValues', 'assignTokens', 'fillTemplate', 'fillQuery',
  'tplVars', 'templateIssues', 'joinTokens', 'applyParams', 'normalizeMultipart',
  /* 内置模板变量（{{@config}} / {{@fp}}） */
  'isBuiltinKey', 'jsonStr', 'utf8b64', 'builtinValue', 'hasBuiltin', 'isObjBody', 'builtinIssues',
  'guardHash', 'fpDesc',
  /* 使用记录 */
  'usageRec', 'usageCount', 'historyOf', 'usageBoost',
  /* 补全 */
  'lastTokenRange', 'joinPath', 'splitForComplete', 'longestCommonPrefix', 'unquoteToken'
];

/* state: 需要预置 groups / all；PY: 拼音模块（可传 null 验证降级）
   extra: 额外要抽出来的函数名
   prelude: 额外的变量声明（有些函数要读 scriptDir / els 这类模块级变量） */
function build(state, PY, extra, prelude) {
  const src = readSrc();
  const names = DEFAULT_NAMES.concat(extra || []);

  const consts = [
    grabConst(src, /const CMD_TYPES = \{[^}]*\};/, 'CMD_TYPES'),
    grabConst(src, /const TPL_FIELDS = \[[^\]]*\];/, 'TPL_FIELDS'),
    grabConst(src, /const TPL_RE = .*;/, 'TPL_RE'),
    grabConst(src, /const BUILTIN_HELP = .*;/, 'BUILTIN_HELP'),
    grabConst(src, /const BUILTIN_KEYS = new Set\(\[[\s\S]*?\]\);/, 'BUILTIN_KEYS'),
    grabConst(src, /const TPL_GUARD = .*;/, 'TPL_GUARD'),
    /* 设备指纹的模块级缓存。boot 不抓（源码里是 window.__BOOTSTRAP__），
       夹具给 null：fpDesc 里的 `boot && …` 本来就要能扛住没有 bootstrap 的情况 */
    grabConst(src, /let fpCache = null;/, 'fpCache'),
    'var boot = null;',
    grabConst(src, /const FIELD_W = \{[\s\S]*?\n  \};/, 'FIELD_W'),
    grabConst(src, /const KIND_LABEL = \{[^}]*\};/, 'KIND_LABEL'),
    prelude || ''
  ].join('\n');

  const code = consts + '\n' + names.map(n => grab(src, n)).join('\n') +
    '\nreturn {' + names.join(',') + '};';

  return new Function('state', 'PY', code)(state, PY || null);
}

module.exports = { build, readSrc, grab, grabConst };
