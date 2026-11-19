/**
 * 拉取综合热榜实况 → site/pack-hot-snapshot.js（预览页 file:// 可加载）
 *
 *   node tools/refresh-pack-preview-hot.mjs
 *
 * NewsNow / DailyHot / 抽屉·小红书·NGA网事杂谈（extras）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNewsnowConfig, fetchOneNewsnow } from './fetch-newsnow.mjs';
import { loadDailyhotConfig, fetchOneDailyhot } from './fetch-dailyhot.mjs';
import { fetchChoutiHot, fetchXiaohongshuHot, fetchNgaWangshi } from './fetch-hot-extras.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../site/pack-hot-snapshot.js');

const MAP = [
  { name: '微博热搜', newsnow: 'weibo', domain: 'weibo.com' },
  { name: '抖音热榜', newsnow: 'douyin', domain: 'douyin.com' },
  { name: '知乎热榜', newsnow: 'zhihu', domain: 'zhihu.com' },
  { name: '百度热搜', newsnow: 'baidu', domain: 'baidu.com' },
  { name: '今日头条热榜', newsnow: 'toutiao', domain: 'toutiao.com' },
  { name: 'B站热搜', newsnow: 'bilibili-hot-search', domain: 'bilibili.com' },
  { name: '虎扑步行街', newsnow: 'hupu', domain: 'hupu.com' },
  { name: '百度贴吧热议', newsnow: 'tieba', domain: 'tieba.baidu.com' },
  { name: 'V2EX', newsnow: 'v2ex', domain: 'v2ex.com' },
  { name: '快手热榜', dailyhot: 'kuaishou', domain: 'kuaishou.com' },
  { name: '小红书热榜', extra: 'xiaohongshu', domain: 'xiaohongshu.com' },
  { name: '抽屉热榜', extra: 'chouti', domain: 'dig.ichouti.cn' },
  { name: 'NGA网事杂谈', extra: 'nga', domain: 'nga.cn' },
];

const PER = 6;

function pickHeat(raw) {
  const info = String(raw?.extra?.info || '').trim();
  if (info) return info;
  const hover = String(raw?.extra?.hover || '').trim();
  const m = hover.match(/^([\d.]+\s*[万亿]?\s*(热度|热|讨论|评论|万热度))/);
  if (m) return m[1];
  if (raw?.hot != null && raw.hot !== '' && Number(raw.hot) > 0) return String(raw.hot);
  return '';
}

function pickSummary(raw) {
  const hover = String(raw?.extra?.hover || raw?.desc || raw?.description || '').trim().replace(/\s+/g, ' ');
  if (!hover) return '';
  return hover.length > 72 ? hover.slice(0, 72) + '…' : hover;
}

function normalize(raw, rank) {
  const title = String(raw.title || raw.name || '').trim();
  if (!title) return null;
  const heat = pickHeat(raw);
  const summary = pickSummary(raw);
  return {
    t: title,
    s: summary || (heat ? heat : `热榜第 ${rank} 名`),
    heat: heat || `#${rank}`,
    rank,
    url: String(raw.url || raw.mobileUrl || raw.link || ''),
  };
}

function fromExtraItems(items, limit) {
  return items.slice(0, limit).map((it, i) => ({
    t: it.title,
    s: it.desc || it.heat || `热榜第 ${i + 1} 名`,
    heat: it.heat || `#${i + 1}`,
    rank: i + 1,
    url: it.link,
  }));
}

async function main() {
  const nnCfg = loadNewsnowConfig();
  const dhCfg = loadDailyhotConfig();
  const bySource = {};
  const failures = [];

  for (const src of MAP) {
    let channel = '';
    let items = [];
    let error = '';

    if (src.newsnow) {
      channel = 'newsnow';
      const r = await fetchOneNewsnow(nnCfg.baseUrl, src.newsnow, { timeoutMs: nnCfg.timeoutMs || 12000 });
      if (!r.ok) error = r.error || 'fail';
      else {
        let rank = 0;
        for (const raw of r.items || []) {
          if (items.length >= PER) break;
          rank += 1;
          const it = normalize(raw, rank);
          if (it) items.push(it);
        }
      }
    } else if (src.dailyhot) {
      channel = 'dailyhot';
      const r = await fetchOneDailyhot(dhCfg.baseUrl, src.dailyhot, { timeoutMs: dhCfg.timeoutMs || 12000 });
      if (!r.ok) error = r.error || 'fail';
      else {
        let rank = 0;
        for (const raw of r.items || []) {
          if (items.length >= PER) break;
          rank += 1;
          const it = normalize(raw, rank);
          if (it) items.push(it);
        }
      }
    } else if (src.extra === 'chouti') {
      channel = 'chouti';
      const r = await fetchChoutiHot({ limit: PER });
      if (!r.ok) error = r.error || 'fail';
      else items = fromExtraItems(r.items, PER);
    } else if (src.extra === 'xiaohongshu') {
      channel = 'omni-xiaohongshu';
      const r = await fetchXiaohongshuHot({ limit: PER });
      if (!r.ok) error = r.error || 'fail';
      else items = fromExtraItems(r.items, PER);
    } else if (src.extra === 'nga') {
      channel = 'nga-wangshi';
      const r = await fetchNgaWangshi({ limit: PER });
      if (!r.ok) error = r.error || 'fail';
      else items = fromExtraItems(r.items, PER);
    }

    if (!items.length) {
      failures.push({ name: src.name, channel, error: error || 'empty' });
      bySource[src.name] = { domain: src.domain, live: false, channel, error: error || 'empty', items: [] };
      continue;
    }
    bySource[src.name] = { domain: src.domain, live: true, channel, error: '', items };
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    newsnowBase: nnCfg.baseUrl,
    dailyhotBase: dhCfg.baseUrl,
    note: '小红书←OmniTrends；抽屉←ichouti；NGA←网事杂谈向版块（非全站游戏热帖）；已撤豆瓣小组脏源',
    bySource,
    failures,
  };

  const body =
    '/* auto-generated by tools/refresh-pack-preview-hot.mjs — do not edit */\n' +
    'window.PACK_HOT = ' + JSON.stringify(payload, null, 2) + ';\n';
  fs.writeFileSync(OUT, body, 'utf8');

  const liveN = Object.values(bySource).filter((x) => x.live).length;
  const itemN = Object.values(bySource).reduce((n, x) => n + x.items.length, 0);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
  console.log(`live sources ${liveN}/${MAP.length} · items ${itemN}`);
  for (const f of failures) console.log(`  ! ${f.name}: ${f.error}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
