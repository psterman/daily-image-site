#!/usr/bin/env node
/** 检查 manifest 里 needLogin 标记是否正确。 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'published/2026-10-26';
const f = fs
  .readdirSync(dir)
  .find((n) => /^manifest.*\.js$/i.test(n));
const s = fs.readFileSync(path.join(dir, f), 'utf8');
const d = JSON.parse(s.match(/=\s*(\{[\s\S]*\});?\s*$/)[1]);
const news = d.tabs.find((t) => t.key === 'news');
const items = news.items || [];

console.log(`manifest : ${f}`);
console.log(`见报条数 : ${items.length}`);

const bySrc = new Map();
for (const it of items) {
  const k = `${it.source}|${it.needLogin ? 'auth' : 'open'}`;
  bySrc.set(k, (bySrc.get(k) || 0) + 1);
}
console.log('\n=== 按来源（open=直接可读 / auth=需登录）===');
for (const [k, n] of [...bySrc.entries()].sort((a, b) => b[1] - a[1])) {
  const [src, kind] = k.split('|');
  console.log(`  ${src.padEnd(14)} ${kind.padEnd(5)} ${n}`);
}

// 交叉验证：域名判定 vs 实际链接
import { needsLogin } from './link-auth.mjs';
let mismatch = 0;
for (const it of items) {
  const want = needsLogin(it.link);
  if (want !== (it.needLogin === true)) {
    mismatch++;
    console.log(`  ! 标记不一致 ${it.source} ${it.link} manifest=${it.needLogin} 判定=${want}`);
  }
}
console.log(`\n标记与域名判定不一致: ${mismatch} 条`);

// 反向检查：需要登录的源，是否都带链接
const noLink = items.filter((it) => !it.link || !/^https?:\/\//i.test(it.link));
console.log(`无有效链接条目: ${noLink.length} 条`);
if (noLink.length) noLink.slice(0, 5).forEach((it) => console.log(`  [${it.source}] ${it.title}`));
