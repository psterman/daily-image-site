#!/usr/bin/env node
/**
 * 统计「源 → 标题/摘要」覆盖率（抓取面 + 可选库内）。
 *
 *   node tools/report-ingest-coverage.mjs
 *   node tools/report-ingest-coverage.mjs --skip-fetch   # 只查库
 *   node tools/report-ingest-coverage.mjs --max-items 800
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { loadConfig, fetchHeadlines } from './fetch-rss.mjs';
import { createClient } from '../lib/sb-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '.cache');
const OUT_JSON = path.join(OUT_DIR, 'ingest-coverage.json');
const OUT_MD = path.join(OUT_DIR, 'ingest-coverage.md');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v == null || v.startsWith('-') ? fallback : v;
}

function hasText(s) {
  return String(s || '').trim().length > 0;
}

async function main() {
  const skipFetch = process.argv.includes('--skip-fetch');
  const cfg = loadConfig();
  const maxItems = Math.max(10, Number(arg('--max-items', String(cfg.maxItems || 2670))) || 2670);
  cfg.maxItems = maxItems;
  cfg.concurrency = Math.max(1, Number(arg('--concurrency', '20')) || 20);

  const feedNames = (cfg.feeds || []).map((f) => f.name || f.url);
  const byFeed = Object.fromEntries(
    feedNames.map((n) => [n, { name: n, items: 0, withTitle: 0, withSummary: 0, withBoth: 0 }]),
  );

  let fetchMeta = { skipped: true, items: 0, failures: [], stale: [] };
  if (!skipFetch) {
    console.log(`抓取 ${cfg.feeds?.length || 0} 源（maxItems=${maxItems}）…`);
    const r = await fetchHeadlines(cfg);
    fetchMeta = {
      skipped: false,
      items: r.items.length,
      failures: r.failures || [],
      stale: r.stale || [],
    };
    for (const it of r.items) {
      const n = it.source || '';
      if (!byFeed[n]) {
        byFeed[n] = { name: n, items: 0, withTitle: 0, withSummary: 0, withBoth: 0 };
      }
      const row = byFeed[n];
      row.items++;
      const t = hasText(it.title);
      const s = hasText(it.desc);
      if (t) row.withTitle++;
      if (s) row.withSummary++;
      if (t && s) row.withBoth++;
    }
    console.log(
      `抓到 ${r.items.length} 条；失败源 ${r.failures.length}；过期丢弃源 ${r.stale.length}`,
    );
  }

  const feedStats = Object.values(byFeed).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const feedsWithItems = feedStats.filter((f) => f.items > 0);
  const feedsWithBoth = feedStats.filter((f) => f.withBoth > 0);
  const feedsEmpty = feedStats.filter((f) => f.items === 0);
  const failNames = new Set((fetchMeta.failures || []).map((f) => f.name));

  let db = null;
  const env = loadEnv();
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const admin = createClient({
        url: env.SUPABASE_URL,
        key: env.SUPABASE_SERVICE_ROLE_KEY,
        schema: 'platform',
      });
      const items = await admin.select('content_items', {
        columns: 'id,title,summary,canonical_url,content_type,metadata,published_at',
        limit: 5000,
      });
      let withTitle = 0;
      let withSummary = 0;
      let withBoth = 0;
      const byPub = {};
      for (const it of items || []) {
        const t = hasText(it.title);
        const s = hasText(it.summary);
        if (t) withTitle++;
        if (s) withSummary++;
        if (t && s) withBoth++;
        const pub = String(it.metadata?.publisher || 'unknown');
        if (!byPub[pub]) byPub[pub] = { n: 0, both: 0 };
        byPub[pub].n++;
        if (t && s) byPub[pub].both++;
      }
      db = {
        total: (items || []).length,
        withTitle,
        withSummary,
        withBoth,
        publishers: Object.keys(byPub).length,
        publishersWithBoth: Object.values(byPub).filter((x) => x.both > 0).length,
      };
      console.log(
        `库内 content_items=${db.total} 标题+摘要=${db.withBoth} 发布源=${db.publishersWithBoth}/${db.publishers}`,
      );
    } catch (e) {
      console.warn('! 读库失败', e.message || e);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    configFeeds: feedStats.length,
    fetch: {
      items: fetchMeta.items,
      failCount: (fetchMeta.failures || []).length,
      staleCount: (fetchMeta.stale || []).length,
      feedsWithItems: feedsWithItems.length,
      feedsWithTitleAndSummary: feedsWithBoth.length,
      feedsEmpty: feedsEmpty.length,
    },
    db,
    emptyFeeds: feedsEmpty.map((f) => f.name).slice(0, 80),
    failedFeeds: (fetchMeta.failures || []).slice(0, 40),
    sampleOk: feedsWithBoth.slice(0, 15).map((f) => ({
      name: f.name,
      items: f.items,
      withBoth: f.withBoth,
    })),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2) + '\n', 'utf8');

  const lines = [
    `# 灌池覆盖报告`,
    ``,
    `- 生成：${report.generatedAt}`,
    `- 配置源数：${report.configFeeds}`,
    `- 本轮条目：${report.fetch.items}`,
    `- 有货源：${report.fetch.feedsWithItems}`,
    `- **标题+摘要都有的源：${report.fetch.feedsWithTitleAndSummary}**`,
    `- 空源：${report.fetch.feedsEmpty}`,
    `- 抓取失败：${report.fetch.failCount}`,
    `- 过期丢弃源：${report.fetch.staleCount}`,
  ];
  if (db) {
    lines.push(
      `- 库内条目：${db.total}（标题+摘要 ${db.withBoth}）`,
      `- 库内发布源：${db.publishersWithBoth}/${db.publishers} 有标题+摘要`,
    );
  }
  lines.push(``, `## 结论`, ``);
  const ratio = report.configFeeds
    ? report.fetch.feedsWithTitleAndSummary / report.configFeeds
    : 0;
  if (ratio >= 0.5) {
    lines.push(
      `约 **${Math.round(ratio * 100)}%** 配置源本轮拿到了标题+摘要。其余多为失败/过期/无摘要源，属预期，不是「必须 100%」。`,
    );
  } else if (skipFetch) {
    lines.push(`未抓取（--skip-fetch）。见库内统计。`);
  } else {
    lines.push(
      `覆盖偏低（${Math.round(ratio * 100)}%）。若在 GitHub Actions（海外）跑，国内 RSS 失败会更多；本机/国内出口更稳。`,
    );
  }
  fs.writeFileSync(OUT_MD, lines.join('\n') + '\n', 'utf8');

  console.log('\n' + lines.join('\n'));
  console.log(`\n写了 ${path.relative(process.cwd(), OUT_JSON)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
