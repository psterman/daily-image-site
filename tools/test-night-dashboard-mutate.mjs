#!/usr/bin/env node
/**
 * 变异测试：证明 test-night-dashboard.mjs 真的有牙齿。
 *
 * 规矩：
 *   ① 每条变异都要写明「应该红的断言」和「应该仍然绿的断言」；
 *   ② 变异点必须**恰好命中一次** —— 命中 0 次说明脚本过期了（源码改了），
 *      命中 2 次说明锚点不唯一 —— 直接 exit 1，别把「脚本坏了」混进「没抓到」；
 *   ③ **必须还原**：改的是**源文件本身**（护栏要 import 它），
 *      所以跑完必须逐字节还原，并校验 sha256。
 *      中途被打断（Ctrl+C / 崩了 / 超时）也要还原 → finally + exit 兜底。
 *   ④ **期望红 / 期望绿都用子串匹配** —— 护栏的标签以后可能会改，
 *      不该因为改了措辞就把这套脚本报废。
 *
 * ⚠️ HTTP 层的变异**绝不许真的发起一次发布**：
 *    护栏的主测试实例挂了**假的 spawn 钩子**（Task 4 修复轮加的 `opts.spawnFn`），
 *    所以即使 `allowWrite` 被改坏，也只是钩子被调用 → 不会真的 spawn。
 *    ⚠️ 别把护栏里那个 spawnFn 钩子删了 —— 删了之后这套脚本就可能真发一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'tools', 'test-night-dashboard.mjs');
const TARGETS = {
  state: path.join(ROOT, 'tools', 'night-dashboard-state.mjs'),
  http: path.join(ROOT, 'tools', 'night-dashboard.mjs'),
  notify: path.join(ROOT, 'tools', 'notify.ps1'),
  common: path.join(ROOT, 'tools', 'common.ps1'),
};

const MUTANTS = [
  /* ── 解析层 ─────────────────────────────────────────────── */
  {
    id: 'M1', file: 'state', name: '不再剥 BOM（JSON.parse 遇到 \\uFEFF 直接抛）',
    from: 's.charCodeAt(0) === 0xFEFF ? s.slice(1) : s',
    to: 's',
    expectFail: ['stripBom 剥掉 U+FEFF', '.done 能剥 BOM 并解析'],
    expectGreen: ['stripBom 对没有 BOM 的原样返回'],
  },
  {
    id: 'M2', file: 'state', name: '时间戳正则不再允许缺省（老日志全解析不了）',
    from: "const STEP_RE = /^===\\s+(\\d+)\\/(\\d+)\\s+(.+?)\\s+===\\s*(?:\\[(\\d{2}:\\d{2}:\\d{2})\\])?\\s*$/;",
    to: "const STEP_RE = /^===\\s+(\\d+)\\/(\\d+)\\s+(.+?)\\s+===\\s+\\[(\\d{2}:\\d{2}:\\d{2})\\]\\s*$/;",
    expectFail: ['老日志（无时间戳）也能解析'],
    expectGreen: ['新格式解析出 2 个步骤'],
  },
  {
    id: 'M3', file: 'state', name: '跨零点不再 +1 天（时长会算成负数）',
    from: 'if (Number.isFinite(prevMs) && atMs < prevMs) atMs += 24 * 60 * 60 * 1000;',
    to: '/* 变异：去掉跨零点处理 */',
    expectFail: ['跨零点：后一步自动 +1 天'],
    expectGreen: ['新格式有时间戳'],
  },
  {
    id: 'M4', file: 'state', name: '阶段耗时算反了（会变成负数）',
    from: 'Math.max(0, to - steps[i].atMs)',
    to: 'steps[i].atMs - to',
    expectFail: ['阶段耗时 = 下一步时刻 − 本步时刻', '阶段耗时不会算出负数'],
    expectGreen: ['新格式解析出 2 个步骤'],
  },
  {
    id: 'M5', file: 'state', name: '分组规则把 2/3、3/3 也算进「准备」',
    from: "if (den === 3) return num === 1 ? 'prepare' : 'verify';",
    to: "if (den === 3) return 'prepare';",
    expectFail: ['2/3、3/3 归「校验与审稿」'],
    expectGreen: ['1/3 与 N/5 归「准备」'],
  },
  {
    id: 'M6', file: 'state', name: 'median 用了平均数（一个异常值就能把基准拉歪）',
    from: 'return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);',
    to: 'return Math.round(a.reduce((x, y) => x + y, 0) / a.length);',
    expectFail: ['median 用中位数不是平均数（一个异常值不能拉歪基准）'],
    expectGreen: ['median 取奇数个的中位数'],
  },

  /* ── HTTP 层（评审实测这 5 个以前全绿存活） ─────────────── */
  {
    id: 'M7', file: 'http', name: 'allowWrite 的闸门失效（写路径不再被拦）',
    from: 'if (!allowWrite)',
    to: 'if (false)',
    expectFail: ['不产生任何发布副作用'],
    expectGreen: ['/api/state → 200', '跨站 Origin → 403'],
  },
  {
    id: 'M8', file: 'http', name: 'allowWrite 被硬编码成 true（测试也会真发）',
    from: 'const allowWrite = opts.allowWrite === true;',
    to: 'const allowWrite = true;',
    expectFail: ['不产生任何发布副作用'],
    expectGreen: ['/api/state → 200', '跨站 Origin → 403'],
  },
  {
    id: 'M9', file: 'http', name: 'findLogFor 改回固定顺序（by:manual 那一夜取错日志）',
    from: "const want = done && done.by === 'manual' ? 'manual' : 'night';",
    to: "const want = 'night';",
    expectFail: ['manual 日志'],
    expectGreen: ['/api/state → 200'],
  },
  {
    id: 'M10', file: 'http', name: '服务绑到 0.0.0.0（不再只对本机）',
    from: "server.listen(chosenPort, '127.0.0.1');",
    to: "server.listen(chosenPort, '0.0.0.0');",
    expectFail: ['只绑 127.0.0.1'],
    expectGreen: ['/api/state → 200'],
  },
  {
    id: 'M11', file: 'http', name: '/api/log 读整份日志（不再只读尾部 64KB）',
    from: "const text = log ? readTail(log.file, 64 * 1024) : '';",
    to: "const text = log ? readText(log.file) : '';",
    expectFail: ['只读尾部 64KB'],
    expectGreen: ['/api/state → 200'],
  },
  {
    id: 'M12', file: 'http', name: '去掉目录穿越防护（金丝雀会漏出来）',
    from: 'if (target !== UI_DIR && !target.startsWith(UI_DIR + path.sep)) {',
    to: 'if (false) {',
    expectFail: ['目录穿越（%2f 形式）拿不到金丝雀'],
    expectGreen: ['/api/state → 200'],
  },

  /* ── AUMID 归位（平台字面量只放 common.ps1） ────────────── */
  {
    id: 'M13', file: 'notify', name: '把 AUMID 字面量搬回 notify.ps1（反斜杠路径 + 硬编码 powershell.exe 又回来了）',
    from: '  $aumid = Get-ToastAumid',
    to: "  $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE519E7B}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    expectFail: ['notify.ps1 的 AUMID 走 common.ps1 的 Get-ToastAumid'],
    expectGreen: ['common.ps1 定义了 Get-ToastAumid', 'notify.ps1 dot-source 了 common.ps1', 'notify.ps1 能被 PowerShell 解析'],
  },
  {
    id: 'M14', file: 'common', name: 'Get-ToastAumid 被改名/删掉（notify.ps1 拿不到 AUMID → toast 发不出去）',
    from: 'function Get-ToastAumid {',
    to: 'function Get-ToastAumidRemoved {',
    expectFail: ['common.ps1 定义了 Get-ToastAumid'],
    expectGreen: ['notify.ps1 的 AUMID 走 common.ps1 的 Get-ToastAumid', 'notify.ps1 能被 PowerShell 解析'],
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
/* 进程被 Ctrl+C / 崩了 / 超时 → 也要还原。 */
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
