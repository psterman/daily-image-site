#!/usr/bin/env node
/**
 * 读「头条」数据 —— 来自 tools/grab/daily_headlines.py 产出的 JSON。
 *
 * 为什么单独一个模块：
 *   头条那 5 个源（知乎热榜 / 微博热搜 / V2EX 热榜 / 驱动之家 / 虎扑）
 *   要带 cookie 抓，构建期再抓一遍既慢又容易被风控 ——
 *   所以让抓取脚本顺手把结果落成 JSON，构建期直接读文件。
 *
 * 产物长这样：
 *   <srcRoot>/headlines/headlines_YYYY-MM-DD.json
 *
 * 找不到就返回 null —— 见报 tab 退化成只有 RSS，不影响发版。
 *
 * ── 标签模型 ────────────────────────────────────────────────
 * 以前是「头条」+「热榜」两个伞标签：
 *   头条 = 所有源拍平（283 条，含 9 个不同来源，用户没法按主题筛）
 *   热榜 = 头条 + 全部 RSS 混排（= 全部内容，chip 和「全部」一模一样）
 * 两个标签高度重复，等于没有分类能力。
 *
 * 现在改成**一个条目只属于一个目录**，目录名 = 内容领域：
 *   知乎 / 微博 / V2EX / 科技 / 社区 / 效率 / 即刻 / 博客 / 数码 / AI …
 * 同一个领域的源会自动合并（知乎日报+知乎热榜 → 「知乎」）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 源名 → 目录名。
 *
 * 正常路径下这个映射由 Python 侧写进 JSON 的 category 字段，
 * 这里是**兜底**：旧日期的 JSON（2026-10-26 及以前）没有 category，
 * 重建归档页时靠这张表还原目录结构。
 */
export const SOURCE_CATEGORY = {
  '知乎热榜': '知乎',
  '微博热搜': '微博',
  'V2EX 热榜': 'V2EX',
  '驱动之家': '科技',
  '虎扑步行街': '社区',
};

/** 兜底目录名（既没 category 又不认识的源） */
const FALLBACK_CATEGORY = '其它';

/**
 * 头条那 5 个源的名字。
 *
 * 导出它是为了**配图白名单的对账**：白名单里的源名要么是 rss.config.json 里的
 * RSS 源、要么是这里的头条源 —— 两者都得认。只认 RSS 源的话，
 * 「虎扑步行街」这种头条源就永远配不了图，而且**拼错了也不报错**。
 */
export const HEADLINE_SOURCES = Object.keys(SOURCE_CATEGORY);

/**
 * 「当天的头条」最多允许多旧（毫秒）。默认 2 小时。
 *
 * 为什么要有这条（2026-11-11 实测）：
 *   头条 JSON 是 `daily_headlines.py` 落的**快照**，构建期**只读不重抓**
 *   （要带 cookie 抓，构建期再抓一遍既慢又容易被风控）。
 *   后果是：早上 07:35 抓的那批热榜，**当天一整天都在**线上。
 *   微博热搜 / V2EX 热榜这种每小时都在换榜的源，5 小时前的热榜就是「不是最新」。
 *   而线上默认第一档「热议」**全部**来自头条 → 用户打开第一眼就是一屏旧时间戳。
 *
 *   所以构建时必须**说破**：这批头条是什么时候抓的、已经旧了多久、
 *   要刷新该跑哪条命令。以前是静默的 —— 构建日志一路「成功」，没人知道热榜是旧的。
 */
export const STALE_HEADLINES_MS = 2 * 60 * 60 * 1000;

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 加载头条。
 * @param {string} srcRoot  源图根目录（<IMAGE_ROOT>\src\<日期>）
 * @param {string} date     页面日期 YYYY-MM-DD
 * @returns {Promise<{items:object[], ts:number, sources:string[]}|null>}
 */
export async function loadHeadlines(srcRoot, date) {
  const dir = path.join(srcRoot, 'headlines');

  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return null; // 没有 headlines 目录 —— 正常情况，不是错误
  }

  const cands = [];
  for (const f of files) {
    const m = f.match(/^headlines_(\d{4}-\d{2}-\d{2})\.json$/i);
    if (m) cands.push({ file: f, date: m[1] });
  }
  if (!cands.length) return null;

  // 优先同一天；没有就退而求其次取最新的（并让调用方知道）
  let pick = cands.find((c) => c.date === date) || null;
  if (!pick) {
    cands.sort((a, b) => (a.date < b.date ? 1 : -1));
    pick = cands[0];
    console.log(`  · 头条没有 {date} 的版本，改用最新的 {pick.date}`);
  }

  let data;
  try {
    data = JSON.parse(await fs.readFile(path.join(dir, pick.file), 'utf8'));
  } catch (e) {
    console.log(`  ! 头条 JSON 解析失败（${pick.file}）：${e.message}`);
    return null;
  }

  // ts 单位坑：Python 的 time.timestamp() 是**秒**，而 JS 的 new Date(数字) 吃**毫秒**。
  // 不做换算的话，1792974310 会被当成毫秒 -> 1970-01-22，页面上时间全是「01-22 02:02」。
  // 这里按数量级自动判别，两种单位都给对。
  let ts = Number(data.ts) || Date.parse(data.generatedAt) || 0;
  if (ts > 0 && ts < 1e11) ts *= 1000;
  const time = fmtTime(ts);

  // 这批头条有多旧？（见 STALE_HEADLINES_MS 的说明）
  const ageMs = ts > 0 ? Date.now() - ts : 0;
  const sameDayFile = pick.date === date;
  if (sameDayFile && ageMs > STALE_HEADLINES_MS) {
    const mins = Math.round(ageMs / 60000);
    console.log(
      `  ! 头条是 ${time} 抓的（已过 ${mins} 分钟，超过 ${STALE_HEADLINES_MS / 60000} 分钟）—— ` +
        `热榜源（微博热搜 / V2EX 热榜 / 虎扑 / 驱动之家）线上会显示成这个旧时间戳，` +
        `默认第一档「热议」全是它们。要最新请先重跑：python tools\\grab\\daily_headlines.py`,
    );
  }

  const items = (Array.isArray(data.items) ? data.items : [])
    .filter((it) => it && it.title)
    .map((it) => {
      const source = it.source || '头条';
      // category 优先用 Python 写的；没有就查兜底表
      const category = it.category || SOURCE_CATEGORY[source] || FALLBACK_CATEGORY;
      // 候选配图（可选）：Python 抓取器逐条抓了条目页、把 <img> 抠出来放这儿。
      // **候选不等于能用** —— 到底哪张能上站由 tools/rss-images.mjs 下载后
      // 按实际尺寸/体积筛（跟 RSS 那条路完全一个规矩）。
      //
      // 形状必须跟 RSS 那条路一致：{url, kind} 对象（fetch-rss.mjs 的
      // extractImages 就是这么产的）—— rss-images.mjs 直接读 cand.url/cand.kind，
      // 形状对不上会静默拿到 undefined，图一张都下不下来，而且**不报错**。
      const imgs = (Array.isArray(it.imgs) ? it.imgs : [])
        .map((c) => (typeof c === 'string' ? { url: c, kind: 'inline' } : c))
        .filter((c) => c && typeof c.url === 'string' && /^https?:\/\//i.test(c.url))
        .map((c) => ({ url: c.url, kind: c.kind || 'inline' }));
      return {
        title: String(it.title).trim(),
        link: it.link || '',
        source,
        // 目录名就是分类标签
        tag: category,
        // 一个条目只属于一个目录（前端用包含匹配，留着数组是为了以后能加多标签）
        tags: [category],
        time,
        ts,
        desc: '',
        imgs,
      };
    });

  const sources = [...new Set(items.map((it) => it.source))];
  return { items, ts, sources, ageMs, sameDayFile };
}
