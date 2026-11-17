#!/usr/bin/env node
/**
 * publish.ps1 的「原生命令不许掀翻脚本」护栏（2026-11-15 加）
 *
 * 为什么要有这个测试：
 *   2026-11-14 / 11-15 两次发布都被腰斩 —— 不是被谁 kill，是被**一行 stderr** 掀翻的。
 *   PowerShell 5.1 里原生命令往 stderr 写一行字就会被转成 ErrorRecord，
 *   而 publish.ps1 顶着 $ErrorActionPreference='Stop'，ErrorRecord 直接变终止性错误。
 *   触发它的是构建里这句（fetch-rss.mjs:57，本机每天都会遇到）：
 *     ! 抓取过程中连接被重置（undici 已知崩溃），该源按失败处理，继续
 *   那只是**提示**，build 自己会接着跑完；但 publish.ps1 当场死掉 →
 *   R2 没上传、Pages 没部署，审稿台那边只看到「发布中…」一直转。
 *
 *   修法：所有原生命令都走 Invoke-NativeCmd / Invoke-NativeCmdCapture
 *   （里面先把 ErrorActionPreference 降成 Continue，成败只看 $LASTEXITCODE）。
 *
 * 这个测试分两层：
 *   ① 静态：publish.ps1 里不许有裸的原生命令调用，各环节都要走 helper。
 *   ② 行为：把 helper 从 publish.ps1 里抠出来真跑一遍 —— 原生命令的 stdout
 *      必须继续流进管道（发布日志靠它刷新）、stderr 不能掀翻脚本、退出码要拿得到。
 *      ⚠️ 这一层抓到过一次真 bug：helper 里写成 `$out = & $Exe ...` 会把 stdout
 *      吞进返回值，退出码判断随之失真（2026-11-15 踩过）。
 *
 * 变异测试（护栏有没有牙齿的判定标准）：
 *   把构建那一步改回 `& node @buildArgs`（裸调用）→ 静态层必须变红。
 *   把 helper 里的 `$ErrorActionPreference = 'Continue'` 删掉 → 静态层必须变红。
 *   把 helper 里的 `& $Exe @NativeArgs` 改成 `$out = & $Exe @NativeArgs` → 行为层必须变红。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

const ps1Path = process.env.PUBLISH_PS1 || path.join(ROOT, 'tools', 'publish.ps1');
const src = fs.readFileSync(ps1Path, 'utf8');
const lines = src.split(/\r?\n/);

/** 找出某个顶层函数的行范围（[起, 止]，含）。 */
function funcRange(name) {
  const start = lines.findIndex((l) => l.startsWith(`function ${name} {`));
  if (start < 0) return null;
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') { end = i; break; }
  }
  return { start, end };
}

const helpers = ['Invoke-NativeCmd', 'Invoke-NativeCmdCapture'].map((n) => ({ n, r: funcRange(n) }));

/* ── ① 静态层 ─────────────────────────────────────────────── */

for (const h of helpers) {
  check(`helper ${h.n} 存在`, !!h.r, { file: ps1Path });
}

for (const h of helpers) {
  if (!h.r) continue;
  const body = lines.slice(h.r.start, h.r.end + 1).join('\n');
  check(`${h.n} 把 ErrorActionPreference 降成 Continue`, body.includes("$ErrorActionPreference = 'Continue'"), {
    missing: "$ErrorActionPreference = 'Continue'",
  });
  check(`${h.n} 事后把 ErrorActionPreference 恢复`, body.includes('$ErrorActionPreference = $prevEap'), {
    missing: '$ErrorActionPreference = $prevEap',
  });
}

/* 裸的原生命令调用（& node / & npx / & python / & $Exe）一个都不许有 —— 除非在 helper 里 */
const NATIVE = /&\s+(node|npx|python|pwsh|powershell)\b/;
const inHelper = (idx) => helpers.some((h) => h.r && idx >= h.r.start && idx <= h.r.end);
const bare = [];
lines.forEach((l, i) => {
  if (NATIVE.test(l) && !inHelper(i)) bare.push({ line: i + 1, text: l.trim() });
});
check('没有裸的原生命令调用（全部走 helper）', bare.length === 0, bare);

/* ⚠️ 流式 helper 的 stdout 不能被吞进返回值：
   写成 `$out = & $Exe ...` 的话，退出码就不再是「只是退出码」，
   而且原生命令的每一行也进不了发布日志。 */
{
  const h = helpers[0];
  if (h.r) {
    const body = lines.slice(h.r.start, h.r.end + 1).join('\n');
    const swallowed = body.split(/\r?\n/).filter(
      (l) => !/^\s*#/.test(l) && /\$\w+\s*=\s*&\s*\$Exe/.test(l)
    );
    check('流式 helper 没有把 stdout 吞进变量', swallowed.length === 0, swallowed);
    check('流式 helper 用脚本级变量带出退出码', body.includes('$script:NativeExit = $LASTEXITCODE'), {
      missing: '$script:NativeExit = $LASTEXITCODE',
    });
  }
}

/* 调用点不能把流式 helper 的返回值赋给变量（会把 stdout 一起吞掉） */
{
  const bad = [];
  lines.forEach((l, i) => {
    if (/=\s*Invoke-NativeCmd(?!Capture)/.test(l)) bad.push({ line: i + 1, text: l.trim() });
  });
  check('调用点没有给流式 helper 的返回值赋值', bad.length === 0, bad);
}

/* 覆盖到每一个环节 */
{
  const callSites = lines
    .map((l) => l.trim())
    .filter((l) => /Invoke-NativeCmd/.test(l) && !/^function /.test(l) && !/^\s*#/.test(l));
  check('至少 8 处走 helper', callSites.length >= 8, { count: callSites.length, callSites });
  const need = [
    ['tools/build.mjs', '构建'],
    ['tools/verify-build.mjs', '产物自检'],
    ['tools/check-r2.mjs', 'R2 探测'],
    ['tools/upload-r2.mjs', '上传 R2'],
    ['tools/stage-static-images.mjs', '静态兜底'],
    ['tools/refresh-token.mjs', 'token 续期'],
    ['pages', '部署'],
  ];
  for (const [needle, label] of need) {
    const idx = lines.findIndex((l) => l.includes(needle));
    const near = idx >= 0 && lines
      .slice(Math.max(0, idx - 6), idx + 7)
      .some((l) => /Invoke-NativeCmd/.test(l) && !/^function /.test(l) && !/^\s*#/.test(l));
    check(`${label} 这一步走 helper`, near, { needle, line: idx + 1 });
  }
}

/* 真凶那一处：构建步骤必须用 helper，而且必须检查退出码 */
{
  const buildLine = lines.findIndex((l) => /Invoke-NativeCmd\s+'node'\s+\$buildArgs/.test(l));
  check('构建步骤走 Invoke-NativeCmd', buildLine >= 0, { hint: "Invoke-NativeCmd 'node' $buildArgs" });
  if (buildLine >= 0) {
    const next = lines.slice(buildLine, buildLine + 3).join('\n');
    check('构建步骤检查了退出码', /\$script:NativeExit -ne 0/.test(next), { next });
  }
}

/* 全局 ErrorActionPreference 仍然是 Stop —— 这正是「必须包 helper」的原因，
   别为了省事把它改成 Continue（那会掩盖真正该抛的错）。 */
check("全局 $ErrorActionPreference 仍是 'Stop'", src.includes("$ErrorActionPreference = 'Stop'"), {
  hint: "别把全局改成 Continue",
});

/* ── ② 行为层：把 helper 抠出来真跑一遍 ───────────────────── */
{
  const h = helpers[0];
  if (h.r) {
    const helperText = lines.slice(h.r.start, h.r.end + 1).join('\r\n');
    const tmp = path.join(os.tmpdir(), `publish-native-${process.pid}.ps1`);
    /* 测试脚本：跑一个会写 stdout、写 stderr、并且故意返回非 0 退出码的 node。
       node 的代码放临时 .js 文件里 —— PS 5.1 传原生命令参数时会把内层引号吃掉，
       写成 -e 'console.log("X")' 到 node 手里就变成 console.log(X)（2026-11-15 踩过）。 */
    const tmpJs = path.join(os.tmpdir(), `publish-native-${process.pid}.js`);
    fs.writeFileSync(tmpJs, "console.log('STDOUT-LINE');\nconsole.error('STDERR-LINE');\nprocess.exit(3);\n", 'utf8');
    const script = [
      helperText,
      '',
      "$ErrorActionPreference = 'Stop'",
      "$script:NativeExit = 0",
      `Invoke-NativeCmd 'node' @('${tmpJs.replace(/\\/g, '\\\\')}')`,
      "Write-Output (\"EXITCODE=\" + $script:NativeExit)",
      "Write-Output 'STILL-ALIVE'",
      '',
    ].join('\r\n');
    fs.writeFileSync(tmp, '\ufeff' + script, 'utf8');
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { encoding: 'utf8', timeout: 60000 }
    );
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    check('helper 跑完没有把脚本掀翻', r.status === 0, { status: r.status, stderr: (r.stderr || '').slice(0, 400) });
    check('原生命令的 stdout 流进了管道', out.includes('STDOUT-LINE'), { out: out.slice(0, 400) });
    check('stderr 没有终止脚本', out.includes('STILL-ALIVE'), { out: out.slice(0, 400) });
    check('退出码拿得到（3）', out.includes('EXITCODE=3'), { out: out.slice(0, 400) });
    try { fs.unlinkSync(tmp); } catch { /* 临时文件留着也无所谓 */ }
    try { fs.unlinkSync(tmpJs); } catch { /* 同上 */ }
  }
}

/* ── ③ token 续期的余量 + 上传前重导环境变量 ───────────────────
   2026-11-15 的第二个真凶：Cloudflare 的 OAuth token 只活 1 小时，
   而发布链路（构建 + 上传 + 部署）会跨过过期点 ——
   11-14 那次发布上传到一半 token 过期，249 个文件 401 code 10000，整次 exit 1。 */
{
  const rt = fs.readFileSync(path.join(ROOT, 'tools', 'refresh-token.mjs'), 'utf8');
  const ttl = /const MIN_TTL_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/.exec(rt);
  check('refresh-token.mjs 有最小有效期余量', !!ttl, { hint: 'const MIN_TTL_MS = 15 * 60 * 1000' });
  if (ttl) check('余量至少 5 分钟', Number(ttl[1]) >= 5, { minutes: Number(ttl[1]) });
  check('续期判断用 needsRenewal（带余量）而不是 isExpired',
    /if\s*\(\s*stale\s*\)/.test(rt) && /needsRenewal\s*\(/.test(rt), {});
  check('isExpired 仍保留（--check 用严格判断）', /function isExpired/.test(rt), {});

  const refreshCalls = lines.filter((l) => /Invoke-NativeCmd\s+'node'\s+@\('tools\/refresh-token\.mjs'\)/.test(l));
  check('publish.ps1 至少续期两次（开头 + 上传前）', refreshCalls.length >= 2, {
    count: refreshCalls.length, refreshCalls,
  });
  const importCalls = lines.filter((l) => /^Import-EnvFile\s*$/.test(l.trim()));
  check('Import-EnvFile 至少调用两次（开头 + 上传前）', importCalls.length >= 2, {
    count: importCalls.length,
  });
  /* 上传前那次续期与重新导入必须挨着（顺序反了就白续） */
  const refreshIdxs = lines
    .map((l, i) => ({ l, i }))
    .filter((x) => /Invoke-NativeCmd\s+'node'\s+@\('tools\/refresh-token\.mjs'\)/.test(x.l))
    .map((x) => x.i);
  const lastRefresh = refreshIdxs[refreshIdxs.length - 1];
  const idxImport = lines.findIndex((l, i) => i > lastRefresh && /^Import-EnvFile\s*$/.test(l.trim()));
  check('上传前续期之后紧跟着重新导入环境变量', lastRefresh >= 0 && idxImport > lastRefresh && idxImport - lastRefresh < 6, {
    lastRefresh, idxImport,
  });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
