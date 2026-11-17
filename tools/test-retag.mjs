#!/usr/bin/env node
/**
 * `--retag` 模式测试：往期重分类。
 *
 * 核心保证：**条目内容一个字都不改**，只有分类标签变。
 * 这是往期重分类的安全底线 —— 内容变了等于篡改历史。
 *
 * 跑法：node tools/test-retag.mjs
 *
 * 测试策略（两个场景，各有各的牙齿）：
 *
 *   场景一 · 真实往期 + --out
 *     拿工程里真实发布的往期（published/<日期>/）当「旧」，
 *     把重分产物写进临时目录，逐字段比对。
 *     断言的是**结构**：条目数、每个字段、照片 tab、页面引用、published/ 没被动过。
 *
 *   场景二 · 隔离工程 + 人为做错的旧标签
 *     真实往期一旦被就地重分过，「旧标签 = 新标签」，
 *     场景一里「新旧不同」的断言就空了 —— 所以另起一个隔离工程，
 *     把条目的旧标签**故意写错**，看重分能不能纠正过来。
 *     这一段跟真实数据的当前状态无关，永远有效。
 *
 * 隔离：所有产物都写进 tools/.tmp-retag-test/，跑完删掉。
 * published/ 只读，不动。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const TMP = path.join(SITE, 'tools', '.tmp-retag-test');
const PUB = path.join(SITE, 'published');

/**
 * 这一套需要**真实往期产物**（published/<日期>/manifest.*.js）。
 *
 * 全新 clone 里没有 published/ —— 它是 .gitignore 掉的构建产物。
 * 所以这里**显式跳过**，退出码 2 = 「跳过」，跟「红」（1）区分开：
 * 跳过绝不能冒充通过（假绿比红更坏）。
 */
if (!fs.existsSync(PUB) || !fs.readdirSync(PUB).some((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))) {
  console.log('\n跳过：--retag 护栏需要 published/ 里的往期产物（全新 clone 里没有）。');
  console.log('      先跑一次 node tools/build.mjs --date <日期> 生成产物，再跑本套件。');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const failed = [];

function ok(cond, msg, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failed.push(msg);
    console.log(`  ✗ ${msg}${extra !== undefined ? `  -> ${JSON.stringify(extra).slice(0, 400)}` : ''}`);
  }
}
function section(t) {
  console.log(`\n── ${t}`);
}

/* ------------------------------------------------------------------ 小工具 */

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}
function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function listManifests(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^manifest\..*\.js$/.test(n)).sort();
}
function readManifestFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw.slice(raw.indexOf('=') + 1).replace(/;\s*$/, '').trim());
}
function findTab(m, key) {
  return (m.tabs || []).find((t) => t.key === key);
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 临时工程要拷哪些模块：**从 build.mjs 的 import 语句递归扫出来**。
 * 手写清单每次给 build.mjs 加模块都会漏 —— 扫 import 就不会漏。
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
  mods.add('news-taxonomy.json'); // 分类真相源（数据文件，不是 import）
  return [...mods];
}

function runBuild(cwd, args) {
  try {
    const out = execFileSync(process.execPath, [path.join(cwd, 'tools', 'build.mjs'), ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/* ------------------------------------------------------------------ 现场 */

const tax = JSON.parse(fs.readFileSync(path.join(SITE, 'tools', 'news-taxonomy.json'), 'utf8'));
const catByKey = new Map(tax.categories.map((c) => [c.key, c]));
const allLabels = new Set(tax.categories.map((c) => c.label));
/** 新 taxonomy 里这个源该归哪个分类（没有就 null —— 那是漏配） */
const labelOfSource = (src) => {
  const key = tax.sourceCategory[src];
  return key && catByKey.has(key) ? catByKey.get(key).label : null;
};

const dates = fs
  .readdirSync(PUB)
  .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
  .sort();
// 挑一期往期做试验：最新一期可能正被人改，躲开。
const DATE = dates.includes('2026-11-04') ? '2026-11-04' : dates[0];
const pubDir = path.join(PUB, DATE);

console.log(`\n═══ --retag 护栏测试（期数 ${DATE}）═══`);

rmrf(TMP);
const oldNames = listManifests(pubDir);
if (oldNames.length !== 1) {
  console.log(`  ✗ ${DATE} 这一期有 ${oldNames.length} 个 manifest，测试没法跑（期望 1 个）`);
  process.exit(1);
}
const oldName = oldNames[0];
const oldManifest = readManifestFile(path.join(pubDir, oldName));
const oldNews = findTab(oldManifest, 'news');
const oldPhotoTabs = (oldManifest.tabs || []).filter((t) => t.key !== 'news');
const pubBefore = fs.readdirSync(pubDir).sort().map((n) => [n, sha(path.join(pubDir, n))]);

/* ============================================================ 场景一：真实往期 */

section('场景一：真实往期 + --out（产物写临时目录，published/ 只读）');

const OUT1 = path.join(TMP, 'out1');
const out1Existed = fs.existsSync(OUT1);
const r1 = runBuild(SITE, ['--retag', '--date', DATE, '--out', OUT1]);
ok(r1.code === 0, `--retag 构建成功（exit=${r1.code}）`, r1.out.slice(-600));
// --out 指到不存在的目录也跑得通 => 旧 manifest 是从工程 published/ 读的，没跟着 --out 跑
ok(!out1Existed && r1.code === 0, '旧 manifest 来自工程 published/（不跟 --out 走）');

if (r1.code === 0) {
  const outDir = path.join(OUT1, DATE);
  const newNames = listManifests(outDir);
  ok(newNames.length === 1, `产物目录里有且只有一个 manifest（${newNames.join(', ')}）`, newNames);

  const newName = newNames[0];
  const newManifest = newName ? readManifestFile(path.join(outDir, newName)) : null;
  const newNews = newManifest ? findTab(newManifest, 'news') : null;

  // --- 页面引用 ---
  const htmlPath = path.join(outDir, 'index.html');
  ok(fs.existsSync(htmlPath), '产物目录里有 index.html');
  const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
  ok(!!newName && html.includes(newName), 'index.html 引用的是新 manifest 的文件名', { newName });
  ok(!!newName && !html.includes(oldName), 'index.html 不再引用旧 manifest', { oldName });

  // --- 条目数 ---
  ok(!!newNews && newNews.items.length === oldNews.items.length, 'news 条目数跟旧 manifest 一致', {
    old: oldNews.items.length,
    now: newNews && newNews.items.length,
  });

  // --- 除 tag/tags 外，其余字段逐字段深比较 ---
  const diffs = [];
  let orderDiffs = 0;
  for (let i = 0; i < oldNews.items.length; i++) {
    const a = oldNews.items[i];
    const b = newNews.items[i];
    if (!b) {
      diffs.push({ i, why: '新 manifest 里少了这条' });
      continue;
    }
    if (JSON.stringify(Object.keys(a)) !== JSON.stringify(Object.keys(b))) orderDiffs++;
    const keys = Object.keys(a).filter((k) => k !== 'tag' && k !== 'tags');
    for (const k of keys) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
        diffs.push({ i, field: k, old: a[k], now: b[k] });
        break;
      }
    }
    const extra = Object.keys(b).filter((k) => k !== 'tag' && k !== 'tags' && !(k in a));
    if (extra.length) diffs.push({ i, why: `多了字段 ${extra.join(',')}` });
  }
  ok(diffs.length === 0, '除 tag/tags 外，每个条目的其余字段逐字段一致（title/link/source/time/desc/img…）', diffs.slice(0, 3));
  ok(orderDiffs === 0, '条目的字段顺序也没变（manifest 字节不会因为重排而变）', orderDiffs);

  // --- 分类确实按新 taxonomy 重算了 ---
  let wrongTag = 0;
  let wrongTags = 0;
  let unknownSource = 0;
  let unknownLabel = 0;
  for (const it of newNews.items) {
    const want = labelOfSource(it.source);
    if (!want) {
      unknownSource++;
      continue;
    }
    if (it.tag !== want) wrongTag++;
    if (!Array.isArray(it.tags) || it.tags[0] !== it.tag) wrongTags++;
    for (const t of it.tags || []) if (!allLabels.has(t)) unknownLabel++;
  }
  ok(unknownSource === 0, '每条条目的源都在新 taxonomy 的 sourceCategory 里（没有漏配的源）', unknownSource);
  ok(wrongTag === 0, '每条的 tag 都等于新 taxonomy 里该源对应的分类', wrongTag);
  ok(wrongTags === 0, '每条的 tags[0] === tag（主分类排第一）', wrongTags);
  ok(unknownLabel === 0, '每条的 tags 里都是新分类表里的分类名', unknownLabel);

  // 分类列表（tab.tags）也要按新 taxonomy 的固定顺序重算
  const cnt = new Map();
  for (const it of newNews.items) for (const t of it.tags || []) cnt.set(t, (cnt.get(t) || 0) + 1);
  const wantCats = tax.categories.filter((c) => (cnt.get(c.label) || 0) > 0).map((c) => c.label);
  ok(
    !!newNews && JSON.stringify(newNews.tags) === JSON.stringify(wantCats),
    '见报 tab 的分类列表按新 taxonomy 固定顺序重算了',
    { got: newNews && newNews.tags, want: wantCats }
  );

  // 新旧对比：输出里不能有残留的旧分类名
  // （旧 manifest 用的是旧分类名 —— 微博/知乎/科技…，这些在新分类表里已经不存在了）
  const staleNow = newNews.items.filter((it) => !allLabels.has(it.tag)).map((it) => it.tag);
  ok(staleNow.length === 0, '新 manifest 里没有残留的旧分类名', staleNow.slice(0, 5));

  let changed = 0;
  for (let i = 0; i < newNews.items.length; i++) {
    if (oldNews.items[i].tag !== newNews.items[i].tag) changed++;
  }
  console.log(`    （这一期 ${changed}/${newNews.items.length} 条的主分类变了）`);

  // --- 照片 tab 原样沿用 ---
  const newPhotoTabs = (newManifest.tabs || []).filter((t) => t.key !== 'news');
  ok(
    JSON.stringify(newPhotoTabs.map((t) => t.key)) === JSON.stringify(oldPhotoTabs.map((t) => t.key)),
    '照片 tab 的 key 集合和顺序都没变',
    { old: oldPhotoTabs.map((t) => t.key), now: newPhotoTabs.map((t) => t.key) }
  );
  ok(
    newPhotoTabs.length === oldPhotoTabs.length &&
      newPhotoTabs.every((t, i) => t.count === oldPhotoTabs[i].count),
    '照片 tab 的条目数没变',
    { old: oldPhotoTabs.map((t) => t.count), now: newPhotoTabs.map((t) => t.count) }
  );
  ok(
    JSON.stringify(newPhotoTabs) === JSON.stringify(oldPhotoTabs),
    '照片 tab 的内容一个字节都没改（整个 tab 逐字节相同）'
  );

  // --- published/ 一个字节都没动 ---
  const pubAfter = fs.readdirSync(pubDir).sort().map((n) => [n, sha(path.join(pubDir, n))]);
  ok(
    JSON.stringify(pubBefore) === JSON.stringify(pubAfter),
    '工程里的 published/ 这一期一个字节都没动（--out 真的隔离了）',
    { before: pubBefore.length, after: pubAfter.length }
  );
}

/* ================================================== 场景二：产物目录里已有旧版 */

section('场景二：产物目录里已经有一份旧产物（模拟就地重分）');

const OUT2 = path.join(TMP, 'out2');
fs.mkdirSync(path.join(OUT2, DATE), { recursive: true });
for (const n of fs.readdirSync(pubDir)) {
  fs.copyFileSync(path.join(pubDir, n), path.join(OUT2, DATE, n));
}
const r2 = runBuild(SITE, ['--retag', '--date', DATE, '--out', OUT2]);
ok(r2.code === 0, `构建成功（exit=${r2.code}）`, r2.out.slice(-500));

if (r2.code === 0) {
  const dir2 = path.join(OUT2, DATE);
  const names2 = listManifests(dir2);
  ok(names2.length === 1 && names2[0] !== oldName, '旧 manifest 被删掉了，目录里只剩新的一个', names2);

  const html2 = fs.readFileSync(path.join(dir2, 'index.html'), 'utf8');
  const oldHtml = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
  ok(
    html2 === oldHtml.split(oldName).join(names2[0]),
    'index.html 只改了 manifest 文件名，别的字节一个没动',
    ''
  );
  const shellOld = (oldHtml.match(/app\.[a-z0-9]+\.(css|js)/g) || []).join();
  const shellNew = (html2.match(/app\.[a-z0-9]+\.(css|js)/g) || []).join();
  ok(shellOld === shellNew, '页面壳（app.css / app.js 的引用）没被换成新版', { shellOld, shellNew });
}

/* ============================================= 场景二b：根路径页面引用的正是这一期 */

section('场景二b：根路径页面引用的正是这一期（重分最新一期时根页面要跟着改）');

const OUT2B = path.join(TMP, 'out2b');
fs.mkdirSync(path.join(OUT2B, DATE), { recursive: true });
for (const n of fs.readdirSync(pubDir)) {
  fs.copyFileSync(path.join(pubDir, n), path.join(OUT2B, DATE, n));
}
// 根页面：模拟「根路径指向这一期」（跟真站点 published/index.html 一个形状）
fs.writeFileSync(
  path.join(OUT2B, 'index.html'),
  `<!DOCTYPE html><html><body><script src="/${DATE}/${oldName}" defer></script></body></html>`,
  'utf8'
);

const r2b = runBuild(SITE, ['--retag', '--date', DATE, '--out', OUT2B]);
ok(r2b.code === 0, `构建成功（exit=${r2b.code}）`, r2b.out.slice(-500));

if (r2b.code === 0) {
  const rootAfter = fs.readFileSync(path.join(OUT2B, 'index.html'), 'utf8');
  const newName2b = listManifests(path.join(OUT2B, DATE))[0];
  ok(
    rootAfter.includes(newName2b) && !rootAfter.includes(oldName),
    '根路径页面的 manifest 引用跟着更新了（不然根页面加载的是已删掉的旧 manifest）',
    { oldName, newName2b }
  );
}

/* ================================================== 场景三：隔离工程（人为做错） */

section('场景三：隔离工程 —— 旧标签故意写错，看重分能不能纠正过来');

const ISO = path.join(TMP, 'iso');
fs.mkdirSync(path.join(ISO, 'tools'), { recursive: true });
for (const f of buildModuleList()) {
  fs.copyFileSync(path.join(SITE, 'tools', f), path.join(ISO, 'tools', f));
}
copyDir(path.join(SITE, 'site'), path.join(ISO, 'site'));

// 隔离工程里造一期「旧 manifest」：
//   条目内容用真实往期的，但**分类标签故意写成错的**（'旧分类'）。
//   重分必须把它纠正成新 taxonomy 算出来的分类 —— 这一段跟真实数据当前状态无关。
const isoItems = oldNews.items.slice(0, 40).map((it) => ({
  ...it,
  tag: '旧分类',
  tags: ['旧分类'],
}));
const isoManifest = {
  date: DATE,
  generatedAt: '2026-01-01T00:00:00.000Z',
  title: '测试站',
  siteUrl: 'https://example.com',
  imageBase: '/img',
  defaultTab: 'jianxiao',
  tabs: [
    ...oldPhotoTabs.map((t) => ({ ...t, items: (t.items || []).slice(0, 2) })),
    {
      key: 'news',
      label: '见报',
      accent: '#3ddc97',
      count: isoItems.length,
      type: 'headlines',
      tags: ['旧分类'],
      items: isoItems,
    },
  ],
};
fs.mkdirSync(path.join(ISO, 'published', DATE), { recursive: true });
fs.writeFileSync(
  path.join(ISO, 'published', DATE, 'manifest.oldsample.js'),
  `window.__DAILY_MANIFEST__=${JSON.stringify(isoManifest)};`,
  'utf8'
);
fs.writeFileSync(
  path.join(ISO, 'published', DATE, 'index.html'),
  '<html><body><script src="manifest.oldsample.js" defer></script></body></html>',
  'utf8'
);

const r3 = runBuild(ISO, ['--retag', '--date', DATE, '--out', path.join(ISO, 'out')]);
ok(r3.code === 0, `隔离工程里重分成功（exit=${r3.code}）`, r3.out.slice(-600));

if (r3.code === 0) {
  const dir3 = path.join(ISO, 'out', DATE);
  const names3 = listManifests(dir3);
  ok(names3.length === 1 && names3[0] !== 'manifest.oldsample.js', '旧 manifest 被换成新的', names3);

  const after = findTab(readManifestFile(path.join(dir3, names3[0])), 'news');
  const stillWrong = after.items.filter((it) => it.tag === '旧分类' || (it.tags || []).includes('旧分类'));
  ok(stillWrong.length === 0, '故意写错的旧分类标签全被纠正了', stillWrong.slice(0, 2));

  let mismatched = 0;
  for (const it of after.items) {
    const want = labelOfSource(it.source);
    if (!want || it.tag !== want) mismatched++;
  }
  ok(mismatched === 0, '纠正后的 tag 等于新 taxonomy 里该源对应的分类', mismatched);

  const html3 = fs.readFileSync(path.join(dir3, 'index.html'), 'utf8');
  ok(html3.includes(names3[0]), '隔离工程的 index.html 也指向新 manifest', names3[0]);
}

/* ========================================== 场景四：源名没配分类 -> 必须响亮失败 */

section('场景四：源名没配分类 -> 必须抛错，不许静默归到「其它」');

const taxPath = path.join(ISO, 'tools', 'news-taxonomy.json');
const goodTax = fs.readFileSync(taxPath, 'utf8');
const brokenTax = JSON.parse(goodTax);
const dropSrc = [...new Set(oldNews.items.map((i) => i.source))][0];
delete brokenTax.sourceCategory[dropSrc];
fs.writeFileSync(taxPath, JSON.stringify(brokenTax, null, 2), 'utf8');

const r4 = runBuild(ISO, ['--retag', '--date', DATE, '--out', path.join(ISO, 'out-broken')]);
ok(r4.code !== 0, `构建失败（exit=${r4.code}）`, r4.out.slice(-400));
ok(/见报源「/.test(r4.out), '报错来自「源没配分类」的预校验（不是分类计算阶段的兜底报错）');
ok(/没有配分类/.test(r4.out), '报错信息说明是「源没配分类」');
ok(r4.out.includes(dropSrc), `报错信息点名了漏配的源（${dropSrc}）`);
ok(
  listManifests(path.join(ISO, 'out-broken', DATE)).length === 0,
  '失败时没有写出任何 manifest（校验在写之前）',
  listManifests(path.join(ISO, 'out-broken', DATE))
);
fs.writeFileSync(taxPath, goodTax, 'utf8');

/* ============================================================ 场景五：各种闸门 */

section('场景五：闸门');

const r5 = runBuild(SITE, ['--retag', '--date', DATE, '--keep-manifest', '--out', path.join(TMP, 'out5')]);
ok(r5.code !== 0 && /互斥/.test(r5.out), '--retag 与 --keep-manifest 互斥', r5.out.slice(-300));

const r6 = runBuild(SITE, ['--retag', '--date', '2020-01-01', '--out', path.join(TMP, 'out6')]);
ok(r6.code !== 0, '没有已发布 manifest 时拒绝执行', r6.out.slice(-300));

const r7 = runBuild(SITE, ['--retag', '--out', path.join(TMP, 'out7')]);
ok(r7.code !== 0 && /--date/.test(r7.out), '不指定 --date 时拒绝执行', r7.out.slice(-300));

/* ------------------------------------------------------------------ 收尾 */

section('清理');
rmrf(TMP);
ok(!fs.existsSync(TMP), '临时工程已删除');

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n没过的断言：');
  for (const f of failed) console.log(`  · ${f}`);
  console.log('\n--retag 的行为跟预期不一致 —— 别急着把产物推上线。');
  process.exit(1);
}
console.log('\n--retag 行为符合预期：内容零改动，只有分类标签变了。');
