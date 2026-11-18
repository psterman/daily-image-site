#!/usr/bin/env node
/**
 * 从 rss.config + news-taxonomy + NewsNow 热榜 生成完整源目录。
 *
 *   node tools/build-source-catalog.mjs
 *
 * 产物：
 *   lib/source-catalog-data.mjs  —— 门户 / tag-options 合并用
 *   tools/source-catalog.json    —— 人读 / 排查
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSourceCatalogEntries,
  groupSourcesByPack,
  domainForSource,
} from '../lib/source-catalog.mjs';
import { curatedSourcesForTag } from '../lib/tag-options.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RSS = path.join(__dirname, 'rss.config.json');
const TAX = path.join(__dirname, 'news-taxonomy.json');
const NEWSNOW = path.join(__dirname, 'newsnow.config.json');
const OUT_JSON = path.join(__dirname, 'source-catalog.json');
const OUT_MJS = path.join(ROOT, 'lib/source-catalog-data.mjs');

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function main() {
  const rss = loadJson(RSS, { feeds: [] });
  const tax = loadJson(TAX, { sourceCategory: {} });
  const nn = loadJson(NEWSNOW, { sources: [] });

  /** NewsNow + 热议精选：无 RSS URL 也要进完整目录 */
  const extras = [];
  const seen = new Set();
  for (const s of nn.sources || []) {
    const name = String(s.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    extras.push({
      name,
      url: '',
      taxonomy: String(s.category || 'hot'),
      contentType: 'article',
    });
  }
  for (const s of curatedSourcesForTag('hot')) {
    if (!s?.name || seen.has(s.name)) continue;
    seen.add(s.name);
    extras.push({
      name: s.name,
      url: s.domain ? `https://${String(s.domain).replace(/\/.*$/, '')}/` : '',
      taxonomy: 'hot',
      contentType: 'article',
    });
  }

  // 确保 taxonomy.sourceCategory 里的热议名也有图标域名
  for (const [name, cat] of Object.entries(tax.sourceCategory || {})) {
    if (cat !== 'hot' || seen.has(name)) continue;
    seen.add(name);
    extras.push({ name, url: '', taxonomy: 'hot', contentType: 'article' });
  }

  const entries = buildSourceCatalogEntries({
    feeds: rss.feeds || [],
    sourceCategory: tax.sourceCategory || {},
    extras,
  });

  // 热议源强制用官方域图标
  for (const e of entries) {
    if (e.taxonomy === 'hot') e.domain = domainForSource(e.name, e.url);
  }

  const byPack = groupSourcesByPack(entries);
  const counts = {
    total: entries.length,
    byTaxonomy: {},
    byFormat: {},
    byPack: {},
  };
  for (const e of entries) {
    counts.byTaxonomy[e.taxonomy] = (counts.byTaxonomy[e.taxonomy] || 0) + 1;
    counts.byFormat[e.contentType] = (counts.byFormat[e.contentType] || 0) + 1;
  }
  for (const [k, list] of Object.entries(byPack)) counts.byPack[k] = list.length;

  const json = {
    generatedAt: new Date().toISOString(),
    counts,
    entries,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(json, null, 2) + '\n', 'utf8');

  const mjs =
    '/** 由 tools/build-source-catalog.mjs 生成 — 勿手改 */\n' +
    'export const SOURCE_CATALOG_GENERATED_AT = ' +
    JSON.stringify(json.generatedAt) +
    ';\n' +
    'export const SOURCE_CATALOG = Object.freeze(' +
    JSON.stringify(entries) +
    ');\n' +
    'export const SOURCES_BY_PACK = Object.freeze(' +
    JSON.stringify(byPack) +
    ');\n' +
    'export function sourcesForPackFromCatalog(packKey) {\n' +
    '  const list = SOURCES_BY_PACK[packKey];\n' +
    '  return Array.isArray(list) ? list.map((s) => ({ name: s.name, domain: s.domain })) : [];\n' +
    '}\n';
  fs.writeFileSync(OUT_MJS, mjs, 'utf8');

  console.log(
    JSON.stringify(
      { wrote: [path.relative(ROOT, OUT_JSON), path.relative(ROOT, OUT_MJS)], ...counts },
      null,
      2,
    ),
  );
}

main();
