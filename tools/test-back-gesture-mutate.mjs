#!/usr/bin/env node
/**
 * 变异测试：证明 test-back-gesture.mjs 真的有牙齿。
 *
 * 规矩（跟 tools/test-viewer-zoom-mutate.mjs 一样）：
 *   ① 每条变异都要写明「应该红的断言」和「应该仍然绿的断言」；
 *   ② 变异点必须**恰好命中一次** —— 命中 0 次说明脚本过期了（源码改了），
 *      命中 2 次说明锚点不唯一 —— 直接 exit 1，别把「脚本坏了」混进「没抓到」；
 *   ③ **必须还原**：改的是**源文件本身**（护栏要读它），
 *      所以跑完必须逐字节还原并校验 sha256；
 *      中途被打断（Ctrl+C / 崩了 / 超时）也要还原 → finally + exit 兜底。
 *   ④ 期望红 / 期望绿都用子串匹配 —— 护栏的标签以后可能会改，
 *      不该因为改了措辞就把这套脚本报废。
 *
 * ⚠️ 锚点为什么这么长：`.tabs` 和 `.chips` 两处的声明**字面完全一样**
 *    （`overscroll-behavior-x: contain;`），所以锚点必须带上**各自那段注释**，
 *    否则命中 2 次 → 直接判脚本坏了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'tools', 'test-back-gesture.mjs');
const TARGETS = {
  app: path.join(ROOT, 'site', 'app.js'),
  css: path.join(ROOT, 'site', 'app.css'),
};

const MUTANTS = [
  {
    id: 'B1', file: 'css', name: 'tab 栏的越界不外传没了（滑到头会带着页面走 → 回退）',
    from: '所以这里是真正管用的那一处。 */\n  overscroll-behavior-x: contain;',
    to: '所以这里是真正管用的那一处。 */',
    expectFail: [
      '静态：.tabs 规则里有 overscroll-behavior-x: contain',
      '真浏览器：.tabs 的 computed overscroll-behavior-x = contain',
    ],
    expectGreen: [
      '真浏览器：.chips 的 computed overscroll-behavior-x = contain',
      '真浏览器：html 的 computed overscroll-behavior-x = none',
    ],
  },
  {
    id: 'B2', file: 'css', name: '分类 chip 的越界不外传没了（见报滑到头最易误退出）',
    from: '滑到头的人最多。 */\n  overscroll-behavior-x: contain;',
    to: '滑到头的人最多。 */',
    expectFail: [
      '静态：.chips 规则里有 overscroll-behavior-x: contain',
      '真浏览器：.chips 的 computed overscroll-behavior-x = contain',
      '真浏览器：chips 滑到头再往外拖，文档没被带着横向滚',
    ],
    expectGreen: [
      '真浏览器：.tabs 的 computed overscroll-behavior-x = contain',
      '真浏览器：html 的 computed overscroll-behavior-x = none',
    ],
  },
  {
    id: 'B3', file: 'css', name: '根上的横向越界兜底没了（视口自己就能触发历史回退）',
    from: '  overscroll-behavior-x: none;\n}',
    to: '}',
    expectFail: [
      '静态：html, body 规则里有 overscroll-behavior-x: none',
      '真浏览器：html 的 computed overscroll-behavior-x = none',
      '真浏览器：body 的 computed overscroll-behavior-x = none',
    ],
    expectGreen: [
      '真浏览器：.chips 的 computed overscroll-behavior-x = contain',
      '真浏览器：.tabs 的 computed overscroll-behavior-x = contain',
    ],
  },
  {
    id: 'B4', file: 'app', name: '查看器的横向手势不接管了（浏览器有机会把它当回退手势）',
    from: 'if (Math.abs(dx) > Math.abs(dy)) e.preventDefault();',
    to: '/* 变异：不接管横向手势 */',
    expectFail: ['真浏览器：查看器里横向拖动被 preventDefault'],
    expectGreen: [
      '真浏览器：横向拖动仍然切图（老行为不坏）',
      '真浏览器：查看器里纵向拖动不被拦',
    ],
  },
];

function redLabels(out) {
  return String(out)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('✗ '))
    .map((l) => l.slice(2));
}
function isRed(out, needle) {
  return redLabels(out).some((l) => l.includes(needle));
}
function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/* ── 还原保险 ─────────────────────────────────────────────── */
const original = new Map();
for (const [k, f] of Object.entries(TARGETS)) original.set(k, fs.readFileSync(f, 'utf8'));

let restored = false;
function restoreAll() {
  if (restored) return;
  restored = true;
  for (const [k, f] of Object.entries(TARGETS)) {
    try { fs.writeFileSync(f, original.get(k), 'utf8'); } catch { /* 还原不了就靠下面的校验报错 */ }
  }
}
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); process.exit(1); });
}

let caught = 0;
let broken = 0;
const failed = [];

try {
  for (const m of MUTANTS) {
    const file = TARGETS[m.file];
    const src = original.get(m.file);

    /* 锚点自检：必须恰好命中一次。 */
    const hits = src.split(m.from).length - 1;
    if (hits !== 1) {
      console.log(`  ✗ ${m.id} ${m.name} —— 锚点命中 ${hits} 次（应该恰好 1 次；源码改了？）`);
      broken++;
      failed.push(m.id);
      continue;
    }
    const mutated = src.replace(m.from, m.to);
    if (mutated === src) {
      console.log(`  ✗ ${m.id} ${m.name} —— 变异没落地`);
      broken++;
      failed.push(m.id);
      continue;
    }

    fs.writeFileSync(file, mutated, 'utf8');
    let r;
    try {
      r = spawnSync(process.execPath, [GUARD], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    } finally {
      /* 每条变异跑完立刻还原 —— 别攒到最后。 */
      fs.writeFileSync(file, src, 'utf8');
    }
    const out = `${r.stdout || ''}${r.stderr || ''}`;

    /* 护栏自己崩了 = 假红，不算「抓到」。 */
    if (/SyntaxError|Cannot find module|ReferenceError|TypeError/.test(out)) {
      console.log(`  ✗ ${m.id} ${m.name} —— 变异把护栏自己搞崩了（假红，不算抓到）`);
      broken++;
      failed.push(m.id);
      continue;
    }

    const missed = m.expectFail.filter((label) => !isRed(out, label));
    const broke = m.expectGreen.filter((label) => isRed(out, label));

    if (missed.length === 0 && broke.length === 0) {
      caught++;
      console.log(`  ✓ ${m.id} ${m.name} —— 被抓住`);
    } else if (missed.length === 0) {
      console.log(`  ✗ ${m.id} ${m.name} —— 抓到了，但把不该红的弄红了：${broke.join('、')}`);
      failed.push(m.id);
    } else {
      console.log(`  ✗ ${m.id} ${m.name} —— 没抓到（应该红的没红：${missed.join('、')}）`);
      failed.push(m.id);
    }
  }
} finally {
  restoreAll();
}

/* ── 还原校验：源文件必须跟跑之前**逐字节**一样 ── */
const bad = [];
for (const [k, f] of Object.entries(TARGETS)) {
  const now = fs.readFileSync(f, 'utf8');
  if (sha256(now) !== sha256(original.get(k))) bad.push(k);
}
if (bad.length) {
  console.log(`  ✗ 源文件没还原干净：${bad.join('、')} —— 手动 git checkout 一下`);
  process.exit(1);
}

console.log(`\n变异测试：${caught}/${MUTANTS.length} 被抓到` + (broken ? `，${broken} 条脚本坏了` : ''));
if (failed.length) console.log('没过的：' + failed.join('、'));
process.exit(caught === MUTANTS.length && broken === 0 ? 0 : 1);
