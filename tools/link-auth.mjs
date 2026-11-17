#!/usr/bin/env node
/**
 * 判断一条外链「打开原文是否需要登录」。
 *
 * 为什么要标：
 *   知乎 / 微博 / X 这三个源，真人点进去也是登录墙（不是链接坏了）。
 *   实测（2026-10-26）：
 *     - 知乎问题页：官方热榜 API 返回的 question id 真实存在，
 *       api/v4/questions/<id>/answers 能取到回答正文；但 HTML 页面
 *       对未登录访客要登录才能看。
 *     - 微博热搜：s.weibo.com / m.weibo.cn 全部跳 Sina Visitor System 访客系统。
 *     - X (x.com)：推文真实存在（publish oEmbed 200、snowflake 时间戳对得上），
 *       但未登录只能看有限内容。
 *   提前标出来，用户就知道「点进去要先登录」而不是「这链接坏了」。
 *
 * 判定按域名做，纯静态、不发请求。
 */

/** 需要登录才能读全文的域名（含子域） */
const AUTH_DOMAINS = [
  'zhihu.com',
  'weibo.com',
  'weibo.cn',
  'x.com',
  'twitter.com',
];

/**
 * @param {string} link 外链
 * @returns {boolean} 是否需要登录
 */
export function needsLogin(link) {
  if (!link || !/^https?:\/\//i.test(link)) return false;
  let host;
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return false;
  }
  return AUTH_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

/**
 * 给一批条目补上 needLogin 标记。
 * @param {object[]} items
 * @returns {object[]} 原数组（就地修改）
 */
export function markAuth(items) {
  for (const it of items) {
    if (it && typeof it === 'object') it.needLogin = needsLogin(it.link);
  }
  return items;
}
