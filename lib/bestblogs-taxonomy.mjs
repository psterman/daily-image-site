/**
 * BestBlogs 微信公众号分类（九类）→ 见报 taxonomy key。
 * 分类表来自 bestblogs_sources_wechat_part1.md；体育故意不收录。
 */

/** BestBlogs 主分类 → news-taxonomy.json categories.key */
export const BESTBLOGS_TO_TAXONOMY = Object.freeze({
  人工智能: 'ai',
  软件编程: 'dev',
  商业科技: 'tech',
  投资财经: 'biz',
  产品设计: 'deep', // → CATEGORY_TO_TAGS.deep → design 包
  个人成长: 'deep',
  媒体资讯: 'current',
  // 生活文化 ≠ 轻松一刻（视觉梗图包）；进深度阅读
  生活文化: 'deep',
  体育运动: null, // 不收录
});

/** awesome-rss-feeds-list 文件夹 → taxonomy */
export const AWESOME_FOLDER_TO_TAXONOMY = Object.freeze({
  'cn-ai-research': 'ai',
  'cn-ai-tools': 'ai',
  'cn-finance': 'biz',
  'cn-product-design': 'deep',
  'cn-tech-teams': 'dev',
  'cn-essays': 'deep',
  'cn-podcasts': 'deep',
});

/**
 * 解析 BestBlogs wechat part1 markdown 表格。
 * @returns {Map<string, {name:string, category:string, priority:string}>}
 *   key 为去空白后的名称，便于和 OPML/catalog 对上。
 */
export function parseBestblogsWechatMd(md) {
  const map = new Map();
  let cur = null;
  for (const line of String(md || '').split(/\n/)) {
    const h = /^### (.+?)（(\d+) 个）/.exec(line);
    if (h) {
      cur = h[1].trim();
      continue;
    }
    const m = /^\| ([^|]+?) +\| (高|中|普通) /.exec(line);
    if (!m || !cur) continue;
    const name = m[1].trim();
    if (!name || name === '名称') continue;
    map.set(normName(name), { name, category: cur, priority: m[2] });
  }
  return map;
}

export function normName(s) {
  return String(s || '').replace(/\s+/g, '');
}

/** 查分类；未命中返回 null */
export function lookupBestblogs(name, table) {
  if (!table || !table.size) return null;
  return table.get(normName(name)) || null;
}

/** BestBlogs 分类名 → taxonomy key；体育 / 未知 → null */
export function bestblogsCategoryToTaxonomy(category) {
  if (!category) return null;
  if (Object.prototype.hasOwnProperty.call(BESTBLOGS_TO_TAXONOMY, category)) {
    return BESTBLOGS_TO_TAXONOMY[category];
  }
  return null;
}

/**
 * timqian blogs-original tags 粗映射。
 * @param {string} tags
 */
export function timqianTagsToTaxonomy(tags) {
  const s = String(tags || '').toLowerCase();
  if (!s) return 'deep';
  if (/ai|人工|llm|gpt|机器学习|大模型/.test(s)) return 'ai';
  if (/财经|金融|投资|股票|经济/.test(s)) return 'biz';
  if (/编程|开发|前端|后端|开源|linux|rust|go\b|java|python/.test(s)) return 'dev';
  if (/设计|ui|ux|产品/.test(s)) return 'deep';
  if (/科技|数码|互联网/.test(s)) return 'tech';
  if (/生活|文化|随笔|读书/.test(s)) return 'fun';
  return 'deep';
}

/** Twitter/xgo 显示名：orange.ai(@oran_ge) → Twitter·orange.ai */
export function twitterDisplayName(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Twitter';
  if (/^Twitter[·•]/.test(s)) return s;
  const base = s.replace(/\(@[^)]+\)\s*$/, '').trim() || s;
  return 'Twitter·' + base;
}
