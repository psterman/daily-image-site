#!/usr/bin/env node
/**
 * 只灌 HotExtras（小红书 / 抽屉 / NGA网事杂谈）进共享池。
 * 全量 ingest-platform 太重；补洞源漏灌时用本脚本。
 *
 *   node tools/ingest-hot-extras.mjs
 *   node tools/ingest-hot-extras.mjs --dry-run
 *   node tools/ingest-hot-extras.mjs --only xiaohongshu
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../lib/sb-client.mjs';
import { mapFeedItems } from '../lib/ingest-map.mjs';
import { loadTaxonomy, classifyItem } from './news-taxonomy.mjs';
import { fetchChoutiHot, fetchXiaohongshuHot, fetchNgaWangshi } from './fetch-hot-extras.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAIN_SOURCE_ID = '74d9887f-a1d4-4e26-92c2-4005e8829c21';
const HOT_TAG_ID = '02f61234-1ce4-4785-818e-9843fc379400'; // platform.tag_packs.key=hot

const FETCHERS = {
  xiaohongshu: ['小红书热榜', fetchXiaohongshuHot],
  chouti: ['抽屉热榜', fetchChoutiHot],
  nga: ['NGA网事杂谈', fetchNgaWangshi],
};

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

async function main() {
  const dry = process.argv.includes('--dry-run');
  const only = String(arg('--only', '') || '').trim();
  const limit = Math.max(1, Number(arg('--limit', '15')) || 15);

  const env = loadEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  }

  const admin = createClient({
    url: env.SUPABASE_URL,
    key: env.SUPABASE_SERVICE_ROLE_KEY,
    schema: 'platform',
    timeout: 20000,
  });

  const packs = await admin.select('tag_packs', {
    columns: 'id,key',
    filters: [{ col: 'status', op: 'eq', value: 'active' }],
  });
  const tagIdByKey = Object.fromEntries(packs.map((p) => [p.key, p.id]));
  if (!tagIdByKey.hot) tagIdByKey.hot = HOT_TAG_ID;

  const taxonomy = loadTaxonomy(ROOT);
  const pick = only
    ? Object.entries(FETCHERS).filter(([id]) => id === only)
    : Object.entries(FETCHERS);
  if (!pick.length) throw new Error(`未知 --only ${only}`);

  const items = [];
  const failures = [];
  for (const [id, [name, fn]] of pick) {
    const r = await fn({ limit });
    if (!r.ok || !r.items.length) {
      failures.push({ id, name, error: r.error || 'empty' });
      console.log(`! ${name}: ${r.error || 'empty'}`);
      continue;
    }
    console.log(`✓ ${name}: ${r.items.length}`);
    items.push(...r.items);
  }

  const classified = [];
  let skipNoCat = 0;
  for (const it of items) {
    try {
      const c = classifyItem(it, taxonomy);
      classified.push({
        title: it.title,
        link: it.link,
        desc: it.desc || it.heat || '',
        source: it.source,
        ts: it.ts,
        categories: c.keys,
      });
    } catch {
      skipNoCat++;
    }
  }
  if (skipNoCat) console.log(`跳过未配 taxonomy：${skipNoCat}`);

  const mapped = mapFeedItems(classified, {
    sourceId: MAIN_SOURCE_ID,
    allowSnippet: true,
    allowImage: false,
    rightsStatus: 'unknown',
    resolveTagId: (k) => tagIdByKey[k] || null,
  });
  console.log(`映射 rows=${mapped.rows.length} links=${mapped.links.length}`, mapped.reasons);

  if (dry) {
    console.log('[dry-run]', mapped.rows.slice(0, 3).map((r) => ({
      title: r.title, pub: r.metadata.publisher, tags: r.metadata.tag_keys, url: r.canonical_url,
    })));
    return;
  }

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

  const fresh = mapped.rows.filter((r) => !have.has(r.content_hash));
  console.log(`已有 hash ${have.size}，本次新插 ${fresh.length}`);

  const okIds = new Set();
  for (const row of fresh) {
    const payload = {
      id: row.id,
      source_id: row.source_id,
      canonical_url: row.canonical_url,
      content_hash: row.content_hash,
      content_type: row.content_type,
      title: row.title,
      summary: row.summary,
      author: row.author,
      image_url: null,
      published_at: row.published_at,
      language: row.language,
      rights_status: row.rights_status,
      license: row.license,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    try {
      await admin.insert('content_items', [payload], { returnMinimal: true });
      okIds.add(row.id);
    } catch (e) {
      if (/duplicate key|409/.test(String(e.message || e))) continue;
      try {
        await admin.insert('content_items', [{ ...payload, summary: null }], { returnMinimal: true });
        okIds.add(row.id);
      } catch (e2) {
        console.warn('  ! 跳过', row.metadata?.publisher, String(row.title || '').slice(0, 24), e2.message);
      }
    }
  }

  const linkByItem = new Map();
  for (const l of mapped.links) {
    if (!linkByItem.has(l.content_item_id)) linkByItem.set(l.content_item_id, []);
    linkByItem.get(l.content_item_id).push(l);
  }
  let tagN = 0;
  for (const id of okIds) {
    for (const l of linkByItem.get(id) || []) {
      try {
        await admin.upsert('content_tags', [l], 'content_item_id,tag_pack_id');
        tagN++;
      } catch (e) {
        console.warn('  ! tag', id, e.message);
      }
    }
  }

  console.log(`完成：items=${okIds.size} tags=${tagN} failures=${failures.length}`);
  for (const f of failures) console.log(`  ! ${f.name}: ${f.error}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
