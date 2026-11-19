/**
 * DailyHotApi 热榜抓取（JSON，补 NewsNow 缺口）。
 *
 *   node tools/fetch-dailyhot.mjs                 # 抓白名单
 *   node tools/fetch-dailyhot.mjs --probe ngabbs  # 单源探针
 *   node tools/fetch-dailyhot.mjs --probe-all     # 白名单 + probeOnly
 *
 * 环境变量 DAILYHOT_BASE_URL 覆盖 config.baseUrl（生产应指向自建）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'dailyhot.config.json');

export function loadDailyhotConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const baseUrl = String(process.env.DAILYHOT_BASE_URL || raw.baseUrl || '')
    .replace(/\/+$/, '');
  return { ...raw, baseUrl };
}

function pickItems(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload)) return payload;
  return [];
}

function normalizeItem(raw, sourceName) {
  const title = String(raw.title || raw.name || raw.desc || '').trim();
  const link = String(raw.url || raw.link || raw.mobileUrl || '').trim();
  if (!title || !link) return null;
  const hot = raw.hot;
  const heat = hot == null || hot === '' ? '' : String(hot);
  const desc = String(raw.desc || raw.description || heat || '').trim().slice(0, 160);
  const ts = Number(raw.timestamp || raw.time || Date.now());
  return {
    title,
    link,
    desc,
    heat,
    source: sourceName,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    imgs: raw.cover ? [String(raw.cover)] : [],
  };
}

export async function fetchOneDailyhot(baseUrl, id, { timeoutMs = 12000 } = {}) {
  const url = `${baseUrl}/${encodeURIComponent(id)}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        accept: 'application/json,text/plain,*/*',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        referer: `${baseUrl}/`,
      },
      signal: ac.signal,
    });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      return { ok: false, id, status: r.status, items: [], error: `non-json ${ct.slice(0, 40) || r.status}` };
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, id, status: r.status, items: [], error: j.message || j.error || `HTTP ${r.status}` };
    }
    const items = pickItems(j);
    return { ok: items.length > 0, id, status: r.status, items, error: items.length ? '' : 'empty' };
  } catch (e) {
    return { ok: false, id, status: 0, items: [], error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/** 返回与 fetch-rss.fetchHeadlines 同形的 { items, failures } */
export async function fetchDailyhotHeadlines(cfg = loadDailyhotConfig()) {
  if (!cfg.enabled) return { items: [], failures: [], skipped: true };
  if (!cfg.baseUrl) throw new Error('dailyhot baseUrl 为空（设 DAILYHOT_BASE_URL 或 config.baseUrl）');

  const per = Math.max(1, Number(cfg.perSource) || 15);
  const timeoutMs = Math.max(3000, Number(cfg.timeoutMs) || 12000);
  const items = [];
  const failures = [];

  for (const src of cfg.sources || []) {
    const r = await fetchOneDailyhot(cfg.baseUrl, src.id, { timeoutMs });
    if (!r.ok) {
      failures.push({ name: src.name, id: src.id, error: r.error, status: r.status });
      continue;
    }
    let n = 0;
    for (const raw of r.items) {
      if (n >= per) break;
      const it = normalizeItem(raw, src.name);
      if (!it) continue;
      items.push(it);
      n++;
    }
  }
  return { items, failures, skipped: false };
}

async function main() {
  const cfg = loadDailyhotConfig();
  const probeAll = process.argv.includes('--probe-all');
  const probeIdx = process.argv.indexOf('--probe');

  if (probeAll) {
    const ids = [
      ...(cfg.sources || []).map((s) => ({ id: s.id, name: s.name })),
      ...(cfg.probeOnly || []).map((s) => ({ id: s.id, name: s.name })),
    ];
    console.log(`DailyHot probe-all ${cfg.baseUrl} · ${ids.length} 源`);
    for (const s of ids) {
      const r = await fetchOneDailyhot(cfg.baseUrl, s.id, { timeoutMs: cfg.timeoutMs });
      const sample = (r.items || []).slice(0, 1).map((x) => x.title || x.name)[0] || '';
      console.log(`${r.ok ? 'OK' : '!!'} ${s.id.padEnd(14)} n=${String(r.items?.length || 0).padStart(3)} ${r.error || sample.slice(0, 40)}`);
    }
    return;
  }

  if (probeIdx >= 0) {
    const id = process.argv[probeIdx + 1];
    if (!id) {
      console.error('用法: node tools/fetch-dailyhot.mjs --probe <id>');
      process.exit(2);
    }
    const r = await fetchOneDailyhot(cfg.baseUrl, id, { timeoutMs: cfg.timeoutMs });
    console.log(JSON.stringify({
      baseUrl: cfg.baseUrl,
      ...r,
      sample: (r.items || []).slice(0, 3).map((x) => x.title || x.name),
      items: undefined,
    }, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  console.log(`DailyHot ${cfg.baseUrl} · ${cfg.sources?.length || 0} 源`);
  const { items, failures } = await fetchDailyhotHeadlines(cfg);
  console.log(`抓到 ${items.length} 条；失败 ${failures.length}`);
  for (const f of failures) console.log(`  ! ${f.name}(${f.id}): ${f.error}`);
  const by = {};
  for (const it of items) by[it.source] = (by[it.source] || 0) + 1;
  console.log('按源:', by);
  console.log('样例:', items.slice(0, 3).map((x) => `[${x.source}] ${x.title}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
