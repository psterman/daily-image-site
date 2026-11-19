/**
 * 站内见笑/见她/见闻 → 「一天一期」映射护栏（不联网）。
 *   node tools/test-ingest-site-visual.mjs
 */
import assert from 'node:assert/strict';
import { parseDailyManifestJs, siteItemsToRaw } from './ingest-visual-packs.mjs';

const fixture = `window.__DAILY_MANIFEST__=${JSON.stringify({
  date: '2026-11-19',
  siteUrl: 'https://daily.onetone.app',
  tabs: [
    {
      key: 'jianxiao',
      items: [
        { full: '/img/2026-11-19/jianxiao/aaa_001.webp', thumb: '/img/2026-11-19/jianxiao/aaa_001_t.webp' },
        { full: '/img/2026-11-19/jianxiao/bbb_001.webp' },
      ],
    },
    {
      key: 'jianshe',
      items: [
        { full: '/img/2026-11-19/jianshe/ccc_001.webp' },
      ],
    },
    {
      key: 'jianwen',
      items: [
        { full: '/img/2026-11-19/jianwen/ddd_001.webp' },
        { full: '/img/2026-11-19/jianwen/eee_001.webp' },
        { full: '/img/2026-11-19/jianwen/fff_001.webp' },
      ],
    },
  ],
})};`;

const man = parseDailyManifestJs(fixture);
assert.equal(man.date, '2026-11-19');

const rows = siteItemsToRaw(man, 'https://daily.onetone.app/', 10);
assert.equal(rows.length, 3, '见笑+见她+见闻各一期');
assert.equal(rows.filter((r) => r.tagKeys[0] === 'funny').length, 1);
assert.equal(rows.filter((r) => r.tagKeys[0] === 'portrait').length, 1);
assert.equal(rows.filter((r) => r.tagKeys[0] === 'sight').length, 1);

const funny = rows.find((r) => r.tagKeys[0] === 'funny');
assert.equal(funny.images.length, 2);
assert.equal(funny.title, '见笑 · 2026-11-19（2 张）');
assert.equal(funny.link, 'https://daily.onetone.app/2026-11-19/?pack=jianxiao');
assert.equal(funny.issueKind, 'jianxiao');

const sight = rows.find((r) => r.tagKeys[0] === 'sight');
assert.equal(sight.images.length, 3);
assert.equal(sight.title, '见闻 · 2026-11-19（3 张）');
assert.equal(sight.link, 'https://daily.onetone.app/2026-11-19/?pack=jianwen');
assert.equal(sight.source, '见闻');
assert.equal(sight.issueKind, 'jianwen');

const capped = siteItemsToRaw(man, 'https://daily.onetone.app', 1);
assert.equal(capped.find((r) => r.tagKeys[0] === 'sight').images.length, 1);

assert.throws(() => parseDailyManifestJs('not a manifest'), /__DAILY_MANIFEST__/);

console.log('ok: test-ingest-site-visual');
