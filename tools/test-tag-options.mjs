/**
 * 锁住：目录 / 标签选项唯一真相源（lib ↔ json ↔ seed ↔ taxonomy chips）
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIRECTORIES, TAG_OPTIONS, NEWS_CHIPS, toCoreTagPacks,
  normalizeSourceSelection, hydrateSourceSelection, itemMatchesSources, defaultSourceNames,
  domainMatches, sourcesForTag, curatedSourcesForTag,
} from '../lib/tag-options.mjs';
import { CORE_TAG_PACKS } from '../lib/platform-model.mjs';
import { SOURCE_CATALOG } from '../lib/source-catalog-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

const json = JSON.parse(readFileSync(path.join(ROOT, 'tools/tag-options.json'), 'utf8'));
const tax = JSON.parse(readFileSync(path.join(ROOT, 'tools/news-taxonomy.json'), 'utf8'));
const seed = readFileSync(path.join(ROOT, 'db/seed-core.sql'), 'utf8');

check('目录 7 个（无综合）', DIRECTORIES.length === 7 && !DIRECTORIES.some((d) => d.key === '综合'), DIRECTORIES.map((d) => d.key));
check('资讯版块在首', DIRECTORIES[0]?.key === '资讯');
check('新闻速览在资讯', TAG_OPTIONS.find((t) => t.key === 'news')?.directory === '资讯');
check('热议在社区', TAG_OPTIONS.find((t) => t.key === 'hot')?.directory === '社区');
{
  const techN = curatedSourcesForTag('tech').map((s) => s.name);
  const ossN = curatedSourcesForTag('opensource').map((s) => s.name);
  check('科技精选含 GitHub/V2EX', techN.includes('GitHub趋势') && techN.includes('V2EX'), techN.slice(0, 6));
  check('开源精选不含 GitHub/V2EX', !ossN.includes('GitHub趋势') && !ossN.includes('V2EX'), ossN);
}
check('标签 11 个', TAG_OPTIONS.length === 11, TAG_OPTIONS.map((t) => t.key));
check('json 目录数一致', json.directories.length === DIRECTORIES.length);
check('json 标签数一致', json.tags.length === TAG_OPTIONS.length);

for (const t of TAG_OPTIONS) {
  const j = json.tags.find((x) => x.key === t.key);
  check(`json↔lib ${t.key}`, !!j && j.label === t.label && j.directory === t.directory);
  check(`标签挂在已知目录 ${t.key}`, DIRECTORIES.some((d) => d.key === t.directory));
  check(`seed 含 ${t.key}`, new RegExp(`\\('${t.key}'\\s*,`).test(seed));
  check(`${t.key} 有来源标签`, Array.isArray(t.sources) && t.sources.length >= 2, t.sources?.length);
  check(`${t.key} 来源含 name+domain`, (t.sources || []).every((s) => s.name && s.domain));
  check(`${t.key} json 来源数一致`, (j?.sources || []).length === (t.sources || []).length);
}

const cores = toCoreTagPacks();
check('CORE_TAG_PACKS 长度', CORE_TAG_PACKS.length === cores.length);
check('CORE 与 TAG_OPTIONS 同 key',
  CORE_TAG_PACKS.every((p, i) => p.key === cores[i].key && p.group_name === cores[i].group_name));

check('见报 chip 10 个', NEWS_CHIPS.length === 10);
check('newsChips ↔ taxonomy',
  NEWS_CHIPS.every((c, i) => tax.categories[i]?.key === c.key && tax.categories[i]?.label === c.label),
  NEWS_CHIPS.map((c) => c.key));

const o2hKeep = (json.boardDirectories.open2hub || []).filter((x) => x.keep);
const rbKeep = (json.boardDirectories.rebang || []).filter((x) => x.keep);
check('open2hub 可选项 > 0', o2hKeep.length >= 8, o2hKeep.map((x) => x.key));
check('rebang 可选项 > 0', rbKeep.length >= 6, rbKeep.map((x) => x.key));
check('不收录购物/体育/汽车',
  json.boardDirectories.open2hub.filter((x) => !x.keep).map((x) => x.key).includes('体育') &&
  json.boardDirectories.rebang.some((x) => x.key === '购物' && !x.keep));

console.log('\n── 子来源勾选 ──');
{
  const all = defaultSourceNames('hot');
  check('hot 默认来源 ≥ 5', all.length >= 5, all.length);
  check('热议含微博抖音', all.includes('微博热搜') && all.includes('抖音热榜'));
  check('热议含小红书', all.includes('小红书热榜'));
  check('热议不含时政路透', !all.includes('路透中文'));
  check('热议不含播客故事FM', !all.includes('故事FM'));
  check('见报 fun=生活', NEWS_CHIPS.find((c) => c.key === 'fun')?.label === '生活');
  check('内容包 hot=热议', TAG_OPTIONS.find((t) => t.key === 'hot')?.label === '热议');
  check('轻松一刻仍是 funny', TAG_OPTIONS.find((t) => t.key === 'funny')?.label === '轻松一刻');
  check('空选回落全量', normalizeSourceSelection('hot', []).length === all.length);
  check('非法名剔除', normalizeSourceSelection('hot', ['微博热搜', '不存在的源']).join() === '微博热搜');
  check('publisher 命中', itemMatchesSources(
    { metadata: { publisher: '百度热搜' }, canonical_url: 'https://www.baidu.com/s' },
    ['百度热搜'], 'hot',
  ));
  check('domain 命中', itemMatchesSources(
    { metadata: { publisher: '其它' }, canonical_url: 'https://weibo.com/x' },
    ['微博热搜'], 'hot',
  ));
  check('未勾选源不命中', !itemMatchesSources(
    { metadata: { publisher: '知乎热榜' }, canonical_url: 'https://zhihu.com/x' },
    ['微博热搜'], 'hot',
  ));
  check('AIHOT 与 AIHOT精选可互认', itemMatchesSources(
    { metadata: { publisher: 'AIHOT' }, canonical_url: 'https://aihot.news/items/x' },
    ['AIHOT精选'], 'ai',
  ));
  check('新智元不吃 AIHOT', !itemMatchesSources(
    { metadata: { publisher: 'AIHOT' }, canonical_url: 'https://aihot.news/items/x' },
    ['新智元'], 'ai',
  ));
  check('旧全选并入 AIHOT精选', hydrateSourceSelection(
    'ai',
    ['机器之心', '量子位', '新智元', '晚点LatePost', 'AI前线', 'APPSO'],
    6,
  ).includes('AIHOT精选'));
  check('用户缩减不强制并入', !hydrateSourceSelection(
    'ai',
    ['机器之心', '量子位'],
    7,
  ).includes('AIHOT精选'));
  check('appinn 子域命中', domainMatches('https://meta.appinn.net/t/1', 'appinn.com'));
  check('cnbeta 镜像域命中', domainMatches('https://m.cnbeta.com.tw/x', 'cnbeta.com'));
  check('NodeSeek 在开源目录', defaultSourceNames('opensource').includes('NodeSeek'));
  check('轻松一刻是站内见笑', defaultSourceNames('funny').includes('见笑'));
  check('人像是站内见她', defaultSourceNames('portrait').includes('见她'));
  check('见闻是站内见闻', defaultSourceNames('sight').includes('见闻'));
  check('电影含猫眼', defaultSourceNames('movie').includes('猫眼'));
  check('设计含产品经理', defaultSourceNames('design').includes('人人都是产品经理'));
  check('见笑 publisher 命中', itemMatchesSources(
    { metadata: { publisher: '见笑' }, canonical_url: 'https://daily.onetone.app/img/2026-11-19/jianxiao/a.webp' },
    ['见笑'], 'funny',
  ));
  check('见她不串到见笑勾选', !itemMatchesSources(
    { metadata: { publisher: '见她' }, canonical_url: 'https://daily.onetone.app/img/2026-11-19/jianshe/a.webp' },
    ['见笑'], 'funny',
  ));
  check('见她勾选命中', itemMatchesSources(
    { metadata: { publisher: '见她' }, canonical_url: 'https://daily.onetone.app/img/2026-11-19/jianshe/a.webp' },
    ['见她'], 'portrait',
  ));
  check('见闻勾选命中', itemMatchesSources(
    { metadata: { publisher: '见闻' }, canonical_url: 'https://daily.onetone.app/img/2026-11-19/jianwen/a.webp' },
    ['见闻'], 'sight',
  ));
  // 手风琴若先截前 48 再按源滤，尾部稀有 publisher 会假「未入库」（portal CATALOG_POOL_LIMIT）
  {
    const fillers = Array.from({ length: 50 }, (_, i) => ({
      metadata: { publisher: '百度热搜' },
      canonical_url: 'https://top.baidu.com/' + i,
      title: '热' + i,
    }));
    const rare = {
      metadata: { publisher: '微博热搜' },
      canonical_url: 'https://s.weibo.com/weibo?q=1',
      title: '稀有热搜',
    };
    const all = fillers.concat(rare);
    const truncated = all.slice(0, 48);
    check('截断池会漏稀有源', !truncated.some((it) => itemMatchesSources(it, ['微博热搜'], 'hot')));
    check('整包能命中稀有源', all.some((it) => itemMatchesSources(it, ['微博热搜'], 'hot')));
  }

  console.log('\n── 完整源目录合并 ──');
  check('SOURCE_CATALOG 已生成', SOURCE_CATALOG.length > 100, SOURCE_CATALOG.length);
  check(
    'ai 合并后多于精选',
    sourcesForTag('ai').length > curatedSourcesForTag('ai').length,
    { all: sourcesForTag('ai').length, curated: curatedSourcesForTag('ai').length },
  );
  check(
    'funny 仍仅视觉精选',
    sourcesForTag('funny').length === curatedSourcesForTag('funny').length,
  );
}

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail === 0 ? 0 : 1);
