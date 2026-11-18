#!/usr/bin/env node
/**
 * 把 format-feeds.json 活源按 BestBlogs / timqian / awesome 分类扩进 rss.config + news-taxonomy。
 *
 *   node tools/expand-rss-from-catalog.mjs
 *   node tools/expand-rss-from-catalog.mjs --dry-run
 *   node tools/expand-rss-from-catalog.mjs --timqian-cap 200 --podcast-cap 80
 *
 * 默认：BestBlogs 文章（除体育）全收；Twitter note 全收；播客 / timqian 有上限防一次拉爆。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BESTBLOGS_TO_TAXONOMY,
  AWESOME_FOLDER_TO_TAXONOMY,
  parseBestblogsWechatMd,
  lookupBestblogs,
  bestblogsCategoryToTaxonomy,
  timqianTagsToTaxonomy,
  twitterDisplayName,
} from '../lib/bestblogs-taxonomy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RSS_PATH = path.join(__dirname, 'rss.config.json');
const TAX_PATH = path.join(__dirname, 'news-taxonomy.json');
const CATALOG_PATH = path.join(__dirname, 'format-feeds.json');
const MD_CANDIDATES = [
  path.join(__dirname, '.cache/format-lists/bestblogs_sources_wechat_part1.md'),
  path.join(
    process.env.USERPROFILE || '',
    '.cursor/projects/e-voice-pilot/uploads/bestblogs_sources_wechat_part1-0.md',
  ),
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1] || fallback;
}

function readMd() {
  for (const p of MD_CANDIDATES) {
    if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error(
    '找不到 BestBlogs wechat part1 markdown；请放到 tools/.cache/format-lists/bestblogs_sources_wechat_part1.md',
  );
}

function urlKey(u) {
  try {
    const x = new URL(String(u));
    x.hash = '';
    return x.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(u || '')
      .trim()
      .replace(/\/$/, '')
      .toLowerCase();
  }
}

function sortByNewest(a, b) {
  return String(b.newestAt || '').localeCompare(String(a.newestAt || ''));
}

function resolveTaxonomy(feed, table) {
  const fmt = feed._format;
  if (fmt === 'note') return 'ai'; // Twitter 池默认进 AI（关键词仍可追加）
  if (fmt === 'video') return 'ent';
  if (fmt === 'podcast') {
    // 播客进深度阅读；不进「轻松一刻」视觉包，也不冒充社交热议
    const t = timqianTagsToTaxonomy(feed.tags || feed.folder || feed.name);
    return t === 'fun' ? 'deep' : t;
  }

  if (feed.sourceList === 'bestblogs') {
    const hit = lookupBestblogs(feed.name, table);
    if (hit) {
      const k = bestblogsCategoryToTaxonomy(hit.category);
      if (k === null) return null; // 体育
      if (k) return k;
    }
    return 'deep'; // catalog 有、表无：保底深度
  }

  if (feed.sourceList === 'awesome' || String(feed.folder || '').startsWith('cn-')) {
    const folder = feed.folder || '';
    if (Object.prototype.hasOwnProperty.call(AWESOME_FOLDER_TO_TAXONOMY, folder)) {
      return AWESOME_FOLDER_TO_TAXONOMY[folder];
    }
  }

  if (feed.sourceList === 'timqian') return timqianTagsToTaxonomy(feed.tags || '');
  if (fmt === 'link') return timqianTagsToTaxonomy(feed.tags || feed.folder || '');
  if (fmt === 'article') return 'tech';
  return 'deep';
}

function displayName(feed) {
  if (feed._format === 'note') return twitterDisplayName(feed.name);
  return String(feed.name || '').trim() || feed.url;
}

function main() {
  const dry = process.argv.includes('--dry-run');
  const timqianCap = Math.max(0, Number(arg('--timqian-cap', '200')) || 200);
  const podcastCap = Math.max(0, Number(arg('--podcast-cap', '80')) || 80);
  const noteAll = !process.argv.includes('--notes-cap'); // 默认全收 note
  const notesCap = noteAll
    ? Infinity
    : Math.max(0, Number(arg('--notes-cap', '158')) || 158);

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const table = parseBestblogsWechatMd(readMd());
  console.log(`BestBlogs 分类表 ${table.size} 名；映射键 ${Object.keys(BESTBLOGS_TO_TAXONOMY).join('/')}`);

  /** @type {{name:string,url:string,contentType?:string,_format:string,sourceList?:string,folder?:string,tags?:string,newestAt?:string}[]} */
  const picked = [];

  const articles = [...(catalog.byFormat.article || [])].sort(sortByNewest);
  for (const f of articles) {
    if (f.sourceList === 'bestblogs') {
      const hit = lookupBestblogs(f.name, table);
      if (hit && bestblogsCategoryToTaxonomy(hit.category) === null) continue; // 体育
      picked.push({ ...f, _format: 'article' });
      continue;
    }
    // awesome / seed 文章：全收（量小）
    if (f.sourceList === 'awesome' || f.sourceList === 'seed') {
      picked.push({ ...f, _format: 'article' });
    }
  }

  const notes = [...(catalog.byFormat.note || [])].sort(sortByNewest).slice(0, notesCap);
  for (const f of notes) picked.push({ ...f, _format: 'note' });

  const podcasts = [...(catalog.byFormat.podcast || [])].sort(sortByNewest).slice(0, podcastCap);
  for (const f of podcasts) picked.push({ ...f, _format: 'podcast' });

  const videos = [...(catalog.byFormat.video || [])];
  for (const f of videos) picked.push({ ...f, _format: 'video' });

  const links = [...(catalog.byFormat.link || [])]
    .filter((f) => f.sourceList === 'timqian')
    .sort(sortByNewest)
    .slice(0, timqianCap);
  for (const f of links) picked.push({ ...f, _format: 'link' });

  const rss = JSON.parse(fs.readFileSync(RSS_PATH, 'utf8'));
  const tax = JSON.parse(fs.readFileSync(TAX_PATH, 'utf8'));
  const byUrl = new Map();
  for (const f of rss.feeds || []) {
    if (!f?.url) continue;
    byUrl.set(urlKey(f.url), { ...f });
  }

  let added = 0;
  let updated = 0;
  let skippedTax = 0;
  const sourceCategory = { ...(tax.sourceCategory || {}) };

  for (const raw of picked) {
    const taxKey = resolveTaxonomy(raw, table);
    if (!taxKey) {
      skippedTax++;
      continue;
    }
    const name = displayName(raw);
    const entry = {
      name,
      url: raw.url,
      contentType: raw._format,
    };
    const key = urlKey(raw.url);
    const prev = byUrl.get(key);
    if (prev) {
      // 保留人工改过的 name；补 contentType
      const next = { ...prev };
      if (!next.contentType) next.contentType = raw._format;
      if (raw._format === 'note' && !/^Twitter[·•]/.test(String(next.name || ''))) {
        next.name = name;
      }
      byUrl.set(key, next);
      sourceCategory[next.name] = taxKey; // 强制覆写，避免旧 fun/热议串台
      updated++;
    } else {
      byUrl.set(key, entry);
      sourceCategory[name] = taxKey;
      added++;
    }
  }

  // BestBlogs 表内分类再扫一遍（改映射后旧 sourceCategory 必须跟着变）
  for (const f of byUrl.values()) {
    if (!f?.name) continue;
    const hit = lookupBestblogs(f.name, table);
    if (!hit) continue;
    const k = bestblogsCategoryToTaxonomy(hit.category);
    if (k) sourceCategory[f.name] = k;
    else if (k === null) delete sourceCategory[f.name]; // 体育
  }

  // 保底：rss 里已有、taxonomy 缺的，按 deep
  for (const f of byUrl.values()) {
    if (f.name && !sourceCategory[f.name]) sourceCategory[f.name] = 'deep';
  }

  // 热议只留社交/社区热榜名（NewsNow + 精选），其余误标 hot 的挪走
  const HOT_ONLY = new Set([
    '微博热搜', '抖音热榜', '小红书热榜', '知乎热榜', '百度热搜',
    '今日头条热榜', '今日头条', 'B站热搜', '虎扑步行街', '百度贴吧热议', '抽屉热榜',
  ]);
  for (const [n, k] of Object.entries(sourceCategory)) {
    if (k === 'hot' && !HOT_ONLY.has(n)) sourceCategory[n] = 'deep';
  }

  const feeds = [...byUrl.values()].sort((a, b) =>
    String(a.name).localeCompare(String(b.name), 'zh'),
  );

  // 源多了要抬总帽，否则 fairCap≈1
  const nextMax = Math.max(Number(rss.maxItems) || 0, Math.ceil(feeds.length * 3));
  const nextPerFeed = Math.min(6, Math.max(Number(rss.perFeed) || 4, 4));

  tax.sourceCategory = sourceCategory;
  tax._align = tax._align || {};
  tax._align.bestblogs = {
    _doc: 'BestBlogs wechat part1 九类 → 见报 key；体育不收录。扩源：node tools/expand-rss-from-catalog.mjs',
    ...Object.fromEntries(
      Object.entries(BESTBLOGS_TO_TAXONOMY).map(([k, v]) => [k, v == null ? '不收录' : v]),
    ),
  };
  tax._align.timqian = {
    _doc: 'chinese-independent-blogs tags 粗映射；默认 deep；扩源时 --timqian-cap',
    AI: 'ai',
    编程技术: 'dev',
    财经: 'biz',
    设计产品: 'deep',
    生活随笔: 'fun',
  };
  tax._doc6 =
    '2026-11-18 BestBlogs/timqian 分类作参考扩源：见 _align.bestblogs / _align.timqian；活源来自 format-feeds.json。';

  rss.feeds = feeds;
  rss.maxItems = nextMax;
  rss.perFeed = nextPerFeed;
  rss._doc = rss._doc || {};
  rss._doc['2026-11-18 BestBlogs扩源'] =
    `expand-rss-from-catalog：+${added} 更新${updated} 跳过体育等${skippedTax}；feeds=${feeds.length} maxItems=${nextMax}`;

  console.log(
    JSON.stringify(
      {
        catalogPicked: picked.length,
        added,
        updated,
        skippedTax,
        feeds: feeds.length,
        maxItems: nextMax,
        perFeed: nextPerFeed,
        byContentType: countBy(feeds, (f) => f.contentType || 'untagged'),
        byTaxonomy: countBy(
          Object.entries(sourceCategory).map(([name, k]) => ({ name, k })),
          (x) => x.k,
        ),
      },
      null,
      2,
    ),
  );

  if (dry) {
    console.log('dry-run：未写盘');
    return;
  }
  fs.writeFileSync(RSS_PATH, JSON.stringify(rss, null, 2) + '\n', 'utf8');
  fs.writeFileSync(TAX_PATH, JSON.stringify(tax, null, 2) + '\n', 'utf8');
  console.log('已写', path.relative(ROOT, RSS_PATH), path.relative(ROOT, TAX_PATH));

  // 同步完整源目录给门户「选内容包 / 全部源」
  const r = spawnSync(process.execPath, [path.join(__dirname, 'build-source-catalog.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) console.warn('! build-source-catalog 失败', r.status);
}

function countBy(arr, fn) {
  const o = {};
  for (const x of arr) {
    const k = fn(x) || '?';
    o[k] = (o[k] || 0) + 1;
  }
  return o;
}

main();
