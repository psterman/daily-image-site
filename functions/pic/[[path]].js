/**
 * 单图分享页 —— /pic/<日期>/<栏key>/<序号3位>/
 *
 * 用途：给每一张图一个**能单独分享**的链接。
 * 微信里分享这个链接 → 渲染成**图文卡片**（标题 + 那张图的缩略图 + 描述），
 * 点进去看大图、拿原图、跳上游原帖。
 *
 * 为什么是 Function 而不是预生成静态页：
 *   一期上千张图，每张预生成一个 HTML 就是上千个文件，构建期和部署包都会爆；
 *   而 og:image 还得**精确到那一张图**（当期有卡片图，往期只有整期拼图）。
 *   这两件事只能放到运行时做。
 *
 * 路由：functions/pic/[[path]].js → /pic/*
 *   /pic/2026-11-26/jianxiao/001/      尾部斜杠可有可无
 *
 * 为什么用 /pic/ 而不是 /p/：另一条工作线（公开成果页）已经占了 functions/p/[[path]].js，
 *   Cloudflare Pages 同一路径只能有一个文件，两边会互相覆盖 → 本功能改用独立前缀。
 *
 * 数据来源（已核实，照做）：
 *   1. env.ASSETS.fetch('/<日期>/index.html') → 正则取 manifest.<hash>.js
 *   2. env.ASSETS.fetch('/<日期>/<manifest>') → 剥掉 window.__DAILY_MANIFEST__= 前缀
 *      和结尾的 ; → JSON.parse
 *   3. manifest.tabs 里按 tab.key 找 tab → items[序号-1]
 *
 * 卡片图降级链（两套并存）：
 *   og:image    1. /<日期>/card-sq/<栏key>/<nonce>_<序号3位>.jpg  方形版 640×640（微信用）
 *                2. /<日期>/card/<栏key>/<nonce>_<序号3位>.jpg    长边版（往期没有方形版时）
 *   twitter:image 长边版 —— X / Telegram 按原比例显示，方图带模糊边反而难看
 *   两者都拿不到时：
 *                3. 该期日期页自己声明的 og:image = <日期>/og.jpg（1200x630，三栏拼图）
 *                                                  2026-11-18 之前的老期没有 og.jpg，
 *                                                  日期页声明的是 /assets/logo.jpg（640x640）
 *                4. <日期>/og.jpg                          renderSharePage 里的最后兜底
 *
 * 为什么 og:image 要方图：微信对 og:image **强制按 1:1 居中裁剪**，
 *   而长边版是「等比缩到长边 900、不裁剪」—— 实测当期 201 张裁完中位只剩 68% 面积，
 *   最差的 900×263 超宽图只剩 29%（对方在聊天里看到的就是一条横带）。
 *
 * 缓存头：
 *   - 错误响应必须 no-store —— Pages 给没设 Cache-Control 的 Function 响应默认套
 *     max-age=14400（4 小时），错误被缓存住后面永远修不好（见 functions/img/[[path]].js）
 *   - 成功响应 max-age=600 —— 卡片图换图时能较快刷新
 */

/* 站点名与域名：manifest 里的 title / siteUrl 是唯一真源，这里是兜底 */
const SITE_NAME = '每日图片站';
const DEFAULT_SITE_URL = 'https://example.com';

/* 卡片图规格：等比缩到长边 900、不裁剪不填充（与 tools/build-cards.mjs 一致） */
const CARD_LONG_EDGE = 900;

/* 方形卡片图规格：640×640 正方形（与 tools/build-cards.mjs 的 CARD_SQUARE_SIZE 一致）。
   微信对 og:image **强制按 1:1 居中裁剪** —— 长边版裁完中位只剩 68% 面积，
   方图版 100% 可见（裁它等于不裁）。 */
const CARD_SQUARE_SIZE = 640;

/* 卡片图在 published/<日期>/ 下的两个目录名（与 tools/build-cards.mjs 一致）：
   card/ = 长边版（twitter:image 等渠道用），card-sq/ = 方形版（微信 og:image 用）。 */
const CARD_DIR = 'card';
const CARD_SQUARE_DIR = 'card-sq';

/* 往期 og.jpg（整期三栏拼图）的规格 */
const OG_FALLBACK_WIDTH = 1200;
const OG_FALLBACK_HEIGHT = 630;

/* 错误响应的头：三条都要 no-store，缺一条就可能被边缘缓存住 */
const noStoreHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'CDN-Cache-Control': 'no-store, no-cache, must-revalidate',
  'Cloudflare-CDN-Cache-Control': 'no-store, no-cache, must-revalidate',
};

/* 成功响应的头：缓存短一点，卡片图换图时能较快刷新 */
const pageHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=600',
  'CDN-Cache-Control': 'public, max-age=600',
  'Cloudflare-CDN-Cache-Control': 'public, max-age=600',
};

export async function onRequest(context) {
  const { request, env, params } = context;

  const raw = params?.path;
  const key = Array.isArray(raw) ? raw.join('/') : raw || '';
  // 尾部斜杠可有可无 —— Pages 的 catch-all 一般不给空段，这里再兜一层
  const segs = key.split('/').filter(Boolean);

  if (segs.length !== 3) {
    return badRequest('路径应为 /pic/<日期>/<栏key>/<序号3位>/');
  }

  const [date, tabKey, seqRaw] = segs;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return badRequest('日期格式应为 YYYY-MM-DD');
  }
  if (!/^[a-z][a-z0-9]{0,31}$/.test(tabKey)) {
    return badRequest('栏 key 格式不对');
  }
  if (!/^\d{3}$/.test(seqRaw)) {
    return badRequest('序号应为 3 位数字');
  }

  const seq = Number(seqRaw);
  if (!Number.isInteger(seq) || seq < 1) {
    return badRequest('序号从 1 开始');
  }

  // 取这一期的 manifest（顺带取日期页自己声明的 og:image，当降级用）
  const period = await loadPeriod(env, request, date);
  if (!period) {
    return notFound('这一期不存在');
  }

  const tab = (period.manifest.tabs || []).find((t) => t && t.key === tabKey);
  if (!tab) {
    return notFound('没有这个栏目');
  }

  const item = (tab.items || [])[seq - 1];
  if (!item || !item.full) {
    return notFound('没有这一张');
  }

  const siteUrl = normalizeSiteUrl(period.manifest.siteUrl || DEFAULT_SITE_URL);
  const tabLabel = tab.label || tabKey;

  const cardImage = await resolveCardImage(env, request, {
    date,
    tabKey,
    item,
    siteUrl,
    period,
  });

  const html = renderSharePage({
    siteUrl,
    date,
    tabKey,
    tabLabel,
    seq,
    item,
    cardImage,
  });

  return new Response(html, { status: 200, headers: pageHeaders });
}

/**
 * 渲染单图页 —— **纯函数**：不碰 env、不碰网络，可以离线调用（护栏直接 import 它测 HTML）。
 *
 * 入参：
 *   siteUrl   站点绝对地址（不含尾斜杠），如 https://example.com
 *   date      期号，如 2026-11-26
 *   tabKey    栏 key，如 jianxiao
 *   tabLabel  栏中文名，如 见笑
 *   seq       序号（数字或字符串都行），显示时去掉前导零，URL 里补成 3 位
 *   item      manifest 里的那一条：{ id, w, h, tw, th, thumb, full, lqip }
 *   cardImage 卡片图：
 *              · { url, width, height }            —— 扁的（只有一张，og 和 twitter 都用它）
 *              · { og: {…}, twitter: {…} }         —— 新的（方图给 og、长边版给 twitter）
 *              传 null 表示降级用 <日期>/og.jpg
 *
 * 返回：完整 HTML 字符串
 */
export function renderSharePage(opts) {
  const o = opts || {};
  const siteUrl = normalizeSiteUrl(o.siteUrl || DEFAULT_SITE_URL);
  const date = String(o.date || '');
  const tabKey = String(o.tabKey || '');
  const tabLabel = String(o.tabLabel || tabKey || '');
  const siteName = String(o.siteName || SITE_NAME);
  const seq = normalizeSeq(o.seq);
  const item = o.item || {};

  const fullUrl = absUrl(siteUrl, item.full);
  const pageUrl = `${siteUrl}/pic/${date}/${tabKey}/${seq.padded}/`;

  // 卡片图：没传就降级用该期的 og.jpg
  //   card       = og:image 用的那张（优先方形版）
  //   twitterCard = twitter:image 用的那张（长边版 —— X/Telegram 这类渠道不裁 1:1，
  //                方图带模糊边反而难看）
  const card = normalizeCard(o.cardImage) || {
    url: `${siteUrl}/${date}/og.jpg`,
    width: OG_FALLBACK_WIDTH,
    height: OG_FALLBACK_HEIGHT,
  };
  const twitterCard = normalizeTwitterCard(o.cardImage) || card;

  const title = `${tabLabel} ${seq.display} · ${date}`;
  const desc = `${siteName} · ${date} ${tabLabel}第 ${seq.display} 张 · 点开看原图`;

  /* ⚠️ 这里**不渲染**「看原帖」：上游原帖是 t.me 外链，微信内置浏览器会拦成
     微信自己的「已停止访问该网页」页 —— 用户点了只会一脸懵。
     主流程是「复制本页链接 → 对方点进来在这个站看原图」。
     manifest 里那条上游地址字段仍然保留（上游反解机制备用），但**没有任何入口消费它**。 */

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#0b0b0f">
<meta name="format-detection" content="telephone=no,email=no,address=no">
<meta name="referrer" content="no-referrer">
<!-- 唯一标记：护栏靠它确认拿到的确实是单图页，不是 ASSETS 回退出来的首页 -->
<meta name="share-page" content="1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">

<!-- 分享卡片（微信/朋友圈）的信息全在这一段。
     og:image 必须是**绝对 URL** —— 相对路径的话微信爬虫拉不到，卡片就是一张白卡（这个站踩过）。
     og:image 的 URL 里带日期，微信按 URL 缓存卡片，换期才能拿到新卡。 -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(siteName)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(card.url)}">
<meta property="og:image:width" content="${card.width}">
<meta property="og:image:height" content="${card.height}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(twitterCard.url)}">
<style>
  /* 关键样式内联：微信 X5 解析外部 CSS 前先上色，避免白闪。
     不引站内的 app.css —— 那套是给整页（多栏网格）用的，单图页用不上。 */
  html,body{background:#0b0b0f;color:#e8e8ee}
  html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
  *{-webkit-tap-highlight-color:rgba(0,0,0,0);box-sizing:border-box}
  body{margin:0;padding:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
       padding-bottom:calc(24px + env(safe-area-inset-bottom,0px))}
  .wrap{max-width:720px;margin:0 auto;padding:16px}
  h1{font-size:19px;font-weight:600;margin:0 0 4px;line-height:1.35}
  .sub{margin:0 0 14px;color:#8b8b99;font-size:13px}
  .shot{display:block;margin:0 0 16px}
  .shot img{display:block;width:100%;max-width:100%;height:auto;border-radius:10px;background:#16161d}
  .acts{display:-webkit-box;display:-webkit-flex;display:flex;flex-wrap:wrap}
  .btn{display:inline-block;margin:0 8px 8px 0;padding:9px 16px;border:1px solid #26262f;border-radius:999px;
       background:#16161d;color:#e8e8ee;font-size:14px;text-decoration:none;-webkit-appearance:none}
  .btn:active{background:#1e1e28}
  .tip{margin:2px 0 0;color:#8b8b99;font-size:12px}
</style>
</head>
<body>
<main class="wrap">
  <h1>${esc(tabLabel)} ${esc(seq.display)}</h1>
  <p class="sub">${esc(siteName)} · ${esc(date)}</p>
  <a class="shot" href="${esc(fullUrl)}">
    <img src="${esc(fullUrl)}" alt="${esc(title)}" decoding="async">
  </a>
  <div class="acts">
    <a class="btn" href="${esc(fullUrl)}">原图</a>
    <a class="btn" href="${esc(`${siteUrl}/${date}/`)}">回到这一期</a>
  </div>
  <p class="tip">长按图片可保存</p>
</main>
</body>
</html>
`;
}

/**
 * 取某一期的 manifest + 该期日期页声明的 og:image。
 *
 * 为什么要顺带取 og:image：
 *   当期有卡片图（精确到那一张），往期没有 —— 往期只能退回整期的 og.jpg；
 *   再老的一期连 og.jpg 都没有（2026-11-18 才开始有），站内那些页面的 og:image
 *   是 /assets/logo.jpg。这里直接读日期页自己的声明，跟站内保持一致，
 *   至少缩略图不是裂图。
 */
async function loadPeriod(env, request, date) {
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    console.error('ASSETS 绑定不可用，单图页拿不到 manifest');
    return null;
  }

  let html = '';
  try {
    const res = await env.ASSETS.fetch(new URL(`/${date}/index.html`, request.url));
    if (!res || res.status !== 200) return null;
    html = await res.text();
  } catch (err) {
    console.error('日期页读取失败:', err?.message || err);
    return null;
  }

  // ASSETS 对找不到的路径会回退到**根首页**并返回 200 + text/html。
  // 根首页引用的是绝对路径 src="/<别的日期>/manifest.<hash>.js"，
  // 只有**相对**引用 src="manifest.<hash>.js" 才是这一期的 manifest ——
  // 靠这一条把「这一期不存在」挡在外面（顺便省掉一次无谓的 fetch）。
  const manifestName = (html.match(/src="(manifest\.[0-9a-z]+\.js)"/) || [])[1];
  if (!manifestName || !html.includes(date)) {
    return null;
  }

  let manifest = null;
  try {
    const res = await env.ASSETS.fetch(new URL(`/${date}/${manifestName}`, request.url));
    if (!res || res.status !== 200) return null;
    const raw = await res.text();
    // manifest 实体是 window.__DAILY_MANIFEST__=<json>;
    // json 里的尖括号已经被转义成 6 位反斜杠转义，直接 parse 没问题
    const json = raw.replace(/^window\.__DAILY_MANIFEST__=/, '').replace(/;\s*$/, '');
    manifest = JSON.parse(json);
  } catch (err) {
    console.error('manifest 读取/解析失败:', err?.message || err);
    return null;
  }

  if (!manifest || !Array.isArray(manifest.tabs)) return null;

  return {
    manifest,
    ogImage: metaProp(html, 'og:image'),
    ogWidth: Number(metaProp(html, 'og:image:width')) || OG_FALLBACK_WIDTH,
    ogHeight: Number(metaProp(html, 'og:image:height')) || OG_FALLBACK_HEIGHT,
  };
}

/**
 * 定卡片图（og:image / twitter:image）。
 *
 * 1. **方形版** /<日期>/card-sq/<栏key>/<nonce>_<序号3位>.jpg —— og:image 用它
 *    （微信强制 1:1 居中裁剪，方的等于不裁）
 * 2. **长边版** /<日期>/card/<栏key>/<nonce>_<序号3位>.jpg —— twitter:image 用它
 *    （X / Telegram 按原比例显示，方图带模糊边反而难看）
 * 3. 降级：该期日期页自己声明的 og:image（<日期>/og.jpg，再老就是 /assets/logo.jpg）
 *
 * ⚠️ 探测有开销（一次网络往返）—— 所以先探方图，探到了就不再探长边版：
 *    两套图是**同一次构建**出来的，方图在就说明长边版也在，路径推得出来。
 */
async function resolveCardImage(env, request, { date, tabKey, item, siteUrl, period }) {
  const squarePath = cardPathFor(date, tabKey, item.full, CARD_SQUARE_DIR);
  const longPath = cardPathFor(date, tabKey, item.full, CARD_DIR);

  const squareExists = squarePath ? await probeAsset(env, request, squarePath) : false;
  const longExists = longPath && !squareExists ? await probeAsset(env, request, longPath) : false;

  const picked = pickCardImages({ squarePath, longPath, squareExists, longExists, item, siteUrl });
  if (picked) return picked;

  if (!period.ogImage) return null;

  const fallback = {
    url: absUrl(siteUrl, period.ogImage),
    width: period.ogWidth,
    height: period.ogHeight,
  };
  return { og: fallback, twitter: fallback };
}

/**
 * 选卡片图 —— **纯函数**：不碰 env、不碰网络，护栏直接 import 它测。
 *
 * 规则（就三条，别自创）：
 *   · 有方图 → og:image = 方图（640×640），twitter:image = 长边版
 *   · 没方图但有长边版 → 两边都用长边版
 *   · 两张都没有 → 返回 null（调用方降级到该期 og.jpg）
 *
 * ⚠️ 有方图时**不再确认长边版存不存在**（longExists 传 false 也照样给 twitter）——
 *   两套图是同一次构建出来的，方图在就说明长边版在；而每多一次 ASSETS 探测
 *   就是多一次网络往返（这个函数每个请求都跑）。
 *
 * @param {object} o
 * @param {string} [o.squarePath] 方形版路径（不存在就是 null）
 * @param {string} [o.longPath]   长边版路径
 * @param {boolean} [o.squareExists] 方形版探测结果
 * @param {boolean} [o.longExists]   长边版探测结果
 * @param {object} o.item  manifest 里那一条（取 w/h 算长边版尺寸）
 * @param {string} o.siteUrl 站点绝对地址
 * @returns {{og:{url:string,width:number,height:number},twitter:{url:string,width:number,height:number}}|null}
 */
export function pickCardImages({ squarePath, longPath, squareExists, longExists, item, siteUrl }) {
  const it = item || {};
  const size = scaledSize(it.w, it.h, CARD_LONG_EDGE);

  if (squarePath && squareExists) {
    const og = {
      url: `${siteUrl}${squarePath}`,
      width: CARD_SQUARE_SIZE,
      height: CARD_SQUARE_SIZE,
    };
    const twitter = longPath
      ? { url: `${siteUrl}${longPath}`, width: size.width, height: size.height }
      : og;
    return { og, twitter };
  }

  if (longPath && longExists) {
    const card = { url: `${siteUrl}${longPath}`, width: size.width, height: size.height };
    return { og: card, twitter: card };
  }

  return null;
}

/**
 * 从 item.full 推导卡片图路径。
 *
 * item.full 形如 /img/<日期>/<栏key>/<nonce>_<序号3位>.webp，
 * 卡片图形如 /<日期>/<card|card-sq>/<栏key>/<nonce>_<序号3位>.jpg
 * —— 同 nonce、同序号，只是目录名和扩展名换了。
 *
 * @param {string} date  期号
 * @param {string} tabKey 栏 key
 * @param {string} full  manifest 里的全图地址
 * @param {string} dir   卡片图目录（card = 长边版 / card-sq = 方形版）
 * @returns {string|null}
 */
function cardPathFor(date, tabKey, full, dir = CARD_DIR) {
  const m = String(full || '').match(/\/([0-9A-Za-z]+)_(\d{3})\.webp$/);
  if (!m) return null;
  return `/${date}/${dir}/${tabKey}/${m[1]}_${m[2]}.jpg`;
}

/**
 * 卡片图存在性探测。
 *
 * ⚠️ Pages 的 ASSETS 对找不到的路径会回退到首页并返回 200 + text/html，
 *    所以**光看状态码会把「不存在」当成「存在」** —— 必须同时看 Content-Type 是 image/*。
 *
 * 探测有开销（一次网络往返），所以结果缓存在模块级 Map 里（Pages 实例会复用）。
 * 正向结果永久有效（卡片图不会被删）；负向结果 10 分钟后过期 ——
 * 当期卡片图是构建期生成的，万一页面先上线、卡片图后补上，
 * 负向缓存不能把它永久钉死在 og.jpg 上。
 */
const cardProbeCache = new Map();
const CARD_PROBE_NEG_TTL_MS = 10 * 60 * 1000;

async function probeAsset(env, request, path) {
  const now = Date.now();
  const cached = cardProbeCache.get(path);
  if (cached && (cached.ok || now - cached.at < CARD_PROBE_NEG_TTL_MS)) {
    return cached.ok;
  }

  let ok = false;
  try {
    const res = await env.ASSETS.fetch(new URL(path, request.url));
    const ct = ((res && res.headers.get('content-type')) || '').toLowerCase();
    ok = !!(res && res.status >= 200 && res.status < 300 && ct.startsWith('image/'));
    // 探测只要「有没有」，正文丢掉（不 cancel 会留一个没消费的流）
    try {
      await (res && res.body ? res.body.cancel() : null);
    } catch {
      /* 忽略 */
    }
  } catch (err) {
    console.error('卡片图探测失败:', path, err?.message || err);
    ok = false;
  }

  cardProbeCache.set(path, { ok, at: now });
  return ok;
}

/**
 * 卡片图的真实宽高：等比缩到长边 900、不裁剪不填充，所以短边按原比例算。
 * manifest 里的 w/h 就是全尺寸图的宽高，卡片图是从全尺寸图转出来的。
 */
function scaledSize(w, h, longEdge) {
  const W = Number(w);
  const H = Number(h);
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) {
    return { width: longEdge, height: longEdge };
  }
  if (W >= H) {
    return { width: longEdge, height: Math.max(1, Math.round((longEdge * H) / W)) };
  }
  return { width: Math.max(1, Math.round((longEdge * W) / H)), height: longEdge };
}

/** 取页面里某个 meta 的 content（只认精确的 property 名，og:image 不会误吃 og:image:width） */
function metaProp(html, prop) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (tag.includes(`property="${prop}"`)) {
      const m = tag.match(/content="([^"]*)"/i);
      if (m) return m[1];
    }
  }
  return '';
}

/** 站点地址去掉尾斜杠，拼绝对 URL 时不会拼出两个斜杠 */
function normalizeSiteUrl(u) {
  return String(u || '').replace(/\/+$/, '');
}

/** 相对地址补成绝对地址；本来就是 http(s) 的原样返回 */
function absUrl(siteUrl, p) {
  const s = String(p || '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return siteUrl + (s.startsWith('/') ? s : '/' + s);
}

/**
 * 序号归一：显示去掉前导零（001 → 1），URL 里补成 3 位（1 → 001）。
 */
function normalizeSeq(seq) {
  const raw = String(seq ?? '').trim();
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) {
    return { display: String(n), padded: String(n).padStart(3, '0') };
  }
  const trimmed = raw.replace(/^0+(?=\d)/, '');
  return { display: trimmed || raw, padded: trimmed ? trimmed.padStart(3, '0') : raw };
}

/**
 * 卡片图对象归一：缺 url 就当没有（走降级），宽高缺失时用 og.jpg 的规格兜底。
 *
 * ⚠️ **两种形状都收**：
 *   · 扁的 { url, width, height }     —— 旧的（只有一张卡片图）
 *   · { og: {...}, twitter: {...} }   —— 新的（方图给微信 og:image、长边版给 twitter:image）
 *   护栏里有一批断言用的是扁的形状 —— 形状改了它们不能跟着红。
 */
function normalizeCard(card) {
  if (!card) return null;
  const one = card.url ? card : card.og;
  if (!one || !one.url) return null;
  const width = Number(one.width);
  const height = Number(one.height);
  return {
    url: String(one.url),
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : OG_FALLBACK_WIDTH,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : OG_FALLBACK_HEIGHT,
  };
}

/**
 * twitter:image 用的那张卡片图（长边版）。
 *
 * 微信的缩略图是 1:1 居中裁剪出来的，方图在那边才好看；
 * 但 X / Telegram 这类渠道按原比例显示，给方图就等于给人家看一圈模糊边。
 * 所以两张并存：og:image = 方图，twitter:image = 长边版。
 *
 * 扁的形状（只有一张）→ 就是它自己；新形状 → card.twitter；都没有 → 退回 og 那张。
 */
function normalizeTwitterCard(card) {
  if (!card) return null;
  if (card.url) return normalizeCard(card);
  const one = card.twitter || card.og;
  if (!one || !one.url) return null;
  return normalizeCard(one);
}

/** HTML 转义：manifest 里的栏名/描述是外部数据，进标签前必须转义 */
function esc(s) {
  return String(s)
    .replace(/&/g, () => '&amp;')
    .replace(/</g, () => '&lt;')
    .replace(/>/g, () => '&gt;')
    .replace(/"/g, () => '&quot;');
}

/**
 * 400 / 404 响应。
 *
 * 关键：错误响应绝不能被缓存。
 * Pages 给没有 Cache-Control 的 Function 响应默认套 max-age=14400（4 小时），
 * 一旦刚上线那几秒资产没就绪返回了 404，这个 404 就会黏在边缘缓存里，
 * 后面即使资源已经可用也一直返回缓存里的 404。
 * Cloudflare-CDN-Cache-Control 优先级最高，zone 的浏览器缓存 TTL 也改不动它。
 */
function badRequest(message) {
  return new Response(message, {
    status: 400,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...noStoreHeaders },
  });
}

function notFound(message) {
  return new Response(message, {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...noStoreHeaders },
  });
}
