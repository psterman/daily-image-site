/**
 * ingest-map.mjs —— RSS 条目 → 平台共享池行的纯映射层（浏览器 / Node 通用，零 node:* 依赖）
 *
 * 职责边界：
 *   - 上游 tools/fetch-rss.mjs 负责「抓 + 解析 + 跨源去重」，输出 {title,link,desc,source,ts,categories}
 *   - 本模块负责「映射 + 版权过滤 + 打标签」，输出可直接 upsert 进 Supabase 的
 *     content_items / content_tags 行
 *   - 下游由 service_role（Edge Function / CLI）写入共享池；前端无权写
 *
 * 版权纪律（产品红线，必须固化在代码里，不能靠人自觉）：
 *   1. 第三方 RSS 一律当 rights_status='unknown'，绝不冒充 authorized；
 *   2. 只存 title + 短摘要（截断 MAX_SUMMARY）+ 原文链接，不存全文、不转存图片；
 *   3. 摘要只在源标记 allow_snippet 时保留，否则置 null；
 *   4. image_url 只存远程原图 URL（索引），绝不下载转存；allowImage=false 时仍为 null；
 *   5. 去重以归一化 URL 为准（复用 platform-model.contentHash），同链接改标题不算新条目。
 *
 * 不造轮子：contentHash / newId / now 全部从 platform-model.mjs 引入。
 */
import { contentHash, normalizeUrl, now, newId } from './platform-model.mjs';

export { normalizeUrl };

/** 摘要硬上限：link_card 只需要一句话导读，不做全文转载。 */
export const MAX_SUMMARY = 160;
/** 推文短帖：允许接近单条推文长度，仍远小于文章全文。 */
export const MAX_SUMMARY_TWEET = 280;

/** 推文 / X / xgo 镜像链接（用于摘要上限与阅读侧短正文）。 */
export function isTwitterLikeUrl(url, publisher) {
  const blob = String(url || '') + ' ' + String(publisher || '');
  return /(?:twitter\.com|\/\/x\.com\/|mobile\.twitter\.com|api\.xgo\.ing|xgo\.ing)/i.test(blob);
}

/**
 * 清洗 RSS 摘要：去 HTML、去源站下载推广尾巴、去掉标题复读前缀。
 * 抽屉热榜等会把「想看更多…请下载客户端」粘在 description 里。
 * @param {string} text
 * @param {string} [title]
 * @param {{ url?: string, publisher?: string, max?: number }} [opts]
 */
export function cleanSummary(text, title, opts) {
  let s = stripHtml(text);
  if (!s) return '';
  s = s
    .replace(/想看更多劲爆内容[\s\S]*$/u, '')
    .replace(/请下载[^。\n]{0,48}客户端[\s\S]*$/u, '')
    .replace(/https?:\/\/dig\.ichouti\.cn\/qrcode\/\S+/gi, '')
    .replace(/\s*[:：]?\s*https?:\/\/\S*qrcode\S*/gi, '')
    // xgo.ing Twitter 镜像尾巴：互动计数 + Powered by
    .replace(/\s*Powered by xgo\.ing\s*$/i, '')
    .replace(/^\s*\d*🔄\d*❤️\d*👀\d*📊\d*⚡?\s*/u, '');
  const t = stripHtml(title || '');
  if (t) {
    if (s.startsWith(t)) s = s.slice(t.length);
    // 标题被粘在摘要开头（中间无标点）
    const compact = s.replace(/\s+/g, '');
    const tCompact = t.replace(/\s+/g, '');
    if (compact.startsWith(tCompact)) s = s.slice(t.length);
    if (compact === tCompact) return '';
  }
  const max =
    (opts && opts.max) ||
    (isTwitterLikeUrl(opts && opts.url, opts && opts.publisher)
      ? MAX_SUMMARY_TWEET
      : MAX_SUMMARY);
  return s.replace(/^[\s·\-—|:：]+/, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 入库乱码检测：大量字面量 "?" 说明曾按错误编码写入。 */
export function isGarbledText(s) {
  const t = String(s == null ? '' : s);
  if (t.length < 4) return false;
  const q = (t.match(/\?/g) || []).length;
  return q >= 3 && q / t.length >= 0.25;
}

/**
 * 老见报分类（tools/news-taxonomy.json 的 key）→ 平台标签包 key（db/seed-core.sql）。
 * 两套分类体系不同，这里是唯一的一座桥，集中维护，避免散落各处。
 * 一个分类可映射到多个包；映射不到的分类返回空数组（该条目不进任何平台栏目）。
 */
export const CATEGORY_TO_TAGS = Object.freeze({
  ai: ['ai'],                       // AI 分类 → AI 资讯
  tools: ['opensource', 'tech'],    // 效率工具 → 开源推荐 + 科技新品
  dev: ['opensource'],              // 技术社区 → 开源推荐
  tech: ['tech'],                   // 科技数码 → 科技新品
  biz: ['finance'],                 // 财经商业 → 财经早报
  current: ['news'],                // 新闻/时政 → 新闻速览（资讯版块）
  hot: ['hot'],                     // 热议 → 微博/抖音/知乎等热榜
  deep: ['design'],                 // 深度阅读 → 设计灵感（案例向）
  ent: ['movie'],                   // 影视音乐 → 电影音乐
  // fun=生活：暂挂 design，避免米游社等 noTag；轻松一刻图包仍只吃 funny
  fun: ['design'],
});

/** 关键词兜底：标题/摘要命中时追加标签，覆盖分类映射不到的情况。 */
export const KEYWORD_TAGS = Object.freeze([
  { key: 'opensource', words: ['github', '开源', 'gpl', 'apache', 'mit 协议', '仓库'] },
  { key: 'ai', words: ['大模型', 'gpt', 'claude', 'diffusion', 'llm', 'agent', '多模态', '算力'] },
  { key: 'design', words: ['设计', '配色', '字体', 'ui', 'ux', '作品集', '界面'] },
  // 电影音乐 / 轻松一刻 / 人像美学：关键词兜底关掉，避免文字稿冒充图片包
]);

/** 把老分类 key 映射成平台标签包 key 列表（去重、保序）。 */
export function mapCategory(categoryKey) {
  if (!categoryKey) return [];
  const base = CATEGORY_TO_TAGS[String(categoryKey)] || [];
  return [...new Set(base)];
}

/** 关键词命中返回要追加的标签 key 列表。大小写不敏感。 */
export function matchKeywords(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  if (!s) return [];
  const out = [];
  for (const rule of KEYWORD_TAGS) {
    if (rule.words.some((w) => s.indexOf(String(w).toLowerCase()) >= 0)) out.push(rule.key);
  }
  return out;
}

/**
 * 剥 HTML 标签（feed 的 description 常是转义 HTML），只留纯文本。
 *
 * 关键：内联标签（b/i/em/span）替换成空串，块级标签（p/br/div）才替换成空格。
 * 若一律换成空格，中文标题会被拆词：<i>深度</i>解析 → "深度 解析"（错），
 * 而 <p>A</p><p>B</p> 又确实需要分隔成 "A B"。两种场景必须区别对待。
 */
const INLINE_TAGS = 'a|b|i|em|strong|span|u|small|code|mark|font|label';
export function stripHtml(s) {
  return String(s == null ? '' : s)
    // 先摘掉内联标签（不插空格），保住中文词完整
    .replace(new RegExp(`<\\/?(?:${INLINE_TAGS})\\b[^>]*>`, 'gi'), '')
    // 块级标签 / 换行当成词边界
    .replace(/<\/?(?:p|div|br|li|h[1-6]|section|article|tr|td)\b[^>]*>/gi, ' ')
    // 兜底：其余未知标签仍按空格处理，避免 `<foo>A</foo><foo>B</foo>` 粘成 AB
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 单条 RSS 条目 → content_item 行（尚未落库，id 由调用方决定或 DB 生成）。
 *
 * @param {object} raw  {title, link, desc, source, ts, categories:[], tagKeys:[]}
 * @param {object} opts
 *   opts.sourceId       必填：归属的 source.id（主源编辑池或已登记 RSS 源）
 *   opts.allowSnippet   是否允许存摘要（源级授权），默认 true
 *   opts.allowImage     是否允许存远程配图 URL（不下载），默认 false
 *   opts.rightsStatus   默认 'unknown'（第三方保守值）
 *   opts.publisher      来源显示名，写进 metadata
 *   opts.id             可选：显式 id（幂等 upsert 用）；不传则新建
 * @returns {object|null} 版权/格式不达标返回 null
 */
export function toContentItem(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const sourceId = String(opts.sourceId || '');
  if (!sourceId) return null;

  const title = stripHtml(raw.title).slice(0, 200);
  const url = String(raw.link || '').trim();
  if (!title || !/^https?:\/\//i.test(url)) return null;
  // 已是乱码的标题不要入库，避免污染共享池
  if (isGarbledText(title)) return null;

  const allowSnippet = opts.allowSnippet !== false;
  const publisherHint = String(opts.publisher || raw.source || '');
  const summary = allowSnippet
    ? (cleanSummary(raw.desc, title, { url, publisher: publisherHint }) || null)
    : null;
  const ts = Number(raw.ts) > 0 ? new Date(Number(raw.ts)).toISOString() : now();
  const catKeys = Array.isArray(raw.categories) ? raw.categories.map(String) : [];
  const explicitTags = Array.isArray(raw.tagKeys) ? raw.tagKeys.map(String) : [];

  // 标签 = 分类映射 ∪ 分类字段命中 ∪ 关键词命中 ∪ 调用方显式指定
  const auto = catKeys.flatMap(mapCategory);
  const kw = matchKeywords(title + ' ' + (raw.desc || ''));
  const tagKeys = [...new Set([...auto, ...explicitTags, ...kw])];

  const rawImg = String(raw.imageUrl || raw.image_url || '').trim();
  // 版权：只索引远程热链，永不下载转存；allowImage=false 时恒 null
  const imageUrl = opts.allowImage && /^https?:\/\//i.test(rawImg) ? rawImg.slice(0, 500) : null;

  const contentType = String(raw.contentType || raw.content_type || 'article');
  const region = String(raw.region || '').trim() || null;
  const language = String(raw.language || (region === 'zh-CN' ? 'zh-CN' : region === 'intl' ? 'en' : 'zh-CN'));
  const publisherAvatar = String(
    raw.publisherAvatar || raw.channelAvatar || raw.publisher_avatar || '',
  ).trim();
  // 见笑/见她「一天一期」：整期图墙 URL 列表（仍只索引，不转存）
  const images = [];
  if (opts.allowImage && Array.isArray(raw.images)) {
    for (const im of raw.images) {
      if (images.length >= 200) break;
      const full = String((im && (im.full || im.url)) || (typeof im === 'string' ? im : '')).trim();
      if (!/^https?:\/\//i.test(full)) continue;
      const thumb = String((im && im.thumb) || full).trim();
      images.push({
        full: full.slice(0, 500),
        ...(thumb && /^https?:\/\//i.test(thumb) ? { thumb: thumb.slice(0, 500) } : {}),
      });
    }
  }
  const issueKind = String(raw.issueKind || raw.issue_kind || '').trim();
  const issueDate = String(raw.issueDate || raw.issue_date || '').trim();

  return {
    id: String(opts.id || newId()),
    source_id: sourceId,
    canonical_url: url,
    content_hash: contentHash(url, title),
    content_type: contentType,
    title,
    summary,
    author: null,
    image_url: imageUrl,
    published_at: ts,
    language,
    rights_status: String(opts.rightsStatus || 'unknown'),
    license: null,
    metadata: {
      publisher: String(opts.publisher || raw.source || 'RSS'),
      tag_keys: tagKeys,
      ingested_by: String(raw.ingestedBy || 'main-source'),
      ...(region ? { region } : {}),
      ...(publisherAvatar && /^https?:\/\//i.test(publisherAvatar)
        ? { publisher_avatar: publisherAvatar.slice(0, 500) }
        : {}),
      ...(images.length ? { images } : {}),
      ...(issueKind ? { issue_kind: issueKind } : {}),
      ...(issueDate ? { issue_date: issueDate } : {}),
    },
    created_at: now(),
    updated_at: now(),
  };
}

/**
 * 批量映射 + 去重。
 * @param {Array} items fetch-rss 的条目数组
 * @param {object} opts 同 toContentItem，另可传 resolveTagId(key)->uuid
 * @returns {{rows:object[], links:object[], skipped:number, reasons:object, tagKeys:string[]}}
 *   rows        = content_items 行
 *   links       = content_tags 行（需要 resolveTagId 才能生成）
 *   skipped     = 被过滤掉的数量
 *   reasons     = {noTitle, noUrl, duplicate, noTag}
 *   tagKeys     = 本批出现过的所有标签包 key
 */
export function mapFeedItems(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const reasons = { noTitle: 0, noUrl: 0, duplicate: 0, noTag: 0 };
  const seen = new Set();
  const rows = [];
  const links = [];
  const allTags = new Set();

  for (const raw of list) {
    const title = stripHtml(raw && raw.title);
    if (!title) { reasons.noTitle++; continue; }
    if (!/^https?:\/\//i.test(String((raw && raw.link) || ''))) { reasons.noUrl++; continue; }
    const key = normalizeUrl(raw.link);
    if (seen.has(key)) { reasons.duplicate++; continue; }
    seen.add(key);

    const row = toContentItem(raw, opts);
    if (!row) { reasons.noTitle++; continue; }
    const keys = row.metadata.tag_keys || [];
    if (!keys.length) { reasons.noTag++; continue; } // 无对应栏目 = 不进平台，避免噪音

    rows.push(row);
    for (const k of keys) {
      allTags.add(k);
      if (typeof opts.resolveTagId === 'function') {
        const tid = opts.resolveTagId(k);
        if (tid) {
          links.push({
            content_item_id: row.id,
            tag_pack_id: String(tid),
            confidence: 100,
            created_at: now(),
          });
        }
      }
    }
  }

  return {
    rows,
    links,
    skipped: Object.values(reasons).reduce((a, b) => a + b, 0),
    reasons,
    tagKeys: [...allTags],
  };
}
