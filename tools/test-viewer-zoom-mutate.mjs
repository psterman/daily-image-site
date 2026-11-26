#!/usr/bin/env node
/**
 * 变异测试：证明 test-viewer-zoom.mjs 真的有牙齿。
 *
 * 规矩（跟 tools/test-night-dashboard-mutate.mjs 一样）：
 *   ① 每条变异都要写明「应该红的断言」和「应该仍然绿的断言」；
 *   ② 变异点必须**恰好命中一次** —— 命中 0 次说明脚本过期了（源码改了），
 *      命中 2 次说明锚点不唯一 —— 直接 exit 1，别把「脚本坏了」混进「没抓到」；
 *   ③ **必须还原**：改的是**源文件本身**（护栏要读它），
 *      所以跑完必须逐字节还原并校验 sha256；
 *      中途被打断（Ctrl+C / 崩了 / 超时）也要还原 → finally + exit 兜底。
 *   ④ 期望红 / 期望绿都用子串匹配 —— 护栏的标签以后可能会改，
 *      不该因为改了措辞就把这套脚本报废。
 *
 * ⚠️ 这套护栏是 Playwright 的**真手势**测试（会起浏览器、约 10 秒一套），
 *    所以变异条数不能铺太多 —— 12 条大约两分半。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'tools', 'test-viewer-zoom.mjs');
const TARGETS = {
  app: path.join(ROOT, 'site', 'app.js'),
  css: path.join(ROOT, 'site', 'app.css'),
  tpl: path.join(ROOT, 'site', 'template.html'),
  build: path.join(ROOT, 'tools', 'build.mjs'),
};

const MUTANTS = [
  {
    id: 'Z1', file: 'app', name: '捏合分支失效（两指分开不再放大）',
    from: 'if (pinching && e.touches.length >= 2) {',
    to: 'if (false) {',
    expectFail: ['双指捏合能放大'],
    expectGreen: ['点开大图后查看器是开的，图已解码', '触屏这一路没有 JS 报错'],
  },
  {
    id: 'Z2', file: 'app', name: '缩放下限没了（能缩到 1× 以下）',
    /* ⚠️ 缩小的下限有**两处**（Math.max 和下面那句 nz<=1.001 → 1），
       任何一处单独改掉都是**等价变异体**（另一处照样兜住）→ 抓不住。
       所以这条必须两处一起改。 */
    from: 'var nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));\n    if (nz <= 1.001) nz = 1;',
    to: 'var nz = Math.min(ZOOM_MAX, z);',
    expectFail: ['滚轮缩到最小会夹在 1×（不会小于 1）'],
    expectGreen: ['桌面滚轮能放大', '触屏这一路没有 JS 报错'],
  },
  {
    id: 'Z3', file: 'app', name: '缩放上限没了（能无限放大）',
    from: 'var nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));',
    to: 'var nz = Math.max(ZOOM_MIN, z);',
    expectFail: ['滚轮放到最大会夹在 4×'],
    expectGreen: ['桌面滚轮能放大', '触屏这一路没有 JS 报错'],
  },
  {
    id: 'Z4', file: 'app', name: '双击判定失效（单击关、双击也不放大）',
    from: 'if (isDoubleTap(x, y)) {',
    to: 'if (false) {',
    expectFail: ['双击放大：比例变成 2.5×'],
    expectGreen: ['单击仍然关闭查看器', '触屏这一路没有 JS 报错'],
  },
  {
    id: 'Z5', file: 'app', name: '单击不再延后（双击的第一下就把查看器关了）',
    from: '      else closeViewer();\n    }, 240);',
    to: '      else closeViewer();\n    }, 0);',
    expectFail: ['双击放大：查看器没有被关掉'],
    expectGreen: ['单击仍然关闭查看器', '触屏这一路没有 JS 报错'],
  },
  {
    id: 'Z6', file: 'app', name: '平移边界没了（能把图拖出屏幕）',
    from: 'if (panX > maxX) panX = maxX; else if (panX < -maxX) panX = -maxX;',
    to: '/* 变异：去掉平移边界 */',
    expectFail: ['平移有边界'],
    expectGreen: ['点开大图后查看器是开的，图已解码', '触屏这一路没有 JS 报错'],
  },
  {
    id: 'Z7', file: 'app', name: '放大态下不提前返回（拖动看图会一路翻页）',
    from: `      if (!moved) handleTap(t.clientX, t.clientY);
      return;`,
    to: `      if (!moved) handleTap(t.clientX, t.clientY);`,
    expectFail: ['放大后拖动**不切图**'],
    expectGreen: ['1× 状态横向滑动仍然切图（老行为没坏）', '触屏这一路没有 JS 报错'],
  },
  {
    id: 'Z8', file: 'app', name: '倍数徽标不更新了',
    from: 'if (zoomBadge) {',
    to: 'if (false) {',
    expectFail: ['双击放大：倍数徽标显示 2.5×'],
    expectGreen: ['双击放大：比例变成 2.5×', '触屏这一路没有 JS 报错'],
  },
  {
    id: 'Z9', file: 'css', name: 'CSS 里的 touch-action 没了（浏览器会抢走双指手势）',
    from: '  touch-action: none;',
    to: '  /* 变异：去掉 touch-action */',
    expectFail: ['CSS：.viewer-stage 禁掉了浏览器自己的手势（touch-action:none）'],
    expectGreen: ['CSS：.viewer-stage img 的缩放锚点是中心（transform-origin:center center）'],
  },
  {
    id: 'Z10', file: 'css', name: '缩放锚点不是中心了',
    from: '  transform-origin: center center;',
    to: '  transform-origin: top left;',
    expectFail: ['CSS：.viewer-stage img 的缩放锚点是中心（transform-origin:center center）'],
    expectGreen: ['CSS：.viewer-stage 禁掉了浏览器自己的手势（touch-action:none）'],
  },
  {
    id: 'Z11', file: 'tpl', name: '提示里不再写「双击放大」（用户不知道能放大）',
    from: '左右滑动切换 · 双击放大 · 长按可保存',
    to: '左右滑动切换 · 长按可保存',
    expectFail: ['页面提示里写了「双击放大」（用户知道能放大）'],
    expectGreen: ['页面里有倍数徽标容器（#viewerZoom）'],
  },
  {
    id: 'Z12', file: 'build', name: '大图宽度上限又退回 1080（她那栏的像素又被压掉）',
    from: 'const FULL_MAX_W = 1920;',
    to: 'const FULL_MAX_W = 1080;',
    expectFail: ['构建：大图宽度上限是 1920（源图上限，见她那栏不再被压到 1080）'],
    expectGreen: ['点开大图后查看器是开的，图已解码'],
  },
];

/** 护栏输出里所有「红了的断言」标签（子串匹配用）。 */
function redLabels(out) {
  return out.split(/\r?\n/)
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
    /* 期望绿的那几条**不能**跟着变红 —— 否则说明这条变异把护栏整体掀翻了，
       那是「脚本坏了」，不是「有牙齿」。 */
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
