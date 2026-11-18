/**
 * 完整源目录：rss.config × news-taxonomy × 内容包映射。
 * 纯函数；生成脚本与门户共用。
 * 注意：不 import ingest-map / tag-options（platform-model ↔ ingest-map 环）。
 */

/** 与 ingest-map.CATEGORY_TO_TAGS 对齐的只读副本 */
const CATEGORY_TO_TAGS = Object.freeze({
  ai: ['ai'],
  tools: ['opensource', 'tech'],
  dev: ['opensource'],
  tech: ['tech'],
  biz: ['finance'],
  current: [],
  hot: ['hot'],
  deep: ['design'],
  ent: ['movie'],
  fun: [],
});

/** 与 NEWS_CHIPS 对齐的只读标签文案 */
const TAX_LABEL = Object.freeze({
  hot: '热议',
  current: '时政要闻',
  biz: '财经商业',
  tech: '科技数码',
  ai: 'AI',
  tools: '效率工具',
  dev: '技术社区',
  deep: '深度阅读',
  ent: '影视音乐',
  fun: '生活文化',
});

/** 分类说明（全部源分组标题副文案） */
export const TAX_BLURB = Object.freeze({
  hot: '微博、抖音、小红书、知乎等社交与社区热榜',
  current: '时政与综合媒体速览',
  biz: '商业财经',
  tech: '数码与科技新品',
  ai: '大模型与 AI 行业',
  tools: '效率工具与产品',
  dev: '开发者社区与开源',
  deep: '深度阅读与独立博客',
  ent: '影视与音乐',
  fun: '生活文化与休闲阅读（≠ 轻松一刻图包）',
});

const FORMAT_LABEL = Object.freeze({
  article: '文章',
  podcast: '播客',
  video: '视频',
  note: 'Twitter',
  link: '网站',
});

/**
 * 源名 → favicon 域名（优先于 feed URL；热榜/镜像常用）。
 * 尽量用官方域，Google s2 favicon 才能出图标。
 */
export const SOURCE_ICON_DOMAIN = Object.freeze({
  百度热搜: 'baidu.com',
  微博热搜: 'weibo.com',
  知乎热榜: 'zhihu.com',
  抖音热榜: 'douyin.com',
  今日头条热榜: 'toutiao.com',
  今日头条: 'toutiao.com',
  B站热搜: 'bilibili.com',
  B站每周必看: 'bilibili.com',
  百度贴吧热议: 'tieba.baidu.com',
  虎扑步行街: 'hupu.com',
  抽屉热榜: 'dig.ichouti.cn',
  小红书热榜: 'xiaohongshu.com',
  小红书: 'xiaohongshu.com',
  V2EX热榜: 'v2ex.com',
  'V2EX 热榜': 'v2ex.com',
  GitHub趋势: 'github.com',
  金十数据: 'jin10.com',
  凤凰热榜: 'ifeng.com',
  华尔街见闻热榜: 'wallstreetcn.com',
  酷安热榜: 'coolapk.com',
  豆瓣热映: 'douban.com',
  豆瓣即将上映: 'douban.com',
  豆瓣音乐新碟: 'douban.com',
  豆瓣实时热门: 'douban.com',
  豆瓣图书榜: 'douban.com',
});

/** URL → favicon domain；公众号镜像 / xgo 归一 */
export function domainFromFeedUrl(url) {
  try {
    const h = new URL(String(url || '')).hostname.replace(/^www\./i, '').toLowerCase();
    if (!h) return '';
    if (/wechat2rss|bestblogs\.dev/i.test(h)) return 'mp.weixin.qq.com';
    if (/xgo\.ing/i.test(h)) return 'x.com';
    if (/rsshub/i.test(h)) return h;
    return h;
  } catch {
    return '';
  }
}

/** 源名优先，其次 URL */
export function domainForSource(name, url) {
  const n = String(name || '').trim();
  if (n && SOURCE_ICON_DOMAIN[n]) return SOURCE_ICON_DOMAIN[n];
  // Twitter·xxx → x.com
  if (/^Twitter[·•]/i.test(n)) return 'x.com';
  return domainFromFeedUrl(url) || 'example.com';
}

export function packsForTaxonomy(taxKey) {
  const packs = CATEGORY_TO_TAGS[String(taxKey || '')];
  return Array.isArray(packs) ? [...packs] : [];
}

export function taxonomyLabel(taxKey) {
  return TAX_LABEL[taxKey] || taxKey || '';
}

export function formatLabel(contentType) {
  const t = String(contentType || 'article');
  return FORMAT_LABEL[t] || t;
}

function toEntry({ name, url, taxonomy, contentType }) {
  const tax = String(taxonomy || 'deep');
  const ct = String(contentType || 'article');
  return {
    name: String(name || '').trim(),
    domain: domainForSource(name, url),
    url: url || '',
    taxonomy: tax,
    taxonomyLabel: taxonomyLabel(tax),
    contentType: ct,
    formatLabel: formatLabel(ct),
    packs: packsForTaxonomy(tax),
  };
}

/**
 * @param {{feeds:object[], sourceCategory:Record<string,string>, extras?:object[]}} input
 *   extras：NewsNow / 精选热榜等无 RSS URL 的源
 */
export function buildSourceCatalogEntries({ feeds, sourceCategory, extras }) {
  const out = [];
  const seen = new Set();

  function push(raw) {
    const name = String(raw.name || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    const taxonomy =
      raw.taxonomy ||
      (sourceCategory && sourceCategory[name]) ||
      'deep';
    out.push(
      toEntry({
        name,
        url: raw.url || '',
        taxonomy,
        contentType: raw.contentType || raw.content_type || 'article',
      }),
    );
  }

  for (const f of feeds || []) {
    if (!f || (!f.url && !f.name)) continue;
    push(f);
  }
  for (const f of extras || []) push(f);

  out.sort((a, b) => {
    const ta = taxonomyLabel(a.taxonomy).localeCompare(taxonomyLabel(b.taxonomy), 'zh');
    if (ta) return ta;
    return a.name.localeCompare(b.name, 'zh');
  });
  return out;
}

/** 按内容包聚合 {name,domain}；同名去重，保序 */
export function groupSourcesByPack(entries) {
  const by = Object.create(null);
  for (const e of entries) {
    for (const pk of e.packs || []) {
      if (!by[pk]) by[pk] = [];
      by[pk].push({ name: e.name, domain: e.domain });
    }
  }
  for (const k of Object.keys(by)) {
    const seen = new Set();
    by[k] = by[k].filter((s) => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });
  }
  return by;
}

/**
 * 精选 sources + 完整目录合并（精选在前）。
 * @param {{name:string,domain:string}[]} curated
 * @param {{name:string,domain:string}[]} extras
 */
export function mergeSources(curated, extras) {
  const out = [];
  const seen = new Set();
  for (const list of [curated || [], extras || []]) {
    for (const s of list) {
      if (!s || !s.name || seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({ name: s.name, domain: s.domain || '' });
    }
  }
  return out;
}

/** 全部源页：按见报分类分组（保 NEWS_CHIPS 顺序） */
export function groupEntriesByTaxonomy(entries, chipOrder) {
  const order = Array.isArray(chipOrder) && chipOrder.length
    ? chipOrder.map((c) => c.key || c)
    : Object.keys(TAX_LABEL);
  const buckets = new Map(order.map((k) => [k, []]));
  for (const e of entries || []) {
    const k = e.taxonomy || 'deep';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(e);
  }
  return order
    .filter((k) => (buckets.get(k) || []).length)
    .map((k) => ({
      key: k,
      label: taxonomyLabel(k),
      blurb: TAX_BLURB[k] || '',
      iconDomain: k === 'hot' ? 'weibo.com' : k === 'ai' ? 'openai.com' : k === 'biz' ? 'ft.com' : 'wikipedia.org',
      entries: buckets.get(k) || [],
    }));
}
