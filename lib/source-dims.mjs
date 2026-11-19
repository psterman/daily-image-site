/**
 * source-dims.mjs —— 全部源 / 今日阅读共用的三维筛选
 *   分类 = 媒体形式 · 平台 = 载体 · 来源 = 题材
 */
import { NEWS_CHIPS } from './tag-options.mjs';

export const SRC_MEDIA_CHIPS = Object.freeze([
  { key: 'article', label: '资讯', glyph: '讯' },
  { key: 'blog', label: '博客', glyph: '博' },
  { key: 'video', label: '视频', glyph: '视' },
  { key: 'image', label: '图片', glyph: '图' },
  { key: 'podcast', label: '播客', glyph: '播' },
  { key: 'note', label: '短讯', glyph: '短' },
]);

/** 平台色块图标（Google favicon 对微信/微博经常错图） */
export const PLATFORM_MARK = Object.freeze({
  weixin: { bg: '#07c160', fg: '#fff', ch: '微' },
  weibo: { bg: '#e6162d', fg: '#fff', ch: '博' },
  twitter: { bg: '#111', fg: '#fff', ch: '𝕏' },
  forum: { bg: '#e8f1ff', fg: '#1d4ed8', ch: '论' },
  community: { bg: '#fef3c7', fg: '#b45309', ch: '社' },
  website: { bg: '#f3f4f6', fg: '#374151', ch: '站' },
});

export const SRC_PLATFORM_CHIPS = Object.freeze([
  { key: 'weixin', label: '微信', mark: PLATFORM_MARK.weixin },
  { key: 'weibo', label: '微博', mark: PLATFORM_MARK.weibo },
  { key: 'twitter', label: '短讯源', mark: PLATFORM_MARK.twitter },
  { key: 'forum', label: '论坛', mark: PLATFORM_MARK.forum },
  { key: 'community', label: '社区', mark: PLATFORM_MARK.community },
  { key: 'website', label: '网站', mark: PLATFORM_MARK.website },
]);

export const TOPIC_CHIP_ICON = Object.freeze({
  hot: '',
  current: 'reuters.com',
  biz: 'wallstreetcn.com',
  tech: 'ifanr.com',
  ai: 'openai.com',
  tools: 'producthunt.com',
  dev: 'github.com',
  deep: 'substack.com',
  ent: 'douban.com',
  fun: 'douban.com',
});

/** 内容包 key → 见报题材（阅读侧用） */
const PACK_TO_TOPIC = Object.freeze({
  news: 'current',
  ai: 'ai',
  tech: 'tech',
  finance: 'biz',
  hot: 'hot',
  opensource: 'dev',
  design: 'deep',
  movie: 'ent',
  funny: 'fun',
  portrait: 'fun',
  sight: 'fun',
});

const FORUM_HOST = /nga\.|tieba\.|v2ex\.|hupu\.|hostloc\.|nodeseek\.|52pojie\.|csdn\.|juejin\.|pcbeta\./i;
const COMMUNITY_HOST = /zhihu\.|chouti\.|ichouti\.|douban\.|xiaohongshu\.|coolapk\.|jianshu\./i;
const IMAGE_HOST = /xiaohongshu\.|jandan\.|huaban\.|zcool\.|dribbble\.|unsplash\./i;
const VIDEO_HOST = /bilibili\.|douyin\.|kuaishou\.|youtube\./i;

function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** 目录行或阅读条目 → 统一取 host */
export function dimHost(r) {
  if (!r || typeof r !== 'object') return '';
  const d = String(r.domain || '').toLowerCase().replace(/^www\./, '');
  if (d) return d;
  return hostOf(r.url || r.canonical_url || '');
}

export function isWeixinSource(r) {
  const d = dimHost(r);
  const u = String((r && (r.url || r.canonical_url)) || '').toLowerCase();
  return /mp\.weixin\.qq\.com/.test(d) || /wechat2rss|weixin/.test(d + u);
}

export function isWeiboSource(r) {
  const d = dimHost(r);
  const n = String((r && (r.name || r.source)) || '');
  return /weibo\./.test(d) || /微博/.test(n);
}

export function isTwitterSource(r) {
  const d = dimHost(r);
  const n = String((r && (r.name || r.source)) || '');
  // 只认推特域名/名称；勿把 contentType=note 一刀切成 Twitter（短讯≠平台）
  return /^(x\.com|twitter\.com|api\.xgo\.ing|xgo\.ing)/.test(d)
    || /(^|\.)xgo\.ing$/i.test(d)
    || /^Twitter[·•.\s]/i.test(n)
    || /推特/i.test(n);
}

/** 展示名：去掉 Twitter· 前缀，避免列表里一排「T」简写 */
export function displaySourceName(r) {
  const n = String((r && (r.name || r.source)) || '').trim();
  return n.replace(/^Twitter[·•.\s]+/i, '').trim() || n;
}

/** 分类·媒体形式 */
export function sourceMediaKey(r) {
  const ct = String((r && (r.contentType || r.content_type)) || '');
  const d = dimHost(r);
  const n = String((r && (r.name || r.source || r.title)) || '');
  if (ct === 'podcast') return 'podcast';
  if (ct === 'video' || VIDEO_HOST.test(d)) return 'video';
  if (ct === 'note' || isTwitterSource(r)) return 'note';
  // 站内图包精确名；勿用 /见闻/ 误伤「华尔街见闻」
  if (
    ct === 'image'
    || IMAGE_HOST.test(d)
    || /daily\.onetone\.app/i.test(d)
    || /^(见笑|见她|见闻)$/.test(n)
    || /图片|摄影|人像/.test(n)
  ) return 'image';
  if (ct === 'link') return 'blog';
  return 'article';
}

/** 站内视觉源（无 RSS，需并进全部源目录） */
export const VISUAL_SOURCE_EXTRAS = Object.freeze([
  { name: '见笑', domain: 'daily.onetone.app', url: 'https://daily.onetone.app/', taxonomy: 'fun', taxonomyLabel: '生活', contentType: 'image', formatLabel: '图片', packs: ['funny'] },
  { name: '见她', domain: 'daily.onetone.app', url: 'https://daily.onetone.app/', taxonomy: 'fun', taxonomyLabel: '生活', contentType: 'image', formatLabel: '图片', packs: ['portrait'] },
  { name: '见闻', domain: 'daily.onetone.app', url: 'https://daily.onetone.app/', taxonomy: 'fun', taxonomyLabel: '生活', contentType: 'image', formatLabel: '图片', packs: ['sight'] },
]);

/** 平台·载体 */
export function sourcePlatformKey(r) {
  const d = dimHost(r);
  if (isWeixinSource(r)) return 'weixin';
  if (isWeiboSource(r)) return 'weibo';
  if (isTwitterSource(r)) return 'twitter';
  if (FORUM_HOST.test(d)) return 'forum';
  if (COMMUNITY_HOST.test(d)) return 'community';
  return 'website';
}

/** 来源·题材（taxonomy 或内容包映射） */
export function sourceTopicKey(r) {
  const tax = String((r && r.taxonomy) || '').trim();
  if (tax && NEWS_CHIPS.some((c) => c.key === tax)) return tax;
  const pack = String((r && (r.columnKey || r.tagKey || r.packKey)) || '').trim();
  if (pack && NEWS_CHIPS.some((c) => c.key === pack)) return pack;
  if (PACK_TO_TOPIC[pack]) return PACK_TO_TOPIC[pack];
  // 与全部源一致：无题材时挂到深度，避免芯片空集
  return tax || 'deep';
}

export function sourceDimLabels(r) {
  const media = SRC_MEDIA_CHIPS.find((c) => c.key === sourceMediaKey(r));
  const plat = SRC_PLATFORM_CHIPS.find((c) => c.key === sourcePlatformKey(r));
  const topic = NEWS_CHIPS.find((c) => c.key === sourceTopicKey(r));
  return {
    media: (media && media.label) || '文章',
    platform: (plat && plat.label) || '网站',
    topic: (topic && topic.label) || (r && r.taxonomyLabel) || '其它',
  };
}

export { NEWS_CHIPS };
