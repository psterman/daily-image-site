#!/usr/bin/env node
/**
 * 把 r2/<date>/ 下的图片上传到 Cloudflare R2
 *
 * 走 Cloudflare 官方 REST API（纯 fetch，不依赖 wrangler）：
 *   PUT https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{bucket}/objects/{key}
 *
 * 环境变量：
 *   CLOUDFLARE_ACCOUNT_ID   账号 ID
 *   CLOUDFLARE_API_TOKEN    API Token（需 R2 Storage:Edit 权限）
 *   R2_BUCKET              bucket 名，默认 your-bucket
 *
 * 用法：
 *   node tools/upload-r2.mjs            # 上传 r2/ 下所有日期
 *   node tools/upload-r2.mjs 2026-10-25
 *   node tools/upload-r2.mjs --dry      # 只打印计划，不真传
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { ROOT, R2_LOCAL } from './paths.mjs';
import { webpSize } from './webp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R2_ROOT = R2_LOCAL;

loadEnv();

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET = process.env.R2_BUCKET || 'your-bucket';
const CONCURRENCY = 8;

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry');
const onlyDate = argv.find((a) => !a.startsWith('--'));

if (!dryRun && (!ACCOUNT || !TOKEN)) {
  console.error('缺少环境变量：');
  if (!ACCOUNT) console.error('  CLOUDFLARE_ACCOUNT_ID');
  if (!TOKEN) console.error('  CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

/**
 * 只上传「构建产物」，其余一律跳过。
 *
 * 产物命名规则：<10位hex随机段>_<3位序号>.webp 和 ..._t.webp（缩略图）
 * 这是 build.mjs 生成的唯一格式，也是代理唯一肯放行的格式。
 *
 * 为什么必须过滤：
 *   母本目录 r2/<日期>/ 里可能混进别的东西 —— 比如用户拿旧版抓图脚本
 *   直接往这里倒的原图（images/、喷嚏图卦/、jandan女装/ 这些旧目录名）。
 *   以前这里是「有什么传什么」，结果原图也进了 R2：
 *   - 白占存储（Class A 写次数 + GB-月）
 *   - 线上虽然被代理按命名规则挡成 404，但对象确实躺在桶里
 *   - 上传时间翻倍
 *   所以这里按命名规则严格过滤，并把跳过的数量明确报出来。
 */
const PRODUCT_RE = /^[0-9a-f]{10}_\d{3}(_t)?\.webp$/;

/**
 * 产物「能不能用」：**存在** 且 **是能读出尺寸的 WebP**。
 *
 * 为什么光看文件名不够（2026-11-15 线上事故）：
 *   PRODUCT_RE 只管**文件名**。转码被中断会在母本里留下 0 字节的 WebP ——
 *   文件名照样合规 → 照传不误 → 线上代理以
 *   HTTP 200 / Content-Length: 0 / Content-Type: image/webp 吐出来 →
 *   2026-11-14 归档页那一格是裂图（状态码 200，监控看不出来）。
 *
 * 为什么用 webpSize：它直接读字节、不起进程（微秒级），
 *   几百上千个产物扫一遍不心疼（这个闸门在发布路径上，不能拖慢发布）。
 *
 * @returns {Promise<string|null>} null = 有效；字符串 = 出问题的原因（中文）
 */
async function productProblem(file) {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return '文件不存在';
  }
  if (st.size === 0) return '是 0 字节的空文件';
  try {
    await webpSize(file);
  } catch (err) {
    // webpSize 的报错形如「WebP 文件过短: <路径>」—— 只取前半句，路径另处已经说了
    return `不是有效的 WebP（${String(err.message || '').split(':')[0]}）`;
  }
  return null;
}

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
    else out.push({ file: full, key: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

async function put(key, file) {
  const body = await fs.readFile(file);
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}` +
    `/r2/buckets/${BUCKET}/objects/${key}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'image/webp',
        },
        body,
      });
      if (res.ok) return { ok: true, key, size: body.length };
      const text = await res.text();
      // 5xx / 429 可重试，4xx 直接失败
      if (res.status >= 500 || res.status === 429) {
        await new Promise((r) => setTimeout(r, 600 * attempt));
        continue;
      }
      return { ok: false, key, error: `${res.status} ${text.slice(0, 200)}` };
    } catch (err) {
      await new Promise((r) => setTimeout(r, 600 * attempt));
      if (attempt === 3) return { ok: false, key, error: err.message };
    }
  }
  return { ok: false, key, error: '重试耗尽' };
}

async function main() {
  const dates = (await fs.readdir(R2_ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((d) => !onlyDate || d === onlyDate)
    .sort();

  if (!dates.length) {
    console.error(`r2/ 下没有可上传的内容${onlyDate ? `（找的是 ${onlyDate}）` : ''}`);
    process.exit(1);
  }

  console.log(`Bucket : ${BUCKET}`);
  console.log(`Account: ${ACCOUNT || '(dry-run)'}`);
  console.log('');

  let totalFiles = 0;
  let totalBytes = 0;
  let skipped = 0;
  const failures = [];

  /* ── 第一步：把要传的文件收齐（只留构建产物） ───────────── */
  const jobs = [];
  for (const date of dates) {
    const all = await walk(path.join(R2_ROOT, date));
    if (!all.length) continue;

    // 只留构建产物；其余（用户手放的原图、旧目录名下的东西）跳过
    const files = all.filter((f) => PRODUCT_RE.test(path.posix.basename(f.key)));
    skipped += all.length - files.length;
    if (!files.length) continue;

    jobs.push({ date, files });
  }

  /* ── 第二步：有效性闸门（0 字节 / 坏文件头 = 一律不上传） ──
     为什么放在「真正上传之前」而且是全局的（不是按日期边传边查）：
       坏产物一旦传上去，线上就是裂图格子，而代理会照吐 200 / Content-Length: 0
       —— 状态码正常，监控看不出来，撤回还要等 24 小时边缘缓存。
       所以先把**所有**日期的产物都查一遍，有问题就**一张都不传**，
       直接以失败退出，让 publish.ps1 停住。

     dry 模式也走这一道：dry 只打印计划，但坏文件必须列出来。 */
  const invalid = [];
  for (const job of jobs) {
    for (const f of job.files) {
      const problem = await productProblem(f.file);
      if (problem) invalid.push({ date: job.date, key: f.key, problem });
    }
  }
  if (invalid.length) {
    console.error(`✗ 有 ${invalid.length} 个产物无效，一个都不上传：`);
    for (const x of invalid.slice(0, 20)) {
      console.error(`  ${x.date}/${x.key}：${x.problem}`);
    }
    if (invalid.length > 20) console.error(`  … 还有 ${invalid.length - 20} 个`);
    console.error(
      '这些产物传上去就是线上裂图格子（代理会以 200 / Content-Length: 0 吐出来）。',
    );
    console.error('多半是转码被中断留下的 0 字节母本 —— 先重新构建，再发布。');
    process.exit(1);
  }

  /* ── 第三步：上传 ──────────────────────────────────────── */
  for (const { date, files } of jobs) {
    let done = 0;
    let bytes = 0;
    const t0 = Date.now();

    if (dryRun) {
      for (const f of files) {
        const st = await fs.stat(f.file);
        bytes += st.size;
      }
      totalFiles += files.length;
      totalBytes += bytes;
      console.log(
        `[dry] ${date}  ${files.length} 个文件  ${(bytes / 1024 / 1024).toFixed(2)} MB`,
      );
      continue;
    }

    // 固定并发批次
    let idx = 0;
    const worker = async () => {
      while (idx < files.length) {
        const i = idx++;
        const f = files[i];
        const r = await put(`${date}/${f.key}`, f.file);
        if (r.ok) {
          bytes += r.size;
        } else {
          failures.push(r);
        }
        done++;
        if (done % 25 === 0 || done === files.length) {
          process.stdout.write(
            `\r  ${date}  ${done}/${files.length}  ${(bytes / 1024 / 1024).toFixed(2)} MB  `,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    process.stdout.write('\n');

    totalFiles += files.length;
    totalBytes += bytes;
    console.log(
      `  ✓ ${date}  ${files.length} 个  ${(bytes / 1024 / 1024).toFixed(2)} MB  ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  }

  console.log('');
  console.log(`上传完成：${totalFiles} 个文件，${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  if (skipped) {
    console.log(
      `跳过 ${skipped} 个非产物文件（不是 <随机段>_<序号>.webp 格式）。` +
        `这些多半是原图或旧目录名的残留，线上本来就 404，留在 R2 里只是白占空间。`,
    );
  }
  if (failures.length) {
    console.error(`失败 ${failures.length} 个：`);
    failures.slice(0, 10).forEach((f) => console.error(`  ${f.key}: ${f.error}`));
    process.exit(1);
  }

  // R2 上传成功后，清掉部署目录里的静态兜底副本。
  //
  // 为什么必须清：图片已经在私有 bucket 里了，部署包里再带一份 490 个文件
  // 纯属浪费 Pages 的 20000 文件配额 —— 而那正是切 R2 要解决的问题。
  // 真要退回静态兜底模式（临时关掉 R2 时），重跑 stage-static-images.mjs
  // 会从 r2/ 再生成一份，本地母本 r2/ 始终保留。
  if (!dryRun) {
    const imgDir = path.join(ROOT, 'published', 'img');
    const stale = await walk(imgDir);
    if (stale.length) {
      await fs.rm(imgDir, { recursive: true, force: true });
      console.log(`已清掉部署目录里的静态兜底副本：${stale.length} 个文件（图片只走 R2）`);
    }
  }
}

main().catch((err) => {
  console.error('上传失败:', err);
  process.exit(1);
});
