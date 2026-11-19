#!/usr/bin/env node
/**
 * repair-shared-pool.mjs —— 修复共享池乱码包名 / 主源名 / 标题摘要，并补远程配图 URL
 *
 * 原因：早期 Windows 环境写入把中文落成字面量 "?"；RSS 现已能正确解析 UTF-8。
 * 本脚本用 service_role：按 canonical_url 对齐现网 RSS，覆写坏标题；CORE 覆盖 tag_packs。
 *
 *   node tools/repair-shared-pool.mjs
 *   node tools/repair-shared-pool.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../lib/sb-client.mjs';
import { CORE_TAG_PACKS } from '../lib/platform-model.mjs';
import { mapFeedItems, isGarbledText, matchKeywords } from '../lib/ingest-map.mjs';
import { fetchHeadlines, loadConfig } from './fetch-rss.mjs';
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

function normUrl(u) {
  return String(u || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const env = loadEnv();
  const admin = createClient({
    url: env.SUPABASE_URL,
    key: env.SUPABASE_SERVICE_ROLE_KEY,
    schema: 'platform',
  });

  // 1) 同步标签包目录：缺的插入（如 hot），旧的改名/改 group_name
  const packs = await admin.select('tag_packs');
  let packFixed = 0;
  let packInserted = 0;
  const missing = [];
  for (const p of CORE_TAG_PACKS) {
    const row = packs.find((x) => x.key === p.key);
    if (!row) {
      missing.push(p);
      continue;
    }
    if (row.name === p.name && row.description === p.description && row.group_name === p.group_name) continue;
    packFixed++;
    if (!dry) {
      await admin.update('tag_packs', {
        name: p.name,
        description: p.description,
        group_name: p.group_name,
        risk_level: p.risk_level,
        status: 'active',
        updated_at: new Date().toISOString(),
      }, { filters: [{ col: 'key', op: 'eq', value: p.key }] });
    }
  }
  if (missing.length) {
    packInserted = missing.length;
    if (!dry) {
      await admin.upsert(
        'tag_packs',
        missing.map((p) => ({
          key: p.key,
          name: p.name,
          description: p.description || '',
          group_name: p.group_name,
          risk_level: p.risk_level,
          status: 'active',
        })),
        'key',
      );
      // 挂到主源编辑池
      const fresh = await admin.select('tag_packs');
      const main = (await admin.select('sources', {
        filters: [{ col: 'id', op: 'eq', value: MAIN_SOURCE_ID }],
      }))[0];
      if (main) {
        const links = fresh
          .filter((t) => missing.some((m) => m.key === t.key))
          .map((t) => ({ tag_pack_id: t.id, source_id: main.id, weight: 100 }));
        if (links.length) await admin.upsert('tag_pack_sources', links, 'tag_pack_id,source_id');
      }
    }
  }
  console.log(`tag_packs 修复 ${packFixed} · 新插 ${packInserted} · 期望 ${CORE_TAG_PACKS.length}`);
  if (missing.length) console.log('  新包:', missing.map((p) => p.key).join(', '));

  // 2) 修主源名 + 允许索引远程图 URL（不转存）
  if (!dry) {
    await admin.update('sources', {
      name: '主源编辑池',
      allow_image: true,
      updated_at: new Date().toISOString(),
    }, { filters: [{ col: 'id', op: 'eq', value: MAIN_SOURCE_ID }] });
  }
  console.log('sources 主源名/allow_image 已更新');

  // 3) 现网抓取 → 按 URL 覆写坏标题/摘要，补 image_url
  const cfg = loadConfig();
  cfg.maxItems = 160;
  cfg.perFeed = Math.min(Number(cfg.perFeed) || 6, 10);
  const { items } = await fetchHeadlines(cfg);
  const taxonomy = loadTaxonomy(ROOT);
  const classified = [];
  for (const it of items) {
    try {
      const c = classifyItem(it, taxonomy);
      classified.push({
        title: it.title,
        link: it.link,
        desc: it.desc,
        source: it.source,
        ts: it.ts,
        categories: c.keys,
        imageUrl: it.imgs && it.imgs[0] && it.imgs[0].url,
        channelAvatar: it.channelAvatar || '',
      });
    } catch { /* skip */ }
  }
  const mapped = mapFeedItems(classified, {
    sourceId: MAIN_SOURCE_ID,
    allowSnippet: true,
    allowImage: true,
    rightsStatus: 'unknown',
    publisher: 'main-source',
  });
  const byUrl = new Map();
  for (const r of mapped.rows) byUrl.set(normUrl(r.canonical_url), r);

  const existing = await admin.select('content_items', {
    columns: 'id,title,summary,canonical_url,image_url',
    filters: [{ col: 'source_id', op: 'eq', value: MAIN_SOURCE_ID }],
    limit: 5000,
  });

  let repaired = 0;
  let imaged = 0;
  for (const ex of existing) {
    const fresh = byUrl.get(normUrl(ex.canonical_url));
    if (!fresh) continue;
    const titleBad = isGarbledText(ex.title) || isGarbledText(ex.summary);
    const needImg = !ex.image_url && fresh.image_url;
    if (!titleBad && !needImg) continue;
    const patch = { updated_at: new Date().toISOString() };
    if (titleBad) {
      patch.title = fresh.title;
      patch.summary = fresh.summary;
      repaired++;
    }
    if (needImg) {
      patch.image_url = fresh.image_url;
      imaged++;
    }
    if (!dry) {
      await admin.update('content_items', patch, {
        filters: [{ col: 'id', op: 'eq', value: ex.id }],
      });
    }
  }

  // RSS 没命中时：对仍乱码的条目抓原页 og:title / og:description / og:image
  let ogFixed = 0;
  const stillBad = (await admin.select('content_items', {
    columns: 'id,title,summary,canonical_url,image_url',
    filters: [{ col: 'source_id', op: 'eq', value: MAIN_SOURCE_ID }],
    limit: 5000,
  })).filter((ex) => isGarbledText(ex.title));
  for (const ex of stillBad) {
    const meta = await fetchOg(ex.canonical_url);
    if (!meta || !meta.title || isGarbledText(meta.title)) continue;
    const patch = {
      title: meta.title.slice(0, 200),
      summary: meta.desc ? meta.desc.slice(0, 160) : ex.summary,
      updated_at: new Date().toISOString(),
    };
    if (!ex.image_url && meta.image) patch.image_url = meta.image;
    ogFixed++;
    if (!dry) {
      await admin.update('content_items', patch, {
        filters: [{ col: 'id', op: 'eq', value: ex.id }],
      });
    }
  }

  console.log(`content_items 标题修复 ${repaired}，配图补链 ${imaged}，og 回填 ${ogFixed}${dry ? ' (dry-run)' : ''}`);
  console.log(`对照池可读条目 ${mapped.rows.length}；库内 ${existing.length}`);

  // 4) 清掉错挂到人像美学的标签（强制 TagKey / 过宽关键词「街头」遗留）
  const portraitPack = packs.find((p) => p.key === 'portrait');
  let portraitCleared = 0;
  if (portraitPack) {
    const pTags = await admin.select('content_tags', {
      filters: [{ col: 'tag_pack_id', op: 'eq', value: portraitPack.id }],
      limit: 5000,
    });
    const allItems = await admin.select('content_items', {
      columns: 'id,title,summary,metadata',
      limit: 5000,
    });
    const byId = Object.fromEntries(allItems.map((i) => [i.id, i]));
    for (const link of pTags) {
      const item = byId[link.content_item_id];
      if (!item) continue;
      const text = `${item.title || ''} ${item.summary || ''}`;
      const still = matchKeywords(text).includes('portrait');
      if (still) continue;
      portraitCleared++;
      if (!dry) {
        await admin.delete('content_tags', {
          filters: [
            { col: 'content_item_id', op: 'eq', value: link.content_item_id },
            { col: 'tag_pack_id', op: 'eq', value: portraitPack.id },
          ],
        });
        const keys = Array.isArray(item.metadata?.tag_keys)
          ? item.metadata.tag_keys.filter((k) => k !== 'portrait')
          : [];
        await admin.update('content_items', {
          metadata: { ...(item.metadata || {}), tag_keys: keys },
          updated_at: new Date().toISOString(),
        }, { filters: [{ col: 'id', op: 'eq', value: item.id }] });
      }
    }
  }
  console.log(`portrait 错标清理 ${portraitCleared}${dry ? ' (dry-run)' : ''}`);
}

async function fetchOg(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; platform-repair/1.0)' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const pick = (prop) => {
      const re = new RegExp(
        `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
        'i',
      );
      const re2 = new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`,
        'i',
      );
      const m = re.exec(html) || re2.exec(html);
      return m ? decodeHtml(m[1]).trim() : '';
    };
    const title = pick('og:title') || (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
    const desc = pick('og:description');
    const image = pick('og:image');
    return {
      title: decodeHtml(title).replace(/\s*[·|].*$/, '').trim(),
      desc: decodeHtml(desc),
      image: /^https?:\/\//i.test(image) ? image : '',
    };
  } catch {
    return null;
  }
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; }
    });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
