/**
 * 见报配图：把 RSS 自带的图片抓下来，缩成小图，落盘。
 *
 * 为什么单独一个模块：
 *   见报一直是纯文字卡片。加配图不是「在前端塞个 <img>」那么简单 ——
 *   绝大多数中文站点的图片**不能直接外链**：
 *     · 防盗链（Referer 校验）—— 实测博海拾贝的图不带 Referer 直接 403
 *     · http:// 地址在 https 页面里会被浏览器当混合内容拦掉（实测每日环球视野 100 条里 99 条是 http）
 *     · 源站随时会改 URL，外链会一夜之间全裂
 *   所以图必须**抓到自己这边**再给页面用。
 *
 * 抓回来的图还要**缩小**：原始体积跨度 5.9 KB ~ 2.1 MB（每日环球视野是摄影站，单张 2.1 MB）。
 *   卡片里显示的是 400px 宽的小图，缩完普遍 15~30 KB。
 *
 * 筛选在**下载之后**做，不靠 URL 猜：
 *   摘要里内联的 <img> 混着广告图、表情、1x1 像素、站点 logo、公众号二维码，
 *   而「logo」「avatar」这些词在正常文章图 URL 里也经常出现 —— 靠名字猜不准，
 *   看实际字节数和实际像素尺寸才靠谱。
 *
 * 用法（正常由 build.mjs 调用）：
 *   import { fetchRssImages } from './rss-images.mjs';
 *   const r = await fetchRssImages({ items, date, outDir, ffmpeg, config, salt, imageBase });
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runWithFormatFallback } from './media-fallback.mjs';
import { webpSize } from './webp.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 临时文件序号。
 *
 * 为什么临时文件名要带序号、不能只用图片 URL 的哈希：
 *   同一篇文章可能被两个源收录（跨源去重之前），两条条目指向**同一张图**。
 *   临时文件名只有哈希的话，两个并发任务会写同一个临时文件 ——
 *   一个转完把它删了，另一个 ffmpeg 正在读，直接失败。
 *   （护栏测试里真的撞到过：两条都指 /ok.jpg，结果只有一条选中了。）
 */
let tmpSeq = 0;

/* 魔数 —— 有些图床返回 application/octet-stream，只能靠内容判断是不是图 */
function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;          // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf.toString('ascii', 0, 3) === 'GIF') return true;                        // GIF
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true;
  if (buf.toString('ascii', 0, 2) === 'BM') return true;                          // BMP
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return true; // ICO
  return false;
}

function extOf(buf, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('bmp')) return '.bmp';
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf.toString('ascii', 0, 3) === 'GIF') return '.gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF') return '.webp';
  return '.jpg';
}

/** Referer 用文章页的 origin —— 图床大多认「同站来的」 */
function refererFor(item, imageUrl) {
  try {
    return new URL(item.link || imageUrl).origin + '/';
  } catch {
    return '';
  }
}

/**
 * 图片 URL 里的随机段。
 *
 * 为什么跟照片用**同一份盐**（.img-salt）：
 *   同一个站点两套随机段，等于把一半的口子留着 —— 一套有盐一套没盐，
 *   枚举的人只要盯上没盐的那一半就行。
 *   照片算的是 sha256(salt|tabKey|文件名|内容哈希)，配图算的是
 *   sha256(salt|rss|图片URL)：作用域词用 "rss"，两边不会撞名。
 *
 * 为什么用「图片 URL」而不是「图片内容」：
 *   配图的原图每次都是重新抓的，内容可能变（CDN 换图、源站重新上传）。
 *   如果按内容算，同一个 URL 内容一变，URL 就变 —— 刚发出去的链接会突然裂掉。
 *   按 URL 算则只要这个 URL 还指着同一张图，链接就一直有效。
 */
function nonceFor(salt, imageUrl) {
  return crypto
    .createHash('sha256')
    .update(`${salt || 'nosalt'}|rss|${imageUrl}`)
    .digest('hex')
    .slice(0, 10);
}

async function download(url, { referer, timeoutMs, maxBytes }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        ...(referer ? { Referer: referer } : {}),
      },
    });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, why: '空响应' };
    if (buf.length > maxBytes) {
      return { ok: false, why: `原图太大 ${(buf.length / 1024 / 1024).toFixed(1)}MB` };
    }
    if (!looksLikeImage(buf) && !ct.startsWith('image/')) {
      return { ok: false, why: `不是图片（${ct || '无类型'}）` };
    }
    return { ok: true, buf, contentType: ct };
  } catch (e) {
    return { ok: false, why: e.name === 'AbortError' ? '超时' : (e.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

/** 缩成小图。-1 让 ffmpeg 自己按比例算高；min() 防止把小图放大。 */
async function toThumb(ffmpeg, src, dest, width, quality) {
  const args = [
    '-y', '-loglevel', 'error',
    '-i', src,
    '-vf', `scale=w='min(${width},iw)':h=-1:flags=lanczos`,
    '-c:v', 'libwebp',
    '-quality', String(quality),
    '-compression_level', '6',
    '-frames:v', '1',
    dest,
  ];
  await runWithFormatFallback(ffmpeg, args, 3, `转码失败: ${src}`);
}

/**
 * 给一批新闻条目抓配图。
 *
 * 落盘位置与命名**必须跟照片那一套对齐**：
 *   目录  <R2母本>/<日期>/rss/
 *   文件  <10位hex>_<3位序号>_t.webp
 *   URL   /img/<日期>/rss/<10位hex>_001_t.webp
 * 这样现有的三个环节**一行都不用改**就能认：
 *   · /img/[[path]].js 的路径正则 `^日期/[a-z0-9]+/[0-9a-f]{10}_[0-9]{3}(_t)?\.webp$`
 *     —— "rss" 符合 [a-z0-9]+，文件名符合命名规则
 *   · tools/upload-r2.mjs 的 PRODUCT_RE 正好是同一个命名规则，walk 也会递归进 rss/ 子目录
 *   · R2 key = <日期>/rss/<文件名>，跟照片的 key 结构一致
 * 随机段用**跟照片一样的盐**算（sha256(salt|rss|图片URL)[:10]）——
 * 不然路径可被枚举，站点「图片不能被批量抓走」的那条约定就破了。
 *
 * @param {object} o
 * @param {object[]} o.items    新闻条目（要有 imgs / source / link）
 * @param {string} o.date        发布日
 * @param {string} o.outDir      图片落盘目录（绝对路径）
 * @param {string} o.ffmpeg      ffmpeg 可执行文件路径
 * @param {object} o.config      配置（见 tools/rss-images.json）
 * @param {string} o.salt        图片随机盐（跟照片同一份）
 * @param {string} o.imageBase   图片 URL 前缀，默认 /img
 * @returns {Promise<{map: Map<number,string>, stats: object}>}
 *          map 是「条目下标 -> URL」的映射
 */
export async function fetchRssImages({ items, date, outDir, ffmpeg, config, salt, imageBase }) {
  const cfg = {
    sources: [],
    maxWidth: 400,
    quality: 78,
    timeoutMs: 15000,
    maxBytes: 1500000,
    minWidth: 120,
    minHeight: 80,
    maxHeight: 900,
    maxTries: 3,
    concurrency: 6,
    ...(config || {}),
  };
  const base = (imageBase || '/img').replace(/\/$/, '');
  const allow = new Set(cfg.sources || []);
  const map = new Map();
  const stats = { candidates: 0, picked: 0, failed: 0, skippedSource: 0, noImage: 0, bytes: 0 };
  const reasons = new Map();

  const jobs = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const cands = (it && it.imgs) || [];
    if (!cands.length) continue;
    if (!allow.has(it.source)) { stats.skippedSource++; continue; }
    jobs.push({ i, it, cands });
    stats.candidates += cands.length;
  }

  if (!jobs.length) {
    return { map, stats };
  }

  await fs.mkdir(outDir, { recursive: true });

  // 清掉上一轮崩在路上的临时文件。
  // 落盘目录就在 R2 母本里（<日期>/rss/），残留的 .tmp-* 会被 upload-r2 一并扫到
  // （虽然按命名规则会被过滤掉，但母本里躺着垃圾文件终归不好）。
  try {
    for (const f of await fs.readdir(outDir)) {
      if (f.startsWith('.tmp-rssimg-')) {
        await fs.rm(path.join(outDir, f), { force: true }).catch(() => {});
      }
    }
  } catch {
    /* 目录还没建 */
  }

  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const { i, it, cands } = job;
      let done = false;
      for (let k = 0; k < Math.min(cands.length, cfg.maxTries) && !done; k++) {
        const cand = cands[k];
        const seq = tmpSeq++;
        const nonce = nonceFor(salt, cand.url);
        let tmp = '';
        let tmpOut = '';
        try {
          const got = await download(cand.url, {
            referer: refererFor(it, cand.url),
            timeoutMs: cfg.timeoutMs,
            maxBytes: cfg.maxBytes,
          });
          if (!got.ok) {
            reasons.set(got.why, (reasons.get(got.why) || 0) + 1);
            stats.failed++;
            continue;
          }
          tmp = path.join(outDir, `.tmp-rssimg-in-${nonce}-${seq}${extOf(got.buf, got.contentType)}`);
          await fs.writeFile(tmp, got.buf);

          const file = `${nonce}_001_t.webp`;
          const dest = path.join(outDir, file);
          // 先转到**带序号的临时产物**，再挪到最终名 ——
          // 否则两条同图的条目会并发写同一个文件，ffmpeg 写到一半被另一个覆盖。
          tmpOut = path.join(outDir, `.tmp-rssimg-out-${nonce}-${seq}.webp`);
          try {
            await toThumb(ffmpeg, tmp, tmpOut, cfg.maxWidth, cfg.quality);
          } catch (e) {
            reasons.set('转码失败', (reasons.get('转码失败') || 0) + 1);
            stats.failed++;
            continue;
          }

          // 转完再验：太小 = 图标/像素点；太长 = 长截图/拼图；比例太极端 = 广告条
          let dim = null;
          try {
            dim = await webpSize(tmpOut);
          } catch {
            dim = null;
          }
          const bad =
            !dim ||
            dim.w < cfg.minWidth ||
            dim.h < cfg.minHeight ||
            dim.h > cfg.maxHeight ||
            dim.w / Math.max(1, dim.h) > 4 ||
            dim.w / Math.max(1, dim.h) < 0.25;
          if (bad) {
            const why = `尺寸不合格 ${dim ? `${dim.w}x${dim.h}` : '读不出'}`;
            reasons.set(why, (reasons.get(why) || 0) + 1);
            stats.failed++;
            continue;
          }

          await fs.rm(dest, { force: true }).catch(() => {});
          await fs.rename(tmpOut, dest);
          tmpOut = '';
          const st = await fs.stat(dest);
          stats.bytes += st.size;
          // URL 跟照片那套同构：<imageBase>/<日期>/<目录>/<文件名>
          // 代理 /img/[[path]].js 的路径正则正好认这个形状（"rss" 符合 [a-z0-9]+）。
          map.set(i, `${base}/${date}/rss/${file}`);
          stats.picked++;
          done = true;
        } catch (e) {
          reasons.set(e.message || String(e), (reasons.get(e.message || String(e)) || 0) + 1);
          stats.failed++;
        } finally {
          if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
          if (tmpOut) await fs.rm(tmpOut, { force: true }).catch(() => {});
        }
      }
      if (!done) stats.noImage++;
    }
  };

  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, jobs.length) }, worker));

  // 旧产物清理：按「本轮实际产出的文件名白名单」删 —— 跟照片那套同一个道理。
  //
  // 为什么必须清：这一轮没选中的图，manifest 不会再引用它，
  // 留在母本里就是 R2 里没人要的孤儿对象（还白占空间）。
  //
  // 只删符合命名规则的文件，别的（.tmp-* 等）不碰。
  try {
    const produced = new Set([...map.values()].map((u) => path.basename(u)));
    for (const f of await fs.readdir(outDir)) {
      if (!/^[0-9a-f]{10}_\d{3}_t\.webp$/.test(f)) continue;
      if (produced.has(f)) continue;
      await fs.rm(path.join(outDir, f), { force: true }).catch(() => {});
    }
  } catch {
    /* 目录还没建 */
  }

  stats.reasons = Object.fromEntries([...reasons.entries()].sort((a, b) => b[1] - a[1]));
  return { map, stats };
}
