#!/usr/bin/env node
/**
 * 检查见报 tab 里每条新闻的链接是否可用（能跳到原文）。
 * 用法：node tools/check-links.mjs [url]
 */
const URL_ = process.argv[2] || 'https://example.com/';

const root = await (await fetch(URL_)).text();
const mUrl = root.match(/src="(\/[^"]*manifest[^"]*\.js)"/)[1];
const s = await (await fetch(new URL(mUrl, URL_))).text();
const d = JSON.parse(s.match(/=\s*(\{[\s\S]*\});?\s*$/)[1]);

const news = d.tabs.find((t) => t.key === 'news');
const items = news.items || [];
const isBad = (it) => !it.link || !/^https?:\/\//.test(it.link);
const bad = items.filter(isBad);

console.log(`manifest : ${mUrl}`);
console.log(`见报总数 : ${items.length}`);
console.log(`链接无效 : ${bad.length}\n`);

const bySrc = new Map();
for (const it of items) {
  const v = bySrc.get(it.source) || { n: 0, bad: 0 };
  v.n++;
  if (isBad(it)) v.bad++;
  bySrc.set(it.source, v);
}
console.log('=== 无效链接按来源 ===');
[...bySrc.entries()]
  .filter(([, v]) => v.bad > 0)
  .sort((a, b) => b[1].bad - a[1].bad)
  .forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${v.bad}/${v.n}`));

console.log('\n=== 无效链接样例 ===');
bad.slice(0, 8).forEach((it) =>
  console.log(`  [${it.source}] ${it.title.slice(0, 36)}  link=${JSON.stringify(it.link)}`),
);

// 抽样探测：能不能真的打开（GET + 浏览器 UA，每个源抽一条）
//
// 注意：用 HEAD + 默认 UA 探测会得到一堆假的 403 ——
// 知乎、V2EX 这类站对无 Cookie 的裸请求一律拒绝，
// 但用户在浏览器里点进去是正常的。所以这里必须带 UA 用 GET。
if (process.argv.includes('--probe')) {
  console.log('\n=== 抽样探测可访问性（GET + 浏览器 UA，每源一条）===');
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const seen = new Set();
  for (const it of items) {
    if (isBad(it) || seen.has(it.source)) continue;
    seen.add(it.source);
    try {
      const r = await fetch(it.link, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      });
      const body = r.status === 200 ? await r.text() : '';
      const titleM = body.match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i);
      console.log(
        `  ${String(r.status).padEnd(4)} ${it.source.padEnd(14)} ` +
          `${(titleM ? titleM[1].trim().replace(/\s+/g, ' ').slice(0, 40) : '').padEnd(42)} ${it.link.slice(0, 58)}`,
      );
    } catch (e) {
      console.log(`  ERR  ${it.source.padEnd(14)} ${it.link.slice(0, 58)}  ${e.message.slice(0, 30)}`);
    }
  }
}
