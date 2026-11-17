#!/usr/bin/env node
/**
 * 打一个「自包含静态包」：页面 + 图片全在同一个目录，可直接丢到任意静态托管
 *
 *   dist-tmp/
 *   ├── index.html            归档入口
 *   ├── assets/               logo
 *   ├── 2026-10-25/           当天页
 *   └── img/2026-10-25/...    图片（页面里引用的 /img/ 路径）
 *
 * 用途：
 *   - 临时公网预览（今天就能发群里）
 *   - 不想用 R2 时，直接静态托管
 *
 * 用法：node tools/bundle-static.mjs [输出目录] [日期]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, R2_LOCAL } from './paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist-tmp'));
const onlyDate = process.argv[3];

async function copyTree(src, dst, filter) {
  let n = 0;
  let bytes = 0;
  let entries;
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch {
    return { n, bytes };
  }
  await fs.mkdir(dst, { recursive: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      const r = await copyTree(s, d, filter);
      n += r.n;
      bytes += r.bytes;
    } else if (!filter || filter(e.name)) {
      await fs.copyFile(s, d);
      const st = await fs.stat(d);
      n++;
      bytes += st.size;
    }
  }
  return { n, bytes };
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  // 1. 页面（含 assets/ 与各日期目录）
  const pub = await copyTree(path.join(ROOT, 'published'), OUT);

  // 2. 图片 -> OUT/img/<日期>/...
  const r2Root = R2_LOCAL;
  const dates = (await fs.readdir(r2Root, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((d) => !onlyDate || d === onlyDate);

  let imgN = 0;
  let imgBytes = 0;
  for (const d of dates) {
    const r = await copyTree(path.join(r2Root, d), path.join(OUT, 'img', d));
    imgN += r.n;
    imgBytes += r.bytes;
  }

  const total = pub.bytes + imgBytes;
  console.log('自包含静态包已生成');
  console.log(`  目录   : ${OUT}`);
  console.log(`  页面   : ${pub.n} 个 / ${(pub.bytes / 1024).toFixed(1)} KB`);
  console.log(`  图片   : ${imgN} 个 / ${(imgBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  合计   : ${(total / 1024 / 1024).toFixed(2)} MB`);
  console.log('');
  console.log('本地预览：node tools/dev-server.mjs 8788  (需把 dist-tmp 挂到根)');
}

main().catch((e) => {
  console.error('打包失败:', e.message);
  process.exit(1);
});
