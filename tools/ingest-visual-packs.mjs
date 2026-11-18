#!/usr/bin/env node
/**
 * ingest-visual-packs.mjs —— 灌「轻松一刻 / 人像美学 / 电影音乐」视觉包
 *
 * 对齐原站 daily_grab_all.py / daily.onetone.app：
 *   轻松一刻 ≈ 见笑  ← TG：每日沙雕墙 / 平壤卫视 / 煎蛋无聊图
 *   人像美学 ≈ 见她  ← 煎蛋女装区 API + 福利吧图帖
 *   电影音乐 ≈ 听乐+看片 ← fetch-rank（猫眼/网易云/Apple），带封面+简介+地区
 *
 * 版权：只存 title + ≤160 摘要 + 原文链接 + 远程 image_url 热链；不转存。
 *
 *   node tools/ingest-visual-packs.mjs
 *   node tools/ingest-visual-packs.mjs --dry-run --per-tag 8
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../lib/sb-client.mjs';
import { mapFeedItems, stripHtml, MAX_SUMMARY } from '../lib/ingest-map.mjs';
import { fetchHeadlines } from './fetch-rss.mjs';
import { fetchRank, GROUP_LABEL } from './fetch-rank.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAIN_SOURCE_ID = '74d9887f-a1d4-4e26-92c2-4005e8829c21';

/** 见笑：与 daily_grab_all.TG_CHANNELS 一致 */
const FUNNY_FEEDS = [
  { name: 'TG每日沙雕墙', url: 'https://rsshub.bestblogs.dev/telegram/channel/woshadiao' },
  { name: 'TG平壤卫视', url: 'https://rsshub.bestblogs.dev/telegram/channel/pingrangTV' },
  { name: 'TG煎蛋无聊图', url: 'https://rsshub.bestblogs.dev/telegram/channel/jandan_pic' },
];

/** 见她补充源：福利吧（女图/汇总帖）；煎蛋女装走官方 API */
const PORTRAIT_FEEDS = [
  { name: '福利吧', url: 'https://fuliba2023.net/feed' },
];

const JANDAN_BEAUTY_SID = 108629;
// 福利吧整站 RSS 很杂：只收汇总图帖 / 明确女图向，避开游戏·动漫资讯
const FULIBA_KEEP = /福利汇总|写真|女装|街拍|人像|美女|小姐姐|啤酒妹/i;

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

function imageTitle(raw, fallback) {
  let t = stripHtml(raw && raw.title).replace(/[:：]\s*$/, '').trim();
  // TG 标题常是「🖼 xxx」—— 去掉装饰符
  t = t.replace(/^[🖼🎬⚠️\s]+/u, '').trim();
  if (!t || t.length < 2) t = fallback;
  return t.slice(0, 200);
}

function toHttps(u) {
  return String(u || '').replace(/^http:\/\//i, 'https://');
}

/** 煎蛋女装区：与 grab_jandan_beauty 同源 API（section 108629）。 */
async function fetchJandanBeauty(limit = 12) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; visual-packs/1.0)',
    Referer: 'https://jandan.net/beauty',
    Origin: 'https://jandan.net',
    Accept: 'application/json',
  };
  const head = await fetch(
    `https://jandan.net/api/comment/post/${JANDAN_BEAUTY_SID}?order=desc`,
    { headers },
  );
  if (!head.ok) throw new Error(`jandan beauty HTTP ${head.status}`);
  const hj = await head.json();
  const page = Number(hj?.data?.current_page) || 1;
  const out = [];
  for (let p = page; p >= Math.max(1, page - 2) && out.length < limit; p--) {
    const r = p === page ? hj : await (await fetch(
      `https://jandan.net/api/comment/post/${JANDAN_BEAUTY_SID}?order=desc&page=${p}`,
      { headers },
    )).json();
    for (const c of r?.data?.list || []) {
      const html = String(c.content || '');
      const imgs = [...html.matchAll(/src=["']([^"']+)["']/gi)].map((m) => toHttps(m[1]));
      const img = imgs.find((u) => /\.(?:jpg|jpeg|png|gif|webp)(?:\?|$)/i.test(u));
      if (!img) continue;
      const id = c.id || c.comment_ID;
      out.push({
        title: String(c.author || '煎蛋女装').replace(/[:：]\s*$/, ''),
        link: `https://jandan.net/t/${id}`,
        desc: '煎蛋女装',
        source: '煎蛋女装',
        ts: c.date_gmt ? Date.parse(c.date_gmt) : Date.now(),
        imgs: [{ url: img }],
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

function regionOfRankItem(it) {
  const source = String((it && it.source) || '');
  const tags = Array.isArray(it && it.tags) ? it.tags : [];
  if (source.includes('猫眼') || source.includes('豆瓣')) return 'zh-CN';
  if (source.includes('网易云')) {
    // 中文榜 → zh-CN；国际/场景榜 → intl（可被非中文 locale 优先命中）
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
  if (!cover) return null; // 电影音乐预览必须有图
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

  // 1) 清掉不合格旧挂；见笑/见她换源后整包重挂（避免 ooxx/热榜残留）
  for (const key of ['funny', 'portrait', 'movie']) {
    const cleared = await clearStaleVisualPack(admin, tagIdByKey[key], key);
    if (cleared) console.log(`清理陈旧 ${key} 标签 ${cleared} 条`);
  }
  for (const key of ['funny', 'portrait']) {
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

  // 2) 见笑：三个 TG 频道；见她：煎蛋女装 API + 福利吧女图帖
  const funnyCfg = {
    enabled: true,
    perFeed: Math.max(perTag, 8),
    maxItems: FUNNY_FEEDS.length * Math.max(perTag, 8),
    timeoutMs: 20000,
    maxAgeDays: 14,
    feeds: FUNNY_FEEDS,
  };
  const portraitCfg = {
    enabled: true,
    perFeed: Math.max(perTag, 8),
    maxItems: PORTRAIT_FEEDS.length * Math.max(perTag, 8),
    timeoutMs: 20000,
    maxAgeDays: 14,
    feeds: PORTRAIT_FEEDS,
  };
  const [funnyRes, portraitRes, beautyItems] = await Promise.all([
    fetchHeadlines(funnyCfg),
    fetchHeadlines(portraitCfg),
    fetchJandanBeauty(Math.max(perTag, 10)).catch((e) => {
      console.log('煎蛋女装 API 失败', e.message);
      return [];
    }),
  ]);
  const failures = [...(funnyRes.failures || []), ...(portraitRes.failures || [])];
  if (failures.length) console.log('图片源失败', failures.map((f) => f.name || f));

  const classified = [];
  const pushImg = (it, tag, fallback) => {
    const img = toHttps(it.imgs && it.imgs[0] && it.imgs[0].url);
    if (!img || !/^https?:\/\//i.test(img)) return;
    // 跳过 TG 的 NSFW 预警纯文字、视频条
    const title = imageTitle(it, fallback);
    if (/#NSFW|提前预警/i.test(title) && !img) return;
    classified.push({
      title,
      link: it.link,
      desc: stripHtml(it.desc || '').slice(0, MAX_SUMMARY) || fallback,
      source: it.source,
      ts: it.ts,
      imageUrl: img,
      tagKeys: [tag],
      contentType: 'image',
      region: 'zh-CN',
      language: 'zh-CN',
      ingestedBy: 'visual-packs',
    });
  };

  // 见笑：三频道交错，避免单一源占满配额
  {
    const bySrc = new Map();
    for (const it of funnyRes.items || []) {
      if (!bySrc.has(it.source)) bySrc.set(it.source, []);
      bySrc.get(it.source).push(it);
    }
    const queues = [...bySrc.values()];
    let guard = 0;
    while (queues.some((q) => q.length) && guard++ < 200) {
      for (const q of queues) {
        const it = q.shift();
        if (it) pushImg(it, 'funny', '趣味图片');
      }
    }
  }
  // 见她：女装 API 与福利吧女图帖交错
  {
    const fuliba = (portraitRes.items || []).filter((it) =>
      FULIBA_KEEP.test(String(it.title || '') + ' ' + String(it.desc || '')),
    );
    const n = Math.max(beautyItems.length, fuliba.length);
    for (let i = 0; i < n; i++) {
      if (i < beautyItems.length) pushImg(beautyItems[i], 'portrait', '煎蛋女装');
      if (i < fuliba.length) pushImg(fuliba[i], 'portrait', '福利吧');
    }
  }
  console.log(
    `image ok: funny=${classified.filter((x) => x.tagKeys[0] === 'funny').length}` +
    ` beauty=${beautyItems.length}` +
    ` portrait=${classified.filter((x) => x.tagKeys[0] === 'portrait').length}`,
  );

  // 3) 电影音乐：复用原站 fetch-rank（封面 + 简介 + 地区）
  console.log('抓取听乐/看片榜单…');
  const rank = await fetchRank({ date: new Date().toISOString().slice(0, 10), checkCovers: false });
  const payload = rank.payload || rank;
  // 院线（偏 zh-CN）+ 乐榜（中文/国际各半），预览按用户 locale 筛选
  const half = Math.max(2, Math.ceil(perTag / 2));
  const moviePick = (payload.movie || []).filter((x) => x.cover).slice(0, half);
  const musicAll = (payload.music || []).filter((x) => x.cover);
  const musicCn = musicAll.filter((x) => regionOfRankItem(x) === 'zh-CN').slice(0, Math.ceil(half / 2));
  const musicIntl = musicAll.filter((x) => regionOfRankItem(x) === 'intl').slice(0, Math.ceil(half / 2));
  const musicPick = [...musicCn, ...musicIntl];
  if (rank.allFailed) console.log('警告：听乐/看片源全部失败', rank.sources?.filter((s) => s.error).map((s) => s.name));
  const interleaved = [];
  for (let i = 0; i < Math.max(moviePick.length, musicPick.length); i++) {
    if (i < moviePick.length) {
      const raw = rankToRaw(moviePick[i], 'movie');
      if (raw) interleaved.push(raw);
    }
    if (i < musicPick.length) {
      const raw = rankToRaw(musicPick[i], 'music');
      if (raw) interleaved.push(raw);
    }
  }
  classified.push(...interleaved);
  console.log(`rank ok: movie=${moviePick.length} musicCn=${musicCn.length} musicIntl=${musicIntl.length} classified=${classified.length}`);

  const mapped = mapFeedItems(classified, {
    sourceId: MAIN_SOURCE_ID,
    allowSnippet: true,
    allowImage: true,
    rightsStatus: 'unknown',
    // publisher 留给各条 raw.source（TG 频道名 / 煎蛋女装 / 福利吧）
    resolveTagId: (k) => tagIdByKey[k] || null,
  });

  // 每包配额
  const picked = [];
  const pickedIds = new Set();
  const countByTag = { funny: 0, portrait: 0, movie: 0 };
  const byTag = new Map();
  for (const row of mapped.rows) {
    for (const k of row.metadata.tag_keys || []) {
      if (!countByTag.hasOwnProperty(k)) continue;
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
      title: r.title, tags: r.metadata.tag_keys, region: r.metadata.region, img: !!r.image_url,
    })));
    return;
  }

  const existing = await admin.select('content_items', {
    columns: 'id,content_hash',
    filters: [{ col: 'source_id', op: 'eq', value: MAIN_SOURCE_ID }],
    limit: 5000,
  });
  const have = new Set(existing.map((r) => r.content_hash));
  const fresh = picked.filter((r) => !have.has(r.content_hash));
  const tagRows = [];
  for (const r of fresh) {
    for (const l of linkByItem.get(r.id) || []) tagRows.push(l);
  }
  // 已存在条目也补标签（同 hash 换包）
  const byHash = Object.fromEntries(existing.map((r) => [r.content_hash, r.id]));
  for (const r of picked) {
    if (!have.has(r.content_hash)) continue;
    const id = byHash[r.content_hash];
    if (!id) continue;
    for (const l of linkByItem.get(r.id) || []) {
      tagRows.push({ ...l, content_item_id: id });
    }
  }

  const inserted = await upsertBatch(admin, fresh, tagRows);
  console.log(`完成：新插 ${inserted}，标签 upsert ${tagRows.length}；按包`, JSON.stringify(countByTag));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
