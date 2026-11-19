/**
 * 热榜补洞：抽屉 / 小红书 / NGA网事杂谈（不走 DailyHot 脏数据）。
 *
 *   node tools/fetch-hot-extras.mjs --probe chouti|xiaohongshu|nga
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OMNI_BASE = String(process.env.OMNI_TRENDS_BASE || 'https://omni-trends.pages.dev').replace(/\/+$/, '');
const CHOUTI_HOT = 'https://dig.ichouti.cn/link/hot';
const NGA_LADDER = 'https://ngabbs.com/nuke.php?__lib=load_topic&__act=load_topic_reply_ladder2&opt=1&all=1';

/** 公开热榜梯里≈网事杂谈向的版块（官方 fid=-7 需登录，此为可匿名命中的生活/职场/文娱闲聊） */
const NGA_WANGSHI_FIDS = new Set([-1459709, -343809, -576177]);
const NGA_SKIP_TITLE = /请下载新版APP|升级.*APP|茶水间|水楼|情报楼/;

function uaHeaders(extra = {}) {
  return {
    accept: 'application/json,text/plain,*/*',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...extra,
  };
}

export async function fetchChoutiHot({ timeoutMs = 12000, limit = 50 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(CHOUTI_HOT, {
      headers: uaHeaders({ referer: 'https://dig.ichouti.cn/' }),
      signal: ac.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, items: [], error: `HTTP ${r.status}` };
    // dig.ichouti.cn/link/hot 一页约 25 条；默认 50 足够抓全，勿再用 NewsNow 的 15 裁掉
    const raw = Array.isArray(j.data) ? j.data : [];
    const items = [];
    for (const x of raw) {
      if (items.length >= limit) break;
      const title = String(x.title || '').trim();
      const id = x.id;
      const link = id
        ? `https://dig.ichouti.cn/link/${id}`
        : String(x.url || x.originalUrl || '').trim();
      if (!title || !link) continue;
      const ups = Number(x.score || x.ups || x.comments_count || 0);
      const img = String(x.img_url || '').trim();
      // ichouti created_time 是微秒；Date 要毫秒
      let ts = Number(x.created_time || x.createTime || 0);
      if (ts > 1e14) ts = Math.floor(ts / 1e3);
      if (!(ts > 0)) ts = Date.now();
      items.push({
        title,
        link,
        desc: String(x.content || '').replace(/\s+/g, ' ').slice(0, 120),
        heat: ups > 0 ? String(Math.round(ups)) : '',
        source: '抽屉热榜',
        ts,
        imgs: img && /^https?:\/\//i.test(img) ? [{ url: img, kind: 'chouti' }] : [],
      });
    }
    return { ok: items.length > 0, items, error: items.length ? '' : 'empty' };
  } catch (e) {
    return { ok: false, items: [], error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/** OmniTrends（NewsNow 兼容）小红书热搜；官方 NewsNow 无此 id */
export async function fetchXiaohongshuHot({ timeoutMs = 12000, limit = 15, baseUrl = OMNI_BASE } = {}) {
  const url = `${baseUrl}/api/s?id=xiaohongshu`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: uaHeaders({ referer: `${baseUrl}/` }),
      signal: ac.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, items: [], error: j.message || `HTTP ${r.status}` };
    const raw = Array.isArray(j.items) ? j.items : (Array.isArray(j.data?.items) ? j.data.items : []);
    const items = [];
    for (const x of raw) {
      if (items.length >= limit) break;
      const title = String(x.title || x.name || '').trim();
      const link = String(x.url || x.link || x.mobileUrl || '').trim();
      if (!title || !link) continue;
      const heat = String(x.extra?.info || x.hot || '').trim();
      items.push({
        title,
        link,
        desc: heat,
        heat,
        source: '小红书热榜',
        ts: Number(x.timestamp || Date.now()),
        imgs: [],
      });
    }
    return { ok: items.length > 0, items, error: items.length ? '' : 'empty' };
  } catch (e) {
    return { ok: false, items: [], error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/** NGA 公开热帖梯 → 筛网事杂谈向（非全站游戏区） */
export async function fetchNgaWangshi({ timeoutMs = 12000, limit = 15 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(NGA_LADDER, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Mozilla/5.0',
        'x-user-agent': 'NGA_skull/7.3.1(iPhone13,2;iOS 17.2.1)',
        referer: 'https://ngabbs.com/',
        host: 'ngabbs.com',
      },
      body: '__output=14',
      signal: ac.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, items: [], error: `HTTP ${r.status}` };
    const raw = Array.isArray(j?.result?.[0]) ? j.result[0] : [];
    const seen = new Set();
    const picked = [];
    for (const v of raw) {
      const tid = String(v.tid || '');
      const title = String(v.subject || '').trim();
      if (!tid || !title || seen.has(tid)) continue;
      seen.add(tid);
      if (NGA_SKIP_TITLE.test(title)) continue;
      if (!NGA_WANGSHI_FIDS.has(Number(v.fid))) continue;
      picked.push(v);
    }
    picked.sort((a, b) => Number(b.replies || 0) - Number(a.replies || 0));
    const items = picked.slice(0, limit).map((v) => {
      const replies = Number(v.replies || 0);
      const path = String(v.tpcurl || `/read.php?tid=${v.tid}`);
      return {
        title: String(v.subject).trim(),
        link: path.startsWith('http') ? path : `https://bbs.nga.cn${path}`,
        desc: replies ? `${replies} 回复` : '',
        heat: replies > 0 ? String(replies) : '',
        source: 'NGA网事杂谈',
        ts: Number(v.postdate || Date.now()) * (String(v.postdate).length < 12 ? 1000 : 1),
        imgs: [],
      };
    });
    return { ok: items.length > 0, items, error: items.length ? '' : 'empty' };
  } catch (e) {
    return { ok: false, items: [], error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const probe = process.argv.includes('--probe')
    ? process.argv[process.argv.indexOf('--probe') + 1]
    : '';
  const map = {
    chouti: fetchChoutiHot,
    xiaohongshu: fetchXiaohongshuHot,
    nga: fetchNgaWangshi,
  };
  const keys = probe ? [probe] : Object.keys(map);
  for (const k of keys) {
    const fn = map[k];
    if (!fn) {
      console.error('unknown', k, 'want', Object.keys(map).join('|'));
      process.exit(2);
    }
    const r = await fn({ limit: 6 });
    console.log(JSON.stringify({
      id: k,
      ok: r.ok,
      n: r.items.length,
      error: r.error,
      sample: r.items.slice(0, 3).map((x) => x.title),
    }, null, 2));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
