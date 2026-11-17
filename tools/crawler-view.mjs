#!/usr/bin/env node
/**
 * 爬虫视角体检：模拟「只解析 HTML、不执行 JS」的微信分享爬虫，
 * 看看它能在这个页面里挖到多少正文图片链接。
 *
 * 微信生成分享卡片时用的就是这种爬虫 —— 它不执行 JS，
 * 所以正文图片如果只存在于 JS 里，它就抓不到，也就没法做图像审核。
 * 这个脚本用来量化「爬虫能看到什么」，防止以后改版不小心把 URL 又漏回 HTML。
 *
 * 用法：node tools/crawler-view.mjs [url]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const target = process.argv[2];
let html = '';

if (target) {
  const res = await fetch(target, {
    headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
  });
  html = await res.text();
} else {
  // 本地产物
  const dir = path.join(ROOT, 'published', '2026-10-25');
  html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
}

const body = html.replace(/<!--[\s\S]*?-->/g, ''); // 去掉注释（爬虫也会忽略）
const imgTags = body.match(/<img[^>]*>/gi) || [];
const scriptSrcs = body.match(/<script[^>]*src=["'][^"']+["'][^>]*>/gi) || [];
const urls = body.match(/\/img\/[^"'\s)]+/g) || [];

console.log(`目标     : ${target || path.join(ROOT, 'published', '2026-10-25', 'index.html')}`);
console.log(`HTML 长度: ${html.length}`);
console.log('');
console.log(`正文里的 <img> 标签 : ${imgTags.length}`);
imgTags.forEach((t) => console.log(`   ${t}`));
console.log(`外部脚本引用        : ${scriptSrcs.length}`);
scriptSrcs.forEach((t) => console.log(`   ${t}`));
console.log(`正文里出现的 /img/ URL : ${urls.length}`);
if (urls.length) {
  console.log('   !! 爬虫能直接抓到这些图片链接，图片内容会被送审');
  urls.slice(0, 5).forEach((u) => console.log(`   ${u}`));
}

const ok = urls.length === 0;
console.log('');
console.log(ok
  ? '✓ 爬虫视角：抓不到任何正文图片链接（图片只存在于 JS 里）'
  : `✗ 爬虫视角：能看到 ${urls.length} 个图片链接`);

// 本地产物时顺便确认 manifest JS 里确实装着图片清单
if (!target) {
  const m = html.match(/<script src="(manifest\.[^"]+\.js)"/);
  if (m) {
    const mf = path.join(ROOT, 'published', '2026-10-25', m[1]);
    if (fs.existsSync(mf)) {
      const body2 = fs.readFileSync(mf, 'utf8');
      const n = (body2.match(/\/img\//g) || []).length;
      console.log(`  manifest JS: ${path.basename(mf)}，含 ${n} 个图片 URL（真实浏览器能看到，爬虫看不到）`);
    }
  }
}

process.exit(ok ? 0 : 1);
