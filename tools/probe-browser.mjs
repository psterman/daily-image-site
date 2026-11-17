#!/usr/bin/env node
/**
 * 真实浏览器验证新闻链接能不能打开（每个源抽一条）。
 * 用法：node tools/probe-browser.mjs <url> [每源抽几条]
 */
import { chromium } from 'playwright';

const URL_ = process.argv[2] || 'https://example.com/';
const PER_SRC = Number(process.argv[3] || 1);

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();

await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.click('.tab[data-key="news"]');
await page.waitForTimeout(1200);

// 收集每个源的链接
const bySrc = await page.evaluate((n) => {
  const out = {};
  for (const el of document.querySelectorAll('#grid-news .news-item')) {
    const src = el.querySelector('.news-src')?.textContent?.split(' ')[0] || '?';
    const a = el.querySelector('a.news-link');
    const title = el.querySelector('.news-title')?.textContent || '';
    if (!a) { (out[src] = out[src] || []).push({ href: '', title }); continue; }
    (out[src] = out[src] || []).push({ href: a.href, title });
  }
  return out;
}, PER_SRC);

console.log('真实浏览器逐源验证：\n');
let bad = 0;
for (const [src, list] of Object.entries(bySrc)) {
  for (const t of list.slice(0, PER_SRC)) {
    if (!t.href) {
      console.log(`  NOREF ${src.padEnd(14)} ${t.title.slice(0, 40)}`);
      bad++;
      continue;
    }
    const p2 = await ctx.newPage();
    let status = 'ERR';
    let pageTitle = '';
    try {
      const resp = await p2.goto(t.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      status = resp ? resp.status() : '?';
      pageTitle = (await p2.title()).replace(/\s+/g, ' ').slice(0, 36);
    } catch (e) {
      status = 'ERR';
    }
    await p2.close();
    const ok = status === 200;
    if (!ok) bad++;
    console.log(
      `  ${String(status).padEnd(5)} ${src.padEnd(14)} ${(pageTitle || t.title).slice(0, 38).padEnd(40)} ${t.href.slice(0, 46)}`,
    );
  }
}
console.log(`\n异常 ${bad} 条`);

await browser.close();
