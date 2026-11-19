/**
 * 锁住：OPML/CSV 解析、五格式分桶、cutoff、itemMatchesFormats
 */
import {
  parseOpml,
  parseBlogsCsv,
  classifyFormat,
  isFreshEnough,
  itemMatchesFormats,
  buildCatalogShape,
  FORMAT_KEYS,
  DEFAULT_CUTOFF,
} from '../lib/format-catalog.mjs';

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

const opml = `<?xml version="1.0"?>
<opml version="1.0"><body>
  <outline text="中文播客">
    <outline text="随机播客" type="rss" xmlUrl="https://example.com/pod.xml" htmlUrl="https://example.com/"/>
  </outline>
  <outline text="科技">
    <outline text="某报" xmlUrl="https://wechat2rss.bestblogs.dev/feed/abc.xml" htmlUrl="https://mp.weixin.qq.com/"/>
  </outline>
  <outline text="推特" xmlUrl="https://rsshub.example/twitter/user/foo" htmlUrl="https://x.com/foo"/>
  <outline text="B站" xmlUrl="https://rsshub.example/bilibili/user/video/1" htmlUrl="https://space.bilibili.com/1"/>
</body></opml>`;

const feeds = parseOpml(opml);
check('OPML 抽出 4 条', feeds.length === 4, feeds.length);
check('播客带 folder', feeds[0].folder === '中文播客', feeds[0]);
check('播客分桶', classifyFormat(feeds[0]) === 'podcast', classifyFormat(feeds[0]));
check(
  'BestBlogs 公众号→文章',
  classifyFormat({ ...feeds[1], sourceList: 'bestblogs' }) === 'article',
);
check('twitter URL→note', classifyFormat(feeds[2]) === 'note', classifyFormat(feeds[2]));
check('bilibili→video', classifyFormat(feeds[3]) === 'video', classifyFormat(feeds[3]));
check(
  'cdjax.com 不误判 note',
  classifyFormat({
    name: 'jax',
    url: 'https://cdjax.com/?feed=rss2',
    sourceList: 'timqian',
  }) === 'link',
);
check(
  '音视频博客不进 video',
  classifyFormat({
    name: '音视频开发进阶',
    url: 'https://glumes.com/index.xml',
    sourceList: 'timqian',
    tags: '音视频; 编程',
  }) === 'link',
);
check(
  'BestBlogs xgo.ing → note',
  classifyFormat({
    name: 'OpenAI(@OpenAI)',
    url: 'https://api.xgo.ing/rss/user/0c0856a69f9f49cf961018c32a0b0049',
    sourceList: 'bestblogs-twitter',
    folder: 'twitter',
  }) === 'note',
);

const csv = `Introduction,Address,RSS feed,tags
测试博客,https://blog.example.com/,https://blog.example.com/atom.xml,技术; 生活
坏行,https://x.com/,not-a-url,x
`;
const blogs = parseBlogsCsv(csv);
check('CSV 只收合法 RSS', blogs.length === 1, blogs);
check(
  'timqian→网站 link',
  classifyFormat({ ...blogs[0], sourceList: 'timqian' }) === 'link',
);

const cut = Date.parse(DEFAULT_CUTOFF);
check('今年条目过闸', isFreshEnough(cut + 86400000, DEFAULT_CUTOFF));
check('去年条目不过闸', !isFreshEnough(cut - 86400000, DEFAULT_CUTOFF));
check('无时间不过闸', !isFreshEnough(0, DEFAULT_CUTOFF));

check('空格式选=全过', itemMatchesFormats({ content_type: 'podcast' }, []));
check(
  '格式过滤命中',
  itemMatchesFormats({ content_type: 'podcast' }, ['podcast', 'video']),
);
check(
  '格式过滤未命中',
  !itemMatchesFormats({ content_type: 'article' }, ['podcast']),
);

const cat = buildCatalogShape([
  {
    name: 'A',
    url: 'https://a.example/feed',
    sourceList: 'bestblogs',
    format: 'article',
    newestAt: '2026-06-01T00:00:00.000Z',
  },
  {
    name: 'P',
    url: 'https://p.example/feed',
    sourceList: 'awesome',
    format: 'podcast',
    newestAt: '2026-03-01T00:00:00.000Z',
  },
]);
check('catalog 含全部 key', FORMAT_KEYS.every((k) => Array.isArray(cat.byFormat[k])));
check('counts.article=1', cat.counts.article === 1);
check('counts.podcast=1', cat.counts.podcast === 1);
check('note 桶存在且空', cat.counts.note === 0);

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail === 0 ? 0 : 1);
