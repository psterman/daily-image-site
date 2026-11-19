/**
 * 锁住 BestBlogs / timqian 分类映射与名称归一。
 */
import {
  BESTBLOGS_TO_TAXONOMY,
  parseBestblogsWechatMd,
  lookupBestblogs,
  bestblogsCategoryToTaxonomy,
  timqianTagsToTaxonomy,
  twitterDisplayName,
  normName,
} from '../lib/bestblogs-taxonomy.mjs';

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

const md = `
### 人工智能（2 个）
| 名称 | 优先级 | 描述 |
| --- | --- | --- |
| 机器之心 | 高 | x |
| 硅 星 人 Pro | 中 | y |

### 体育运动（1 个）
| 名称 | 优先级 | 描述 |
| --- | --- | --- |
| 体坛周报 | 普通 | z |
`;

const table = parseBestblogsWechatMd(md);
check('解析 3 名', table.size === 3, table.size);
check('空格归一命中', !!lookupBestblogs('硅星人Pro', table));
check('AI→ai', bestblogsCategoryToTaxonomy('人工智能') === 'ai');
check('体育→null', bestblogsCategoryToTaxonomy('体育运动') === null);
check('九类齐全', Object.keys(BESTBLOGS_TO_TAXONOMY).length === 9);
check('timqian AI', timqianTagsToTaxonomy('AI;随笔') === 'ai');
check('timqian 默认 deep', timqianTagsToTaxonomy('') === 'deep');
check('Twitter 名', twitterDisplayName('orange.ai(@oran_ge)') === 'Twitter·orange.ai');
check('normName', normName('硅 星') === '硅星');

console.log(fail ? `FAIL ${fail}` : `OK ${pass}`);
process.exit(fail ? 1 : 0);
