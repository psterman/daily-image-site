#!/usr/bin/env node
/**
 * ingest-platform.mjs —— 从 rss.config.json 抓取 → ingest-map 映射 → 写入 platform 共享池
 *
 * 用法：
 *   node tools/ingest-platform.mjs                 # 默认每标签最多 10 条
 *   node tools/ingest-platform.mjs --per-tag 8
 *   node tools/ingest-platform.mjs --dry-run
 *   node tools/ingest-platform.mjs --max-items 80
 *
 * 凭证：.env.local 的 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY（已 GRANT platform schema）。
 * 版权：只写 title + ≤160 摘要 + 链接；rights=unknown；image_url 仅远程索引（不转存）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../lib/sb-client.mjs';
import { mapFeedItems } from '../lib/ingest-map.mjs';
import { pipelinePublisherCaps } from '../lib/pipeline-policy.mjs';
import { fetchHeadlines, loadConfig } from './fetch-rss.mjs';
import { fetchNewsnowHeadlines, loadNewsnowConfig } from './fetch-newsnow.mjs';
import { fetchDailyhotHeadlines, loadDailyhotConfig } from './fetch-dailyhot.mjs';
import { fetchChoutiHot, fetchXiaohongshuHot, fetchNgaWangshi } from './fetch-hot-extras.mjs';
import { loadTaxonomy, classifyItem } from './news-taxonomy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAIN_SOURCE_ID = '74d9887f-a1d4-4e26-92c2-4005e8829c21';

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

function sqlEsc(s) {
  return String(s == null ? '' : s).replace(/'/g, "''");
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  // 流水白名单按源 dailyCap 先收；per-tag 作软顶（过小会把热榜挤瘦）
  const perTag = Math.max(1, Number(arg('--per-tag', '400')) || 400);
  // 源变多后 fairCap≈maxItems/源数；太小会把电影/搞笑挤没
  const maxItems = Math.max(10, Number(arg('--max-items', '3200')) || 3200);

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

  const sources = await admin.select('sources', {
    filters: [{ col: 'id', op: 'eq', value: MAIN_SOURCE_ID }],
  });
  const main = sources[0];
  if (!main || main.rights_status !== 'authorized' || !main.allow_snippet) {
    throw new Error('主源编辑池必须存在且 authorized + allow_snippet');
  }

  const cfg = loadConfig();
  cfg.maxItems = maxItems;
  // 普通源仍 8；video/podcast 在 fetch-rss 里按格式抬到周榜量级（展示区另截 3 条）
  cfg.perFeed = Math.min(Number(cfg.perFeed) || 6, 8);
  console.log(`抓取 RSS ${cfg.feeds?.length || 0} 源（maxItems=${maxItems} perFeed≤${cfg.perFeed}）…`);
  const { items, failures, stale } = await fetchHeadlines(cfg);
  console.log(`RSS 抓到 ${items.length} 条；失败源 ${failures.length}；过期丢弃源 ${stale.length}`);

  // 热榜缺口：NewsNow JSON API（白名单见 newsnow.config.json）
  const nnCfg = loadNewsnowConfig();
  if (nnCfg.enabled) {
    console.log(`抓取 NewsNow ${nnCfg.sources?.length || 0} 源（${nnCfg.baseUrl}）…`);
    const nn = await fetchNewsnowHeadlines(nnCfg);
    items.push(...nn.items);
    for (const f of nn.failures) failures.push({ name: f.name, error: `newsnow:${f.error}` });
    console.log(`NewsNow 抓到 ${nn.items.length} 条；失败 ${nn.failures.length}`);
  }

  // NewsNow 缺口：DailyHotApi（白名单见 dailyhot.config.json）
  const dhCfg = loadDailyhotConfig();
  if (dhCfg.enabled) {
    console.log(`抓取 DailyHot ${dhCfg.sources?.length || 0} 源（${dhCfg.baseUrl}）…`);
    const dh = await fetchDailyhotHeadlines(dhCfg);
    items.push(...dh.items);
    for (const f of dh.failures) failures.push({ name: f.name, error: `dailyhot:${f.error}` });
    console.log(`DailyHot 抓到 ${dh.items.length} 条；失败 ${dh.failures.length}`);
  }

  // 抽屉 / 小红书 / NGA网事杂谈（hot-extras.config.json）
  const hxPath = path.join(__dirname, 'hot-extras.config.json');
  const hxCfg = fs.existsSync(hxPath) ? JSON.parse(fs.readFileSync(hxPath, 'utf8')) : { enabled: false };
  if (hxCfg.enabled) {
    const extras = [
      ['抽屉热榜', fetchChoutiHot],
      ['小红书热榜', fetchXiaohongshuHot],
      ['NGA网事杂谈', fetchNgaWangshi],
    ];
    let hxN = 0;
    // HotExtras 按源抓全：勿复用 NewsNow perSource=15（抽屉热榜 API 一页约 25）
    const hxLimit = Math.max(50, Number(nnCfg.perSource) || 0);
    for (const [name, fn] of extras) {
      const r = await fn({ limit: hxLimit });
      if (!r.ok) {
        failures.push({ name, error: `extras:${r.error || 'fail'}` });
        continue;
      }
      items.push(...r.items);
      hxN += r.items.length;
    }
    console.log(`HotExtras 抓到 ${hxN} 条；失败记入 failures`);
  }

  const taxonomy = loadTaxonomy(ROOT);
  const classified = [];
  let skipNoCat = 0;
  for (const it of items) {
    try {
      const c = classifyItem(it, taxonomy);
      classified.push({
        title: it.title,
        link: it.link,
        desc: it.desc,
        source: it.source,
        ts: it.ts,
        categories: c.keys, // 老见报分类 key → ingest-map CATEGORY_TO_TAGS
        imageUrl: it.imgs && it.imgs[0] && it.imgs[0].url,
        channelAvatar: it.channelAvatar || it.publisherAvatar || '',
        contentType: it.contentType || it.content_type,
      });
    } catch {
      skipNoCat++;
    }
  }
  if (skipNoCat) console.log(`跳过未配 taxonomy 的源条目：${skipNoCat}`);

  // publisher 用每条 raw.source（feed/榜单名），勿写死 main-source——
  // 否则内容包按「机器之心」等芯片过滤时永远匹配不到。
  const mapped = mapFeedItems(classified, {
    sourceId: MAIN_SOURCE_ID,
    allowSnippet: true,
    allowImage: true,
    rightsStatus: 'unknown',
    resolveTagId: (k) => tagIdByKey[k] || null,
  });
  console.log(
    `映射：rows=${mapped.rows.length} links=${mapped.links.length} skipped=${mapped.skipped}`,
    mapped.reasons,
  );

  // 每标签配额：按标签轮询挑满 perTag，避免全挤进 ai
  // 只跳过站内图包（见笑/见她/见闻）。movie 含 B站每周必看等 RSS，主抓取要收全；
  // 听乐看片配图仍由 ingest-visual-packs 另灌。
  const VISUAL_KEYS = new Set(['funny', 'portrait', 'sight']);
  const picked = [];
  const pickedIds = new Set();
  const countByTag = Object.fromEntries(Object.keys(tagIdByKey).map((k) => [k, 0]));
  const byTag = new Map();
  for (const row of mapped.rows) {
    for (const k of row.metadata.tag_keys || []) {
      if (VISUAL_KEYS.has(k)) continue;
      if (!byTag.has(k)) byTag.set(k, []);
      byTag.get(k).push(row);
    }
  }
  // 按 publisher 轮询取满 perTag；内容包芯片名 / NewsNow 白名单优先，
  // 否则 Map 插入顺序下「联合早报」等先占满 24 格，B站/头条永远分不到。
  const preferPubs = new Set([
    ...(nnCfg.sources || []).map((s) => String(s.name || '')),
    '百度热搜', '微博热搜', '知乎热榜', '抖音热榜', '今日头条热榜', 'B站热搜',
    '抽屉热榜', '小红书热榜', 'NGA网事杂谈', '快手热榜',
    'GitHub趋势', 'AIHOT精选', 'AI前线', '机器之心', '新智元', '量子位',
    '晚点LatePost', 'APPSO',
    // HotExtras 配置名也进优先队列（与上面硬编码互补）
    ...(hxCfg.sources || []).map((s) => String(s.name || '')),
    // 格式白名单（带 contentType 的 feed）优先占格，避免被话痨源挤成「版块空」
    ...(cfg.feeds || [])
      .filter((f) => f && f.contentType)
      .map((f) => String(f.name || '')),
  ].filter(Boolean));
  const queues = new Map();
  for (const [k, list] of byTag) {
    const byPub = new Map();
    for (const row of list) {
      const pub = String(row.metadata?.publisher || row.metadata?.ingested_by || 'RSS');
      if (!byPub.has(pub)) byPub.set(pub, []);
      byPub.get(pub).push(row);
    }
    const ordered = [...byPub.entries()].sort((a, b) => {
      const pa = preferPubs.has(a[0]) ? 0 : 1;
      const pb = preferPubs.has(b[0]) ? 0 : 1;
      return pa - pb || a[0].localeCompare(b[0], 'zh');
    });
    queues.set(k, ordered.map(([, rows]) => rows));
  }
  const takeOne = (k, q) => {
    while (q.length) {
      const row = q.shift();
      if (pickedIds.has(row.id)) continue;
      pickedIds.add(row.id);
      picked.push(row);
      for (const tk of row.metadata.tag_keys || []) {
        countByTag[tk] = (countByTag[tk] || 0) + 1;
      }
      return true;
    }
    return false;
  };
  // Pass 0：流水白名单（board/wire/media）按源 dailyCap 收满，不受 preferCap 截断
  const pipeCaps = pipelinePublisherCaps();
  for (const [k, pubLists] of queues) {
    for (const q of pubLists) {
      const pub = String(q[0]?.metadata?.publisher || '');
      const cap = pipeCaps.get(pub);
      if (!cap) continue;
      let n = 0;
      while (n < cap && (countByTag[k] || 0) < perTag && takeOne(k, q)) n++;
    }
  }
  // Pass 1：其余优先源打底（门户演示另截 3 条）
  const preferCap = 8;
  for (const [k, pubLists] of queues) {
    for (const q of pubLists) {
      const pub = String(q[0]?.metadata?.publisher || '');
      if (pipeCaps.has(pub)) continue; // 已在 pass 0 处理
      let n = 0;
      while (n < preferCap && (countByTag[k] || 0) < perTag && takeOne(k, q)) n++;
    }
  }
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [k, pubLists] of queues) {
      if ((countByTag[k] || 0) >= perTag) continue;
      for (const q of pubLists) {
        if ((countByTag[k] || 0) >= perTag) break;
        if (takeOne(k, q)) progressed = true;
      }
    }
  }

  const linkByItem = new Map();
  for (const l of mapped.links) {
    if (!pickedIds.has(l.content_item_id)) continue;
    if (!linkByItem.has(l.content_item_id)) linkByItem.set(l.content_item_id, []);
    linkByItem.get(l.content_item_id).push(l);
  }

  console.log('配额后：', picked.length, '条；按标签', JSON.stringify(countByTag));

  if (dry) {
    console.log('[dry-run] 示例：', picked.slice(0, 3).map((r) => ({
      title: r.title, tags: r.metadata.tag_keys, url: r.canonical_url,
    })));
    return;
  }

  // 已有 hash 跳过（幂等）。PostgREST 默认 max-rows≈1000，必须翻页，
  // 否则会把已存在行当成「新插」生成新 id，content_tags FK 必炸。
  const have = new Set();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const existing = await admin.select('content_items', {
      columns: 'content_hash',
      filters: [{ col: 'source_id', op: 'eq', value: MAIN_SOURCE_ID }],
      limit: PAGE,
      offset,
    });
    for (const r of existing) if (r.content_hash) have.add(r.content_hash);
    if (existing.length < PAGE) break;
  }
  const fresh = picked.filter((r) => !have.has(r.content_hash));
  console.log(`已有 ${have.size}，本次新插 ${fresh.length}`);

  function toRow(r) {
    return {
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
    };
  }
  const okIds = new Set();
  async function insertRows(rows) {
    if (!rows.length) return 0;
    try {
      await admin.insert('content_items', rows, { returnMinimal: true });
      for (const row of rows) okIds.add(row.id);
      return rows.length;
    } catch (e) {
      // 批量偶发 400（个别 Twitter 摘要脏字符）→ 逐条兜底，坏摘要置空再试
      let n = 0;
      for (const row of rows) {
        try {
          await admin.insert('content_items', [row], { returnMinimal: true });
          okIds.add(row.id);
          n++;
        } catch {
          try {
            await admin.insert('content_items', [{ ...row, summary: null }], { returnMinimal: true });
            okIds.add(row.id);
            n++;
          } catch (e2) {
            // 已存在：库内是旧 id，不能用本次新 id 挂 tags
            if (/duplicate key|409/.test(String(e2.message || e2))) continue;
            console.warn('  ! 跳过插入', row.metadata?.publisher, String(row.title || '').slice(0, 24), e2.message);
          }
        }
      }
      return n;
    }
  }
  let inserted = 0;
  for (let i = 0; i < fresh.length; i += 50) {
    inserted += await insertRows(fresh.slice(i, i + 50).map(toRow));
  }

  const tagRows = [];
  for (const r of fresh) {
    if (!okIds.has(r.id)) continue;
    for (const l of linkByItem.get(r.id) || []) tagRows.push(l);
  }
  for (let i = 0; i < tagRows.length; i += 100) {
    const batch = tagRows.slice(i, i + 100);
    try {
      await admin.upsert('content_tags', batch, 'content_item_id,tag_pack_id');
    } catch (e) {
      // 逐条兜底，避免一坏批拖死整轮
      for (const row of batch) {
        try {
          await admin.upsert('content_tags', [row], 'content_item_id,tag_pack_id');
        } catch (e2) {
          console.warn('  ! 跳过 content_tags', row.content_item_id, e2.message);
        }
      }
    }
  }

  // 汇总
  const allTags = await admin.select('content_tags', { columns: 'tag_pack_id', limit: 5000 });
  const allItems = await admin.select('content_items', { columns: 'id', limit: 1, head: false });
  const packCount = {};
  for (const t of allTags) {
    const key = packs.find((p) => p.id === t.tag_pack_id)?.key || t.tag_pack_id;
    packCount[key] = (packCount[key] || 0) + 1;
  }
  console.log(`完成：新插 content_items=${inserted} content_tags=${tagRows.length}`);
  console.log('各包标签计数：', JSON.stringify(packCount));
  console.log('content_items 抽样可读（publishable 可见）');
  void allItems;
  void sqlEsc;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
