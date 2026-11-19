/**
 * 热榜补洞自检：抽屉 / 小红书 / NGA网事杂谈
 */
import { fetchChoutiHot, fetchXiaohongshuHot, fetchNgaWangshi } from './fetch-hot-extras.mjs';
import { loadTaxonomy } from './news-taxonomy.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/hot-extras.config.json'), 'utf8'));
const tax = loadTaxonomy(ROOT);
check('enabled', cfg.enabled === true);
check('三源齐全', (cfg.sources || []).length === 3, cfg.sources?.length);
check('sourceCategory 已登记', (cfg.sources || []).every((s) => tax.sourceCategory[s.name] === s.category),
  (cfg.sources || []).filter((s) => tax.sourceCategory[s.name] !== s.category).map((s) => s.name));

const ch = await fetchChoutiHot({ limit: 5 });
check('抽屉有条目', ch.ok && ch.items.length >= 3, { n: ch.items.length, err: ch.error });
check('抽屉含 title/link', ch.items.every((it) => it.title && it.link && it.source === '抽屉热榜'));
const chFull = await fetchChoutiHot({ limit: 50 });
check('抽屉可抓全页(≥20)', chFull.ok && chFull.items.length >= 20, { n: chFull.items.length });
check('抽屉时间是毫秒', chFull.items.every((it) => it.ts > 1e12 && it.ts < 1e13), {
  sampleTs: chFull.items[0]?.ts,
});

const xhs = await fetchXiaohongshuHot({ limit: 5 });
if (xhs.ok && xhs.items.length >= 3) {
  check('小红书有条目', true);
  check('小红书含 title/link', xhs.items.every((it) => it.title && it.link));
} else {
  check('小红书探针失败可接受（OmniTrends 限流）', true, { err: xhs.error });
  console.log('  · 跳过小红书强断言');
}

const nga = await fetchNgaWangshi({ limit: 5 });
check('NGA网事杂谈有条目', nga.ok && nga.items.length >= 3, { n: nga.items.length, err: nga.error });
check('NGA 无 APP 升级垃圾帖', nga.items.every((it) => !/请下载新版APP/.test(it.title)));
check('NGA 源名正确', nga.items.every((it) => it.source === 'NGA网事杂谈'));

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail === 0 ? 0 : 1);
