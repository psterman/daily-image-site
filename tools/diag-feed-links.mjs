#!/usr/bin/env node
/**
 * 诊断某个 RSS 源为什么有条目拿不到链接。
 * 用法：node tools/diag-feed-links.mjs <feed-url> [源名]
 */
import { parseFeed } from './fetch-rss.mjs';

const url = process.argv[2];
const name = process.argv[3] || url;

const res = await fetch(url, {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'application/rss+xml, application/xml, text/xml',
  },
});
const xml = await res.text();
const items = parseFeed(xml);

console.log(`源    : ${name}`);
console.log(`URL  : ${url}`);
console.log(`条目  : ${items.length}`);
const noLink = items.filter((it) => !it.link);
console.log(`无链接: ${noLink.length}\n`);

for (const it of noLink.slice(0, 5)) {
  console.log(`  ${it.title.slice(0, 44)}`);
  console.log(`    link=${JSON.stringify(it.link)}  ts=${it.ts}`);
}

// 把原始 XML 里对应的 item 片段抠出来看看
if (noLink.length) {
  const cleaned = xml.replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(cleaned)) && n < 3) {
    const block = m[2];
    const t = /<title>([\s\S]*?)<\/title>/i.exec(block);
    const title = t ? t[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    if (!noLink.some((x) => x.title === title)) continue;
    n++;
    console.log(`\n--- 原始 item 片段（${title.slice(0, 24)}）---`);
    console.log(block.replace(/\t+/g, ' ').slice(0, 600));
  }
}
