/**
 * 见报分类：taxonomy 校验 + 归属计算的单元测试。
 *
 * 为什么单独一个文件：分类是「用户看到的第一层筛选」，
 * 一旦映射错了，用户点「AI」看到的是一堆不相关内容 —— 而且不会报错。
 */
import { loadTaxonomy, validateTaxonomy, classifyItem, matchWords, orderCategories } from './news-taxonomy.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function throws(fn, re) {
  try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; }
}
/**
 * 坏配置的错误列表里「有没有这一类错」。
 *
 * 为什么不用 `errors.length > 0`：那种断言对「缺哪一项」零检出能力 ——
 * fixture 里只要还有别的错，长度就照样 > 0，断言照样绿。
 * 所以这里断言的是**具体那条错**，改坏了才会红。
 */
function hasErr(t, re) {
  const errs = validateTaxonomy(t);
  return errs.some((e) => re.test(e));
}

console.log('── taxonomy 本身 ──');
const tax = loadTaxonomy(SITE);
check('能加载', !!tax);
check('校验通过', validateTaxonomy(tax).length === 0, validateTaxonomy(tax));

console.log('\n── 分类定义 ──');
check('有 8 个分类', tax.categories.length === 8, tax.categories.map((c) => c.label));
check('label 全是用户思维（不含平台名）', !tax.categories.some((c) => /微博|知乎|即刻|V2EX|虎扑/.test(c.label)), tax.categories.map((c) => c.label));
check('第一个分类是「热议」', tax.categories[0]?.label === '热议', tax.categories[0]);
check('key 唯一', new Set(tax.categories.map((c) => c.key)).size === tax.categories.length);

console.log('\n── 每个源都有映射 ──');
{
  const rssCfg = JSON.parse(readFileSync(SITE + '/tools/rss.config.json', 'utf8'));
  const rssSources = rssCfg.feeds.map((f) => f.name);
  const py = readFileSync(SITE + '/tools/grab/daily_headlines.py', 'utf8');
  const topSources = [...py.matchAll(/^\s*\("([^"]+)",\s*fetch_/gm)].map((m) => m[1]);
  const all = [...rssSources, ...topSources];
  // 同一个源可能有**两个渠道**：V2EX 热榜 = 头条（Python 抓 v2ex.com/?tab=hot）
  // + RSS（RSS屋 的镜像）。显示名一样，分类映射也只需要一条 —— 所以按「去重后的源名」比。
  const distinct = new Set(all);
  const mapped = Object.keys(tax.sourceCategory);

  // 期望值从 taxonomy 反推，不写死「16 个源」——
  // 加一个合法 RSS 源不该让整套测试红，红的原因必须跟 taxonomy 对不对有关。
  check('RSS 源和头条源都解析到了', rssSources.length > 0 && topSources.length > 0, { rss: rssSources.length, top: topSources.length });
  check('真实源数量 == sourceCategory 里的源数量', distinct.size === mapped.length, { real: distinct.size, mapped: mapped.length });

  const missing = all.filter((s) => !tax.sourceCategory[s]);
  check('每个真实源都在 sourceCategory 里', missing.length === 0, missing);

  // 反方向：sourceCategory 里留了已下线源的陈旧映射，也得被发现
  const stale = mapped.filter((s) => !all.includes(s));
  check('sourceCategory 里没有已下线的源', stale.length === 0, stale);
}

console.log('\n── 归属计算 ──');
{
  const it = classifyItem({ source: '微博热搜', title: '某某发布新款 AI 大模型', desc: '' }, tax);
  check('主分类是「热议」', it.tag === '热议', it.tag);
  check('关键词命中追加「AI」', it.tags.includes('AI'), it.tags);
  check('主分类排第一', it.tags[0] === '热议', it.tags);
  check('tags 全是 label 不是 key', it.tags.every((x) => tax.categories.some((c) => c.label === x)), it.tags);

  const it2 = classifyItem({ source: '驱动之家', title: '普通硬件新闻', desc: '' }, tax);
  check('没命中关键词时只有主分类', it2.tags.length === 1, it2.tags);
  check('驱动之家 → 科技数码', it2.tag === '科技数码', it2.tag);

  check('源未映射时抛错（不 fallback）', throws(
    () => classifyItem({ source: '不存在的源', title: 'x' }, tax), /没有配分类/));

  const it3 = classifyItem({ source: 'AIHOT精选', title: 'GPT-5 发布了', desc: '大模型', }, tax);
  check('主分类已含 AI 时不重复追加', it3.tags.filter((x) => x === 'AI').length === 1, it3.tags);

  // 摘要（desc）要参与匹配：标题里什么都不说，只有 desc 提到大模型
  const it4 = classifyItem({ source: '驱动之家', title: '普通标题', desc: '大模型' }, tax);
  check('摘要参与匹配（只有 desc 提到大模型）', it4.tags.includes('AI'), it4.tags);
  check('摘要命中时主分类不变', it4.tag === '科技数码', it4.tag);

  // 截断：临时给 taxonomy 加第二个关键词分类，maxExtraTags 设成 1
  {
    const t2 = JSON.parse(JSON.stringify(tax));
    t2.keywordTags.push({ tag: 'tech', words: ['硬件'] });
    t2.maxExtraTags = 1;
    const it = classifyItem({ source: '微博热搜', title: 'AI 硬件新闻', desc: '' }, t2);
    check('超出 maxExtraTags 被截断', it.tags.length === 2, it.tags);
    check('截断后主分类仍在', it.tags[0] === '热议', it.tags);
  }

  // 重名 tag：同一个 tag 配了两条关键词规则
  // 后果是条目上出现两个「AI」、chip 计数虚高 —— 用户看得见的错数字，且不报错
  {
    const t2 = JSON.parse(JSON.stringify(tax));
    t2.keywordTags.push({ tag: 'ai', words: ['模型'] });
    check('keywordTags 重名 tag 被校验器拒掉', hasErr(t2, /keywordTags 的 tag 重复/), validateTaxonomy(t2));

    const it = classifyItem({ source: '微博热搜', title: 'AI 模型发布', desc: '' }, t2);
    check('重名 tag 不会产生重复标签', it.tags.filter((x) => x === 'AI').length === 1, it.tags);
    const cats = orderCategories(t2, [it]);
    check('重名 tag 不会让 chip 计数虚高', cats.find((x) => x.label === 'AI')?.count === 1, cats);
  }
}

console.log('\n── 关键词匹配 ──');
check('英文按单词边界：said 不命中 ai', matchWords('he said that', ['ai']).length === 0);
check('英文按单词边界：GPT-4 命中 GPT', matchWords('GPT-4 发布了', ['GPT']).length === 1);
check('中文子串命中', matchWords('大模型又变强了', ['大模型']).length === 1);
check('空文本不命中', matchWords('', ['大模型']).length === 0);

console.log('\n── 分类顺序固定 ──');
{
  // 条数故意跟 taxonomy 顺序**相反**：a 里 AI 比 热议 多，b 里反过来。
  //
  // 为什么必须这样：要是两边条数跟 taxonomy 顺序一致，
  // 「按条数降序」算出来的结果跟「taxonomy 固定顺序」完全重合 ——
  // 排序就成了恒等变换，断言根本看不出 orderCategories 到底按哪个排
  // （变异 M2「分类列表改回按条数降序」就是这么漏过去的）。
  // 现在 a 的条数序（AI 在前）跟 taxonomy 序（热议 在前）相反，
  // 一旦实现改成按条数排，序列就会变成 [AI, 热议]，与期望不一致 -> 断言必红。
  const aiItem = { tags: ['AI'] };
  const hotItem = { tags: ['热议'] };
  const a = orderCategories(tax, [aiItem, aiItem, aiItem, hotItem]); // AI=3 热议=1
  const b = orderCategories(tax, [hotItem, hotItem, hotItem, aiItem]); // 热议=3 AI=1

  // 期望值从 taxonomy 反推：返回的 label 序列必须等于
  // 「taxonomy.categories 的顺序里，过滤出当天有内容的那些」
  const expected = tax.categories.map((c) => c.label).filter((l) => a.some((x) => x.label === l));
  check('顺序 = taxonomy 顺序', JSON.stringify(a.map((x) => x.label)) === JSON.stringify(expected), a.map((x) => x.label));
  check('条数变了顺序不变', JSON.stringify(a.map((x) => x.label)) === JSON.stringify(b.map((x) => x.label)), [a.map((x) => x.label), b.map((x) => x.label)]);
  check('没内容的分类不出现', !a.some((x) => x.label === '深度阅读'), a.map((x) => x.label));
  // 可选链：分类不存在时返回 undefined，比较为 false（红）而不是抛 TypeError 崩掉
  check('计数正确', a.find((x) => x.label === 'AI')?.count === 3 && b.find((x) => x.label === '热议')?.count === 3, { a, b });
}

console.log('\n── 坏配置要被拒 ──');
// 断言具体那条错，不是断言「错误列表非空」——
// 后者对「缺哪一项」零检出能力：fixture 里只要还有别的错，长度照样 > 0。
{
  // 只有 label 缺失，其余字段都合法
  const noLabel = { categories: [{ key: 'a' }, { key: 'b', label: 'B' }], sourceCategory: { s: 'b' } };
  check('category 缺 label 被拒', hasErr(noLabel, /category a 缺 label/), validateTaxonomy(noLabel));

  const badSc = { categories: [{ key: 'a', label: 'A' }], sourceCategory: { s: 'zzz' } };
  check('sourceCategory 指向不存在的 key 被拒', hasErr(badSc, /sourceCategory\[s\] 指向不存在的 category/), validateTaxonomy(badSc));

  const badKt = { categories: [{ key: 'a', label: 'A' }], sourceCategory: { s: 'a' }, keywordTags: [{ tag: 'zzz', words: ['x'] }] };
  check('keywordTags 指向不存在的 key 被拒', hasErr(badKt, /keywordTags 指向不存在的 category/), validateTaxonomy(badKt));

  const dupKt = { categories: [{ key: 'a', label: 'A' }], sourceCategory: { s: 'a' }, keywordTags: [{ tag: 'a', words: ['x'] }, { tag: 'a', words: ['y'] }] };
  check('keywordTags 重名 tag 被拒', hasErr(dupKt, /keywordTags 的 tag 重复/), validateTaxonomy(dupKt));

  const fracMax = { categories: [{ key: 'a', label: 'A' }], sourceCategory: { s: 'a' }, maxExtraTags: 2.5 };
  check('maxExtraTags 非整数被拒', hasErr(fracMax, /maxExtraTags 必须是整数/), validateTaxonomy(fracMax));

  const negMax = { categories: [{ key: 'a', label: 'A' }], sourceCategory: { s: 'a' }, maxExtraTags: -1 };
  check('maxExtraTags 负数被拒', hasErr(negMax, /maxExtraTags 不能是负数/), validateTaxonomy(negMax));

  const okMax = { categories: [{ key: 'a', label: 'A' }], sourceCategory: { s: 'a' }, maxExtraTags: 0 };
  check('maxExtraTags = 0 合法（只挂主分类）', validateTaxonomy(okMax).length === 0, validateTaxonomy(okMax));
}

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail === 0 ? 0 : 1);
