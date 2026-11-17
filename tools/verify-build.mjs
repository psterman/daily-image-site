#!/usr/bin/env node
/**
 * 产物自检：published/<日期>/manifest.*.js  ↔  r2/<日期>/<分类>/*.webp
 *
 * 为什么需要它：
 *   页面是从 manifest 里读图片 URL 的，图片本体在 R2。
 *   两边只要有一张对不上，线上就是一个裂图格子 —— 而且不报错、不报警，
 *   只有一个用户能看见的空白。
 *
 *   真实踩过的坑（2026-10-28）：删掉中间一张图后序号前移，
 *   随机段（nonce）跟着变，--no-convert 复用没对上，
 *   manifest 引用了 21 个不存在的文件，构建日志却全程报「成功」。
 *
 * 检查五件事：
 *   1. manifest 引用的每个产物，在 r2 母本里都存在 **而且是有效 WebP**
 *      （漏 → 线上裂图；「存在但坏了」同样 → 线上裂图，见下面 productProblem）
 *   2. r2 母本里没有被引用的孤儿产物                    （漏 → R2 白花钱）
 *   3. 源图张数 == manifest 各分类张数                    （漏 → 漏图）
 *   4. manifest 各分类 count 与 items 数量一致            （漏 → 前端显示错）
 *   5. 见报里没有同一个链接出现两遍                       （漏 → 同一条新闻出现两次）
 *
 * 用法：
 *   node tools/verify-build.mjs                # 校验 .publish-date 指定的那天
 *   node tools/verify-build.mjs --date 2026-10-28
 *   node tools/verify-build.mjs --date all     # 校验所有已构建的日期
 *
 * 退出码：0 = 全部通过；1 = 有问题（publish.ps1 会据此中止发布）
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, R2_LOCAL, SRC_LOCAL } from './paths.mjs';
import { linkKey } from './news-dedupe.mjs';
import { isTextTab } from './tab-kinds.mjs';
import { webpSize } from './webp.mjs';

function parseArgs(argv) {
  const out = { date: null, all: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const v = argv[++i];
      if (v === 'all') out.all = true;
      else out.date = v;
    } else if (a === '--all') out.all = true;
    else if (!out.date && !a.startsWith('-')) {
      if (a === 'all') out.all = true;
      else out.date = a;
    }
  }
  return out;
}

/** 读某天 published 目录里的 manifest（文件名带 hash，取最新的那个） */
function loadManifest(date) {
  const dir = path.join(ROOT, 'published', date);
  if (!fs.existsSync(dir)) return { error: `published/${date} 不存在` };
  const names = fs.readdirSync(dir).filter((n) => /^manifest\..*\.js$/.test(n));
  if (!names.length) return { error: `published/${date} 里没有 manifest` };
  // 同名 manifest 内容一样；多个说明是历史残留，取最后修改的
  names.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  const raw = fs.readFileSync(path.join(dir, names[0]), 'utf8');
  const json = raw.replace(/^window\.__DAILY_MANIFEST__=/, '').replace(/;\s*$/, '');
  try {
    return { manifest: JSON.parse(json), file: names[0] };
  } catch (e) {
    return { error: `manifest 解析失败：${e.message}` };
  }
}

/**
 * 产物「能不能用」：**存在** 且 **是能读出尺寸的 WebP**。
 *
 * 为什么不能只查存不存在（2026-11-15 线上事故）：
 *   转码被中断会在母本里留下 0 字节的 WebP —— fs.existsSync 判定「存在」→
 *   自检放行 → 0 字节传到 R2 → 线上代理以 200 / Content-Length: 0 吐出来 →
 *   2026-11-14 归档页那一格是裂图（状态码 200，监控看不出来）。
 *   「存在」不等于「能用」：还得真读一下文件头。
 *
 * 为什么用 webpSize：它直接读字节、不起进程（微秒级），
 *   当期几百上千个产物扫一遍不心疼（这个自检是发布闸门，不能拖慢发布）。
 *
 * @returns {Promise<string|null>} null = 有效；字符串 = 出问题的原因（中文）
 */
async function productProblem(file) {
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return '不存在';
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

async function checkDate(date) {
  const problems = [];
  const { manifest, file: mfFile, error } = loadManifest(date);
  if (error) {
    console.log(`\n[${date}] ✗ ${error}`);
    return { problems: [error], total: 0 };
  }

  const r2Date = path.join(R2_LOCAL, date);
  const referenced = new Map(); // 分类 -> Set(文件名)
  const rssRefs = new Set();    // 见报配图的文件名
  let refCount = 0;

  for (const tab of manifest.tabs || []) {
    /* 文本型 tab（见报 headlines / 榜单 rank）的条目是内容与远程链接，
       产物**不在 r2 母本里** —— 必须跳过，否则会被判成「缺少 full/thumb 字段」
       把发布拦下来。见报 tab 的 type 就是 'headlines'。 */
    if (isTextTab(tab)) {
      /* ⚠️ 但**本地化的封面**确实在母本里，不能跟着一起跳过。
         豆瓣封面图床对不带 Referer 一律 418 → 抓取端把封面下载到本地，
         构建期转成 WebP 存进 r2/<日期>/covers/，manifest 里是站内路径
         /img/<日期>/covers/<随机段>_<序号>.webp。
         引用了但文件不在 = 线上那个封面格子是空的，而构建日志全程报「成功」。

         远程热链封面（猫眼 / B站 / 网易云 / TVmaze）**不查** —— 它们不在母本里。 */
      for (const it of tab.items || []) {
        const c = typeof it.cover === 'string' ? it.cover : '';
        if (!c || c.indexOf('/img/') !== 0) continue;
        const parts = c.split('/').filter(Boolean);
        // /img/<日期>/<分类>/<文件名>
        if (parts.length < 4) {
          problems.push(`${tab.key}: 封面路径格式不对：${c}`);
          continue;
        }
        const coverFile = path.join(r2Date, parts[2], path.basename(parts[3]));
        const coverProblem = await productProblem(coverFile);
        if (coverProblem) {
          problems.push(
            `${tab.key}/${path.basename(parts[3])} 被 manifest 引用，但母本里的封面产物${coverProblem}`,
          );
        }
      }
      continue;
    }
    if (tab.key === 'news') {
      // 5. 见报里不能有同一个链接出现两遍
      //    （RSS 源和头条源收录了同一篇文章 —— 比如 V2EX 热榜：Python 抓的和
      //      RSS屋 镜像的是同一份热榜。构建期有跨源去重，这里是对真实产物的验收。）
      const seen = new Map();
      for (const it of tab.items || []) {
        // 6. 见报配图：manifest 引用的每一张图，母本里都必须真的存在。
        //    （跟照片同一个道理：引用了但文件不在 = 线上一个裂图格子，
        //      而构建日志全程报「成功」。照片那边查了，配图这边以前漏了。）
        if (it.img) {
          const rf = path.basename(it.img);
          rssRefs.add(rf);
          const rssProblem = await productProblem(path.join(r2Date, 'rss', rf));
          if (rssProblem) {
            problems.push(`rss/${rf} 被 manifest 引用，但母本里的配图产物${rssProblem}`);
          }
        }
        const key = linkKey(it);
        if (!key) continue;
        if (seen.has(key)) {
          problems.push(
            `见报: 同一个链接出现两遍（${seen.get(key)} × ${it.source}）— ${String(it.title).slice(0, 30)}`
          );
        } else {
          seen.set(key, it.source);
        }
      }
      continue;
    }

    // 4. count 与 items 数量一致
    if (typeof tab.count === 'number' && tab.count !== (tab.items || []).length) {
      problems.push(`${tab.key}: manifest count=${tab.count} 但 items=${(tab.items || []).length}`);
    }

    const set = referenced.get(tab.key) || new Set();
    for (const it of tab.items || []) {
      if (!it.full || !it.thumb) {
        problems.push(`${tab.key}: 条目 ${it.id} 缺少 full/thumb 字段`);
        continue;
      }
      const fn = path.basename(it.full);
      const tn = path.basename(it.thumb);
      set.add(fn);
      set.add(tn);
      refCount += 2;
      // 1. 引用的产物必须存在 **而且能用**（0 字节 / 坏文件头 = 线上裂图）
      for (const f of [fn, tn]) {
        const productIssue = await productProblem(path.join(r2Date, tab.key, f));
        if (productIssue) {
          problems.push(`${tab.key}/${f} 被 manifest 引用，但母本里的产物${productIssue}`);
        }
      }
    }
    referenced.set(tab.key, set);
  }

  // 2. 孤儿产物
  let orphanCount = 0;
  for (const [cat, set] of referenced) {
    const dir = path.join(r2Date, cat);
    if (!fs.existsSync(dir)) {
      // 目录不存在本身不是问题 —— 要看 manifest 有没有引用这个栏目的图。
      //
      // 某个栏目整栏为 0 时（比如「见闻」当天没抓到图），
      // build 压根不会建这个母本目录，而 manifest 也一张都没引用它。
      // 这时候报「母本目录缺失」是**误伤**，会把发布白白拦下来
      // （2026-11-05 就被这么拦了一次：见闻 0 张 → 没有 jianwen 母本目录
      //   → 自检失败 → R2 一张没传、也没部署）。
      //
      // 真正要拦的是「manifest 引用了图，但母本里没有」—— 那才是裂图。
      if (set.size > 0) {
        problems.push(`母本目录缺失：${dir}（manifest 引用了 ${set.size} 个文件）`);
      }
      continue;
    }
    for (const f of fs.readdirSync(dir)) {
      if (!/^[0-9a-f]{10}_\d{3}(_t)?\.webp$/.test(f)) continue;
      if (!set.has(f)) orphanCount++;
    }
  }
  // rss/ 目录的孤儿产物（见报配图）
  //
  // 只在 manifest 确实带了配图时才查：
  //   --keep-manifest 那一路压根不抓图，manifest 里没有 img 字段，
  //   而母本里可能还留着上一次抓的图 —— 那不是孤儿，是还没清理的旧产物，
  //   拿它当孤儿报会把发布白白拦下来。
  if (rssRefs.size) {
    const rssDir = path.join(r2Date, 'rss');
    if (fs.existsSync(rssDir)) {
      for (const f of fs.readdirSync(rssDir)) {
        if (!/^[0-9a-f]{10}_\d{3}_t\.webp$/.test(f)) continue;
        if (!rssRefs.has(f)) orphanCount++;
      }
    }
  }

  if (orphanCount) {
    problems.push(`母本里有 ${orphanCount} 个孤儿产物（manifest 没引用）`);
  }

  // 3. 源图张数 == manifest 张数
  const srcRoot = path.join(SRC_LOCAL, date);
  const srcDirs = [
    { dir: '见闻', key: 'jianwen' },
    { dir: '见她', key: 'jianshe' },
    { dir: '见笑', key: 'jianxiao' },
  ];
  for (const s of srcDirs) {
    const d = path.join(srcRoot, s.dir);
    if (!fs.existsSync(d)) continue; // 源图被清掉是允许的（会走「从已转码产物重建」）
    const n = fs.readdirSync(d).filter((f) => /\.(jpe?g|png|gif|webp|bmp)$/i.test(f)).length;
    const tab = (manifest.tabs || []).find((t) => t.key === s.key);
    const m = tab ? (tab.items || []).length : 0;
    if (n !== m) problems.push(`${s.dir} 源图 ${n} 张，但 manifest 里 ${m} 张`);
  }

  // 6. 日期页 HTML 里引用的**分享图**（og:image）必须真的在产物里
  //
  //    为什么单独查它：og:image 是 HTML 里唯一一个指向「日期目录里、但不在 manifest 里」
  //    的引用（每期那张 1200x630 的 og.jpg 不是 manifest 的条目，
  //    所以上面那套「manifest ↔ 母本」的自检查不到它）。
  //    它不在 → 分享到群里时卡片是白卡，而构建日志全程报「成功」。
  //
  //    往期（v3 之前构建的）og:image 指向 assets/logo.jpg，同样要查。
  {
    const htmlPath = path.join(ROOT, 'published', date, 'index.html');
    let html = '';
    try {
      html = fs.readFileSync(htmlPath, 'utf8');
    } catch {
      problems.push(`日期页 HTML 不存在：${htmlPath}`);
    }
    const ogMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
    if (!ogMatch) {
      problems.push('日期页 HTML 里没有 og:image（分享卡片没有封面图）');
    } else {
      const url = ogMatch[1];
      const dated = url.match(/\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/);
      const file = dated
        ? path.join(ROOT, 'published', dated[1], dated[2])
        : path.join(ROOT, 'published', url.replace(/^https?:\/\/[^/]+\//, ''));
      let st = null;
      try {
        st = fs.statSync(file);
      } catch {
        /* 文件不在 */
      }
      if (!st) {
        problems.push(`日期页的 og:image 指向 ${url}，但产物里没有这个文件`);
      } else if (st.size === 0) {
        problems.push(`日期页的 og:image 指向 ${url}，但那个文件是 0 字节`);
      }
    }
  }

  const ok = problems.length === 0;
  console.log(
    `\n[${date}] ${ok ? '✓ 通过' : '✗ 不通过'}  ` +
      `manifest=${mfFile}  引用产物 ${refCount} 个  ` +
      `见闻 ${(manifest.tabs.find((t) => t.key === 'jianwen') || {}).count || 0} / ` +
      `见她 ${(manifest.tabs.find((t) => t.key === 'jianshe') || {}).count || 0} / ` +
      `见笑 ${(manifest.tabs.find((t) => t.key === 'jianxiao') || {}).count || 0}`,
  );
  for (const p of problems.slice(0, 20)) console.log(`    · ${p}`);
  if (problems.length > 20) console.log(`    … 还有 ${problems.length - 20} 条`);

  return { problems, total: refCount };
}

const args = parseArgs(process.argv);
let dates = [];
if (args.all) {
  const pub = path.join(ROOT, 'published');
  if (fs.existsSync(pub)) {
    dates = fs
      .readdirSync(pub, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
      .map((d) => d.name)
      .sort();
  }
} else {
  let d = args.date;
  if (!d) {
    const pf = path.join(ROOT, '.publish-date');
    d = fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8').trim() : null;
  }
  if (!d) {
    const pub = path.join(ROOT, 'published');
    const list = fs.existsSync(pub)
      ? fs
          .readdirSync(pub, { withFileTypes: true })
          .filter((x) => x.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(x.name))
          .map((x) => x.name)
          .sort()
      : [];
    d = list.length ? list[list.length - 1] : null;
  }
  if (!d) {
    console.error('找不到要校验的日期：用 --date 指定，或先跑一次构建');
    process.exit(1);
  }
  dates = [d];
}

let bad = 0;
for (const d of dates) {
  const r = await checkDate(d);
  if (r.problems.length) bad++;
}
console.log('');
if (bad) {
  console.error(`✗ ${bad}/${dates.length} 期不通过 —— 不要发布`);
  process.exit(1);
}
console.log(`✓ ${dates.length} 期全部通过`);
