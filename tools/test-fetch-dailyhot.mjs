/**
 * DailyHot 配置 + 抓取形状自检（网络探针一条；失败则整文件非零退出）。
 */
import { loadDailyhotConfig, fetchOneDailyhot, fetchDailyhotHeadlines } from './fetch-dailyhot.mjs';
import { loadTaxonomy } from './news-taxonomy.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

const cfg = loadDailyhotConfig();
const tax = loadTaxonomy(ROOT);
const keys = new Set(tax.categories.map((c) => c.key));

check('enabled', cfg.enabled === true);
check('有 baseUrl', !!cfg.baseUrl);
check('白名单非空', (cfg.sources || []).length >= 5, cfg.sources?.length);
check('源 id/name 齐全', (cfg.sources || []).every((s) => s.id && s.name && s.category));
check('category 都在 taxonomy', (cfg.sources || []).every((s) => keys.has(s.category)),
  (cfg.sources || []).filter((s) => !keys.has(s.category)).map((s) => s.name));
check('sourceCategory 已登记', (cfg.sources || []).every((s) => tax.sourceCategory[s.name] === s.category),
  (cfg.sources || []).filter((s) => tax.sourceCategory[s.name] !== s.category).map((s) => s.name));

const probeId = cfg.sources?.[0]?.id || 'kuaishou';
const one = await fetchOneDailyhot(cfg.baseUrl, probeId, { timeoutMs: cfg.timeoutMs });
if (one.ok && one.items.length > 0) {
  check(`探针 ${probeId} 通`, true);
  const { items, failures } = await fetchDailyhotHeadlines({
    ...cfg,
    sources: cfg.sources.slice(0, 2),
    perSource: 3,
  });
  check('fetchHeadlines 有条目', items.length > 0, { n: items.length, failures });
  check('条目含 title/link/source', items.every((it) => it.title && it.link && it.source));
} else {
  // 公共镜像常挂/限流；配置与映射仍必须绿。自建 DAILYHOT_BASE_URL 后再强依赖网络。
  check('探针失败可接受（公共镜像挂/限流）', one.status === 403 || one.status === 429 || one.status === 500 || one.status === 0,
    { status: one.status, err: one.error });
  console.log('  · 跳过实抓断言；生产请自建 DailyHotApi 并设 DAILYHOT_BASE_URL');
}

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail === 0 ? 0 : 1);
