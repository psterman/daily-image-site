#!/usr/bin/env node
/**
 * 微信 UA + 真实浏览器，对线上「见报」逐源实点验证。
 * 目的：区分「链接真的坏了」和「本机数据中心 IP 被风控」的假警报。
 *
 * 用法：node tools/probe-wechat.mjs [url] [每源抽样条数]
 */
import { chromium } from 'playwright';

const URL_ = process.argv[2] || 'https://example.com/';
const PER_SRC = Number(process.argv[3] || 2);

// 微信内置浏览器 UA（iOS）
const WECHAT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 MicroMessenger/8.0.49(0x18002939) NetType/WIFI Language/zh_CN';

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent: WECHAT_UA,
  locale: 'zh-CN',
});
const page = await ctx.newPage();

await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.click('.tab[data-key="news"]');
await page.waitForTimeout(1200);

const items = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('#grid-news .news-item')) {
    // 源名就是完整文本 —— 有些源名带空格（「V2EX 热榜」），
  // 按空格切第一段会把源名截断（2026-11-05 修）
  const src = el.querySelector('.news-src')?.textContent || '?';
    const a = el.querySelector('a.news-link');
    out.push({
      src,
      href: a ? a.href : '',
      title: el.querySelector('.news-title')?.textContent || '',
    });
  }
  return out;
});

console.log(`微信 UA 真实浏览器逐源验证（每源 ${PER_SRC} 条）\n`);

const bySrc = new Map();
for (const it of items) {
  if (!bySrc.has(it.src)) bySrc.set(it.src, []);
  bySrc.get(it.src).push(it);
}

let bad = 0;
let noref = 0;
const summary = [];

for (const [src, list] of bySrc.entries()) {
  let ok = 0;
  const details = [];
  for (const t of list.slice(0, PER_SRC)) {
    if (!t.href) {
      noref++;
      details.push('NOREF');
      continue;
    }
    const p2 = await ctx.newPage();
    let status = 'ERR';
    let pageTitle = '';
    let matched = false;
    try {
      const resp = await p2.goto(t.href, { waitUntil: 'domcontentloaded', timeout: 35000 });
      status = resp ? resp.status() : '?';
      pageTitle = (await p2.title()).replace(/\s+/g, ' ').slice(0, 34);
      const body = (await p2.content()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      // 用标题里的关键词判断是不是真的打开了原文
      const kw = t.title.replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 8);
      matched = kw.length >= 3 && body.includes(kw);
    } catch {
      status = 'ERR';
    }
    await p2.close();
    if (status === 200) ok++;
    else bad++;
    details.push(`${status}${matched ? '/内容命中' : ''} ${pageTitle}`);
  }
  summary.push({ src, total: list.length, ok, sampled: Math.min(PER_SRC, list.length) });
  console.log(`  ${src}`);
  details.forEach((d) => console.log(`      ${d}`));
}

console.log('\n=== 汇总 ===');
for (const s of summary) {
  console.log(
    `  ${s.src.padEnd(14)} 抽样 ${s.sampled}  正常 ${s.ok}  异常 ${s.sampled - s.ok}`,
  );
}
console.log(`\n无链接条目 ${noref} 条；抽样中非 200 共 ${bad} 条`);

await browser.close();
