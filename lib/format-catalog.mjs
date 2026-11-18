/**
 * 格式五板块（第二筛选轴）—— 纯函数：OPML 解析 / 分桶 / 新鲜度判定。
 * 映射 content_items.content_type：
 *   文章 article · 播客 podcast · 视频 video · Twitter note · 网站 link
 */

export const FORMAT_KEYS = Object.freeze(['article', 'podcast', 'video', 'note', 'link']);

export const FORMAT_LABELS = Object.freeze({
  article: '文章',
  podcast: '播客',
  video: '视频',
  note: 'Twitter',
  link: '网站',
});

/** 门户 chip：全不选 = 不限格式 */
export const FORMAT_OPTIONS = Object.freeze(
  FORMAT_KEYS.map((key) => ({ key, label: FORMAT_LABELS[key] })),
);

export const DEFAULT_CUTOFF = '2026-01-01T00:00:00.000Z';

/**
 * 粗解析 OPML：扁平抽出 rss outline，带上父文件夹名作 folder。
 * @returns {{name:string,url:string,home:string,folder:string}[]}
 */
export function parseOpml(xml) {
  const text = String(xml || '');
  if (!text.trim()) return [];
  const out = [];
  const stack = [];
  const tokenRe = /<outline\b([^>]*)>|<\/outline>/gi;
  let m;
  while ((m = tokenRe.exec(text))) {
    if (m[0].startsWith('</')) {
      stack.pop();
      continue;
    }
    const attrs = m[1] || '';
    const selfClose = /\/\s*$/.test(attrs);
    const name = attr(attrs, 'text') || attr(attrs, 'title') || '';
    const url = attr(attrs, 'xmlUrl') || attr(attrs, 'xmlurl') || '';
    const home = attr(attrs, 'htmlUrl') || attr(attrs, 'htmlurl') || '';
    if (url) {
      out.push({
        name: (name || url).trim(),
        url: url.trim(),
        home: (home || '').trim(),
        folder: stack.length ? stack[stack.length - 1] : '',
      });
      continue;
    }
    if (!selfClose && name) stack.push(name);
  }
  return out;
}

function attr(attrs, key) {
  const re = new RegExp('\\b' + key + '\\s*=\\s*"([^"]*)"', 'i');
  const m = re.exec(attrs);
  if (m) return decodeXml(m[1]);
  const re2 = new RegExp("\\b" + key + "\\s*=\\s*'([^']*)'", 'i');
  const m2 = re2.exec(attrs);
  return m2 ? decodeXml(m2[1]) : '';
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * blogs-original.csv：name, url, rss, tags
 * @returns {{name:string,url:string,home:string,folder:string,tags:string}[]}
 */
export function parseBlogsCsv(csv) {
  const lines = String(csv || '').split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = splitCsvLine(line);
    if (parts.length < 3) continue;
    const [name, home, rss, tags] = parts;
    if (!rss || !/^https?:\/\//i.test(rss.trim())) continue;
    out.push({
      name: (name || home || rss).trim(),
      url: rss.trim(),
      home: (home || '').trim(),
      folder: '',
      tags: (tags || '').trim(),
    });
  }
  return out;
}

function splitCsvLine(line) {
  // 简易 CSV：字段内一般无引号逗号；timqian 表是逗号分隔四列
  const parts = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      q = !q;
      continue;
    }
    if (c === ',' && !q) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur.trim());
  return parts;
}

/**
 * @param {{name?:string,url?:string,home?:string,folder?:string,tags?:string,sourceList?:string,enclosureHint?:string}} feed
 * @returns {'article'|'podcast'|'video'|'note'|'link'}
 */
export function classifyFormat(feed) {
  const blob = [
    feed && feed.name,
    feed && feed.url,
    feed && feed.home,
    feed && feed.folder,
    feed && feed.tags,
    feed && feed.sourceList,
    feed && feed.enclosureHint,
  ]
    .map((x) => String(x || '').toLowerCase())
    .join(' ');

  const enc = String((feed && feed.enclosureHint) || '').toLowerCase();
  if (/audio|mpeg|mp3|m4a/.test(enc)) return 'podcast';
  if (/video|mp4|webm/.test(enc)) return 'video';

  if (/播客|podcast|电台|听书/.test(blob) || /cn-podcasts|en-podcasts/.test(blob)) {
    return 'podcast';
  }
  // 视频：只要真视频站 / seed folder，避免「音视频开发」类博客误入
  if (
    /bilibili\.|youtube\.|youtu\.be/.test(blob) ||
    (feed && feed.folder === 'video') ||
    /\/bilibili\/|\/youtube\//.test(blob)
  ) {
    return 'video';
  }
  // Twitter/X：锚定主机名，避免 cdjax.com / reorx.com 误伤；
  // BestBlogs_RSS_Twitters 走 api.xgo.ing，靠 folder/sourceList 识别
  if (
    /(?:^|[/\s])(?:www\.)?(?:twitter\.com|x\.com|nitter\.)/.test(blob) ||
    /\/twitter\//.test(blob) ||
    /api\.xgo\.ing\/rss\//.test(blob) ||
    (feed && feed.folder === 'twitter') ||
    (feed && /twitter/i.test(String(feed.sourceList || '')))
  ) {
    return 'note';
  }

  const list = String((feed && feed.sourceList) || '').toLowerCase();
  if (list === 'bestblogs' || /wechat2rss\.bestblogs\.dev/.test(blob)) return 'article';
  if (list === 'timqian' || list === 'chinese-independent-blogs') return 'link';

  // awesome 中文非播客分区：独立站/newsletter 偏网站，媒体味文件夹偏文章
  if (/cn-essays|cn-lifestyle|cn-newsletters|cn-startups/.test(blob)) return 'link';
  if (/cn-ai|cn-backend|cn-dev|cn-finance|cn-mobile|cn-product|cn-tech|cn-web/.test(blob)) {
    return 'article';
  }

  return 'article';
}

/** newestTs：毫秒时间戳；cutoffIso：ISO 日界 */
export function isFreshEnough(newestTs, cutoffIso = DEFAULT_CUTOFF) {
  const cut = Date.parse(cutoffIso);
  if (!Number.isFinite(cut)) return false;
  const n = Number(newestTs);
  if (!Number.isFinite(n) || n <= 0) return false;
  return n >= cut;
}

/** 条目是否命中用户勾选的格式（空选 = 全部通过） */
export function itemMatchesFormats(item, formatKeys) {
  if (!Array.isArray(formatKeys) || !formatKeys.length) return true;
  const want = new Set(formatKeys.filter((k) => FORMAT_KEYS.includes(k)));
  if (!want.size) return true;
  const t = String((item && item.content_type) || (item && item.contentType) || 'article');
  return want.has(t);
}

/**
 * 去重：同 url（忽略尾斜杠与大小写）保留先出现的。
 */
export function dedupeFeeds(feeds) {
  const seen = new Set();
  const out = [];
  for (const f of feeds || []) {
    const key = String(f.url || '')
      .trim()
      .replace(/\/+$/, '')
      .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export function emptyByFormat() {
  return Object.fromEntries(FORMAT_KEYS.map((k) => [k, []]));
}

/**
 * 把带 format + newestAt 的活源收成 catalog 形状。
 */
export function buildCatalogShape(aliveFeeds, opts = {}) {
  const cutoff = opts.cutoff || DEFAULT_CUTOFF;
  const byFormat = emptyByFormat();
  for (const f of aliveFeeds || []) {
    const format = FORMAT_KEYS.includes(f.format) ? f.format : classifyFormat(f);
    byFormat[format].push({
      name: f.name,
      url: f.url,
      home: f.home || '',
      sourceList: f.sourceList || '',
      newestAt: f.newestAt || null,
      folder: f.folder || '',
    });
  }
  for (const k of FORMAT_KEYS) {
    byFormat[k].sort((a, b) => String(b.newestAt || '').localeCompare(String(a.newestAt || '')));
  }
  return {
    generatedAt: opts.generatedAt || new Date().toISOString(),
    cutoff,
    byFormat,
    counts: Object.fromEntries(FORMAT_KEYS.map((k) => [k, byFormat[k].length])),
  };
}
