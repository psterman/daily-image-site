/**
 * 集成测试：真在临时目录跑一次构建，验 manifest 的分类。
 *
 * 为什么不直接读真产物：真产物是线上期次，构建会改它。
 * 这个测试在临时目录里造最小工程，跑完删掉，不碰 published/。
 *
 * 两个场景：
 *   1. 正常构建 —— 分类按 taxonomy 算，chip 顺序固定（不按条数排）
 *   2. 源没配分类 —— 构建必须失败，而且**不能把已发布的产物删掉**
 *      （删了那一期就回不来了，--retag 的往期重分类也做不了了）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const TMP = path.join(SITE, 'tools', '.tmp-build-taxonomy-test');
const DATE = '2026-11-04';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

// 造最小工程：照抄 tools/test-keep-manifest.mjs 的隔离模式
// （复制构建脚本 + 它 import 的模块 + 前端资源 + 随机盐，用临时 IMAGE_ROOT）
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function writeHeadlines(srcDir, items) {
  const dir = path.join(srcDir, 'headlines');
  fs.mkdirSync(dir, { recursive: true });
  const flat = items.map((it, i) => ({
    title: it.title,
    link: `https://example.com/${i}`,
    source: it.source,
    category: '旧分类名',
  }));
  fs.writeFileSync(
    path.join(dir, `headlines_${DATE}.json`),
    JSON.stringify({ ts: Date.now(), items: flat }, null, 2),
    'utf8'
  );
}

// 头条数据。刻意做成「条数多的分类排在 taxonomy 顺序的后面」——
// 这样「按条数排」和「按 taxonomy 固定顺序排」必然给出不同结果，
// 顺序断言才真的能抓住回归（不然两种排法碰巧一样，断言就是假护栏）。
const HEADLINES = [
  { title: '某公司发布新款 AI 大模型', source: '微博热搜' },
  { title: '普通生活话题', source: '知乎热榜' },
  { title: '每周科技周报第 300 期', source: '阮一峰' },
  { title: 'TypeScript 类型体操实践', source: '阮一峰' },
  { title: '一篇值得存下来的长文', source: '阮一峰' },
];

/**
 * 临时工程要拷哪些模块：**从 build.mjs 的 import 语句递归扫出来**。
 * 手写清单每次给 build.mjs 加模块都会漏（加 news-dedupe.mjs 时就漏了一次，
 * 两个集成测试一起红），扫 import 就不会漏。
 * 必须是递归的 —— paths.mjs 自己还 import 了 env.mjs（只看一层照样漏）。
 */
function buildModuleList() {
  const mods = new Set(['build.mjs']);
  const queue = ['build.mjs'];
  while (queue.length) {
    const f = queue.pop();
    if (!/\.mjs$/.test(f)) continue;
    const src = fs.readFileSync(path.join(SITE, 'tools', f), 'utf8');
    for (const m of src.matchAll(/from\s+['"]\.\/([\w.-]+)['"]/g)) {
      if (!mods.has(m[1])) {
        mods.add(m[1]);
        queue.push(m[1]);
      }
    }
  }
  mods.add('news-taxonomy.json'); // 不是 import 的数据文件（分类真相源）
  return [...mods];
}

function setupProject() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'tools'), { recursive: true });

  for (const f of buildModuleList()) {
    fs.copyFileSync(path.join(SITE, 'tools', f), path.join(TMP, 'tools', f));
  }
  const cfg = path.join(SITE, 'tools', 'rss.config.json');
  if (fs.existsSync(cfg)) fs.copyFileSync(cfg, path.join(TMP, 'tools', 'rss.config.json'));

  copyDir(path.join(SITE, 'site'), path.join(TMP, 'site'));

  const salt = path.join(SITE, '.img-salt');
  if (fs.existsSync(salt)) fs.copyFileSync(salt, path.join(TMP, '.img-salt'));

  const imgRoot = path.join(TMP, 'imageroot');
  const srcDir = path.join(imgRoot, 'src', DATE);
  const tabs = { 见闻: '0x4a8cff', 见她: '0xff6b9d', 见笑: '0xffb020' };
  for (const [tab, color] of Object.entries(tabs)) {
    const dir = path.join(srcDir, tab);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 2; i++) {
      const out = path.join(dir, `${String(i).padStart(3, '0')}.png`);
      execFileSync('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=${color}:s=64x64`,
        '-frames:v', '1', out,
      ], { stdio: 'pipe' });
    }
  }
  writeHeadlines(srcDir, HEADLINES);
}

// 跑构建：关 RSS（不联网），只让 headlines 进
function runBuild() {
  try {
    const out = execFileSync(process.execPath,
      [path.join(TMP, 'tools', 'build.mjs'), '--date', DATE, '--no-rss'],
      {
        cwd: TMP, stdio: 'pipe', encoding: 'utf8',
        env: { ...process.env, IMAGE_ROOT: path.join(TMP, 'imageroot') },
      });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// 先把临时工程造出来 —— 不然下面跑构建时 TMP 里根本没有 build.mjs
setupProject();

const pubDir = path.join(TMP, 'published', DATE);
function manifestFile() {
  if (!fs.existsSync(pubDir)) return null;
  return fs.readdirSync(pubDir).find((n) => /^manifest\..*\.js$/.test(n)) || null;
}
function manifestBytes() {
  const f = manifestFile();
  return f ? fs.readFileSync(path.join(pubDir, f)) : null;
}

/* ── 场景 1：正常构建 ───────────────────────────────────── */

console.log('\n── 场景 1：正常构建（分类按 taxonomy 算）');

const r1 = runBuild();
check('构建成功', r1.ok, r1.out.slice(-800));

if (r1.ok) {
  const mf = manifestFile();
  check('生成了 manifest', !!mf, fs.existsSync(pubDir) ? fs.readdirSync(pubDir) : '没有 published 目录');
  const man = JSON.parse(
    fs.readFileSync(path.join(pubDir, mf), 'utf8')
      .replace(/^window\.__DAILY_MANIFEST__=/, '').replace(/;\s*$/, '')
  );
  const news = man.tabs.find((t) => t.key === 'news');
  check('有见报 tab', !!news);
  if (news) {
    const ai = news.items.find((i) => i.source === '微博热搜');
    check('微博热搜 → 主分类「热议」', ai && ai.tag === '热议', ai && ai.tag);
    check('关键词命中追加「AI」', ai && ai.tags.includes('AI'), ai && ai.tags);
    check('tags 是数组且主分类在前', ai && Array.isArray(ai.tags) && ai.tags[0] === '热议', ai && ai.tags);
    const other = news.items.find((i) => i.source === '知乎热榜');
    check('没命中关键词的只有主分类', other && other.tags.length === 1, other && other.tags);
    const deep = news.items.find((i) => i.source === '阮一峰');
    check('「深度阅读」源 → 主分类「深度阅读」', deep && deep.tag === '深度阅读', deep && deep.tag);

    check('分类列表含「热议」', news.tags.includes('热议'), news.tags);
    check('分类列表含「AI」', news.tags.includes('AI'), news.tags);
    check('分类列表含「深度阅读」', news.tags.includes('深度阅读'), news.tags);
    check('分类列表只含有内容的分类（这期就 3 个）', news.tags.length === 3, news.tags);

    // 强断言：分类列表必须与 taxonomy 的固定顺序**全等**。
    // （只断言 indexOf('热议') < indexOf('AI') 抓不住「改回按条数排」这种回归）
    const tax = JSON.parse(
      fs.readFileSync(path.join(TMP, 'tools', 'news-taxonomy.json'), 'utf8')
    );
    const expected = tax.categories.map((c) => c.label).filter((l) => news.tags.includes(l));
    check('分类列表与 taxonomy 顺序全等', JSON.stringify(news.tags) === JSON.stringify(expected), {
      actual: news.tags, expected,
    });
    // 这期「深度阅读」条数最多（3）却排在最后 —— 说明确实没按条数排
    check('不是按条数排的（条数最多的「深度阅读」排在最后）',
      news.tags[news.tags.length - 1] === '深度阅读', news.tags);
  }
  check('构建日志标明分类是固定顺序', r1.out.includes('固定顺序'), r1.out.slice(-400));
}

/* ── 场景 2：源没配分类 → 必须失败，且不能删掉已发布的产物 ─── */

console.log('\n── 场景 2：源没配分类（构建必须失败，且 published/ 不能被清空）');

const before = manifestBytes();
const beforeName = manifestFile();
check('场景 1 留下了已发布的产物', !!before && !!beforeName, { dir: pubDir });

// 塞一个 taxonomy 里没配分类的源 —— 模拟「加了个新源忘了配 taxonomy」
writeHeadlines(
  path.join(TMP, 'imageroot', 'src', DATE),
  [...HEADLINES, { title: '某个新加的源', source: '没配分类的新源' }]
);

const r2 = runBuild();
check('构建失败（非零退出）', !r2.ok, r2.out.slice(-600));
check('报错里点名是哪个源没配分类', /没有配分类/.test(r2.out), r2.out.slice(-600));
check('报错里列出了已配的源', /已配的源/.test(r2.out), r2.out.slice(-600));

// 关键断言：失败不能把已发布的产物删掉。
// 删了那一期就回不来了（--retag 的往期重分类要读旧 manifest）。
check('published/<日期>/ 没被清空', fs.existsSync(pubDir), { dir: pubDir });
check('已发布的 manifest 还在', manifestFile() === beforeName, { before: beforeName, now: manifestFile() });
const after = manifestBytes();
check('已发布的 manifest 字节没变', !!after && !!before && after.equals(before));

/* ── 场景 3：/archive/ 的日期索引必须能点到最新一期 ─────────── */

console.log('\n── 场景 3：/archive/ 的日期索引必须包含最新一期');

// 场景 2 往源里塞了「没配分类的新源」，先把源恢复成能构建的样子
writeHeadlines(path.join(TMP, 'imageroot', 'src', DATE), HEADLINES);

{
  // 再造一期更早的，然后重建 ——
  // 这样「最新一期」和「往期」同时存在，才测得出列表到底有没有把最新一期剔掉。
  // 只造一期的话，旧逻辑 slice(1) 会把列表清空，测不出差别。
  fs.mkdirSync(path.join(TMP, 'published', '2026-11-03'), { recursive: true });

  const r3 = runBuild();
  check('第三次构建成功', r3.ok, r3.out.slice(-600));

  const archive = path.join(TMP, 'published', 'archive', 'index.html');
  check('生成了 archive/index.html', fs.existsSync(archive));
  const html = fs.existsSync(archive) ? fs.readFileSync(archive, 'utf8') : '';

  // 列表里必须有最新一期（2026-11-04）的链接。
  //
  // 之前 buildIndexHtml 用的是 dates.slice(1) —— 最新一期被剔掉了，
  // 在「全部日期」里根本点不到今天，列表第一条是昨天那一期。
  // 「进入11月11日的内容，却看到11月9日的内容」就是这么来的：
  // 不是内容错了，是**今天那期没出现在列表里**，人只能去点昨天那期。
  check('日期索引里有最新一期（2026-11-04）', html.includes('../2026-11-04/'));
  check('日期索引里有往期（2026-11-03）', html.includes('../2026-11-03/'));
  check('「最新一期」快捷卡片还在', /class="latest"/.test(html));

  // 列表项数 == 已构建的期数（不多不少）
  // 「最新一期」卡片链的是 ../，不带日期，所以这里只数日期列表项。
  // 正则不写死 `<a href=` —— 锚点还有 class="row"，
  // 写死了以后加个 class 就会误判成「列表空了」。
  const listed = [...html.matchAll(/<a[^>]*href="\.\.\/(\d{4}-\d{2}-\d{2})\//g)].map((m) => m[1]);
  check('日期列表里有 2 个日期', listed.length === 2, listed);
  check('最新一期排在列表最前', listed[0] === '2026-11-04', listed);

  // 日期条目**必须带 class="row"** —— 这个页面的卡片样式（背景 / 圆角 /
  // 右边的 › 箭头 / 日期的等宽数字）全挂在 `a.row` 上。
  // 漏了这个 class，日期列表就是一排**裸蓝色下划线链接**，像没做完的半成品
  // （留言板那条 `<a class="row">` 反而是对的，所以更不容易被发现）。
  const rowLinks = [...html.matchAll(/<a class="row" href="\.\.\/(\d{4}-\d{2}-\d{2})\//g)].map((m) => m[1]);
  check('日期列表的条目带 class="row"（卡片样式能生效）', rowLinks.length === 2, rowLinks);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail === 0 ? 0 : 1);
