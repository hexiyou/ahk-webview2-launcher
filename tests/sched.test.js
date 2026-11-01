/* 定时调度的配置解析用例（parseAt / parseEvery / parseDays / normalizeSchedules）
   （函数体同样从 ui/app.js 抽取，见 tests/harness.js）

   这一层是唯一会在"写错配置"时拦人的地方：写错的条目要带着原因被跳过，
   而不是让整份配置失效、或者悄悄按错的时刻跑。所以非法输入一律返回 null，
   由 normalizeSchedules 统一转成 { id, err }。 */
const { build, readSrc, grabConst } = require('./harness');
const PY = require('../ui/pinyin.js');

const src = readSrc();
const prelude = grabConst(src, /const DAY_MAP = \{[\s\S]*?\n  \};/, 'DAY_MAP');

const state = { groups: [], all: [], index: {}, usage: {}, cfg: null };
const T = build(state, PY, ['parseDays', 'parseAt', 'parseEvery', 'normalizeSchedules'], prelude);

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b); }
}

console.log('— days');
eq('省略 = 每天', T.parseDays(undefined), '0,1,2,3,4,5,6');
eq('空串 = 每天', T.parseDays(''), '0,1,2,3,4,5,6');
eq('* = 每天', T.parseDays('*'), '0,1,2,3,4,5,6');
eq('daily = 每天', T.parseDays('daily'), '0,1,2,3,4,5,6');
eq('weekdays = 周一到周五', T.parseDays('weekdays'), '1,2,3,4,5');
eq('工作日 = 周一到周五', T.parseDays('工作日'), '1,2,3,4,5');
eq('weekend = 周日和周六', T.parseDays('weekend'), '0,6');
eq('周末 = 周日和周六', T.parseDays('周末'), '0,6');
eq('单个英文', T.parseDays('mon'), '1');
eq('大小写不敏感', T.parseDays('WED'), '3');
eq('中文星期', T.parseDays('周三'), '3');
eq('数组：去重并排序', T.parseDays(['fri', 'mon', 'fri']), '1,5');
eq('数组：数字也能写', T.parseDays([1, 6]), '1,6');
eq('数组：非法项忽略，剩空则报错', T.parseDays(['xyz']), null);
eq('空数组 = 报错', T.parseDays([]), null);
eq('不认识的值 = 报错', T.parseDays('每隔两天'), null);

console.log('— at');
eq('HH:MM', T.parseAt('09:30'), '093000');
eq('一位数也能认', T.parseAt('9:5'), '090500');
eq('带秒', T.parseAt('09:30:15'), '093015');
eq('一天多次：排序', T.parseAt(['18:00', '09:30']), '093000,180000');
eq('一天多次：去重', T.parseAt(['09:30', '09:30']), '093000');
eq('24 点 = 报错', T.parseAt('24:00'), null);
eq('60 分 = 报错', T.parseAt('09:60'), null);
eq('60 秒 = 报错', T.parseAt('09:30:60'), null);
eq('乱写 = 报错', T.parseAt('早上九点'), null);
eq('空数组 = 报错', T.parseAt([]), null);

console.log('— every');
eq('30s', T.parseEvery('30s'), 30);
eq('15m', T.parseEvery('15m'), 900);
eq('2h', T.parseEvery('2h'), 7200);
eq('1.5h', T.parseEvery('1.5h'), 5400);
eq('不带单位按秒', T.parseEvery('90'), 90);
eq('纯数字按秒', T.parseEvery(600), 600);
eq('中文单位', T.parseEvery('30分钟'), 1800);
eq('小于 30 秒 = 报错', T.parseEvery('10s'), null);
eq('0m = 报错', T.parseEvery('0m'), null);
eq('超过 30 天 = 报错', T.parseEvery(31 * 86400), null);
eq('乱写 = 报错', T.parseEvery('半小时一圈'), null);

console.log('— 整份配置');
eq('没有 schedules 字段', T.normalizeSchedules({ items: [] }), []);
eq('schedules 不是数组', T.normalizeSchedules({ schedules: 'x' }), []);
eq('空数组', T.normalizeSchedules({ schedules: [] }), []);

const one = T.normalizeSchedules({
  schedules: [{ id: 'a', run: 'http-ip', at: '09:30', days: ['mon', 'tue'] }]
});
eq('at 任务：字段齐全',
  [one[0].id, one[0].q, one[0].mode, one[0].days, one[0].times, one[0].first, one[0].err],
  ['a', 'http-ip', 'at', '1,2', '093000', 1, undefined]);

const two = T.normalizeSchedules({ schedules: [{ run: 'pull-config', every: '6h' }] });
eq('id 缺省用 run', two[0].id, 'pull-config');
eq('every 任务字段', [two[0].mode, two[0].every, two[0].days], ['every', 21600, undefined]);

const three = T.normalizeSchedules({
  schedules: [{ id: 'x', run: 'y', at: '08:00', args: '--full "a b"', first: false }]
});
eq('args 原样透传', three[0].args, '--full "a b"');
eq('first 默认开', one[0].first, 1);
eq('first:false 关掉', three[0].first, 0);

console.log('— 写错的条目：跳过自己，不连累别人');
const bad = T.normalizeSchedules({
  schedules: [
    { id: 'no-run', at: '09:00' },
    { id: 'both', run: 'a', at: '09:00', every: '1h' },
    { id: 'neither', run: 'a' },
    { id: 'every-days', run: 'a', every: '1h', days: ['mon'] },
    { id: 'bad-at', run: 'a', at: '99:99' },
    { id: 'bad-days', run: 'a', at: '09:00', days: ['周八'] },
    { id: 'ok', run: 'a', at: '09:00' }
  ]
});
eq('七条全在（含写错的）', bad.length, 7);
eq('缺 run', bad[0].err, '缺少 run（要执行的条目）');
eq('at 与 every 同时出现', bad[1].err, 'at 与 every 只能写一个');
eq('两者都没写', bad[2].err, 'at 与 every 至少要写一个');
eq('days 配了 every', bad[3].err, 'days 只能和 at 一起用');
eq('at 非法', bad[4].err, 'at 写法不对（示例 "09:30" 或 "09:30:00"）');
eq('days 非法', bad[5].err, 'days 写法不对（示例 ["mon","fri"] / "weekdays" / "weekend"）');
eq('最后一条仍然正常', [bad[6].id, bad[6].mode, bad[6].err], ['ok', 'at', undefined]);

console.log('— enabled: false');
const off = T.normalizeSchedules({
  schedules: [
    { id: 'off', run: 'a', every: '1h', enabled: false },
    { id: 'on', run: 'a', every: '1h', enabled: true }
  ]
});
eq('停用的不安装、也不报错', off.map(x => x.id), ['on']);

console.log('— runOnStart');
const boot = T.normalizeSchedules({
  schedules: [
    { id: 'b1', run: 'a', every: '1h', runOnStart: true },
    { id: 'b2', run: 'a', every: '1h' },
    { id: 'b3', run: 'a', every: '1h', runOnStart: false },
    { id: 'b4', run: 'a', every: '1h', runOnStart: 'true' },
    { id: 'b5', run: 'a', at: '09:00', runOnStart: true }
  ]
});
eq('只有 runOnStart: true 才算', boot.map(x => x.runOnStart), [1, 0, 0, 0, 1]);
eq('字符串 "true" 不认（免得把 "false" 也当真的）', boot[3].runOnStart, 0);
eq('at 与 every 两种都能带', [boot[0].mode, boot[4].mode], ['every', 'at']);
eq('默认不跑', one[0].runOnStart, 0);
eq('写错的条目没有 runOnStart', bad[0].runOnStart, undefined);

console.log('— 不是对象的条目');
const junk = T.normalizeSchedules({ schedules: [null, 42, 'x'] });
eq('垃圾条目报缺 run，而不是崩掉', junk.length, 3);
eq('依然带 err', junk.every(x => !!x.err), true);

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
