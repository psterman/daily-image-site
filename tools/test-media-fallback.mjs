#!/usr/bin/env node
/**
 * ffmpeg 格式探测回退机制的护栏测试
 *
 * 用法：node tools/test-media-fallback.mjs
 * 退出码：0 = 全过；1 = 有失败
 *
 * 背景：福利吧的图是「后缀 .gif、内容 JPEG」，ffmpeg 偶尔认不出来
 * （2026-11-08 实测 336 张里有 1 张）。触发条件是**文件内容**，
 * 没法稳定复现 —— 所以这里测的是**回退机制本身**：
 *
 *   1. 第一次就成功        → 不许重试（多余的探测只是慢）
 *   2. 第一次失败第二次成功 → 自动重试，且重试时把 '-f image2pipe'
 *                            插在**输入项前面**（插错位置 ffmpeg 会报
 *                            「Option not found」）
 *   3. 两次都失败          → 抛错，而且错误消息里要同时有两次的原因
 *                            （只报一个就等于把另一个丢进黑洞）
 *
 * 假二进制用 node 自己：`-e <脚本> -- <参数...>`。
 * 那道 `--` 是必须的：没有它，node 会把 '--flag'、'-f' 当成**自己的**选项
 * 解析（报 "bad option"），假二进制根本跑不到我们要测的那段。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithFormatFallback } from './media-fallback.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = path.join(__dirname, '.tmp-media-fallback');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  -> ' + extra : ''}`);
  }
}

/* 假二进制：
 *   FAKE_MODE=ok          每次都成功
 *   FAKE_MODE=firstfail   第一次失败、第二次成功
 *   FAKE_MODE=alwaysfail  每次都失败
 * 每次调用都把收到的参数记进 FAKE_LOG。 */
const FAKE = `
const fs = require('fs');
const c = process.env.FAKE_COUNTER, log = process.env.FAKE_LOG;
const n = fs.existsSync(c) ? Number(fs.readFileSync(c, 'utf8')) : 0;
fs.writeFileSync(c, String(n + 1));
fs.appendFileSync(log, JSON.stringify(process.argv.slice(1)) + '\\n');
if (process.env.FAKE_MODE === 'alwaysfail') { console.error('假二进制: 一直失败'); process.exit(3); }
if (process.env.FAKE_MODE === 'firstfail' && n === 0) { console.error('假二进制: 第一次故意失败'); process.exit(1); }
console.log('1164x1608');
process.exit(0);
`;

function resetSandbox(mode) {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  process.env.FAKE_COUNTER = path.join(SANDBOX, 'counter');
  process.env.FAKE_LOG = path.join(SANDBOX, 'log');
  process.env.FAKE_MODE = mode;
}

function calls() {
  const log = process.env.FAKE_LOG;
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

const BIN = process.execPath;
/* node -e <脚本> -- <参数...>：'--' 之后的东西原样进 process.argv */
const PRE = ['-e', FAKE, '--'];

/* ── 1. 第一次就成功：不该重试 ────────────────────────────── */
console.log('\n第一次就成功');
resetSandbox('ok');
{
  const r = await runWithFormatFallback(BIN, [...PRE, '--flag', 'input.bin'], 4, '测试');
  check('返回 ok', r.ok === true);
  check('标记为「没走回退」', r.fallback === false);
  check('只调用了一次', calls().length === 1, `实际 ${calls().length} 次`);
}

/* ── 2. 第一次失败：自动回退 ──────────────────────────────── */
console.log('\n第一次失败、第二次成功');
resetSandbox('firstfail');
{
  const r = await runWithFormatFallback(BIN, [...PRE, '--flag', 'input.bin'], 4, '测试');
  check('返回 ok', r.ok === true);
  check('标记为「走了回退」', r.fallback === true);
  check('调用了两次', calls().length === 2, `实际 ${calls().length} 次`);
  const args = calls()[1] || [];
  check('重试时插入了 -f image2pipe', args.includes('-f') && args.includes('image2pipe'),
    JSON.stringify(args));
  const iFmt = args.indexOf('-f');
  const iInput = args.indexOf('input.bin');
  check('-f 就在输入项前面（插错位置 ffmpeg 会报 Option not found）',
    iFmt >= 0 && iInput >= 0 && iFmt < iInput && iInput - iFmt === 2,
    JSON.stringify(args));
}

/* ── 3. 两次都失败：抛错，两次原因都在 ────────────────────── */
console.log('\n两次都失败');
resetSandbox('alwaysfail');
{
  let err = null;
  try {
    await runWithFormatFallback(BIN, [...PRE, '--flag', 'input.bin'], 4, '测试');
  } catch (e) {
    err = e;
  }
  check('抛错了', !!err);
  check('确实调了两次', calls().length === 2, `实际 ${calls().length} 次`);
  if (err) {
    const msg = String(err.message || err);
    check('消息里有标签', msg.includes('测试'), msg);
    check('消息里有失败原因', msg.includes('一直失败'), msg);
    check('消息里两种格式都提到了', msg.includes('默认探测') && msg.includes('image2pipe'), msg);
  }
}

/* ── 4. 插入位置：输入项在中间时也要对 ────────────────────── */
console.log('\n输入项在中间时的插入位置');
resetSandbox('firstfail');
{
  const args = [...PRE, '-i', 'src.jpg', 'dest.webp'];
  await runWithFormatFallback(BIN, args, 4, '测试');
  const got = calls()[1] || [];
  const iFmt = got.indexOf('-f');
  const iIn = got.indexOf('src.jpg');
  check('-f 插在输入文件前面', iFmt >= 0 && iIn >= 0 && iFmt < iIn, JSON.stringify(got));
  check('输入项和输出项都还在', got.includes('src.jpg') && got.includes('dest.webp'), JSON.stringify(got));
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log('');
console.log(`  ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
