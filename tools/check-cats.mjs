#!/usr/bin/env node
/** 校验「见报」目录结构：目录名 ↔ 条目归属是否一致。 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'published/2026-10-26';
const f = fs.readdirSync(dir).find((n) => /^manifest.*\.js$/i.test(n));
const s = fs.readFileSync(path.join(dir, f), 'utf8');
const d = JSON.parse(s.match(/=\s*(\{[\s\S]*\});?\s*$/)[1]);
const news = d.tabs.find((t) => t.key === 'news');
const items = news.items || [];

console.log(`manifest : ${f}`);
console.log(`见报总数 : ${items.length}`);
console.log(`目录列表 : ${(news.tags || []).join(' ')}\n`);

// 目录 ↔ 实际归属交叉表
const cross = new Map();
for (const it of items) {
  const cat = it.tag || '(无)';
  for (const t of it.tags || []) {
    cross.set(`${cat}|${t}`, (cross.get(`${cat}|${t}`) || 0) + 1);
  }
}
console.log('=== category × tags 交叉表 ===');
for (const [k, n] of [...cross.entries()].sort((a, b) => b[1] - a[1])) {
  const [cat, t] = k.split('|');
  const same = cat === t;
  console.log(`  ${same ? '  ' : '≠≠'} category=${cat.padEnd(6)} tags含「${t}」  ${n} 条`);
}

// 每个目录的实际条数
const cnt = new Map();
for (const it of items) for (const t of it.tags || []) cnt.set(t, (cnt.get(t) || 0) + 1);
console.log('\n=== 目录条数（manifest.tags 顺序）===');
for (const t of news.tags || []) {
  const list = items.filter((it) => (it.tags || []).includes(t));
  const srcs = [...new Set(list.map((i) => i.source))];
  console.log(`  ${t.padEnd(6)} ${String(cnt.get(t) || 0).padStart(3)} 条   来源: ${srcs.join('、')}`);
}

// 一致性检查
let bad = 0;
for (const it of items) {
  if (!it.tag) { console.log(`  ! 无 category: ${it.title.slice(0, 30)}`); bad++; continue; }
  if (!(it.tags || []).includes(it.tag)) {
    console.log(`  ! tags 不含自己的 category: ${it.tag} / ${(it.tags || []).join(' ')}`);
    bad++;
  }
}
console.log(`\n归属不一致: ${bad} 条`);
console.log(`伞标签残留: ${['头条', '热榜'].filter((t) => (news.tags || []).includes(t)).join('、') || '无 ✓'}`);
