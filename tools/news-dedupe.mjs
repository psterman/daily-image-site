#!/usr/bin/env node
/**
 * 见报条目跨源去重：同一篇文章只留一条。
 *
 * 为什么需要（2026-11-05）：
 * 见报的条目有两个来源 —— RSS（fetch-rss）和头条（daily_headlines.py）——
 * 它们各自内部去重，但**两边之间没有去重**。
 * 同一个平台被两个渠道收录时就会重复：
 *   V2EX 热榜：Python 那边抓 `www.v2ex.com/?tab=hot`（10-26 / 10-28 成功过，之后一直 403），
 *              RSS 那边走 RSS屋 的镜像 —— 两边是同一份热榜，同一个链接。
 *
 * 判重键直接用 fetch-rss.mjs 的 normalizeLink（去 hash、去 utm 之类追踪参数）——
 * **不要在这里抄一份**：抄一份的话两边规则一漂移，重复条目就又冒出来了
 * （本项目已经因为「手抄生产正则」吃过一次亏）。
 * `https://www.v2ex.com/t/123#reply10` 和 `https://www.v2ex.com/t/123` 是同一篇。
 * 没有链接的条目退回用标题（小写）。
 */
import { normalizeLink } from './fetch-rss.mjs';

/**
 * @param {object[]} items 见报条目（title/link/source/...）
 * @returns {{items:object[], duplicates:number}} 去重后的条目 + 被去掉的重复数
 */
export function dedupeNewsItems(items) {
  const seen = new Set();
  const out = [];
  let duplicates = 0;
  for (const it of items) {
    const key = linkKey(it);
    if (key) {
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
    }
    out.push(it);
  }
  return { items: out, duplicates };
}

/** 判重键：链接优先（归一化），没有链接就用标题 */
export function linkKey(it) {
  const link = String((it && it.link) || '').trim();
  if (link) return normalizeLink(link) || link.toLowerCase();
  const title = String((it && it.title) || '').trim().toLowerCase();
  return title || '';
}
