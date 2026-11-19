#!/usr/bin/env node
/** 按需全文分流护栏：分类 + 三策略假数据。 */
import {
  classifyFulltextUrl,
  extractTweetId,
} from '../lib/fulltext-fetch.mjs';
import {
  extractWechatArticle,
  extractBilibiliRead,
  tweetJsonToText,
  safeArticleUrl,
  toReadingHtml,
  extractArticle,
  splitReadingParagraphs,
} from '../lib/extract-article.mjs';
import { isTwitterLikeUrl, cleanSummary, MAX_SUMMARY_TWEET } from '../lib/ingest-map.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(classifyFulltextUrl('https://mp.weixin.qq.com/s/abc') === 'wechat', 'wechat classify');
assert(
  classifyFulltextUrl('https://x.com/user/status/1234567890123456789') === 'twitter',
  'x.com classify',
);
assert(
  classifyFulltextUrl('https://twitter.com/user/status/1234567890123456789') === 'twitter',
  'twitter.com classify',
);
assert(
  classifyFulltextUrl('https://www.bilibili.com/read/cv123456') === 'bilibili_read',
  'bilibili read classify',
);
assert(
  classifyFulltextUrl('https://www.bilibili.com/video/BV1xx') === 'generic',
  'bilibili video is generic',
);
assert(classifyFulltextUrl('https://sspai.com/post/1') === 'generic', 'generic classify');
assert(
  extractTweetId('https://x.com/foo/status/1234567890123456789') === '1234567890123456789',
  'tweet id',
);

const wxHtml = `<!doctype html><html><head>
<meta property="og:title" content="微信标题">
</head><body>
<div id="js_content"><p>第一段微信正文，这里写得足够长，方便护栏检查正文抽取是否完整可用。</p><p>第二段继续补充说明，仍然保持可读的长度。</p></div>
</body></html>`;
const wx = extractWechatArticle(wxHtml);
assert(wx.title === '微信标题', 'wechat title');
assert(wx.text.includes('第一段微信正文'), 'wechat body');
assert(wx.chars >= 40, 'wechat chars');

const biliHtml = `<!doctype html><html><head><title>专栏标题</title></head><body>
<div class="article-content"><p>B站专栏第一段，这里写得足够长，方便护栏检查正文抽取是否完整可用。</p><p>第二段继续补充说明内容。</p></div>
</body></html>`;
const bili = extractBilibiliRead(biliHtml);
assert(bili.text.includes('B站专栏第一段'), 'bilibili body');

const tweet = tweetJsonToText({
  text: '短推文正文内容足够长一些',
  user: { name: '测试号', screen_name: 'test' },
  quoted_tweet: { text: '被引用的内容', user: { screen_name: 'other' } },
});
assert(tweet.text.includes('短推文正文'), 'tweet text');
assert(tweet.text.includes('引用'), 'tweet quote');
assert(tweet.chars > 10, 'tweet chars');

const longNote = tweetJsonToText({
  note_tweet: { text: '这是一条超长推文正文，用来验证 note_tweet 优先于 text 字段。' },
  text: '被截断的预览…',
  user: { name: '长文' },
});
assert(longNote.text.includes('超长推文正文'), 'note_tweet wins');
assert(!longNote.text.includes('被截断的预览'), 'preview discarded');

assert(isTwitterLikeUrl('https://x.com/a/status/1'), 'isTwitter x');
assert(isTwitterLikeUrl('https://api.xgo.ing/foo', 'Twitter·宝玉'), 'isTwitter xgo');
const twSum = cleanSummary('x'.repeat(400), '', { url: 'https://x.com/a/status/1' });
assert(twSum.length === MAX_SUMMARY_TWEET, 'tweet summary cap 280');
const artSum = cleanSummary('y'.repeat(400), '');
assert(artSum.length === 160, 'article summary still 160');

assert(safeArticleUrl('javascript:alert(1)') === '', 'safe url');

const rich = toReadingHtml(
  `<div><p>你好<a href="/x">链接</a></p><img data-src="https://example.com/a.jpg" alt="图"><script>evil()</script></div>`,
  'https://example.com/post/1',
);
assert(rich.includes('<p>'), 'reading html keeps p');
assert(rich.includes('href="https://example.com/x"'), 'reading html abs link');
assert(rich.includes('src="https://example.com/a.jpg"'), 'reading html lazy img');
assert(!rich.includes('script'), 'reading html drops script');
assert(!rich.includes('evil'), 'reading html drops script body');

const wall = '甲'.repeat(50) + '。' + '乙'.repeat(50) + '。' + '丙'.repeat(50) + '。';
assert(splitReadingParagraphs(wall).length >= 2, 'dense cjk splits');

const packed = extractArticle(
  `<html><body><article><p>段一有图<img src="https://cdn.example/x.png"></p><p>段二有<a href="https://v2ex.com/t/1">链接</a></p></article></body></html>`,
  { baseUrl: 'https://v2ex.com/' },
);
assert(packed.html.includes('<img'), 'extract keeps img in html');
assert(packed.html.includes('v2ex.com'), 'extract keeps link host');

console.log('test-fulltext-fetch: ok');
