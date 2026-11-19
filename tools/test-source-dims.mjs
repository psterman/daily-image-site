/**
 * 源三维标签护栏
 *   node tools/test-source-dims.mjs
 */
import assert from 'node:assert/strict';
import {
  sourceMediaKey,
  sourcePlatformKey,
  isTwitterSource,
  isWeixinSource,
  displaySourceName,
  SRC_MEDIA_CHIPS,
} from '../lib/source-dims.mjs';
import { FORMAT_LABELS } from '../lib/format-catalog.mjs';

assert.equal(FORMAT_LABELS.article, '资讯');
assert.equal(FORMAT_LABELS.note, '短讯');
assert.equal(SRC_MEDIA_CHIPS.find((c) => c.key === 'article').label, '资讯');
assert.equal(SRC_MEDIA_CHIPS.find((c) => c.key === 'note').label, '短讯');

const wx = { name: '财联社', domain: 'mp.weixin.qq.com', contentType: 'article' };
assert.equal(isWeixinSource(wx), true);
assert.equal(isTwitterSource(wx), false);
assert.equal(sourceMediaKey(wx), 'article');
assert.equal(sourcePlatformKey(wx), 'weixin');

const tw = { name: 'Twitter·宝玉', domain: 'x.com', contentType: 'note' };
assert.equal(isTwitterSource(tw), true);
assert.equal(sourceMediaKey(tw), 'note');
assert.equal(sourcePlatformKey(tw), 'twitter');
assert.equal(displaySourceName(tw), '宝玉');

// contentType=note 但不是推特域名 → 仍是短讯媒体，平台不应硬判 Twitter
const odd = { name: '某短讯源', domain: 'example.com', contentType: 'note' };
assert.equal(isTwitterSource(odd), false);
assert.equal(sourceMediaKey(odd), 'note');
assert.equal(sourcePlatformKey(odd), 'website');

const sight = { name: '见闻', domain: 'daily.onetone.app', contentType: 'image' };
assert.equal(sourceMediaKey(sight), 'image');

// 「华尔街见闻」是资讯，不能因名字含「见闻」被判成图片
const wall = { name: '华尔街见闻', domain: 'mp.weixin.qq.com', contentType: 'article' };
assert.equal(sourceMediaKey(wall), 'article');

console.log('ok: test-source-dims');
