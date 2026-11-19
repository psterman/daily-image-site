#!/usr/bin/env node
/** 最小护栏：抽取逻辑坏了就红。 */
import {
  extractArticle,
  safeArticleUrl,
  splitReadingParagraphs,
  isMostlyCjk,
} from '../lib/extract-article.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const html = `<!doctype html><html><head>
<title>演示标题 · 站点名</title>
<meta property="og:title" content="演示标题">
<script>evil()</script><style>.x{}</style>
</head><body>
<nav>导航应丢</nav>
<article>
  <h1>演示标题</h1>
  <p>第一段正文，讲清楚一件小事。</p>
  <p>第二段继续，保证超过四十个字符，好让阈值通过。</p>
</article>
<footer>页脚应丢</footer>
</body></html>`;

const art = extractArticle(html);
assert(art.title === '演示标题', 'title 应从 og:title 取');
assert(art.text.includes('第一段正文'), '应保留 article 正文');
assert(!art.text.includes('evil'), '应剥掉 script');
assert(!/导航应丢/.test(art.text), '应丢掉 nav');
assert(art.chars >= 40, 'chars 应计数');

assert(safeArticleUrl('https://example.com/a') === 'https://example.com/a', 'https ok');
assert(safeArticleUrl('javascript:alert(1)') === '', '挡 javascript');
assert(safeArticleUrl('file:///etc/passwd') === '', '挡 file');

const paras = splitReadingParagraphs(art.text);
assert(paras.length >= 2, '正文应按段拆开');
assert(isMostlyCjk(art.text), '中文样例应判为 CJK');
assert(splitReadingParagraphs('a\n\nb\n\nc').length === 3, '空行分段');
assert(splitReadingParagraphs('').length === 0, '空文本');

console.log('test-extract-article: ok');
