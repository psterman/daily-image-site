#!/usr/bin/env node
/**
 * 变异测试：证明 test-share-page.mjs 真的有牙齿。
 *
 * 规矩（跟 tools/test-back-gesture-mutate.mjs 一样）：
 *   ① 每条变异都要写明「应该红的断言」和「应该仍然绿的断言」；
 *   ② 变异点必须**恰好命中一次** —— 命中 0 次说明脚本过期了（源码改了），
 *      命中 2 次说明锚点不唯一 —— 直接 exit 1，别把「脚本坏了」混进「没抓到」；
 *   ③ **必须还原**：改的是**源文件本身**（护栏要读它），
 *      所以跑完必须逐字节还原并校验 sha256；
 *      中途被打断（Ctrl+C / 崩了 / 超时）也要还原 → finally + exit 兜底。
 *   ④ 期望红 / 期望绿都用子串匹配 —— 护栏的标签以后可能会改，
 *      不该因为改了措辞就把这套脚本报废。
 *
 * ⚠️ 锚点为什么这么长：`build: (m) => ...` 在 upstream-url.mjs 里不止一处，
 *    「src 可能出现在多处」同理 —— 所以锚点必须带上**各自的上下文**，
 *    命中数不是 1 就直接判脚本坏了。
 * ⚠️ **等价变异体**：「卡片图长边 900」在两处都有实现
 *    （tools/build-cards.mjs 的 CARD_MAX_EDGE 与 functions/pic/[[path]].js 的 CARD_LONG_EDGE），
 *    只改一处会出现「另一处兜住了行为 → 护栏不红」的假象，所以 M5 两处一起改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'tools', 'test-share-page.mjs');
const TARGETS = {
  upstream: path.join(ROOT, 'tools', 'upstream-url.mjs'),
  build: path.join(ROOT, 'tools', 'build.mjs'),
  cards: path.join(ROOT, 'tools', 'build-cards.mjs'),
  fn: path.join(ROOT, 'functions', 'pic', '[[path]].js'),
  app: path.join(ROOT, 'site', 'app.js'),
};

const MUTANTS = [
  {
    id: 'M1', file: 'upstream', name: '见笑规则改成返回 null（原帖链接全丢了）',
    from: '    build: (m) => `https://t.me/${m[1]}/${m[2]}`,',
    to: '    build: () => null,',
    expectFail: ['纯函数：upstreamUrlFor 见笑规则匹配 → t.me 链接'],
    expectGreen: [
      '纯函数：见她不给原帖（返回 null）',
      '纯函数：见闻不给原帖（返回 null）',
      '静态：tools/upstream-url.mjs 存在并导出 upstreamUrlFor',
    ],
  },
  {
    id: 'M2', file: 'upstream', name: '见笑规则里的 t.me 写错域名（链接指到别的站去）',
    from: '    build: (m) => `https://t.me/${m[1]}/${m[2]}`,',
    to: '    build: (m) => `https://telegram.me/${m[1]}/${m[2]}`,',
    expectFail: ['纯函数：upstreamUrlFor 见笑规则匹配 → t.me 链接'],
    expectGreen: [
      '纯函数：见她不给原帖（返回 null）',
      '纯函数：见闻不给原帖（返回 null）',
      '静态：tools/upstream-url.mjs 存在并导出 upstreamUrlFor',
    ],
  },
  {
    id: 'M3', file: 'upstream', name: '见她规则开始返回 URL（错误地给出原帖）',
    from: '    // 这一版不给链接 —— 规则先留着，等上面那条路走通了把 build 填上就行。\n    build: () => null,',
    to: '    // 这一版不给链接 —— 规则先留着，等上面那条路走通了把 build 填上就行。\n    build: (m) => `https://jandan.net/cms/detail/${m[1]}`,',
    expectFail: ['纯函数：见她不给原帖（返回 null）'],
    expectGreen: [
      '纯函数：upstreamUrlFor 见笑规则匹配 → t.me 链接',
      '纯函数：见闻不给原帖（返回 null）',
    ],
  },
  {
    id: 'M4', file: 'build', name: 'manifest 里 src 字段不写了（分享页永远没有「看原帖」）',
    from: '        ...(upstream ? { src: upstream } : {}),',
    to: '        // 变异：src 字段不写了',
    expectFail: ['静态：build.mjs 的媒体 item 带 src'],
    expectGreen: [
      '静态：build.mjs 用 upstreamUrlFor 反解上游原帖',
      '静态：tools/upstream-url.mjs 存在并导出 upstreamUrlFor',
    ],
  },
  {
    id: 'M5', file: ['cards', 'fn'], name: '卡片图规格从长边 900 改成 600（生成端和分享页端一起改）',
    from: {
      cards: 'export const CARD_MAX_EDGE = 900;',
      fn: 'const CARD_LONG_EDGE = 900;',
    },
    to: {
      cards: 'export const CARD_MAX_EDGE = 600;',
      fn: 'const CARD_LONG_EDGE = 600;',
    },
    expectFail: [
      '静态：tools/build-cards.mjs 存在，卡片图规格是长边 900 / 质量 70',
      '静态：分享页声明的卡片图长边也是 900',
    ],
    expectGreen: [
      '产物：card/jianxiao 的卡片图长边 = 900（等比放大到 900）',
      '纯函数：cardImage 为 null 时 og:image 降级成 <日期>/og.jpg',
    ],
  },
  {
    id: 'M6', file: 'fn', name: 'renderSharePage 在没有 src 时也渲染「看原帖」（空链接）',
    from: '  const srcLink = srcUrl\n    ? `\\n    <a class="btn" href="${esc(srcUrl)}" target="_blank" rel="noopener noreferrer">看原帖</a>`\n    : \'\';',
    to: '  const srcLink = `\\n    <a class="btn" href="${esc(srcUrl)}" target="_blank" rel="noopener noreferrer">看原帖</a>`;',
    expectFail: [
      '纯函数：没传 src 时 HTML 里没有「看原帖」',
      '真浏览器：没有 src 时「看原帖」整个不出现',
    ],
    expectGreen: [
      '纯函数：传了 src 时 HTML 里有「看原帖」',
      '真浏览器：「看原帖」有 src 时可见且 href 正确',
    ],
  },
  {
    id: 'M7', file: 'fn', name: 'renderSharePage 的 og:image 写成相对路径（微信爬虫抓不到）',
    from: '<meta property="og:image" content="${esc(card.url)}">',
    to: '<meta property="og:image" content="${esc(card.url.slice(siteUrl.length))}">',
    expectFail: ['纯函数：og:image 是绝对 URL（微信爬虫抓不到相对路径）'],
    expectGreen: [
      '纯函数：cardImage 为 null 时 og:image 降级成 <日期>/og.jpg',
      '纯函数：og 标签齐全（title / description / image / url / type / twitter:card）',
    ],
  },
  {
    id: 'M8', file: 'fn', name: '降级逻辑失效（cardImage 为 null 时不降级成该期 og.jpg）',
    from: '  const card = normalizeCard(o.cardImage) || {\n    url: `${siteUrl}/${date}/og.jpg`,\n    width: OG_FALLBACK_WIDTH,\n    height: OG_FALLBACK_HEIGHT,\n  };',
    to: '  const card = normalizeCard(o.cardImage) || { url: "", width: 0, height: 0 };',
    expectFail: ['纯函数：cardImage 为 null 时 og:image 降级成 <日期>/og.jpg'],
    expectGreen: [
      '纯函数：og:image 是绝对 URL（微信爬虫抓不到相对路径）',
      '纯函数：og 标签齐全（title / description / image / url / type / twitter:card）',
    ],
  },
  {
    id: 'M9', file: 'app', name: '前端 #viewerOrigin 不做条件显示（没有 src 也留个空按钮）',
    from: '      if (upstream) {\n        originLink.setAttribute(\'href\', upstream);\n        originLink.hidden = false;\n      } else {\n        originLink.removeAttribute(\'href\');\n        originLink.hidden = true;\n      }',
    to: '      originLink.setAttribute(\'href\', upstream || \'#\');\n      originLink.hidden = false;',
    expectFail: ['静态：site/app.js 里 #viewerOrigin 按 item.src 条件显示'],
    expectGreen: [
      '静态：site/app.js 里有分享三件套的 id（viewerShare / viewerOriginal / viewerOrigin）',
      '静态：site/template.html 里有那三个 id',
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

/** 一条变异可以改多个文件（等价变异体必须一起改）—— file 写成数组即可。 */
function targetsOf(m) {
  return (Array.isArray(m.file) ? m.file : [m.file]);
}
function pieceOf(spec, key) {
  return (spec && typeof spec === 'object' && !Array.isArray(spec)) ? spec[key] : spec;
}

let caught = 0;
let broken = 0;
const failed = [];

try {
  for (const m of MUTANTS) {
    const keys = targetsOf(m);
    const srcs = keys.map((k) => original.get(k));

    /* 锚点自检：每个文件都要恰好命中一次。 */
    let badHit = null;
    for (let i = 0; i < keys.length; i++) {
      const hits = srcs[i].split(pieceOf(m.from, keys[i])).length - 1;
      if (hits !== 1) { badHit = `${keys[i]}（命中 ${hits} 次）`; break; }
    }
    if (badHit) {
      console.log(`  ✗ ${m.id} ${m.name} —— 锚点命中不对：${badHit}（应该恰好 1 次；源码改了？）`);
      broken++;
      failed.push(m.id);
      continue;
    }

    /* 落地变异（多文件时逐个写）。 */
    let mutated = true;
    for (let i = 0; i < keys.length; i++) {
      const from = pieceOf(m.from, keys[i]);
      const to = pieceOf(m.to, keys[i]);
      const next = srcs[i].replace(from, to);
      if (next === srcs[i]) { mutated = false; break; }
      fs.writeFileSync(TARGETS[keys[i]], next, 'utf8');
    }
    if (!mutated) {
      console.log(`  ✗ ${m.id} ${m.name} —— 变异没落地`);
      broken++;
      failed.push(m.id);
      for (const k of keys) fs.writeFileSync(TARGETS[k], original.get(k), 'utf8');
      continue;
    }

    let r;
    try {
      r = spawnSync(process.execPath, [GUARD], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
    } finally {
      /* 每条变异跑完立刻还原 —— 别攒到最后。 */
      for (const k of keys) fs.writeFileSync(TARGETS[k], original.get(k), 'utf8');
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
