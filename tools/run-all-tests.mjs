#!/usr/bin/env node
/**
 * 全量护栏跑批器。
 *
 *   node tools/run-all-tests.mjs              # 跑 38 个常规套件
 *   node tools/run-all-tests.mjs --mutate     # 连变异套件一起跑（慢，但能证明护栏有牙齿）
 *   node tools/run-all-tests.mjs --only=lqip  # 只跑名字里含 lqip 的套件
 *
 * 为什么要有它：护栏一多，靠人记「哪几个要跑」迟早漏。
 * 这里把 tools/test-*.mjs 全收进来，逐个跑、逐个判退出码，
 * 结尾给一张总表 —— 任何一套红了一眼就能看见。
 *
 * 约定：
 *   - 每个套件独立进程、独立退出码，**一个红不影响后面的**（要拿到完整清单）
 *   - 单个套件超时算红（挂死比红更糟：它会假装还在跑）
 *   - 结尾非零退出 = 有红
 *
 * 超时默认 30 分钟：test-webp.mjs 要把 R2 母本里上万个 WebP 逐个跟 ffprobe
 * 对照（实测 12695 个文件 ≈ 16 分钟）。嫌慢可以调小，但别调到它跑不完 ——
 * 那会得到一个「因为超时而红」的假象。
 *   SUITE_TIMEOUT_MS=600000 node tools/run-all-tests.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const includeMutate = argv.includes('--mutate');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : '';
const PER_SUITE_TIMEOUT_MS = Number(process.env.SUITE_TIMEOUT_MS || 1800_000);   // 30 分钟

const files = fs.readdirSync(__dirname)
  .filter((n) => /^test-.*\.mjs$/.test(n))
  .filter((n) => includeMutate || !n.includes('-mutate'))
  .filter((n) => !only || n.includes(only))
  .sort();

if (!files.length) {
  console.error('没有匹配的测试套件');
  process.exit(1);
}

/** 从输出里刨出最后一条统计行（各套件格式不一，尽力而为） */
function statLine(out) {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pats = [
    /(\d+)\s*通过\s*\/\s*(\d+)\s*失败/,
    /(\d+)\s*\/\s*(\d+)\s*(?:passed|failed)/i,
    /PASS\s+(\d+).*FAIL\s+(\d+)/i,
  ];
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const p of pats) {
      const m = lines[i].match(p);
      if (m) return lines[i];
    }
  }
  return lines[lines.length - 1] || '(无输出)';
}

console.log(`跑批：${files.length} 个套件${includeMutate ? '（含变异）' : ''}${only ? `，过滤="${only}"` : ''}`);
console.log(`工作目录：${ROOT}\n`);

const rows = [];
let red = 0;
let skipped = 0;

for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join('tools', f)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: PER_SUITE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  /* 退出码 2 = 显式跳过（需要真实产物 / 真实凭据才能跑）。
   * 跳过**不算通过** —— 把它混进「绿」里就是假绿。 */
  const isSkip = r.status === 2;
  const ok = r.status === 0;
  if (isSkip) skipped++;
  else if (!ok) red++;
  const stat = statLine(out);
  rows.push({ f, ok, isSkip, dt, stat, code: r.status, out });
  const mark = isSkip ? '[33m跳[0m' : (ok ? '[32mOK[0m' : '[31m红[0m');
  console.log(`  ${mark}  ${f.padEnd(36)} ${String(dt).padStart(6)}s  ${stat}`);
}

console.log('\n' + '─'.repeat(72));
const okCount = rows.filter((r) => r.ok).length;
console.log(`总计 ${rows.length} 套件：${okCount} 绿 / ${red} 红 / ${skipped} 跳过`);

if (skipped) {
  console.log('\n跳过的套件（不算通过）：');
  for (const r of rows.filter((x) => x.isSkip)) console.log(`  - ${r.f}`);
}

if (red) {
  console.log('\n红的套件：');
  for (const r of rows.filter((x) => !x.ok)) {
    console.log(`\n── ${r.f}（退出码 ${r.code}）`);
    const tail = r.out.split(/\r?\n/).filter((l) => l.trim()).slice(-12);
    for (const l of tail) console.log(`   ${l}`);
  }
}

process.exit(red ? 1 : 0);
