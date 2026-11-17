#!/usr/bin/env node
/**
 * 见报跨源去重的单元测试
 *
 * 用法：node tools/test-news-dedupe.mjs
 * 退出码：0 = 全过；1 = 有失败
 *
 * 为什么要有这组用例（2026-11-05）：
 * V2EX 热榜有两个渠道 —— 头条（Python 抓 www.v2ex.com/?tab=hot）和
 * RSS（RSS屋 的镜像）。两边是同一份热榜，同一个链接。
 * 不去重的话同一天会看到同一条新闻两遍（10-26 / 10-28 那两期头条抓成功了）。
 */
import { dedupeNewsItems, linkKey } from './news-dedupe.mjs';
import { normalizeLink } from './fetch-rss.mjs';

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  -> ' + extra : ''}`);
  }
}

function eq(name, actual, expected) {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`,
  );
}

const item = (title, link, source = '某源') => ({ title, link, source });

console.log('\n跨源去重');
{
  // 1) 头条和 RSS 收录同一篇 V2EX 帖子 —— 链接只差一个锚点
  const r = dedupeNewsItems([
    item('V2EX 帖子 A', 'https://www.v2ex.com/t/123456#reply10', 'V2EX 热榜'),
    item('V2EX 帖子 A', 'https://www.v2ex.com/t/123456', 'V2EX 热榜'),
  ]);
  eq('同一篇文章（只差 #reply10 锚点）只留一条', r.items.length, 1);
  eq('去重条数被记下来', r.duplicates, 1);
  check('留的是先出现的那条', r.items[0].source === 'V2EX 热榜');
}

{
  // 2) 追踪参数不同也算同一篇
  const r = dedupeNewsItems([
    item('文章 X', 'https://example.com/a?utm_source=rss&utm_medium=feed', 'RSS 源'),
    item('文章 X', 'https://example.com/a', '头条源'),
  ]);
  eq('带 utm 参数的同一篇被去掉', r.items.length, 1);
}

{
  // 3) 不同文章都要留着
  const r = dedupeNewsItems([
    item('文章 X', 'https://example.com/a', '源1'),
    item('文章 Y', 'https://example.com/b', '源2'),
  ]);
  eq('不同链接的两条都留着', r.items.length, 2);
  eq('没有重复', r.duplicates, 0);
}

{
  // 4) 没有链接的条目按标题判重
  const r = dedupeNewsItems([
    item('没有链接的标题', '', '源1'),
    item('没有链接的标题', '', '源2'),
    item('另一个标题', '', '源3'),
  ]);
  eq('同标题的没链接条目只留一条', r.items.length, 2);
}

{
  // 5) 顺序不能变（先出现的排前面）
  const r = dedupeNewsItems([
    item('第一条', 'https://example.com/1', '源1'),
    item('第二条', 'https://example.com/2', '源2'),
  ]);
  eq('顺序保持原样', r.items.map((i) => i.title), ['第一条', '第二条']);
}

console.log('\n判重键跟 RSS 侧一致');
{
  // 手抄一份归一化规则 = 迟早漂移（项目踩过这个坑）。这里钉住：两边必须算出同一个键。
  eq(
    '键跟 fetch-rss 的 normalizeLink 一致',
    linkKey({ title: 't', link: 'https://WWW.Example.com/a/?utm_source=x#frag' }),
    normalizeLink('https://WWW.Example.com/a/?utm_source=x#frag')
  );
  check('两个不同 URL 不会撞键', linkKey({ link: 'https://a.com/x' }) !== linkKey({ link: 'https://a.com/y' }));
}

console.log('\n边界');
{
  eq('空数组', dedupeNewsItems([]).items.length, 0);
  const r = dedupeNewsItems([item('没有链接也没有标题', '', '源')]);
  eq('既没链接也没标题的条目不丢', r.items.length, 1);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
