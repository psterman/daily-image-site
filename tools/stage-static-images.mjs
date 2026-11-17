#!/usr/bin/env node
/**
 * 把 r2/<date>/ 下的图片复制到 published/img/<date>/，
 * 让「R2 还没启用」时的静态兜底能出图。
 *
 * 页面里引用的路径本来就是 /img/<date>/<tab>/<file>.webp，
 * 和这里生成的路径完全一致，所以不用改前端。
 *
 * 用法：
 *   node tools/stage-static-images.mjs            # 全部日期
 *   node tools/stage-static-images.mjs 2026-10-25 # 只处理一天
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, R2_LOCAL } from './paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R2_ROOT = R2_LOCAL;
const IMG_ROOT = path.join(ROOT, 'published', 'img');

// Pages 免费版单站文件数上限 20,000，留点余量
const FILE_LIMIT = 20000;
const WARN_AT = 15000;

async function walk(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else out.push({ file: full, rel: path.relative(base, full) });
  }
  return out;
}

async function main() {
  const onlyDate = process.argv[2];
  const dates = (await fs.readdir(R2_ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((d) => !onlyDate || d === onlyDate)
    .sort();

  if (!dates.length) {
    console.error(`r2/ 下没有可暂存的图片${onlyDate ? `（找的是 ${onlyDate}）` : ''}`);
    process.exit(1);
  }

  let files = 0;
  let bytes = 0;

  for (const date of dates) {
    const list = await walk(path.join(R2_ROOT, date));
    if (!list.length) continue;

    for (const f of list) {
      const dest = path.join(IMG_ROOT, date, f.rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(f.file, dest);
      const st = await fs.stat(dest);
      bytes += st.size;
      files++;
    }

    // 清掉目标目录里源目录已经没有的文件。
    // 改名（文件名带随机段）或删图之后，旧文件会残留在这里，
    // 打进部署包既占空间又白占 Pages 的 20,000 文件额度。
    const srcSet = new Set(list.map((f) => f.rel));
    let pruned = 0;
    for (const f of await walk(path.join(IMG_ROOT, date))) {
      if (!srcSet.has(f.rel)) {
        await fs.rm(f.file, { force: true });
        pruned++;
      }
    }

    console.log(
      `  ✓ ${date}  ${list.length} 个文件` +
        (pruned ? `  (清理旧命名残留 ${pruned} 个)` : ''),
    );
  }

  // 连同已有的历史图片一起算总数（published/img 可能已有别的日期）
  let total = 0;
  const countAll = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await countAll(path.join(dir, e.name));
      else total++;
    }
  };
  await countAll(IMG_ROOT);

  console.log('');
  console.log(`静态兜底已暂存：${files} 个文件 / ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`published/img/ 累计文件数：${total} / ${FILE_LIMIT}`);

  // Pages 每站 20,000 个文件的上限是静态兜底模式的真正瓶颈：
  // 每天新增 490 个文件，约 40 天就会撞线，撞线后整个站点部署直接失败。
  // R2 模式则不受这个限制（图片不在 Pages 资产里）。
  const perDay = files || 1;
  const daysLeft = Math.floor((FILE_LIMIT - total) / perDay);
  console.log(`按本次 ${perDay} 个文件/天估算：还能撑约 ${daysLeft} 天`);

  if (daysLeft <= 7) {
    console.log('');
    console.log(
      `  !! 只剩 ${daysLeft} 天！Pages 每站 ${FILE_LIMIT} 个文件的上限快撞上了，` +
        `撞线后部署会直接失败、站点当天发不出去。`,
    );
    console.log('     立刻去 Dashboard 启用 R2：https://dash.cloudflare.com -> R2');
  } else if (daysLeft <= 30) {
    console.log(
      `  !! 只剩 ${daysLeft} 天。建议尽快在 Dashboard 启用 R2，` +
        `之后图片走 R2，这个限制就不存在了（部署包也会从每天 ${(bytes / 1024 / 1024).toFixed(1)} MB 回到几百 KB）。`,
    );
  }
}

main().catch((e) => {
  console.error('暂存失败:', e.message);
  process.exit(1);
});
