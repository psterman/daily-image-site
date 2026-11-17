#!/usr/bin/env node
/**
 * 微信 UA 下确认「需登录」徽标渲染正常，并截图存档。
 * 用法：node tools/shot-auth.mjs [url]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const URL_ = process.argv[2] || 'https://example.com/';
const OUT = path.resolve('.verify');
fs.mkdirSync(OUT, { recursive: true });

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
  deviceScaleFactor: 2,
  userAgent: WECHAT_UA,
  locale: 'zh-CN',
});
const page = await ctx.newPage();
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.click('.tab[data-key="news"]');
await page.waitForTimeout(1500);

const stats = await page.evaluate(() => {
  const items = [...document.querySelectorAll('#grid-news .news-item')];
  const auth = items.filter((el) => el.querySelector('.news-auth'));
  const arrow = items.filter((el) => el.querySelector('.news-arrow'));
  const plain = items.filter((el) => el.querySelector('.news-link-plain'));
  const bySrc = {};
  for (const el of auth) {
    const s = el.querySelector('.news-src')?.textContent?.split(' ')[0] || '?';
    bySrc[s] = (bySrc[s] || 0) + 1;
  }
  // 徽标样式检查
  const first = auth[0]?.querySelector('.news-auth');
  const cs = first ? getComputedStyle(first) : null;
  return {
    total: items.length,
    auth: auth.length,
    arrow: arrow.length,
    plain: plain.length,
    bySrc,
    authText: first?.textContent || '',
    authVisible: first ? first.getBoundingClientRect().height > 0 : false,
    authStyle: cs ? { fontSize: cs.fontSize, color: cs.color, radius: cs.borderRadius } : null,
    // 徽标不能挤压 meta 行
    metaOverflow: [...document.querySelectorAll('.news-meta')]
      .filter((m) => m.scrollWidth > m.clientWidth + 2).length,
  };
});

console.log('微信 UA 下「需登录」徽标检查\n');
console.log(`见报条目    : ${stats.total}`);
console.log(`带 ↗ 角标  : ${stats.arrow}`);
console.log(`带「需登录」: ${stats.auth}`);
console.log(`纯文本条目 : ${stats.plain}`);
console.log(`meta 行溢出 : ${stats.metaOverflow}`);
console.log(`徽标文案    : ${JSON.stringify(stats.authText)}  可见: ${stats.authVisible}`);
console.log(`徽标样式    : ${JSON.stringify(stats.authStyle)}`);
console.log('按来源:');
for (const [k, v] of Object.entries(stats.bySrc)) console.log(`  ${k.padEnd(14)} ${v}`);

// 截一张含徽标的图
const target = await page.evaluateHandle(() => {
  const el = [...document.querySelectorAll('#grid-news .news-item')].find(
    (e) => e.querySelector('.news-auth') && e.querySelector('.news-src')?.textContent?.includes('知乎'),
  );
  return el || [...document.querySelectorAll('#grid-news .news-item')].find((e) => e.querySelector('.news-auth'));
});
await target.asElement().scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'news-auth-badge.png') });
console.log(`\n截图: ${path.join(OUT, 'news-auth-badge.png')}`);

await browser.close();
