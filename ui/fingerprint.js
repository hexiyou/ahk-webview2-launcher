/* ============================================================
   设备指纹 · 第二套：浏览器侧（纯 JS，可单独复制到任意网页应用里用）

   目标是「Edge 版本升级，指纹不变」。所以信号集是**白名单**，只收
   跟操作系统 / 硬件 / 区域设置有关、跟浏览器版本无关的那几项。

   刻意**不采**这些（它们正是各种开源指纹库在升级后漂移的来源）：
     userAgent 全文 / userAgentData.brands / getHighEntropyValues
        —— 里面带 Chromium 大版本号，Edge 每月升级就变
     devicePixelRatio / screen.availWidth·availHeight
        —— 跟着缩放比例、任务栏位置走，用户随手就改
     canvas / WebGL / AudioContext / 字体枚举 / 插件列表
        —— 随图形栈和驱动版本漂移；同一台机器换一次驱动就换一个值
   这些加起来能把区分度拉到很高，代价是「升级就认不出设备」。
   反作弊不是本项目的目标，稳定性才是。

   哈希为什么自己写：页面是 file:/// 加载，不是 secure context，
   crypto.subtle 直接不可用；而且它是异步的，塞不进同步的模板替换。
   所以带一份同步 SHA-256（标准实现，已用已知向量自测）。

   用法（QuickLaunch 内部）：
     var r = QLFinger.describe(null, salt)   // salt 由 AHK 注入，可空
     r.fp      // FP1-xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx
     r.bound   // FPB1-…（有 salt 时才是二次哈希，否则等于 fp）
     r.signals // 明细对象，排查用

   用法（别的网页应用校验）：
     <script src="fingerprint.js"></script>
     var mine = QLFinger.describe().fp;
     // 与 QuickLaunch 采到的值比 —— 同一台机器、同一浏览器引擎族，值相同
   ============================================================ */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  root.QLFinger = api;
  if (typeof module === 'object' && module.exports)
    module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  /* 算法版本。改了信号集或归一化规则就 +1 —— 前缀会跟着变，
     老值不会被误认为是新算法的结果。 */
  var V = 1;

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha256Hex(str) {
    var msg = new TextEncoder().encode(str == null ? '' : String(str));
    var len = msg.length;
    /* 补位：0x80 + 若干个 0 + 8 字节长度，总长凑到 64 的倍数 */
    var total = (((len + 9 + 63) / 64) | 0) * 64;
    var buf = new Uint8Array(total);
    buf.set(msg);
    buf[len] = 0x80;
    var bitLen = len * 8;
    /* 高位恒为 0（字符串远小于 2^29 字节），只写低 32 位 */
    buf[total - 1] = bitLen & 0xff;
    buf[total - 2] = (bitLen >>> 8) & 0xff;
    buf[total - 3] = (bitLen >>> 16) & 0xff;
    buf[total - 4] = (bitLen >>> 24) & 0xff;

    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Int32Array(64);
    for (var off = 0; off < total; off += 64) {
      var i;
      for (i = 0; i < 16; i++) {
        w[i] = (buf[off + i * 4] << 24) | (buf[off + i * 4 + 1] << 16)
             | (buf[off + i * 4 + 2] << 8) | buf[off + i * 4 + 3];
      }
      for (i = 16; i < 64; i++) {
        var x = w[i - 15], y = w[i - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0;
      H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0;
      H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = '';
    for (var j = 0; j < 8; j++)
      out += ('00000000' + (H[j] >>> 0).toString(16)).slice(-8);
    return out;
  }

  /* 值归一化：去掉分隔符 | 和 =（它们是规范串的语法），截到 64 字符。
     不做大小写折叠 —— 平台名 / 语言的写法本身就是规范的一部分。 */
  function val(v) {
    return String(v == null ? '' : v).replace(/[|=]/g, '').slice(0, 64);
  }

  function timeZone() {
    try {
      return val(Intl.DateTimeFormat().resolvedOptions().timeZone || '');
    } catch (e) {
      return '';
    }
  }

  /* 采集。env 默认是全局对象；单测可以传一个假的 {navigator, screen}。
     顺序固定 —— canonical() 依赖它，换顺序等于换算法。 */
  function collect(env) {
    var g = env || root || {};
    var nav = g.navigator || {};
    var scr = g.screen || {};
    var uad = nav.userAgentData || null;
    return {
      v: V,
      os: val(nav.platform),                                  /* Win32 */
      cores: val(nav.hardwareConcurrency || 0),                /* 逻辑核数 */
      mem: val(nav.deviceMemory || 0),                         /* 内存档位（GB） */
      scr: val((scr.width || 0) + 'x' + (scr.height || 0)),    /* 主屏分辨率 */
      depth: val(scr.colorDepth || 0),
      langs: val((nav.languages && nav.languages.join(',')) || nav.language),
      /* env.tz 是给单测用的注入点（Intl 读的是真实系统，没法从 navigator 换） */
      tz: val(g.tz != null ? g.tz : timeZone()),
      touch: val(nav.maxTouchPoints || 0),
      /* 只取 platform（"Windows"），不碰 brands —— brands 里带版本号 */
      uap: val(uad && uad.platform)
    };
  }

  function canonical(sig) {
    return 'v=' + val(sig.v)
      + '|os=' + val(sig.os)
      + '|cores=' + val(sig.cores)
      + '|mem=' + val(sig.mem)
      + '|scr=' + val(sig.scr)
      + '|depth=' + val(sig.depth)
      + '|langs=' + val(sig.langs)
      + '|tz=' + val(sig.tz)
      + '|touch=' + val(sig.touch)
      + '|uap=' + val(sig.uap);
  }

  function hex4(h32) {
    return h32.slice(0, 8) + '-' + h32.slice(8, 16) + '-' + h32.slice(16, 24) + '-' + h32.slice(24, 32);
  }

  function fpOf(sig) {
    return 'FP' + V + '-' + hex4(sha256Hex(canonical(sig)));
  }

  /* 本机绑定版：把 AHK 生成、只存在本机的盐拌进去。
     盐不在页面代码里，所以别人抄走这份 JS 也算不出同一台机器的 bound 值。 */
  function boundOf(fp, salt) {
    if (!salt)
      return fp;
    return 'FPB' + V + '-' + hex4(sha256Hex('FPB' + V + '|' + salt + '|' + fp));
  }

  /* 明细：给 {{@fp.parts}} 和排查用。用 k=v 逗号分隔，不含引号，
     免得塞进 JSON 字符串时还要再转义一层。 */
  function partsOf(sig) {
    return canonical(sig);
  }

  /* 一次算全。缓存键把规范串和盐都带上：盐换了（换了程序目录）要重算。 */
  var cache = { key: '', val: null };

  function describe(env, salt) {
    var sig = collect(env);
    var c = canonical(sig);
    var key = c + '#' + (salt || '');
    if (cache.key === key)
      return cache.val;
    var fp = fpOf(sig);
    var res = { v: V, fp: fp, bound: boundOf(fp, salt), signals: sig, canonical: c };
    cache.key = key;
    cache.val = res;
    return res;
  }

  return {
    version: V,
    sha256: sha256Hex,
    collect: collect,
    canonical: canonical,
    fpOf: fpOf,
    boundOf: boundOf,
    partsOf: partsOf,
    describe: describe,
    hex4: hex4
  };
});
