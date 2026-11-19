/**
 * extract-article.mjs —— 零依赖 HTML → 正文（浏览器 / Workers / Node 通用）
 *
 * 不是完整 Mozilla Readability，只做「点开读一下」够用的抽取：
 *   剥脚本样式 → 优先 article/main → 去标签 → 压空白。
 * 版权纪律：结果只给当次阅读 / 短缓存，不进共享池 content_items。
 */

export const MAX_FULLTEXT = 50000;

const DROP_BLOCKS = /<(script|style|noscript|svg|iframe|template|aside|nav|footer|header|form)[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );
}

function collapse(text) {
  return String(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function pickTitle(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)
    || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(html);
  if (og) return decodeEntities(og[1]).trim();
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return t ? collapse(stripTags(t[1])).slice(0, 200) : '';
}

function pickBlock(html) {
  const prefer = [/<(article)[^>]*>([\s\S]*?)<\/article>/i, /<(main)[^>]*>([\s\S]*?)<\/main>/i];
  for (const re of prefer) {
    const m = re.exec(html);
    if (m && stripTags(m[2]).trim().length > 120) return m[2];
  }
  // 退化：在若干大块里挑文本最长的
  let best = '';
  const blockRe = /<(div|section|td)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = blockRe.exec(html))) {
    const text = collapse(stripTags(m[2]));
    if (text.length > best.length) best = m[2];
  }
  return best || html;
}

/**
 * 把纯文本拆成阅读段（简悦 / Inoreader 式排版用）。
 * 优先空行分段；只有单段但有换行时按行拆；过碎行再合并。
 */
export function splitReadingParagraphs(text) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  if (!raw) return [];
  let parts = raw.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1 && /\n/.test(parts[0])) {
    const lines = parts[0].split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (lines.length >= 3) parts = lines;
  }
  parts = parts.map((p) => p.replace(/[ \t]*\n[ \t]*/g, isMostlyCjk(p) ? '' : ' ').trim()).filter(Boolean);
  // 一整墙中文：按句号切成段，避免 AIHOT 类源只有 span 时糊成一块
  if (parts.length === 1 && isMostlyCjk(parts[0]) && parts[0].length > 180) {
    const sents = parts[0].split(/(?<=[。！？])(?![」』"'])/).map((s) => s.trim()).filter(Boolean);
    if (sents.length >= 3) {
      const merged = [];
      let buf = '';
      for (const s of sents) {
        buf += s;
        if (buf.length >= 90) {
          merged.push(buf);
          buf = '';
        }
      }
      if (buf) merged.push(buf);
      if (merged.length >= 2) parts = merged;
    }
  }
  // 过碎（纯短句行）合并，避免一行一段
  if (parts.length > 8) {
    const avg = parts.reduce((n, p) => n + p.length, 0) / parts.length;
    if (avg < 28) {
      const merged = [];
      let buf = '';
      for (const p of parts) {
        buf = buf ? buf + p : p;
        if (buf.length >= 60 || /[。！？…]$/.test(buf)) {
          merged.push(buf);
          buf = '';
        }
      }
      if (buf) merged.push(buf);
      if (merged.length) parts = merged;
    }
  }
  return parts;
}

const ALLOWED_TAGS = new Set([
  'p', 'br', 'h2', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'li',
  'strong', 'b', 'em', 'i', 'a', 'img', 'figure', 'figcaption', 'hr',
]);

function absUrl(u, base) {
  const raw = String(u || '').trim();
  if (!raw || /^javascript:/i.test(raw) || /^data:/i.test(raw)) return '';
  try {
    const out = new URL(raw, base || undefined).toString();
    return /^https?:\/\//i.test(out) ? out : '';
  } catch {
    return '';
  }
}

/**
 * 正文碎片 → 可读安全 HTML（保留段/链/图；剥脚本与事件）。
 * @param {string} fragment
 * @param {string} [baseUrl]
 */
export function toReadingHtml(fragment, baseUrl) {
  let h = String(fragment || '');
  if (!h.trim()) return '';
  h = h.replace(COMMENT, '').replace(DROP_BLOCKS, ' ');
  // 懒加载图：提升 data-src
  h = h.replace(/<img\b([^>]*)>/gi, (full, attrs) => {
    const src =
      /(?:data-src|data-original|data-lazy-src|data-actualsrc)=["']([^"']+)["']/i.exec(attrs) ||
      /src=["']([^"']+)["']/i.exec(attrs);
    const alt = /alt=["']([^"']*)["']/i.exec(attrs);
    const href = absUrl(src && src[1], baseUrl);
    if (!href) return '';
    return `<img src="${href}" alt="${alt ? alt[1].replace(/"/g, '') : ''}" loading="lazy" referrerpolicy="no-referrer">`;
  });
  // 链接：只留 http(s)
  h = h.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs, inner) => {
    const m = /href=["']([^"']+)["']/i.exec(attrs);
    const href = absUrl(m && m[1], baseUrl);
    if (!href) return inner;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
  });
  // 白名单标签；其余揭掉外壳留内容
  h = h.replace(/<\/?([a-z0-9]+)(\s[^>]*)?>/gi, (full, tag) => {
    const t = String(tag || '').toLowerCase();
    const closing = /^<\//.test(full);
    if (t === 'br') return '<br>';
    if (t === 'img') return full; // 已重写
    if (t === 'a') return full; // 已重写开闭
    if (!ALLOWED_TAGS.has(t)) return '';
    if (closing) return `</${t}>`;
    if (t === 'p' || t === 'h2' || t === 'h3' || t === 'h4' || t === 'blockquote' ||
        t === 'ul' || t === 'ol' || t === 'li' || t === 'strong' || t === 'b' ||
        t === 'em' || t === 'i' || t === 'figure' || t === 'figcaption' || t === 'hr') {
      return `<${t}>`;
    }
    return '';
  });
  // 没有块级标签时：包成 <p>（有链/图时不能 strip，否则会丢掉）
  if (!/<(p|h[2-4]|li|blockquote)\b/i.test(h)) {
    if (/<(a|img)\b/i.test(h)) {
      const chunks = h.split(/(?:<br\s*\/?>\s*){2,}/i).map((x) => x.trim()).filter(Boolean);
      h = (chunks.length ? chunks : [h]).map((c) => `<p>${c}</p>`).join('');
    } else {
      const chunks = h
        .split(/<br\s*\/?>/i)
        .map((x) => collapse(stripTags(x)))
        .filter(Boolean);
      if (chunks.length >= 2) {
        h = chunks.map((c) => `<p>${c}</p>`).join('');
      } else {
        const paras = splitReadingParagraphs(collapse(stripTags(h)));
        h = paras.map((c) => `<p>${c}</p>`).join('');
      }
    }
  }
  // 截断过长 HTML
  if (h.length > MAX_FULLTEXT * 2) h = h.slice(0, MAX_FULLTEXT * 2) + '…';
  return h.trim();
}

function packArticle(title, block, baseUrl, max) {
  const cleaned = String(block || '').replace(COMMENT, '').replace(DROP_BLOCKS, ' ');
  let text = collapse(stripTags(cleaned));
  if (text.length > max) text = text.slice(0, max) + '…';
  const html = toReadingHtml(cleaned, baseUrl);
  return { title: title || '', text, html, chars: text.length };
}

/** 中文占比够高时启用首行缩进等中文阅读习惯。 */
export function isMostlyCjk(text) {
  const s = String(text || '');
  if (!s) return false;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk >= 24 && cjk / s.length >= 0.25;
}

/**
 * 按 id/class 抠一块 HTML（零 DOM）。
 * 用开标签 + 同名标签深度找闭标签，避免非贪婪在嵌套处截断。
 */
function sliceTaggedBlock(html, openRe) {
  const raw = String(html || '');
  const om = openRe.exec(raw);
  if (!om) return '';
  const tag = om[1].toLowerCase();
  const start = om.index + om[0].length;
  let depth = 1;
  let i = start;
  const openTok = new RegExp(`<${tag}\\b[^>]*>`, 'ig');
  const closeTok = new RegExp(`</${tag}\\s*>`, 'ig');
  while (i < raw.length && depth > 0) {
    openTok.lastIndex = i;
    closeTok.lastIndex = i;
    const o = openTok.exec(raw);
    const c = closeTok.exec(raw);
    if (!c) return '';
    if (o && o.index < c.index) {
      depth += 1;
      i = o.index + o[0].length;
    } else {
      depth -= 1;
      if (depth === 0) {
        const inner = raw.slice(start, c.index);
        return stripTags(inner).replace(/\s+/g, ' ').trim().length >= 20 ? inner : '';
      }
      i = c.index + c[0].length;
    }
  }
  return '';
}

export function extractBySelectors(html, sel) {
  const ids = (sel && sel.ids) || [];
  const classes = (sel && sel.classes) || [];
  for (const id of ids) {
    const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inner = sliceTaggedBlock(
      html,
      new RegExp(`<([a-z0-9]+)[^>]*\\sid=["']${esc}["'][^>]*>`, 'i'),
    );
    if (inner) return inner;
  }
  for (const cls of classes) {
    const esc = String(cls).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inner = sliceTaggedBlock(
      html,
      new RegExp(`<([a-z0-9]+)[^>]*\\sclass=["'][^"']*\\b${esc}\\b[^"']*["'][^>]*>`, 'i'),
    );
    if (inner) return inner;
  }
  return '';
}

/** 微信公众号：#js_content */
export function extractWechatArticle(html, opts) {
  const max = (opts && opts.max) || MAX_FULLTEXT;
  const baseUrl = (opts && opts.baseUrl) || '';
  const raw = String(html || '');
  const title = pickTitle(raw);
  const block =
    extractBySelectors(raw, { ids: ['js_content'] }) ||
    extractBySelectors(raw, { classes: ['rich_media_content'] });
  if (!block) return { title, text: '', html: '', chars: 0 };
  return packArticle(title, block, baseUrl, max);
}

/** B 站专栏 /read/ */
export function extractBilibiliRead(html, opts) {
  const max = (opts && opts.max) || MAX_FULLTEXT;
  const baseUrl = (opts && opts.baseUrl) || '';
  const raw = String(html || '');
  const title = pickTitle(raw);
  const block =
    extractBySelectors(raw, {
      ids: ['read-article-holder', 'article-content'],
      classes: ['article-content', 'article-holder', 'read-article'],
    });
  if (!block) return { title, text: '', html: '', chars: 0 };
  return packArticle(title, block, baseUrl, max);
}

/**
 * Twitter syndication JSON → 纯文本（长文优先 note_tweet）。
 * @param {object} data
 */
export function tweetJsonToText(data) {
  if (!data || typeof data !== 'object') return { title: '', text: '', chars: 0 };
  const user = (data.user && (data.user.name || data.user.screen_name)) || '';
  const note =
    (data.note_tweet && (data.note_tweet.text || data.note_tweet.note_text)) ||
    (data.noteTweet && (data.noteTweet.text || data.noteTweet.note_text)) ||
    '';
  const main = String(note || data.text || data.full_text || '').trim();
  const parts = [];
  if (main) parts.push(main);
  const quoted = data.quoted_tweet || data.quotedTweet || data.quote;
  if (quoted && typeof quoted === 'object') {
    const qUser = (quoted.user && (quoted.user.name || quoted.user.screen_name)) || '';
    const qText = String(quoted.text || quoted.full_text || '').trim();
    if (qText) parts.push((qUser ? `引用 @${qUser}：` : '引用：') + qText);
  }
  const text = parts.join('\n\n').trim();
  const title = user ? `${user} 的推文` : (main.slice(0, 40) || '推文');
  return { title, text, chars: text.length };
}

/**
 * @param {string} html
 * @param {{ max?: number, baseUrl?: string }} [opts]
 * @returns {{ title: string, text: string, html: string, chars: number }}
 */
export function extractArticle(html, opts) {
  const max = (opts && opts.max) || MAX_FULLTEXT;
  const baseUrl = (opts && opts.baseUrl) || '';
  const raw = String(html || '');
  const title = pickTitle(raw);
  const cleaned = raw.replace(COMMENT, '').replace(DROP_BLOCKS, ' ');
  const block = pickBlock(cleaned);
  return packArticle(title, block, baseUrl, max);
}

/** 只允许 http(s)，挡 file/javascript/data。 */
export function safeArticleUrl(link) {
  if (!link || typeof link !== 'string') return '';
  try {
    const u = new URL(link.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!u.hostname) return '';
    return u.toString();
  } catch {
    return '';
  }
}
