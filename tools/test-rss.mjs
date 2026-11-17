#!/usr/bin/env node
/**
 * RSS 解析器单元测试
 *
 * 用法：node tools/test-rss.mjs
 * 退出码：0 = 全过；1 = 有失败
 */
import http from 'node:http';
import { parseFeed, looksLikeFeed, normalizeLink, probeFeed, fetchHeadlines, fmtTime } from './fetch-rss.mjs';

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

/* ────────────────────── RSS 2.0 ────────────────────── */
console.log('\nRSS 2.0');
const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>测试源</title>
    <item>
      <title><![CDATA[带 CDATA 的标题]]></title>
      <link>https://example.com/a?utm_source=rss&amp;utm_medium=feed</link>
      <pubDate>Sun, 25 Oct 2026 08:30:00 +0800</pubDate>
      <category>科技</category>
      <category><![CDATA[效率]]></category>
      <description><![CDATA[<p>带 <b>HTML</b> 标签的摘要 &amp; 实体</p>]]></description>
    </item>
    <item>
      <title>第二条</title>
      <link>https://example.com/b</link>
      <pubDate>Sat, 24 Oct 2026 09:00:00 +0800</pubDate>
    </item>
    <item>
      <title>没有链接的条目</title>
    </item>
  </channel>
</rss>`;

const items = parseFeed(rss);
eq('条目数', items.length, 3);
eq('CDATA 标题被解包', items[0].title, '带 CDATA 的标题');
eq('HTML 实体被解码', items[0].link, 'https://example.com/a?utm_source=rss&utm_medium=feed');
eq('RFC822 日期被解析', new Date(items[0].ts).toISOString(), '2026-10-25T00:30:00.000Z');
eq('description 里的 HTML 被剥掉', items[0].desc, '带 HTML 标签的摘要 & 实体');
eq('category 列表', items[0].categories, ['科技', '效率']);
eq('第二条正常', items[1].title, '第二条');
eq('没标题的条目被丢掉', items.length, 3);

/* ────────────────────── Atom ────────────────────── */
console.log('\nAtom');
const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 测试</title>
  <entry>
    <title>Atom 条目标题</title>
    <link rel="alternate" type="text/html" href="https://example.org/post-1"/>
    <published>2026-10-25T10:00:00Z</published>
    <updated>2026-10-25T11:30:00Z</updated>
    <category term="技术"/>
    <summary>一段摘要</summary>
  </entry>
  <entry>
    <title>第二条 Atom</title>
    <link href="https://example.org/post-2"/>
    <updated>2026-10-24T10:00:00Z</updated>
  </entry>
</feed>`;

const aitems = parseFeed(atom);
eq('Atom 条目数', aitems.length, 2);
eq('Atom 的 href 链接被取到', aitems[0].link, 'https://example.org/post-1');
eq('Atom ISO 日期被解析', new Date(aitems[0].ts).toISOString(), '2026-10-25T10:00:00.000Z');
eq('Atom category term 被取到', aitems[0].categories, ['技术']);
eq('Atom summary 被取到', aitems[0].desc, '一段摘要');
eq('Atom 第二条', aitems[1].link, 'https://example.org/post-2');

/* ────────────────────── 实体与杂项 ────────────────────── */
console.log('\n实体与杂项');
eq(
  '数字实体',
  parseFeed('<rss><channel><item><title>&#72;&#x65;&#108;&#108;&#111;</title></item></channel></rss>')[0].title,
  'Hello',
);
eq(
  '命名实体',
  parseFeed('<rss><channel><item><title>A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#39;</title></item></channel></rss>')[0].title,
  `A & B <C> "D" 'E'`,
);
eq(
  '转义过的 HTML 摘要不会露出标签',
  parseFeed(
    '<rss><channel><item><title>t</title><description>&lt;p data-vmark="6f88"&gt;正文 &amp;amp; 实体&lt;/p&gt;</description></item></channel></rss>',
  )[0].desc,
  '正文 & 实体',
);
eq(
  '正文里的比较号不会被当成标签',
  parseFeed('<rss><channel><item><title>t</title><description>5 < 10 &gt; 3</description></item></channel></rss>')[0].desc,
  '5 < 10 > 3',
);
eq(
  '注释里的 item 不算',
  parseFeed('<rss><!-- <item><title>注释里的</title></item> --><channel><item><title>真的</title></item></channel></rss>').length,
  1,
);
eq('空输入返回空数组', parseFeed('').length, 0);
eq('非字符串返回空数组', parseFeed(null).length, 0);

/* ────────────────────── 是不是 RSS ────────────────────── */
console.log('\n是不是 RSS');
check('RSS 认得出来', looksLikeFeed(rss));
check('Atom 认得出来', looksLikeFeed(atom));
check('反爬 HTML 被识破', !looksLikeFeed('<!DOCTYPE html><html><head><title>Just a moment</title></head></html>'));
check('空字符串不算', !looksLikeFeed(''));

/* ────────────────────── 链接归一化 ────────────────────── */
console.log('\n链接归一化');
eq('去掉 utm 参数', normalizeLink('https://example.com/a?utm_source=rss&utm_medium=feed'), 'https://example.com/a');
eq('去掉 hash', normalizeLink('https://example.com/a#top'), 'https://example.com/a');
eq(
  'utm 与 hash 一起去',
  normalizeLink('https://example.com/a?utm_source=rss#top'),
  'https://example.com/a',
);
eq('保留有意义的参数', normalizeLink('https://example.com/a?id=7'), 'https://example.com/a?id=7');
eq('非 URL 当普通字符串处理', normalizeLink('not a url'), 'not a url');
eq('空链接返回空', normalizeLink(''), '');

/* ────────────────────── 抓取重试 ──────────────────────
 *
 * 为什么要有这组用例（2026-11-05）：
 * 国内站点到本机的链路会间歇性超时/断连。抓取器没有重试的时候，
 * 一次跑下来 15 个源里有 5 个超时，当天的新闻条数直接少三分之一，
 * 而且日志只写「抓取失败」，看不出是网络抖了还是源真的挂了。
 *
 * 但重试不能无脑做：HTTP 404 和「200 但返回反爬页」重试多少次结果都一样，
 * 那种情况重试只是白等 —— 所以要验证「该重试的重试、不该重试的不重试」。
 */
console.log('\n抓取重试');

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>临时源</title>
<item><title>临时条目</title><link>https://example.com/t</link></item>
</channel></rss>`;

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/feed` });
    });
  });
}

// 1) 第一次连接被重置，第二次正常 —— 必须重试并拿到内容
{
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    if (hits === 1) {
      req.socket.destroy(); // 模拟 ECONNRESET
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(FEED_XML);
  });
  const r = await probeFeed(url, 5000);
  check('连接被重置后重试并成功', r.ok && r.count === 1, JSON.stringify({ ok: r.ok, count: r.count, error: r.error }));
  check('确实重试过（请求数 = 2）', hits === 2, `实际请求数=${hits}`);
  server.close();
}

// 2) HTTP 404 —— 站点自己的回答，不该重试
{
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    res.writeHead(404);
    res.end('not found');
  });
  const r = await probeFeed(url, 5000);
  check('404 判为抓不到', !r.ok && /404/.test(r.error), r.error);
  check('404 不重试（请求数 = 1）', hits === 1, `实际请求数=${hits}`);
  server.close();
}

// 3) 200 但返回的是反爬 HTML —— 也不该重试
{
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><head><title>Just a moment</title></head></html>');
  });
  const r = await probeFeed(url, 5000);
  check('反爬页判为抓不到', !r.ok && /不是 RSS/.test(r.error), r.error);
  check('反爬页不重试（请求数 = 1）', hits === 1, `实际请求数=${hits}`);
  server.close();
}

// 4) 服务器不响应 —— 超时是用户看得见的契约（构建日志里写「超时 300ms」），
//    而且超时属于网络层失败，必须重试满 3 次
{
  let hits = 0;
  const { server, url } = await startServer(() => {
    hits++;
    // 故意不响应，让客户端超时
  });
  const r = await probeFeed(url, 300);
  check('超时判为抓不到', !r.ok && /超时 300ms/.test(r.error), r.error);
  check('超时重试满 3 次（请求数 = 3）', hits === 3, `实际请求数=${hits}`);
  server.close();
}

// 5) 服务器只认 `Accept: */*` —— 窄 Accept 回 406，要退回去再试一次，
//    而且这次回退**不能消耗重试次数**（它不是失败，是换一种请求方式）
{
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    if ((req.headers.accept || '') === '*/*') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(FEED_XML);
      return;
    }
    res.writeHead(406);
    res.end('not acceptable');
  });
  const r = await probeFeed(url, 5000);
  check(
    '406 退回宽 Accept 后能抓到',
    r.ok && r.count === 1,
    JSON.stringify({ ok: r.ok, count: r.count, error: r.error }),
  );
  check('406 回退不消耗重试次数（请求数 = 2）', hits === 2, `实际请求数=${hits}`);
  server.close();
}

/* ────────────────────── 过期条目闸门 ──────────────────────
 *
 * 为什么要有这组用例（2026-11-05 评审加）：
 * 页面只显示 `MM-DD HH:mm`，没有年份。源一旦停更（镜像挂了），
 * 去年/上个月的文章看起来跟今天的一模一样 —— 知乎日报旧镜像就是这样
 * （最新条目停在 2025-09-16，页面显示成「09-16」）。
 * 所以过期条目直接丢掉：源停更 = 整源从见报里消失（看得见的故障）。
 */
console.log('\n过期条目闸门');
{
  const now = Date.now();
  const mixed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>新旧混合</title>
<item><title>今天的中文条目</title><link>https://example.com/new</link><pubDate>${new Date(now - 3600000).toUTCString()}</pubDate></item>
<item><title>一个月前的旧条目</title><link>https://example.com/old</link><pubDate>${new Date(now - 30 * 86400000).toUTCString()}</pubDate></item>
</channel></rss>`;
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(mixed);
  });
  const base = { enabled: true, perFeed: 10, maxItems: 45, timeoutMs: 5000, maxAgeDays: 10 };

  const r = await fetchHeadlines({ ...base, feeds: [{ name: '过期测试源', url }] });
  check(
    '过期条目被丢掉',
    r.items.length === 1 && r.items[0].title === '今天的中文条目',
    r.items.map((i) => i.title),
  );
  check(
    '丢了几条要记进 stale（不能静悄悄地少内容）',
    r.stale && r.stale.length === 1 && r.stale[0].dropped === 1,
    JSON.stringify(r.stale),
  );

  // 单个源可以放宽（阮一峰是周刊，10 天太紧）
  const r2 = await fetchHeadlines({ ...base, feeds: [{ name: '放宽测试源', url, maxAgeDays: 60 }] });
  check('单个源可以放宽过期阈值', r2.items.length === 2, r2.items.length);

  // 不配 maxAgeDays = 不限（老配置不该突然少内容）
  const r3 = await fetchHeadlines({
    enabled: true, perFeed: 10, maxItems: 45, timeoutMs: 5000,
    feeds: [{ name: '不限测试源', url }],
  });
  check('没配 maxAgeDays 就不丢条目', r3.items.length === 2, r3.items.length);
  server.close();
}

/* ────────────────────── 旧条目显示年份 ────────────────────── */
console.log('\n条目时间的年份');
{
  const now = Date.now();
  const fresh = fmtTime(now - 3600000);
  check('7 天内的条目只显示 MM-DD', /^\d\d-\d\d \d\d:\d\d$/.test(fresh), fresh);
  const old = fmtTime(now - 30 * 86400000);
  check('超过 7 天的条目带年份', /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(old), old);
  eq('没有时间就返回空', fmtTime(0), '');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
