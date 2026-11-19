/**
 * extractChannelAvatar / NewsNow 摘要·角标 自检
 *   node tools/test-channel-avatar.mjs
 */
import assert from 'node:assert/strict';
import { extractChannelAvatar } from './fetch-rss.mjs';
import { normalizeItem } from './fetch-newsnow.mjs';

const xml = `<?xml version="1.0"?><rss><channel>
<title>半导体行业观察</title>
<image><url>https://wx.qlogo.cn/mmhead/abc/0</url><title>x</title><link>https://mp.weixin.qq.com/</link></image>
<item><title>一则</title><link>https://mp.weixin.qq.com/s/1</link>
<description>&lt;img src="https://mmbiz.qpic.cn/cover.jpg"/&gt;摘要正文</description>
</item></channel></rss>`;

assert.equal(
  extractChannelAvatar(xml, 'https://wechat2rss.bestblogs.dev/feed/x.xml'),
  'https://wx.qlogo.cn/mmhead/abc/0',
);

const it = normalizeItem({
  title: '话题',
  url: 'https://s.weibo.com/weibo?q=1',
  extra: { info: '123万', hover: '讨论升温', icon: { url: 'https://example.com/hot.png' } },
}, '微博热搜');
assert.equal(it.desc, '讨论升温');
assert.equal(it.imgs.length, 0); // 角标不当正文缩略图
assert.match(it.channelAvatar, /weibo\.com/);

console.log('ok extractChannelAvatar + newsnow summary/avatar');
