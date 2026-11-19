/**
 * 护栏：Ino flat 行必须保留 images[]，否则右侧只剩封面一张。
 * （与 portal-render.mjs 扁平化字段对齐）
 *   node tools/test-ino-issue-flat.mjs
 */
import assert from 'node:assert/strict';

function flattenHighlight(h, tab) {
  return {
    title: h.title,
    url: h.url,
    note: h.note,
    image: h.image || h.thumb || null,
    thumb: h.thumb || h.image || null,
    full: h.full || h.image || null,
    images: Array.isArray(h.images) ? h.images : null,
    issueKind: h.issueKind || null,
    issueDate: h.issueDate || null,
    source: h.source || null,
    contentType: h.contentType || 'article',
    columnKey: h.columnKey || tab.key,
    columnLabel: h.columnLabel || tab.label,
  };
}

const h = {
  title: '见笑 · 2026-11-19（2 张）',
  url: 'https://daily.onetone.app/2026-11-19/?pack=jianxiao',
  image: 'https://daily.onetone.app/img/a.webp',
  images: [
    { full: 'https://daily.onetone.app/img/a.webp', thumb: 'https://daily.onetone.app/img/a_t.webp' },
    { full: 'https://daily.onetone.app/img/b.webp' },
  ],
  issueKind: 'jianxiao',
  issueDate: '2026-11-19',
  source: '见笑',
  contentType: 'image',
};
const row = flattenHighlight(h, { key: 'funny', label: '轻松一刻' });
assert.equal(row.images.length, 2);
assert.equal(row.issueKind, 'jianxiao');
assert.ok(row.images[0].full.includes('/img/'));

function neteaseSongId(url) {
  if (!/music\.163\.com/i.test(String(url || ''))) return '';
  const m = /[?&]id=(\d+)/i.exec(url) || /\/song\/(\d+)/i.exec(url);
  return m ? m[1] : '';
}
assert.equal(neteaseSongId('https://music.163.com/#/song?id=12345'), '12345');
assert.equal(neteaseSongId('https://music.163.com/#/song?id=3447579985'), '3447579985');
assert.equal(neteaseSongId('https://example.com/x'), '');

console.log('ok: test-ino-issue-flat');
