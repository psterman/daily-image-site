#!/usr/bin/env node
/**
 * 从三份中文 RSS 清单拉源 → 探针最新条目 → cutoff 验活 → 五格式分桶。
 *
 *   node tools/build-format-catalog.mjs
 *   node tools/build-format-catalog.mjs --concurrency 8 --timeout 8000
 *   node tools/build-format-catalog.mjs --max 120          # 调试：每清单最多 N 条
 *   node tools/build-format-catalog.mjs --skip-probe       # 只解析分桶，不写活源
 *
 * 产物：tools/format-feeds.json · tools/format-feeds-report.md
 * 缓存：tools/.cache/format-lists/ · tools/.cache/format-probe.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestFeed } from './fetch-rss.mjs';
import {
  FORMAT_KEYS,
  FORMAT_LABELS,
  DEFAULT_CUTOFF,
  parseOpml,
  parseBlogsCsv,
  classifyFormat,
  isFreshEnough,
  dedupeFeeds,
  buildCatalogShape,
} from '../lib/format-catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(__dirname, '.cache');
const LIST_CACHE = path.join(CACHE, 'format-lists');
const PROBE_CACHE = path.join(CACHE, 'format-probe.json');
const OUT_JSON = path.join(__dirname, 'format-feeds.json');
const OUT_MD = path.join(__dirname, 'format-feeds-report.md');

const CUTOFF = DEFAULT_CUTOFF;

/** 上游几乎没有的格式：显式补探（仍走同一 cutoff） */
const SEED_FEEDS = [
  {
    name: 'B站每周必看',
    url: 'https://rsshub.bestblogs.dev/bilibili/weekly',
    home: 'https://www.bilibili.com/v/popular/weekly',
    sourceList: 'seed',
    folder: 'video',
    tags: '视频',
  },
  {
    name: 'B站排行榜',
    url: 'https://rsshub.bestblogs.dev/bilibili/ranking/0/3',
    home: 'https://www.bilibili.com/v/popular/rank/all',
    sourceList: 'seed',
    folder: 'video',
    tags: '视频',
  },
];

const SOURCES = [
  {
    id: 'bestblogs',
    label: 'BestBlogs wechat2rss',
    url: 'https://raw.githubusercontent.com/ginobefun/BestBlogs/main/opml/bestblogs_wechat2rss_opml_all.opml',
    kind: 'opml',
    defaultFolder: 'wechat',
  },
  {
    // 仓库根目录精选池（与 opml/wechat2rss 分开）；约 160 个 X/Twitter → note
    id: 'bestblogs-twitter',
    label: 'BestBlogs_RSS_Twitters',
    url: 'https://raw.githubusercontent.com/ginobefun/BestBlogs/main/BestBlogs_RSS_Twitters.opml',
    kind: 'opml',
    defaultFolder: 'twitter',
  },
  {
    id: 'awesome-cn-podcasts',
    label: 'awesome cn-podcasts',
    url: 'https://raw.githubusercontent.com/xiangyugongzuoliu/awesome-rss-feeds-list/main/feeds/cn-podcasts.opml',
    kind: 'opml',
    defaultFolder: 'cn-podcasts',
  },
  {
    id: 'awesome-cn-ai-tools',
    label: 'awesome cn-ai-tools',
    url: 'https://raw.githubusercontent.com/xiangyugongzuoliu/awesome-rss-feeds-list/main/feeds/cn-ai-tools.opml',
    kind: 'opml',
    defaultFolder: 'cn-ai-tools',
  },
  {
    id: 'awesome-cn-ai-research',
    label: 'awesome cn-ai-research',
    url: 'https://raw.githubusercontent.com/xiangyugongzuoliu/awesome-rss-feeds-list/main/feeds/cn-ai-research.opml',
    kind: 'opml',
    defaultFolder: 'cn-ai-research',
  },
  {
    id: 'awesome-cn-finance',
    label: 'awesome cn-finance',
    url: 'https://raw.githubusercontent.com/xiangyugongzuoliu/awesome-rss-feeds-list/main/feeds/cn-finance.opml',
    kind: 'opml',
    defaultFolder: 'cn-finance',
  },
  {
    id: 'awesome-cn-essays',
    label: 'awesome cn-essays',
    url: 'https://raw.githubusercontent.com/xiangyugongzuoliu/awesome-rss-feeds-list/main/feeds/cn-essays.opml',
    kind: 'opml',
    defaultFolder: 'cn-essays',
  },
  {
    id: 'awesome-cn-tech-teams',
    label: 'awesome cn-tech-teams',
    url: 'https://raw.githubusercontent.com/xiangyugongzuoliu/awesome-rss-feeds-list/main/feeds/cn-tech-teams.opml',
    kind: 'opml',
    defaultFolder: 'cn-tech-teams',
  },
  {
    id: 'awesome-cn-product-design',
    label: 'awesome cn-product-design',
    url: 'https://raw.githubusercontent.com/xiangyugongzuoliu/awesome-rss-feeds-list/main/feeds/cn-product-design.opml',
    kind: 'opml',
    defaultFolder: 'cn-product-design',
  },
  {
    id: 'timqian',
    label: 'chinese-independent-blogs',
    url: 'https://raw.githubusercontent.com/timqian/chinese-independent-blogs/master/blogs-original.csv',
    kind: 'csv',
  },
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v == null || v.startsWith('-') ? fallback : v;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'daily-image-site-format-catalog/1.0' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function loadList(src) {
  fs.mkdirSync(LIST_CACHE, { recursive: true });
  const cachePath = path.join(LIST_CACHE, src.id + (src.kind === 'csv' ? '.csv' : '.opml'));
  let body;
  if (fs.existsSync(cachePath) && !process.argv.includes('--refresh-lists')) {
    body = fs.readFileSync(cachePath, 'utf8');
  } else {
    console.log(`  ↓ ${src.id}`);
    body = await fetchText(src.url);
    fs.writeFileSync(cachePath, body);
  }
  let feeds =
    src.kind === 'csv'
      ? parseBlogsCsv(body)
      : parseOpml(body).map((f) => ({
          ...f,
          folder: f.folder || src.defaultFolder || '',
        }));
  return feeds.map((f) => ({
    ...f,
    sourceList: src.id.startsWith('awesome') ? 'awesome' : src.id,
    folder: f.folder || src.defaultFolder || '',
  }));
}

function loadProbeCache() {
  if (!fs.existsSync(PROBE_CACHE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PROBE_CACHE, 'utf8'));
  } catch {
    return {};
  }
}

function saveProbeCache(cache) {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(PROBE_CACHE, JSON.stringify(cache, null, 2));
}

async function probeOne(url, timeoutMs, cache) {
  const key = url.replace(/\/+$/, '').toLowerCase();
  const hit = cache[key];
  if (hit && hit.probedAt && Date.now() - Date.parse(hit.probedAt) < 7 * 86400000) {
    return hit;
  }
  try {
    const r = await requestFeed(url, timeoutMs, 1);
    let newestTs = r.items.reduce((m, it) => Math.max(m, it.ts || 0), 0);
    // 离谱未来时间（坏时钟/占位）夹到现在，避免脏排序
    if (newestTs > Date.now() + 7 * 86400000) newestTs = Date.now();
    // 有条目但无日期（部分榜单 RSS）：视为「刚探到」，避免整源被 cutoff 误杀
    if (!newestTs && r.items.length) newestTs = Date.now();
    const enc = '';
    const result = {
      ok: true,
      newestTs,
      newestAt: newestTs ? new Date(newestTs).toISOString() : null,
      count: r.items.length,
      error: '',
      probedAt: new Date().toISOString(),
      enclosureHint: enc,
    };
    cache[key] = result;
    return result;
  } catch (e) {
    const result = {
      ok: false,
      newestTs: 0,
      newestAt: null,
      count: 0,
      error: e.name === 'AbortError' ? `超时 ${timeoutMs}ms` : String(e.message || e),
      probedAt: new Date().toISOString(),
      enclosureHint: '',
    };
    cache[key] = result;
    return result;
  }
}

async function mapPool(items, concurrency, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, concurrency);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return ret;
}

function writeReport(catalog, stats) {
  const lines = [];
  lines.push('# 格式五板块 · 活源目录');
  lines.push('');
  lines.push(`生成：${catalog.generatedAt}`);
  lines.push(`新鲜度 cutoff：${catalog.cutoff}（最新条目 ≥ 此日才入桶）`);
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push(`| 格式 | content_type | 活源数 |`);
  lines.push(`|------|--------------|--------|`);
  for (const k of FORMAT_KEYS) {
    lines.push(`| ${FORMAT_LABELS[k]} | \`${k}\` | ${catalog.counts[k]} |`);
  }
  lines.push('');
  lines.push('## 探针');
  lines.push('');
  lines.push(`- 候选去重后：${stats.candidates}`);
  lines.push(`- 探针成功：${stats.ok}`);
  lines.push(`- 探针失败：${stats.fail}`);
  lines.push(`- 过旧（早于 cutoff）：${stats.stale}`);
  lines.push(`- 活源合计：${stats.alive}`);
  lines.push('');
  if (catalog.counts.note === 0) {
    lines.push('## Twitter（note）');
    lines.push('');
    lines.push('本轮上游几乎无 Twitter/X 源，桶为空（待补 RSSHub / 名单）。');
    lines.push('');
  }
  for (const k of FORMAT_KEYS) {
    const list = catalog.byFormat[k];
    lines.push(`## ${FORMAT_LABELS[k]}（${list.length}）`);
    lines.push('');
    if (!list.length) {
      lines.push('_无_');
      lines.push('');
      continue;
    }
    for (const f of list.slice(0, 12)) {
      lines.push(`- **${f.name}** · ${f.newestAt || '?'} · \`${f.sourceList}\``);
      lines.push(`  - ${f.url}`);
    }
    if (list.length > 12) lines.push(`- … 另有 ${list.length - 12} 个`);
    lines.push('');
  }
  if (stats.failSamples?.length) {
    lines.push('## 失败样例');
    lines.push('');
    for (const s of stats.failSamples) {
      lines.push(`- ${s.name}: ${s.error}`);
    }
    lines.push('');
  }
  fs.writeFileSync(OUT_MD, lines.join('\n'));
}

async function main() {
  const concurrency = Math.max(1, Number(arg('--concurrency', '8')) || 8);
  const timeoutMs = Math.max(2000, Number(arg('--timeout', '8000')) || 8000);
  const maxPerList = Number(arg('--max', '0')) || 0;
  const skipProbe = process.argv.includes('--skip-probe');
  const fromCache = process.argv.includes('--from-cache');

  console.log('拉清单…');
  let all = [];
  for (const src of SOURCES) {
    try {
      let feeds = await loadList(src);
      if (maxPerList > 0) feeds = feeds.slice(0, maxPerList);
      console.log(`  ${src.id}: ${feeds.length}`);
      all.push(...feeds);
    } catch (e) {
      console.warn(`  ! ${src.id}: ${e.message}`);
    }
  }
  all = dedupeFeeds(all.concat(SEED_FEEDS));
  console.log(`去重后候选 ${all.length}（含 seed ${SEED_FEEDS.length}）`);

  // 先打 format 标签（探针前）
  for (const f of all) {
    f.format = classifyFormat(f);
  }

  const stats = {
    candidates: all.length,
    ok: 0,
    fail: 0,
    stale: 0,
    alive: 0,
    failSamples: [],
  };

  let alive = [];
  if (skipProbe) {
    console.log('跳过探针（--skip-probe），不写活源目录');
  } else {
    const cache = loadProbeCache();
    if (fromCache) {
      console.log('仅用探针缓存重分桶（--from-cache）…');
    } else {
      console.log(`探针 concurrency=${concurrency} timeout=${timeoutMs}ms …`);
    }
    let done = 0;
    const run = fromCache
      ? async (feed) => {
          const key = feed.url.replace(/\/+$/, '').toLowerCase();
          return cache[key] || {
            ok: false,
            newestTs: 0,
            newestAt: null,
            error: 'no-cache',
            enclosureHint: '',
          };
        }
      : (feed) => probeOne(feed.url, timeoutMs, cache);

    await mapPool(all, fromCache ? 32 : concurrency, async (feed) => {
      const r = await run(feed);
      done++;
      if (!fromCache && (done % 50 === 0 || done === all.length)) {
        console.log(`  … ${done}/${all.length}`);
        saveProbeCache(cache);
      }
      if (!r.ok) {
        stats.fail++;
        if (stats.failSamples.length < 15) {
          stats.failSamples.push({ name: feed.name, error: r.error });
        }
        return;
      }
      stats.ok++;
      let newestTs = r.newestTs;
      if (newestTs > Date.now() + 7 * 86400000) newestTs = Date.now();
      if (!isFreshEnough(newestTs, CUTOFF)) {
        stats.stale++;
        return;
      }
      stats.alive++;
      alive.push({
        ...feed,
        format: classifyFormat({ ...feed, enclosureHint: r.enclosureHint }),
        newestTs,
        newestAt: newestTs ? new Date(newestTs).toISOString() : r.newestAt,
      });
    });
    if (!fromCache) saveProbeCache(cache);
  }

  const catalog = buildCatalogShape(alive, { cutoff: CUTOFF });
  fs.writeFileSync(OUT_JSON, JSON.stringify(catalog, null, 2));
  writeReport(catalog, stats);
  console.log('写出', path.relative(ROOT, OUT_JSON));
  console.log('写出', path.relative(ROOT, OUT_MD));
  console.log('counts', catalog.counts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
