# 从 mozillazg/pinyin-data 的 pinyin.txt 生成 ui\pinyin.js（只保留 GB2312 常用字）
#
# 用法：
#   curl -L -o pinyin.txt https://raw.githubusercontent.com/mozillazg/pinyin-data/master/pinyin.txt
#   powershell -File tools\gen-pinyin.ps1 -Src pinyin.txt -Out ui\pinyin.js
#
# 产物格式："一yi丁ding…" —— 一个汉字紧跟它的拼音（无分隔符），
# 解析时按「遇到汉字就开新记录」来切，比 JSON 小一大截（约 40KB）。
param(
    [string]$Src = 'pinyin.txt',
    [string]$Out = 'ui\pinyin.js'
)

$ErrorActionPreference = 'Stop'
[System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance)
$gb = [System.Text.Encoding]::GetEncoding(20936)   # GB2312

function Strip-Tone([string]$s) {
    # 先拆成「字母 + 组合声调符号」，再逐个处理：
    #   U+0308（ü 的两点）→ v，用户敲拼音时打的是 lv 而不是 lü
    #   其余 U+0300-036F 是声调，直接丢掉
    $d = $s.Normalize([Text.NormalizationForm]::FormD)
    $out = ''
    foreach ($ch in $d.ToCharArray()) {
        $c = [int]$ch
        if ($c -eq 0x308) {
            if ($out.EndsWith('u')) { $out = $out.Substring(0, $out.Length - 1) }
            $out += 'v'
        } elseif ($c -lt 0x300 -or $c -gt 0x36F) {
            $out += $ch
        }
    }
    return $out.Normalize([Text.NormalizationForm]::FormC)
}

$pairs = New-Object System.Text.StringBuilder
$n = 0
foreach ($line in [System.IO.File]::ReadLines((Resolve-Path $Src))) {
    if (-not $line.StartsWith('U+')) { continue }
    $m = [regex]::Match($line, '^U\+([0-9A-Fa-f]{4,6}):\s*([^\s#]+)')
    if (-not $m.Success) { continue }

    $cp = [Convert]::ToInt32($m.Groups[1].Value, 16)
    if ($cp -lt 0x4E00 -or $cp -gt 0x9FFF) { continue }          # 只要基本区汉字

    $ch = [char]$cp
    $bytes = $gb.GetBytes([string]$ch)
    if ($bytes.Length -ne 2) { continue }                        # 不在 GB2312 → 太生僻，跳过

    $py = ($m.Groups[2].Value -split ',')[0].Trim()              # 多音字取第一个读音
    $py = Strip-Tone $py
    if ($py -notmatch '^[a-z]+$') { continue }

    [void]$pairs.Append($ch).Append($py)
    $n++
}

$header = @"
/* 拼音表（自动生成，请勿手改）
 * 来源：https://github.com/mozillazg/pinyin-data (MIT)
 * 范围：GB2312 常用汉字 $n 个，多音字取首个读音，声调已去除、ü 记作 v
 * 重新生成：tools\gen-pinyin.ps1
 * 格式：汉字紧跟其拼音，无分隔符；遇到汉字即开始下一条记录
 */
"@

$js = @"
$header
(function (root) {
  'use strict';

  var RAW = '$($pairs.ToString())';
  var MAP = Object.create(null);

  for (var i = 0; i < RAW.length; ) {
    var ch = RAW.charAt(i);
    var code = RAW.charCodeAt(i);
    if (code < 0x3400) { i++; continue; }        /* 防御：非汉字开头直接跳过 */
    var j = i + 1;
    while (j < RAW.length && RAW.charCodeAt(j) < 0x3400) j++;
    MAP[ch] = RAW.slice(i + 1, j);
    i = j;
  }

  function isHan(c) { return c >= 0x3400; }

  /* 整串拼音："查公网 IP" -> "chagongwangip"；拉丁字母原样保留（小写） */
  function full(text) {
    var s = String(text || '');
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = c.charCodeAt(0);
      if (isHan(code)) out += (MAP[c] || '');
      else if (/[0-9a-z]/i.test(c)) out += c.toLowerCase();
    }
    return out;
  }

  /* 首字母："查公网 IP" -> "cgwip"；连续拉丁片段整段保留 */
  function initials(text) {
    var s = String(text || '');
    var out = '';
    var run = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = c.charCodeAt(0);
      if (isHan(code)) {
        if (run) { out += run; run = ''; }
        var py = MAP[c];
        if (py) out += py.charAt(0);
      } else if (/[0-9a-z]/i.test(c)) {
        run += c.toLowerCase();
      } else if (run) {
        out += run; run = '';
      }
    }
    return out + run;
  }

  root.__PY__ = { size: $n, map: MAP, full: full, initials: initials };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.__PY__;
})(this);
"@

[System.IO.File]::WriteAllText($Out, $js, (New-Object System.Text.UTF8Encoding($false)))
"生成完成：$Out  汉字 $n 个  体积 $([math]::Round((Get-Item $Out).Length / 1024, 1)) KB"
