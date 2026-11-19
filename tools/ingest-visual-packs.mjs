#!/usr/bin/env node
/**
 * ingest-visual-packs.mjs —— 灌「轻松一刻 / 人像美学 / 电影音乐」视觉包
 *
 * 轻松一刻 / 人像美学：读 daily.onetone.app 当日（及昨日）manifest 的站内图
 *   （见笑 / 见她 → /img/<日期>/…webp，已过滤、已上 Cloudflare）。
 *   TG RSS 热链进不了浏览器池，不再用作图源。
 * 电影音乐：仍走 fetch-rank（猫眼/网易云/Apple 封面热链）。
 *
 * 版权：只存 title + ≤160 摘要 + 原文链接 + 站内 image_url；不二次转存。
 *
 *   node tools/ingest-visual-packs.mjs
 *   node tools/ingest-visual-packs.mjs --dry-run --per-tag 8
 *   node tools/ingest-visual-packs.mjs --site https://daily.onetone.app --date 2026-11-19
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../lib/sb-client.mjs';
import { mapFeedItems, MAX_SUMMARY } from '../lib/ingest-map.mjs';
import { fetchRank, GROUP_LABEL } from './fetch-rank.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAIN_SOURCE_ID = '74d9887f-a1d4-4e26-92c2-4005e8829c21';
const DEFAULT_SITE = 'https://daily.onetone.app';

/** 原站 media tab → 平台标签包 */
const SITE_TAB_TO_PACK = Object.freeze({
  jianxiao: { tag: 'funny', source: '见笑', label: '见笑精选' },
  jianshe: { tag: 'portrait', source: '见她', label: '见她精选' },
  jianwen: { tag: 'sight', source: '见闻', label: '见闻精选' },
});

function loadEnv() {
  const raw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  return Object.fromEntries(
    raw.split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v == null || v.startsWith('-') ? fallback : v;
}

function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function shiftDate(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function baseUrl(u) {
  return String(u || '').replace(/\/+$/, '');
}

/** 解析 window.__DAILY_MANIFEST__={...} */
export function parseDailyManifestJs(text) {
  const m = String(text || '').match(/__DAILY_MANIFEST__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!m) throw new Error('manifest 不是 __DAILY_MANIFEST__ 赋值');
  return JSON.parse(m[1]);
}

/**
 * 见笑/见她：一天一期整期收录（不拆成 N 张独立条目）。
 * limitByTag = 单期最多收几张（默认收满，上限 200）。
 */
export function siteItemsToRaw(manifest, site, limitByTag = 200) {
  const siteBase = baseUrl(site || manifest.siteUrl || DEFAULT_SITE);
  const date = String(manifest.date || '');
  const cap = Math.max(1, Math.min(200, Number(limitByTag) || 200));
  const out = [];
  for (const tab of manifest.tabs || []) {
    const map = SITE_TAB_TO_PACK[tab.key];
    if (!map) continue;
    const images = [];
    for (const it of tab.items || []) {
      if (images.length >= cap) break;
      const rel = String(it.full || it.thumb || '').trim();
      if (!rel.startsWith('/img/')) continue;
      const full = `${siteBase}${rel}`;
      const thumbRel = String(it.thumb || it.full || '').trim();
      images.push({
        full,
        thumb: thumbRel.startsWith('/img/') ? `${siteBase}${thumbRel}` : full,
      });
    }
    if (!images.length) continue;
    out.push({
      title: `${map.source} · ${date}（${images.length} 张）`,
      // 用 ?pack= 去重（normalizeUrl 会丢掉 #jianxiao，见笑/见她会撞车）
      link: `${siteBase}/${date}/?pack=${tab.key}`,
      desc: `大佬请批阅 · ${map.source} · ${date} · 共 ${images.length} 张`.slice(0, MAX_SUMMARY),
      source: map.source,
      ts: Date.parse(`${date}T12:00:00+08:00`) || Date.now(),
      imageUrl: images[0].full,
      images,
      tagKeys: [map.tag],
      contentType: 'image',
      region: 'zh-CN',
      language: 'zh-CN',
      ingestedBy: 'visual-packs',
      issueKind: tab.key,
      issueDate: date,
    });
  }
  return out;
}

async function fetchText(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; visual-packs/1.0)',
        accept: 'text/html,application/javascript,*/*',
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/** 拉一期站内 manifest → 见笑/见她 raw 条目 */
export async function fetchSiteVisualDay(site, date, limitByTag = 200) {
  const root = baseUrl(site);
  const pageUrl = `${root}/${date}/`;
  const html = await fetchText(pageUrl);
  const src = [...html.matchAll(/<script[^>]+src=["']([^"']*manifest[^"']*\.js)["']/gi)]
    .map((m) => m[1])
    .find(Boolean);
  if (!src) throw new Error(`${date} 页面无 manifest script`);
  const manUrl = new URL(src, pageUrl).href;
  const js = await fetchText(manUrl);
  const manifest = parseDailyManifestJs(js);
  return siteItemsToRaw(manifest, root, limitByTag);
}

function regionOfRankItem(it) {
  const source = String((it && it.source) || '');
  const tags = Array.isArray(it && it.tags) ? it.tags : [];
  if (source.includes('猫眼') || source.includes('豆瓣')) return 'zh-CN';
  if (source.includes('网易云')) {
    if (tags.some((t) => String(t).includes(GROUP_LABEL.cn))) return 'zh-CN';
    return 'intl';
  }
  if (source.includes('Apple')) return 'intl';
  return 'intl';
}

function rankToRaw(it, kind) {
  const title = String((it && it.title) || '').trim();
  const link = String((it && it.link) || '').trim();
  if (!title || !/^https?:\/\//i.test(link)) return null;
  const cover = String((it && it.cover) || '').trim();
  if (!cover) return null;
  const bits = [it.subtitle, it.meta, it.tag].map((x) => String(x || '').trim()).filter(Boolean);
  return {
    title,
    link,
    desc: bits.join(' · ').slice(0, MAX_SUMMARY),
    source: it.source || kind,
    ts: Date.now(),
    imageUrl: cover,
    tagKeys: ['movie'],
    contentType: kind === 'music' ? 'podcast' : 'video',
    region: regionOfRankItem(it),
    language: regionOfRankItem(it) === 'zh-CN' ? 'zh-CN' : 'en',
    ingestedBy: 'visual-packs',
  };
}

async function upsertBatch(admin, rows, links) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 40) {
    const batch = rows.slice(i, i + 40).map((r) => ({
      id: r.id,
      source_id: r.source_id,
      canonical_url: r.canonical_url,
      content_hash: r.content_hash,
      content_type: r.content_type,
      title: r.title,
      summary: r.summary,
      author: r.author,
      image_url: r.image_url || null,
      published_at: r.published_at,
      language: r.language,
      rights_status: r.rights_status,
      license: r.license,
      metadata: r.metadata,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    await admin.insert('content_items', batch, { returnMinimal: true });
    inserted += batch.length;
  }
  for (let i = 0; i < links.length; i += 100) {
    await admin.upsert('content_tags', links.slice(i, i + 100), 'content_item_id,tag_pack_id');
  }
  return inserted;
}

/**
 * 清掉某包下不合格旧条目：无图，或不是 visual-packs 灌入的（文字 RSS 误挂）。
 */
async function clearStaleVisualPack(admin, packId, key) {
  if (!packId) return 0;
  const tags = await admin.select('content_tags', {
    filters: [{ col: 'tag_pack_id', op: 'eq', value: packId }],
    limit: 500,
  });
  if (!tags.length) return 0;
  const items = await admin.select('content_items', {
    columns: 'id,image_url,metadata',
    filters: [{ col: 'id', op: 'in', value: tags.map((t) => t.content_item_id) }],
  });
  let n = 0;
  for (const it of items) {
    const meta = it.metadata || {};
    const hasImg = it.image_url && /^https?:\/\//i.test(it.image_url);
    const fromVisual = meta.ingested_by === 'visual-packs';
    if (hasImg && fromVisual) continue;
    await admin.delete('content_tags', {
      filters: [
        { col: 'content_item_id', op: 'eq', value: it.id },
        { col: 'tag_pack_id', op: 'eq', value: packId },
      ],
    });
    const keys = Array.isArray(meta.tag_keys) ? meta.tag_keys.filter((k) => k !== key) : [];
    await admin.update('content_items', {
      metadata: { ...meta, tag_keys: keys },
    }, { filters: [{ col: 'id', op: 'eq', value: it.id }] });
    n++;
  }
  return n;
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const perTag = Math.max(3, Number(arg('--per-tag', '10')) || 10);
  const site = baseUrl(arg('--site', process.env.VISUAL_SITE_URL || process.env.SITE_URL || DEFAULT_SITE));
  const date = arg('--date', todayShanghai());
  const dates = [date, shiftDate(date, -1)];

  const env = loadEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  }
  const admin = createClient({
    url: env.SUPABASE_URL,
    key: env.SUPABASE_SERVICE_ROLE_KEY,
    schema: 'platform',
  });

  const packs = await admin.select('tag_packs', {
    columns: 'id,key,status',
    filters: [{ col: 'status', op: 'eq', value: 'active' }],
  });
  const tagIdByKey = Object.fromEntries(packs.map((p) => [p.key, p.id]));

  // 1) 清掉不合格旧挂；见笑/见她换源后整包重挂（避免 TG 热链残留）
  for (const key of ['funny', 'portrait', 'sight', 'movie']) {
    const cleared = await clearStaleVisualPack(admin, tagIdByKey[key], key);
    if (cleared) console.log(`清理陈旧 ${key} 标签 ${cleared} 条`);
  }
  for (const key of ['funny', 'portrait', 'sight']) {
    const packId = tagIdByKey[key];
    if (!packId) continue;
    const tags = await admin.select('content_tags', {
      filters: [{ col: 'tag_pack_id', op: 'eq', value: packId }],
      limit: 500,
    });
    for (const t of tags) {
      await admin.delete('content_tags', {
        filters: [
          { col: 'content_item_id', op: 'eq', value: t.content_item_id },
          { col: 'tag_pack_id', op: 'eq', value: packId },
        ],
      });
    }
    if (tags.length) console.log(`重置 ${key} 标签 ${tags.length} 条（换源重灌）`);
  }

  // 2) 站内见笑/见她：每天各一整期（今日优先，昨日补缺）
  const classified = [];
  const seenIssue = new Set();
  for (const d of dates) {
    try {
      const rows = await fetchSiteVisualDay(site, d, 300);
      let added = 0;
      for (const row of rows) {
        const k = `${row.tagKeys[0]}:${row.issueDate || d}`;
        if (seenIssue.has(k)) continue;
        seenIssue.add(k);
        classified.push(row);
        added++;
      }
      const nImg = rows.reduce((n, r) => n + (r.images ? r.images.length : 0), 0);
      console.log(`site ${d}: +${added} 期 / ${nImg} 张（累计 ${classified.length} 期）`);
    } catch (e) {
      console.log(`site ${d} 失败`, e.message || e);
    }
  }
  console.log(
    `image ok: funny=${classified.filter((x) => x.tagKeys[0] === 'funny').length}期` +
    ` portrait=${classified.filter((x) => x.tagKeys[0] === 'portrait').length}期` +
    ` sight=${classified.filter((x) => x.tagKeys[0] === 'sight').length}期` +
    ` imgs=${classified.reduce((n, r) => n + ((r.images && r.images.length) || 0), 0)}`,
  );
  if (!classified.some((x) => x.tagKeys[0] === 'funny')) {
    console.log('警告：站内见笑为空 —— 检查 SITE / 日期是否已发布');
  }
  if (!classified.some((x) => x.tagKeys[0] === 'sight')) {
    console.log('警告：站内见闻为空 —— 检查 SITE / 日期是否已发布');
  }

  // 3) 电影音乐：复用原站 fetch-rank（封面 + 简介 + 地区）
  console.log('抓取听乐/看片榜单…');
  const rank = await fetchRank({ date, checkCovers: false });
  const payload = rank.payload || rank;
  const half = Math.max(2, Math.ceil(perTag / 2));
  const moviePick = (payload.movie || []).filter((x) => x.cover).slice(0, half);
  const musicAll = (payload.music || []).filter((x) => x.cover);
  const musicCn = musicAll.filter((x) => regionOfRankItem(x) === 'zh-CN').slice(0, Math.ceil(half / 2));
  const musicIntl = musicAll.filter((x) => regionOfRankItem(x) === 'intl').slice(0, Math.ceil(half / 2));
  const musicPick = [...musicCn, ...musicIntl];
  if (rank.allFailed) console.log('警告：听乐/看片源全部失败', rank.sources?.filter((s) => s.error).map((s) => s.name));
  for (let i = 0; i < Math.max(moviePick.length, musicPick.length); i++) {
    if (i < moviePick.length) {
      const raw = rankToRaw(moviePick[i], 'movie');
      if (raw) classified.push(raw);
    }
    if (i < musicPick.length) {
      const raw = rankToRaw(musicPick[i], 'music');
      if (raw) classified.push(raw);
    }
  }
  console.log(`rank ok: movie=${moviePick.length} musicCn=${musicCn.length} musicIntl=${musicIntl.length} classified=${classified.length}`);

  const mapped = mapFeedItems(classified, {
    sourceId: MAIN_SOURCE_ID,
    allowSnippet: true,
    allowImage: true,
    rightsStatus: 'unknown',
    resolveTagId: (k) => tagIdByKey[k] || null,
  });

  const picked = [];
  const pickedIds = new Set();
  const countByTag = { funny: 0, portrait: 0, sight: 0, movie: 0 };
  const byTag = new Map();
  for (const row of mapped.rows) {
    for (const k of row.metadata.tag_keys || []) {
      if (!Object.prototype.hasOwnProperty.call(countByTag, k)) continue;
      if (!byTag.has(k)) byTag.set(k, []);
      byTag.get(k).push(row);
    }
  }
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [k, list] of byTag) {
      if (countByTag[k] >= perTag) continue;
      while (list.length) {
        const row = list.shift();
        if (pickedIds.has(row.id)) continue;
        if (!row.image_url) continue;
        pickedIds.add(row.id);
        picked.push(row);
        for (const tk of row.metadata.tag_keys || []) {
          if (countByTag[tk] != null) countByTag[tk]++;
        }
        progressed = true;
        break;
      }
    }
  }

  const linkByItem = new Map();
  for (const l of mapped.links) {
    if (!pickedIds.has(l.content_item_id)) continue;
    if (!linkByItem.has(l.content_item_id)) linkByItem.set(l.content_item_id, []);
    linkByItem.get(l.content_item_id).push(l);
  }

  console.log('配额', JSON.stringify(countByTag), 'picked', picked.length);
  if (dry) {
    console.log('[dry-run]', picked.slice(0, 6).map((r) => ({
      title: r.title, tags: r.metadata.tag_keys, img: String(r.image_url || '').slice(0, 72),
    })));
    return;
  }

  // 只按本批 hash 查重（避免 5000 截断漏判 → insert 409）
  const hashList = [...new Set(picked.map((r) => r.content_hash))];
  const existing = hashList.length
    ? await admin.select('content_items', {
      columns: 'id,content_hash',
      filters: [
        { col: 'source_id', op: 'eq', value: MAIN_SOURCE_ID },
        { col: 'content_hash', op: 'in', value: hashList },
      ],
    })
    : [];
  const byHash = Object.fromEntries(existing.map((r) => [r.content_hash, r.id]));
  const fresh = picked.filter((r) => !byHash[r.content_hash]);
  const tagRows = [];
  for (const r of fresh) {
    for (const l of linkByItem.get(r.id) || []) tagRows.push(l);
  }
  for (const r of picked) {
    const id = byHash[r.content_hash];
    if (!id) continue;
    for (const l of linkByItem.get(r.id) || []) {
      tagRows.push({ ...l, content_item_id: id });
    }
  }

  const inserted = await upsertBatch(admin, fresh, tagRows);
  console.log(`完成：新插 ${inserted}，标签 upsert ${tagRows.length}；按包`, JSON.stringify(countByTag));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
