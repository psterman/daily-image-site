#!/usr/bin/env node
/**
 * 验证「图片全部加载失败时，页面不会白屏」——
 * 即访问口令模式下，没带凭证的访客看到的是明确的提示条，而不是一片空白。
 *
 * 做法：拦截所有 /img/* 请求并让它们失败，模拟「全部 401」。
 *
 * 用法：node tools/verify-gate-notice.mjs [url]
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const URL_ = process.argv[2] || 'https://example.com/2026-10-25/';

const WECHAT_UA =
  'Mozilla/5.0 (Linux; Android 10; V1938CT Build/QP1A.190711.020; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 Mobile Safari/537.36 ' +
  'MicroMessenger/8.0.32.2180(0x28002037) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64';

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: WECHAT_UA,
});
const page = await ctx.newPage();

// 把所有图片请求打断，模拟「全部拿不到」
await page.route('**/img/**', (route) => route.abort('failed'));

await page.goto(URL_, { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(4000);

const state = await page.evaluate(() => {
  const notice = document.getElementById('gateNotice');
  return {
    title: document.title,
    tabsRendered: document.querySelectorAll('.tab').length,
    tabLabels: Array.from(document.querySelectorAll('.tab .tab-label')).map((t) => t.textContent),
    gridCells: document.querySelectorAll('.cell').length,
    noticeHidden: notice ? notice.hidden : null,
    noticeText: notice ? notice.textContent.replace(/\s+/g, ' ').trim() : '(无)',
    bodyTextLen: document.body.innerText.replace(/\s+/g, '').length,
  };
});

await page.screenshot({ path: path.join(ROOT, '.verify', '07-gate-notice.png') });

console.log('=== 图片全挂时的页面状态 ===');
console.log('标题            :', state.title);
console.log('Tab 是否渲染出来 :', state.tabsRendered, state.tabLabels.join(' / '));
console.log('网格格子数      :', state.gridCells);
console.log('提示条是否显示  :', state.noticeHidden === false ? '是' : '否');
console.log('提示条文案      :', state.noticeText);
console.log('页面文字长度    :', state.bodyTextLen, '（>0 说明不是白屏）');
console.log('截图            :', path.join(ROOT, '.verify', '07-gate-notice.png'));

await browser.close();

const ok = state.tabsRendered > 0 && state.noticeHidden === false && state.bodyTextLen > 0;
console.log(ok ? '\n✓ 降级表现正常：不是白屏，有明确提示' : '\n✗ 降级表现有问题');
process.exit(ok ? 0 : 1);
