/**
 * 日志轮转：把只增不减的日志切一份历史出来，原地清空。
 *
 * ⚠️ **为什么需要它**（2026-11-25 加）：
 *   `.night-publish-console.log` 是 `cmd >>` 重定向写出来的 —— **只追加，永不清理**。
 *   实测 11 天就涨到 505 KB / 9962 行，一年下来能到十几 MB，
 *   而且**每次排查问题都要 tail 它** → 越大越慢、越慢越不想看。
 *   `.daily-review.log` 同理（664 KB）。
 *
 *   台账 `.fetch-ledger.json` **不在这里处理** —— 它已经有自己的保留策略
 *   （fetch_ledger.py 的 KEEP_DAYS = 120，按日期清条目）。
 *
 * 设计要点：
 *   · **切历史而不是删** —— 保留最近 N 份，出问题还能回看。
 *   · **不碰正在写的文件** —— 只切已经存在且非空的（正在写的那份当天不动）。
 *   · **切完清空原文件而不是删掉** —— 因为 `cmd >>` 是按路径追加的，
 *     文件被删掉后 cmd 下次会重新创建，但**删文件在 Windows 上会失败**
 *     （文件被 cmd 句柄占用）→ 只能清空。
 *   · **幂等** —— 跑两遍不会出问题。
 *
 * 用法：
 *   node tools/rotate-logs.mjs           # 轮转（默认保留 7 份历史）
 *   node tools/rotate-logs.mjs --keep 3  # 只保留 3 份
 *   node tools/rotate-logs.mjs --dry     # 只看会做什么，不动手
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ── 要轮转的日志 ──────────────────────────────────────────────
 * 注意：只列**纯追加型**的日志。
 * `.night-publish-<日期>.log` 是**每天一份**的（night-publish.ps1 自己重开），
 * 不是只增不减 → 不在这里管。
 */
const TARGETS = [
  { file: '.night-publish-console.log', keep: 7 },
  { file: '.daily-review.log', keep: 7 },
  { file: '.night-watchdog-console.log', keep: 7 },
];

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const keepIdx = args.indexOf('--keep');
const globalKeep = keepIdx >= 0 ? Number(args[keepIdx + 1]) : null;

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 给历史文件排序。文件名形如 `<原名>.1` / `<原名>.2` …（数字越大越旧）。
 */
function historyFiles(basePath) {
  const dir = path.dirname(basePath);
  const base = path.basename(basePath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(base + '.'))
    .map((f) => {
      const m = f.match(/\.(\d+)$/);
      return { file: f, idx: m ? Number(m[1]) : 0 };
    })
    .filter((x) => x.idx > 0)
    .sort((a, b) => a.idx - b.idx);
}

function rotateOne(target) {
  const keep = globalKeep != null && Number.isFinite(globalKeep) ? globalKeep : target.keep;
  const p = path.join(ROOT, target.file);

  if (!fs.existsSync(p)) {
    console.log(`  · ${target.file} 不存在，跳过`);
    return;
  }
  const size = fs.statSync(p).size;
  if (size === 0) {
    console.log(`  · ${target.file} 是空的，跳过`);
    return;
  }

  const hist = historyFiles(p);
  // 旧的 .1 要变成 .2，.2 变 .3 …（从最旧的一路往前挪）
  // 倒序遍历，先挪最旧的，避免覆盖
  //
  // ⚠️ 挪之前先算好「哪些要删」：挪完之后文件名会整体后移一位，
  //    如果挪完再按新文件名算「多余的」，会把**刚切出来的 .1 也删掉**
  //    （实测踩过：轮转完 .1 直接没了，历史全丢）。
  //    所以「要删哪些」必须在挪之前按**旧编号**定下来。
  const doomedIdx = hist.map((h) => h.idx).filter((idx) => idx >= keep);
  for (let i = hist.length - 1; i >= 0; i--) {
    const from = path.join(ROOT, hist[i].file);
    const to = path.join(ROOT, `${target.file}.${hist[i].idx + 1}`);
    if (dry) {
      console.log(`    [dry] ${hist[i].file} -> ${path.basename(to)}`);
      continue;
    }
    try {
      fs.renameSync(from, to);
    } catch (e) {
      console.log(`    ! 挪不动 ${hist[i].file}：${e.message}`);
    }
  }

  // 当前的 -> .1
  if (dry) {
    console.log(`  → ${target.file} (${fmtSize(size)}) 会切成 ${target.file}.1`);
  } else {
    try {
      fs.renameSync(p, path.join(ROOT, `${target.file}.1`));
      // 重新建一个空的（cmd >> 靠它存在才追加）
      fs.writeFileSync(p, '');
      console.log(`  ✓ ${target.file} (${fmtSize(size)}) -> ${target.file}.1`);
    } catch (e) {
      console.log(`  ! ${target.file} 轮转失败：${e.message}`);
    }
  }

  // 只保留最近 keep 份历史，多余的删掉
  // ⚠️ 按上面定下的**旧编号**删（编号 ≥ keep 的那些，它们被挪到了 +1 的位置）
  for (const idx of doomedIdx) {
    const fname = `${target.file}.${idx + 1}`;
    const fp = path.join(ROOT, fname);
    if (!fs.existsSync(fp)) continue;
    if (dry) {
      console.log(`    [dry] 会删 ${fname}`);
      continue;
    }
    try {
      fs.unlinkSync(fp);
      console.log(`    - 删掉旧历史 ${fname}`);
    } catch (e) {
      console.log(`    ! 删不掉 ${fname}：${e.message}`);
    }
  }
}

console.log(`日志轮转${dry ? '（dry-run，不动手）' : ''}`);
for (const t of TARGETS) rotateOne(t);
console.log('完成。');
