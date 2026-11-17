#!/usr/bin/env node
/**
 * 给「见报」tab 截图（按目录各一张），用来肉眼验收。
 * 用法：node tools/shot-news.mjs [url] [最多几张]
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const URL_ = process.argv[2] || 'https://example.com/';
const MAX_SHOTS = Number(process.argv[3] || 3);

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();

await page.goto(URL_, { waitUntil: 'networkidle', timeout: 60000 });
await page.click('.tab[data-key="news"]');
await page.waitForTimeout(1200);

/* 只取目录行的 chip（.chip[data-tag]）——
   原来用 .chip 全收，把来源行的 chip 也收进来了，
   然后按 data-tag 去点就点不到（来源行没有 data-tag）。
   2026-11-06 起目录行也没有「全部」了，不需要再过滤。 */
const chips = await page.$$eval('#grid-news .chip[data-tag]', (els) => els.map((e) => e.textContent));
console.log('目录:', chips.join(' '));

// 目录已经按内容量排序，取前几个有代表性的
for (const tag of chips.slice(0, MAX_SHOTS)) {
  await page.click(`#grid-news .chip[data-tag="${tag}"]`);
  await page.waitForTimeout(700);
  const shown = await page.$$eval('#grid-news .news-item:not(.is-hidden)', (els) => els.length);
  const out = path.join(ROOT, '.verify', `news-${tag}.png`);
  await page.screenshot({ path: out });
  console.log(`「${tag}」显示 ${shown} 条 -> ${out}`);
}

await browser.close();
