/**
 * 锁住：完整源目录映射 / 合并 / 域名归一
 */
import {
  domainFromFeedUrl,
  domainForSource,
  packsForTaxonomy,
  buildSourceCatalogEntries,
  mergeSources,
  groupEntriesByTaxonomy,
} from '../lib/source-catalog.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''));
  }
}

check('wechat2rss→微信域', domainFromFeedUrl('https://wechat2rss.bestblogs.dev/feed/x.xml') === 'mp.weixin.qq.com');
check('xgo→x.com', domainFromFeedUrl('https://api.xgo.ing/rss/user/1') === 'x.com');
check('ai→ai包', packsForTaxonomy('ai').join() === 'ai');
check('deep→design', packsForTaxonomy('deep').join() === 'design');
check('fun不进包', packsForTaxonomy('fun').join() === '');
check('hot只进热议', packsForTaxonomy('hot').join() === 'hot');
check('current→news', packsForTaxonomy('current').join() === 'news');

const entries = buildSourceCatalogEntries({
  feeds: [
    { name: '机器之心', url: 'https://wechat2rss.bestblogs.dev/feed/a.xml', contentType: 'article' },
    { name: 'Twitter·宝玉', url: 'https://api.xgo.ing/rss/user/1', contentType: 'note' },
  ],
  sourceCategory: { 机器之心: 'ai', 'Twitter·宝玉': 'ai' },
});
check('条目 2', entries.length === 2, entries.length);
check('带 packs', entries[0].packs.includes('ai'));
check('taxonomyLabel', entries[0].taxonomyLabel === '智能');

const merged = mergeSources(
  [{ name: '精选A', domain: 'a.com' }],
  [{ name: '精选A', domain: 'a.com' }, { name: '扩B', domain: 'b.com' }],
);
check('合并去重', merged.length === 2 && merged[0].name === '精选A' && merged[1].name === '扩B');
check('微博图标域', domainForSource('微博热搜', '') === 'weibo.com');
check('小红书图标域', domainForSource('小红书热榜', '') === 'xiaohongshu.com');

const grouped = groupEntriesByTaxonomy(
  [
    { name: 'a', taxonomy: 'hot', taxonomyLabel: '热议' },
    { name: 'b', taxonomy: 'fun', taxonomyLabel: '生活' },
  ],
  [{ key: 'hot' }, { key: 'fun' }],
);
check('分组标题', grouped[0].label === '热议' && grouped[1].label === '生活', grouped.map((g) => g.label));

console.log(fail ? `FAIL ${fail}` : `OK ${pass}`);
process.exit(fail ? 1 : 0);
