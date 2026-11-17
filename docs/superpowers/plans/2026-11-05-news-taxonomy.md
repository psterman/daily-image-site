# 见报分类重构（用户思维）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把见报 tab 顶层筛选从「平台名 / 内容领域 / 内容形态三轴混排」改成统一的「用户思维」内容领域分类（热议 / 科技数码 / AI / 效率工具 / 技术社区 / 深度阅读），并把 11 期往期一并重分类。

**Architecture:** 新增 `tools/news-taxonomy.json` 作为**唯一分类真相源**（分类表 + 源→主分类映射 + 关键词表），新增 `tools/news-taxonomy.mjs` 提供纯函数「归属计算」。`tools/build.mjs` 在 news items 组装后统一用 taxonomy 重算每条的 `tag` / `tags`，分类列表改为按 taxonomy 固定顺序输出。前端 `site/app.js` **一行不改**（`data-tags` 本就是数组、`applyFilter` 本就是包含匹配、徽章本就只显示 `it.tag`）。新增 `--retag` 构建模式：沿用已发布 manifest 的见报条目、只重算分类标签，用于往期重分类。

**Tech Stack:** Node.js ESM（无框架、无构建器）、Python 3（抓取侧，本任务不改）、Cloudflare Pages / R2（发布侧）、Playwright + Chrome（线上验证）。

---

## Global Constraints

这些约束适用于**每一个任务**，任务里的步骤默认已包含它们：

- **站点代码不在 git 里。** `PROJECT_ROOT` 跟踪文件数为 0，`docs/` 也不在 git 里。
  → **本计划里没有 commit 步骤**，每个任务的检查点是「跑测试 + 在 README 记录」。不要执行 `git add` / `git commit`。
- **临时脚本用完必须清理**：文件名用 `tmp-*` 前缀（`tmp-xxx.mjs` / `tmp-xxx.py` / `tmp-xxx.log`），
  任务结束前用
  `recycle-delete.cmd -- "PROJECT_ROOT/tmp-xxx.mjs"` 删掉。
  **不要**用 `Remove-Item`（会被权限策略拒绝）。
- **测试脚本内部的临时工程目录**用 `tools/.tmp-<名字>`（点开头），跑完由脚本自己 `fs.rmSync` 删掉 ——
  照抄 `tools/test-keep-manifest.mjs` 的现成模式，别另发明一套。
- **删除文件一律走回收站删除器**（同上），一次性一个顶层命令，路径用正斜杠字面量。
- **PowerShell 5.1 陷阱**：`&&` / `||` 不支持；`$home` / `$HOST` 只读；`node -e` 的内联引号会被 PS 吃掉（要内联就写临时 `.mjs` 文件）；读 UTF-8 无 BOM 文件会乱码（用 `Get-Content -Raw -Encoding UTF8`）。
- **联网脚本必须自带重试**：本机到 `api.cloudflare.com` / `example.com` 会间歇性 `ECONNRESET`。
  区分「连接被重置」（重试即可） vs「HTTP 4xx/5xx」（真问题，不许重试掩盖）。
- **验证脚本本身不能有假护栏**：断言必须对着 manifest 的真实数据算期望值，不能假设「一定有 N 条」。
  已踩过的坑：`review-desk-check.mjs` 断言「三个栏目分组都在」，见闻 0 张时必然红 —— 那是脚本假设过时，不是产品问题。
- **前端（若改动）必须微信/iOS 13 兼容**：不用 flex `gap`，关键属性带 `-webkit-` 前缀，不用 `srcset`。
  **本计划不改前端**，此条仅作提醒。
- **不要泄露凭据**：`.env.local`、`.img-salt`、`.fetch-ledger.json` 的内容不得出现在日志、输出或提交物里。
- **日期语义**：目录名 = **发布日**（北京时间今天），抓的是**昨天内容**。2026-11-05 期 = 内容日 2026-11-04。

---

## File Structure

| 文件 | 责任 | 状态 |
|---|---|---|
| `tools/news-taxonomy.json` | 分类唯一真相源：分类表 + 源→主分类映射 + 关键词表 | 新建 |
| `tools/news-taxonomy.mjs` | 加载/校验 taxonomy，按条目算归属，按固定顺序排分类 | 新建 |
| `tools/test-news-taxonomy.mjs` | taxonomy 与归属计算的单元测试 | 新建 |
| `tools/test-news-taxonomy-mutate.mjs` | 变异测试：故意打破 4 条规则，验证测试抓得住 | 新建 |
| `tools/build.mjs` | 接入 taxonomy；新增 `--retag` 模式 | 修改 |
| `tools/rss.config.json` | 删掉 `feeds[].tag`（分类改由 taxonomy 管），更新 `_doc` | 修改 |
| `tools/test-build-taxonomy.mjs` | 集成测试：真在临时目录跑一次构建，验 manifest 的分类 | 新建 |
| `tools/test-retag.mjs` | `--retag` 模式测试：items 逐条不变、只有分类变、闸门会拒 | 新建 |
| `tools/retag-all.mjs` | 逐期重建 + 自动比对内容未变 | 新建 |
| `README.md` | 记录分类体系与往期重分类 | 修改 |

---

### Task 1: 分类真相源 + 归属计算模块

**Files:**
- Create: `tools/news-taxonomy.json`
- Create: `tools/news-taxonomy.mjs`
- Test: `tools/test-news-taxonomy.mjs`
- Modify: `README.md`（新增一节《见报的分类：唯一真相源 `news-taxonomy.json`》）

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces:
  - `loadTaxonomy(root: string) -> Taxonomy` —— 读 `tools/news-taxonomy.json`，校验失败**抛错**（带中文原因列表）
  - `validateTaxonomy(t: any) -> string[]` —— 返回错误列表，空数组 = 合法
  - `classifyItem(item: {title?, desc?, source?}, taxonomy: Taxonomy) -> { tag: string, tags: string[], mainKey: string, keys: string[] }`
    - `tag` = 主分类的 **label**；`tags` = 全部归属的 label 数组（主分类在前）
    - 源未映射时**抛错**（不 fallback）
  - `matchWords(text: string, words: string[]) -> string[]` —— 返回命中的词
  - `orderCategories(taxonomy: Taxonomy, items: {tags?: string[]}[]) -> { label: string, count: number }[]`
    - 按 `taxonomy.categories` 的**固定顺序**输出，**只含有内容的**

- [ ] **Step 1: 写失败的测试**

创建 `tools/test-news-taxonomy.mjs`：

```js
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

console.log('── taxonomy 本身 ──');
const tax = loadTaxonomy(SITE);
check('能加载', !!tax);
check('校验通过', validateTaxonomy(tax).length === 0, validateTaxonomy(tax));

console.log('\n── 分类定义 ──');
check('有 6 个分类', tax.categories.length === 6, tax.categories.map((c) => c.label));
check('label 全是用户思维（不含平台名）', !tax.categories.some((c) => /微博|知乎|即刻|V2EX|虎扑/.test(c.label)), tax.categories.map((c) => c.label));
check('第一个分类是「热议」', tax.categories[0].label === '热议', tax.categories[0]);
check('key 唯一', new Set(tax.categories.map((c) => c.key)).size === tax.categories.length);

console.log('\n── 每个源都有映射 ──');
{
  const rssCfg = JSON.parse(readFileSync(SITE + '/tools/rss.config.json', 'utf8'));
  const rssSources = rssCfg.feeds.map((f) => f.name);
  const py = readFileSync(SITE + '/tools/grab/daily_headlines.py', 'utf8');
  const topSources = [...py.matchAll(/^\s*\("([^"]+)",\s*fetch_/gm)].map((m) => m[1]);
  const all = [...rssSources, ...topSources];
  check('共 16 个源', all.length === 16, all.length);
  const missing = all.filter((s) => !tax.sourceCategory[s]);
  check('每个源都在 sourceCategory 里', missing.length === 0, missing);
  check('RSS 源 11 个', rssSources.length === 11, rssSources.length);
  check('头条源 5 个', topSources.length === 5, topSources.length);
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

  // 截断：临时给 taxonomy 加第二个关键词分类，maxExtraTags 设成 1
  {
    const t2 = JSON.parse(JSON.stringify(tax));
    t2.keywordTags.push({ tag: 'tech', words: ['硬件'] });
    t2.maxExtraTags = 1;
    const it = classifyItem({ source: '微博热搜', title: 'AI 硬件新闻', desc: '' }, t2);
    check('超出 maxExtraTags 被截断', it.tags.length === 2, it.tags);
    check('截断后主分类仍在', it.tags[0] === '热议', it.tags);
  }
}

console.log('\n── 关键词匹配 ──');
check('英文按单词边界：said 不命中 ai', matchWords('he said that', ['ai']).length === 0);
check('英文按单词边界：GPT-4 命中 GPT', matchWords('GPT-4 发布了', ['GPT']).length === 1);
check('中文子串命中', matchWords('大模型又变强了', ['大模型']).length === 1);
check('摘要也参与匹配', matchWords('', ['大模型']).length === 0);

console.log('\n── 分类顺序固定 ──');
{
  const big = { tags: ['热议', 'AI'] };
  const small = { tags: ['热议'] };
  const a = orderCategories(tax, [big, small, big]);
  const b = orderCategories(tax, [small, big, big]);
  check('条数变了顺序不变', JSON.stringify(a.map((x) => x.label)) === JSON.stringify(b.map((x) => x.label)), [a.map((x) => x.label), b.map((x) => x.label)]);
  check('顺序 = taxonomy 顺序', JSON.stringify(a.map((x) => x.label)) === JSON.stringify(tax.categories.map((c) => c.label).filter((l) => a.some((x) => x.label === l))), a.map((x) => x.label));
  check('没内容的分类不出现', !a.some((x) => x.label === '深度阅读'), a.map((x) => x.label));
  check('计数正确', a.find((x) => x.label === 'AI').count === 2, a);
}

console.log('\n── 坏配置要被拒 ──');
check('category 缺 label 被拒', validateTaxonomy({ categories: [{ key: 'a' }], sourceCategory: {} }).length > 0);
check('sourceCategory 指向不存在的 key 被拒', validateTaxonomy({ categories: [{ key: 'a', label: 'A' }], sourceCategory: { s: 'zzz' } }).length > 0);
check('keywordTags 指向不存在的 key 被拒', validateTaxonomy({ categories: [{ key: 'a', label: 'A' }], sourceCategory: { s: 'a' }, keywordTags: [{ tag: 'zzz', words: ['x'] }] }).length > 0);

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: 跑测试，确认它红**

Run: `node tools/test-news-taxonomy.mjs`
Expected: FAIL —— 报 `Cannot find module ... news-taxonomy.mjs`

- [ ] **Step 3: 写分类配置 `tools/news-taxonomy.json`**

```json
{
  "_doc": "见报分类的唯一真相源。改这里 = 改分类，不用动任何代码。categories 的顺序 = 前端 chip 显示顺序（固定，不随条数变）。sourceCategory：源名 -> 主分类 key，每个源都必须有。keywordTags：标题/摘要命中关键词后追加的分类。",

  "categories": [
    { "key": "hot",   "label": "热议" },
    { "key": "tech",  "label": "科技数码" },
    { "key": "ai",    "label": "AI" },
    { "key": "tools", "label": "效率工具" },
    { "key": "dev",   "label": "技术社区" },
    { "key": "deep",  "label": "深度阅读" }
  ],

  "sourceCategory": {
    "微博热搜": "hot",
    "知乎热榜": "hot",
    "虎扑步行街": "hot",
    "抽屉热榜": "hot",
    "驱动之家": "tech",
    "爱范儿": "tech",
    "AIHOT精选": "ai",
    "即刻·AI编程": "ai",
    "少数派": "tools",
    "少数派发现": "tools",
    "V2EX 热榜": "dev",
    "V2EX创意": "dev",
    "即刻·行业内幕": "dev",
    "阮一峰": "deep",
    "博海拾贝": "deep",
    "知乎日报": "deep"
  },

  "keywordTags": [
    {
      "tag": "ai",
      "words": ["AI", "人工智能", "大模型", "GPT", "ChatGPT", "Claude", "英伟达", "算力", "智能体", "机器学习"]
    }
  ],

  "maxExtraTags": 2
}
```

- [ ] **Step 4: 写归属计算模块 `tools/news-taxonomy.mjs`**

```js
/**
 * 见报分类：加载/校验 taxonomy，按条目算归属，按固定顺序排分类。
 *
 * 为什么单独一个模块：分类是「用户看到的第一层筛选」，
 * 映射错了不会报错 —— 用户点「AI」看到一堆不相关内容还以为自己记错了。
 * 所以规则集中在这里，build.mjs 只调用，不内嵌判断。
 *
 * 唯一真相源：tools/news-taxonomy.json（分类表 + 源映射 + 关键词表）
 */
import fs from 'node:fs';
import path from 'node:path';

export const TAXONOMY_FILE = 'news-taxonomy.json';

/* ── 校验 ─────────────────────────────────────────────── */

export function validateTaxonomy(t) {
  const errs = [];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['不是对象'];

  const cats = Array.isArray(t.categories) ? t.categories : [];
  if (!cats.length) errs.push('categories 为空');

  const keys = new Set();
  const labels = new Set();
  for (const c of cats) {
    if (!c || typeof c !== 'object') { errs.push('categories 里有不是对象的项'); continue; }
    if (!c.key) { errs.push('有 category 缺 key'); continue; }
    if (!c.label) { errs.push(`category ${c.key} 缺 label`); continue; }
    if (keys.has(c.key)) errs.push(`category key 重复：${c.key}`);
    if (labels.has(c.label)) errs.push(`category label 重复：${c.label}`);
    keys.add(c.key);
    labels.add(c.label);
  }

  const sc = (t.sourceCategory && typeof t.sourceCategory === 'object' && !Array.isArray(t.sourceCategory))
    ? t.sourceCategory : {};
  if (!Object.keys(sc).length) errs.push('sourceCategory 为空');
  for (const [src, key] of Object.entries(sc)) {
    if (!keys.has(key)) errs.push(`sourceCategory[${src}] 指向不存在的 category：${key}`);
  }

  for (const kt of Array.isArray(t.keywordTags) ? t.keywordTags : []) {
    if (!kt || typeof kt !== 'object' || !kt.tag) { errs.push('有 keywordTag 缺 tag'); continue; }
    if (!keys.has(kt.tag)) errs.push(`keywordTags 指向不存在的 category：${kt.tag}`);
    if (!Array.isArray(kt.words) || !kt.words.length) errs.push(`keywordTags[${kt.tag}] 的 words 为空`);
  }

  return errs;
}

export function loadTaxonomy(root) {
  const file = path.join(root, 'tools', TAXONOMY_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`读不到分类配置 ${file}：${e.message}`);
  }
  let t;
  try {
    t = JSON.parse(raw);
  } catch (e) {
    throw new Error(`分类配置 ${file} 不是合法 JSON：${e.message}`);
  }
  const errs = validateTaxonomy(t);
  if (errs.length) {
    throw new Error(`分类配置 ${file} 有问题：\n    - ` + errs.join('\n    - '));
  }
  return t;
}

/* ── 关键词匹配 ───────────────────────────────────────── */

/**
 * 命中的词列表。
 *
 * 中文词按子串匹配；英文/数字词按**单词边界**匹配 ——
 * 「said」不该命中「ai」，但「GPT-4」该命中「GPT」。
 */
export function matchWords(text, words) {
  if (!text) return [];
  const hit = [];
  const lower = String(text).toLowerCase();
  for (const w of words || []) {
    if (!w) continue;
    if (/[\u4e00-\u9fa5]/.test(w)) {
      // 含中文：子串匹配
      if (lower.includes(String(w).toLowerCase())) hit.push(w);
    } else {
      // 纯 ASCII：单词边界匹配
      const esc = String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|[^0-9A-Za-z])${esc}($|[^0-9A-Za-z])`, 'i');
      if (re.test(String(text))) hit.push(w);
    }
  }
  return hit;
}

/* ── 归属计算 ─────────────────────────────────────────── */

/**
 * 算一条内容的归属。
 *
 * 归属 = 源的主分类（必有） + 关键词命中的分类（可无，最多 maxExtraTags 个）。
 * 源没配分类 -> 抛错。**不 fallback 到「其它」** ——
 * 悄悄归到「其它」会让人以为分类没问题，其实是新源漏配了。
 */
export function classifyItem(item, taxonomy) {
  const src = (item && item.source) || '';
  const mainKey = taxonomy.sourceCategory[src];
  if (!mainKey) {
    const known = Object.keys(taxonomy.sourceCategory).join('、');
    throw new Error(
      `源「${src}」没有配分类（news-taxonomy.json 的 sourceCategory 缺这一项）。` +
      `已配的源：${known}`
    );
  }

  const catByKey = new Map(taxonomy.categories.map((c) => [c.key, c]));
  const maxExtra = Number.isInteger(taxonomy.maxExtraTags) ? taxonomy.maxExtraTags : 2;

  const text = `${(item && item.title) || ''}\n${(item && item.desc) || ''}`;
  const extraKeys = [];
  for (const kt of taxonomy.keywordTags || []) {
    if (!kt || kt.tag === mainKey) continue;
    if (matchWords(text, kt.words || []).length) extraKeys.push(kt.tag);
  }

  const keys = [mainKey, ...extraKeys].slice(0, 1 + maxExtra);
  const labels = keys.map((k) => {
    const c = catByKey.get(k);
    if (!c) throw new Error(`分类 key 不存在：${k}`);
    return c.label;
  });

  return { tag: labels[0], tags: labels, mainKey, keys };
}

/* ── 分类列表 ─────────────────────────────────────────── */

/**
 * 分类列表：按 taxonomy 里的**固定顺序**，只保留当天有内容的。
 *
 * 为什么不按条数排：按条数排的话「AI」今天第 3 位明天第 1 位，
 * chip 位置天天乱跳，用户的肌肉记忆就废了。
 */
export function orderCategories(taxonomy, items) {
  const count = new Map();
  for (const it of items || []) {
    for (const t of (it && it.tags) || []) {
      if (!t) continue;
      count.set(t, (count.get(t) || 0) + 1);
    }
  }
  const out = [];
  for (const c of taxonomy.categories) {
    const n = count.get(c.label) || 0;
    if (n > 0) out.push({ label: c.label, count: n });
  }
  return out;
}
```

- [ ] **Step 5: 跑测试，确认它绿**

Run: `node tools/test-news-taxonomy.mjs`
Expected: 全部通过，`═══ N 通过 / 0 失败 ═══`，exit 0

- [ ] **Step 6: 不在本任务写 README（挪到 Task 3）**

> **2026-11-05 改（用户裁决）**：原本这一步是「在 README 记录」，评审发现那段文字写的是
> **目标态**（「`rss.config.json` 的 `tag` 字段已删除」「chip 顺序已固定」）——
> 但这些要到 Task 3 接线才成立，跟 README 里今天仍在生效的旧描述自相矛盾。
> 文档必须跟现状走，所以 README 那一节挪到 **Task 3 Step 11** 写。
>
> 本任务**不要动 `README.md`**。Task 1 的交付物只有 3 个新文件。

- [ ] **Step 7: 确认工作区没有残留**

Run: `Get-ChildItem 'PROJECT_ROOT' -Filter 'tmp-*' -Recurse -File -ErrorAction SilentlyContinue | Select-Object FullName`
Expected: 空（没有输出）

---

### Task 2: 变异测试（护栏有没有牙齿）

**Files:**
- Create: `tools/test-news-taxonomy-mutate.mjs`

**Interfaces:**
- Consumes: Task 1 的 `tools/news-taxonomy.mjs` 与 `tools/test-news-taxonomy.mjs`
- Produces: 无（纯验证）

**为什么单独一个任务**：本项目踩过 7 次「假护栏」—— 测试全绿但护栏是空的。
判定标准是**变异测试**：故意打破规则，测试必须变红。绿了就说明护栏没牙齿。

- [ ] **Step 1: 写变异脚本**

创建 `tools/test-news-taxonomy-mutate.mjs`：

```js
/**
 * 变异测试：故意破坏 4 条规则，验证单元测试抓得住。
 *
 * 护栏有没有牙齿，判定标准是「变异测试」：
 * 改坏实现，测试必须变红。全绿 = 护栏是空的。
 *
 * 手法：把 news-taxonomy.mjs 的源码按变异规则改写，写进临时目录，
 * 连同测试一起在临时目录跑一遍，检查测试是否失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const TMP = path.join(SITE, 'tools', '.tmp-news-mutate');
const TMPTOOLS = path.join(TMP, 'tools');

const MUTATIONS = [
  {
    id: 'M1',
    name: '源未映射时 fallback 到「其它」而不是报错',
    from: "throw new Error(\n      `源「${src}」没有配分类",
    to: "return { tag: '其它', tags: ['其它'], mainKey: 'other', keys: ['other'] };\n    // throw new Error(\n    //   `源「${src}」没有配分类",
  },
  {
    id: 'M2',
    name: '分类列表改回按条数降序',
    from: "for (const c of taxonomy.categories) {\n    const n = count.get(c.label) || 0;\n    if (n > 0) out.push({ label: c.label, count: n });\n  }",
    to: "for (const c of taxonomy.categories) {\n    const n = count.get(c.label) || 0;\n    if (n > 0) out.push({ label: c.label, count: n });\n  }\n  out.sort((a, b) => b.count - a.count);",
  },
  {
    id: 'M3',
    name: '关键词只匹配标题不匹配摘要',
    from: "const text = `${(item && item.title) || ''}\\n${(item && item.desc) || ''}`;",
    to: "const text = `${(item && item.title) || ''}`;",
  },
  {
    id: 'M4',
    name: '多归属退化成单归属',
    from: "const keys = [mainKey, ...extraKeys].slice(0, 1 + maxExtra);",
    to: "const keys = [mainKey];",
  },
];

// 临时工程：测试文件放在 TMP/tools/ 下 —— 测试脚本用
// path.resolve(__dirname, '..') 算 SITE，放对了它就自动指向 TMP。
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMPTOOLS, 'grab'), { recursive: true });
for (const f of ['test-news-taxonomy.mjs', 'rss.config.json', 'news-taxonomy.json']) {
  fs.copyFileSync(path.join(SITE, 'tools', f), path.join(TMPTOOLS, f));
}
fs.copyFileSync(path.join(SITE, 'tools', 'grab', 'daily_headlines.py'), path.join(TMPTOOLS, 'grab', 'daily_headlines.py'));
const orig = fs.readFileSync(path.join(SITE, 'tools', 'news-taxonomy.mjs'), 'utf8');
fs.writeFileSync(path.join(TMPTOOLS, 'news-taxonomy.mjs'), orig, 'utf8');

let caught = 0;
for (const m of MUTATIONS) {
  if (!orig.includes(m.from)) {
    console.log(`  ✗ ${m.id} ${m.name} —— 变异锚点没找到，变异脚本本身过期了（源文件改了？）`);
    process.exit(1);
  }
  const mutated = orig.replace(m.from, m.to);
  fs.writeFileSync(path.join(TMPTOOLS, 'news-taxonomy.mjs'), mutated, 'utf8');
  let red = false;
  try {
    execFileSync(process.execPath, [path.join(TMPTOOLS, 'test-news-taxonomy.mjs')], { stdio: 'pipe' });
  } catch (e) {
    red = true; // 非 0 退出 = 测试抓到了
  }
  console.log(`  ${red ? '✓' : '✗'} ${m.id} ${m.name} —— ${red ? '被抓到了' : '没被抓到（护栏没牙齿！）'}`);
  if (red) caught++;
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n变异测试：${caught}/${MUTATIONS.length} 被抓到`);
process.exit(caught === MUTATIONS.length ? 0 : 1);
```

- [ ] **Step 2: 跑变异测试**

Run: `node tools/test-news-taxonomy-mutate.mjs`
Expected: `变异测试：4/4 被抓到`，exit 0

**如果某个变异没被抓到**：说明单元测试有缺口，回去补断言，再跑一遍。
**如果报「变异锚点没找到」**：说明 `news-taxonomy.mjs` 的源码和变异脚本里的锚点不一致，
读一下当前源码，把 `from` 改成当前实际文本。

- [ ] **Step 3: 跑一遍单元测试确认没被变异脚本弄坏**

Run: `node tools/test-news-taxonomy.mjs`
Expected: 全部通过，exit 0

---

### Task 3: build.mjs 接入 taxonomy

**Files:**
- Modify: `tools/build.mjs`（import 区、news 组装段、分类列表段）
- Modify: `tools/rss.config.json`（删 `feeds[].tag`，更新 `_doc`）
- Create: `tools/test-build-taxonomy.mjs`

**Interfaces:**
- Consumes: Task 1 的 `loadTaxonomy(root)` / `classifyItem(item, tax)` / `orderCategories(tax, items)`
- Produces: `build.mjs` 构建出的 manifest 里，news tab 的 `items[].tag` = 主分类 label、`items[].tags` = 全部归属 label 数组；`tabs[news].tags` = 固定顺序的分类 label 列表

- [ ] **Step 1: 写失败的集成测试**

创建 `tools/test-build-taxonomy.mjs`：

```js
/**
 * 集成测试：真在临时目录跑一次构建，验 manifest 的分类。
 *
 * 为什么不直接读真产物：真产物是线上期次，构建会改它。
 * 这个测试在临时目录里造最小工程，跑完删掉，不碰 published/。
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

function setupProject() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'tools'), { recursive: true });

  for (const f of [
    'build.mjs', 'paths.mjs', 'env.mjs', 'fetch-rss.mjs',
    'webp.mjs', 'headlines.mjs', 'link-auth.mjs',
    'news-taxonomy.mjs', 'news-taxonomy.json',
  ]) {
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
  writeHeadlines(srcDir, [
    { title: '某公司发布新款 AI 大模型', source: '微博热搜' },
    { title: '普通生活话题', source: '知乎热榜' },
  ]);
}

// 跑构建：关 RSS（不联网），只让 headlines 进
let buildOut = '';
let buildOk = true;
try {
  buildOut = execFileSync(process.execPath,
    [path.join(TMP, 'tools', 'build.mjs'), '--date', DATE, '--no-rss'],
    {
      cwd: TMP, stdio: 'pipe', encoding: 'utf8',
      env: { ...process.env, IMAGE_ROOT: path.join(TMP, 'imageroot') },
    });
} catch (e) {
  buildOk = false;
  buildOut = (e.stdout || '') + (e.stderr || '');
}

check('构建成功', buildOk, buildOut.slice(-800));

if (buildOk) {
  const pubDir = path.join(TMP, 'published', DATE);
  const mf = fs.readdirSync(pubDir).find((n) => /^manifest\..*\.js$/.test(n));
  check('生成了 manifest', !!mf, fs.readdirSync(pubDir));
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
    check('分类列表含「热议」', news.tags.includes('热议'), news.tags);
    check('分类列表含「AI」', news.tags.includes('AI'), news.tags);
    check('分类列表只含有内容的分类（这期就 2 个）', news.tags.length === 2, news.tags);
    check('分类列表按 taxonomy 固定顺序', news.tags.indexOf('热议') < news.tags.indexOf('AI'), news.tags);
  }
  check('构建日志标明分类是固定顺序', buildOut.includes('固定顺序'), buildOut.slice(-400));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: 跑测试，确认它红**

Run: `node tools/test-build-taxonomy.mjs`
Expected: FAIL —— 「微博热搜 → 主分类「热议」」等断言失败（当前 build.mjs 仍用旧的 tag/category）

- [ ] **Step 3: 改 `tools/build.mjs`：加 import**

在 import 区（`import { markAuth } from './link-auth.mjs';` 附近）加一行：

```js
import { loadTaxonomy, classifyItem, orderCategories } from './news-taxonomy.mjs';
```

- [ ] **Step 4: 改 `tools/build.mjs`：构建开头加载 taxonomy**

在 `const publishedDir = path.join(ROOT, 'published', date);` 之后加：

```js
  /* --- 分类配置 ---
     提前加载：配置写错要在构建开头就报，而不是等到拼 manifest 时才炸。
     加载失败直接抛错中止 —— 分类配错会静默发错内容，不能降级。 */
  const taxonomy = loadTaxonomy(ROOT);
```

- [ ] **Step 5: 改 `tools/build.mjs`：统一重算归属**

把 news 组装段（当前是「先抓 RSS、再读头条」两段）改成三分支。**整段替换**：

```js
  /* ── 见报的三个来源分支 ──
       1. --retag：沿用已发布 manifest 的见报条目，只重算分类标签（Task 4 实现）
       2. 普通构建：RSS + 头条都重新抓
       3. --keep-manifest：整份 manifest 原样沿用，压根不碰见报
     分类归属统一在下面重算，不看 RSS 的 tag、不看头条的 category。 */
  if (args.retag) {
    // Task 4 会把这里换成真正的实现（读已发布 manifest + 沿用条目）。
    throw new Error('--retag 尚未实现（见计划 Task 4）');
  } else {
    if (!args.skipRss && !keptManifest) {
      const cfg = loadConfig();
      if (cfg.enabled) {
        const r = await fetchHeadlines(cfg);
        rssCount = r.items.length;
        for (const f of r.failures) {
          console.log(`  ! RSS 源 ${f.name} 抓取失败：${f.error}（不影响其他源）`);
        }
        for (const it of r.items) {
          newsItems.push({
            title: it.title,
            link: it.link,
            source: it.source,
            tag: it.tag,
            tags: [it.tag],
            time: it.time,
            ts: it.ts || 0,
            desc: (it.desc || '').slice(0, 120),
          });
        }
      } else {
        console.log('  · RSS 已关闭（rss.config.json: enabled=false）');
      }
    }

    // 头条：读 daily_headlines.py 落的 JSON。没有这个文件就跳过，不报错。
    //
    // --keep-manifest 时不读：内容要原样沿用上一版，重新读一遍只会引入差异。
    const tops = keptManifest ? null : await loadHeadlines(srcRoot, date);
    if (tops && tops.items.length) {
      topCount = tops.items.length;
      newsItems.push(...tops.items);
      console.log(`  · 头条 ${topCount} 条（${tops.sources.length} 个源）`);
    } else if (!args.skipRss && !keptManifest) {
      console.log(`  · 没有找到头条 JSON（${path.join(srcRoot, 'headlines')}）—— 跳过头条部分`);
    }
  }
```

- [ ] **Step 6: 改 `tools/build.mjs`：重算归属 + 固定顺序的分类列表**

把 `if (newsItems.length) {` 那一段里「目录列表」的部分（当前从 `// 目录列表：按**内容量**排序` 到 `console.log(...目录...)`）**整段替换**：

```js
    // ── 分类归属重算 ──
    // 一律以 news-taxonomy.json 为准：RSS 的 tag 和头条的 category 只是线索。
    // 源没配分类 -> classifyItem 抛错 -> 整个构建失败（不静默归到「其它」）。
    for (const it of newsItems) {
      const c = classifyItem(it, taxonomy);
      it.tag = c.tag;
      it.tags = c.tags;
    }

    // 分类列表：按 taxonomy 的**固定顺序**，只列当天有内容的。
    // 不按条数排 —— 按条数排的话 chip 位置天天乱跳，用户的肌肉记忆就废了。
    const cats = orderCategories(taxonomy, newsItems);
    const ordered = cats.map((c) => c.label);

    console.log(
      `  · 目录 ${ordered.length} 个（固定顺序）：` +
        cats.map((c) => `${c.label}(${c.count})`).join(' '),
    );
```

**注意**：`if (newsItems.length) {` 这行和它里面的 `newsItems.sort(...)`、`markAuth(newsItems)`、`manifest.tabs.push({...})` 都**保持原样不动**。
只替换「目录列表」那一段。

- [ ] **Step 7: 改 `tools/rss.config.json`：删掉 tag 字段**

把 `feeds` 数组里每个源对象的 `"tag": "xxx",` 行删掉（例如「少数派」变成只有 `name` 和 `url`）。

同时把 `_doc.feeds` 那行改成：

```json
    "feeds": "每个源：name=显示的来源名，url=订阅地址。分类不在这里配 —— 见 tools/news-taxonomy.json（唯一真相源）",
```

- [ ] **Step 8: 跑集成测试，确认它绿**

Run: `node tools/test-build-taxonomy.mjs`
Expected: `═══ N 通过 / 0 失败 ═══`，exit 0

- [ ] **Step 9: 跑单元测试，确认没打破别的**

Run:
```powershell
node tools/test-news-taxonomy.mjs
node tools/test-news-ui.mjs
node tools/test-keep-manifest.mjs
node tools/test-contract.mjs
```
Expected: 全部 exit 0

**如果 `test-contract.mjs` 红了**：它断言前后端的正则/常量逐字相同，
看它报哪一项 —— 很可能是它手抄了旧的分类列表，需要一起更新。

- [ ] **Step 10: 用真数据跑一次构建，确认当期能出正确分类**

Run: `node tools/build.mjs --date 2026-11-05 --no-convert`
Expected: 构建成功，日志里出现 `· 目录 6 个（固定顺序）：热议(114) 科技数码(34) ...`

**这一步会改 `published/2026-11-05/`（当期线上产物）** —— 这是预期的，Task 5 会统一部署。
如果不想现在就动线上产物，跳过这步，把验证留给 Task 5。

- [ ] **Step 11: 在 README 记录（Task 1 原 Step 6 挪到这里）**

> **为什么挪过来**：Task 1 就写 README 的话，那段文字写的是**目标态**
> （「`rss.config.json` 的 `tag` 字段已删除」「chip 顺序已固定」），
> 但这些要到本任务接线才成立 —— 跟 README 里今天仍在生效的旧描述自相矛盾。
> 文档必须跟现状走，所以放在接线之后写。

在 `README.md` 的《见报的两层筛选：大类 + 真实 RSS 源名（2026-11-04 加）》那一节**后面**插入：

```markdown
### 见报的分类：唯一真相源 `news-taxonomy.json`（2026-11-05 改）

见报顶层的分类以前是三套轴混在一起：

```
全部 / 微博 / 科技 / 社区 / 知乎 / 即刻 / 效率 / 博客 / 数码 / 资讯 / AI
```

平台名（微博/知乎/即刻/V2EX）、内容领域（科技/效率/数码/AI）、内容形态（社区/博客/资讯）
并列一行，用户没法建立心智模型 —— 看到「科技」和「微博」并列时，
他会问「那我到底该怎么找东西」。

现在改成分类**只按用户思维**（= 我想看什么）：

```
全部 / 热议 / 科技数码 / AI / 效率工具 / 技术社区 / 深度阅读
```

| 分类 | 含义 | 源 |
|---|---|---|
| 热议 | 今天大家在聊什么 | 微博热搜、知乎热榜、虎扑步行街、抽屉热榜 |
| 科技数码 | 硬件、软件、产品发布 | 驱动之家、爱范儿 |
| AI | 前沿模型与工具 | AIHOT精选、即刻·AI编程 |
| 效率工具 | 软件、技巧、方法 | 少数派、少数派发现 |
| 技术社区 | 开发者与从业者讨论 | V2EX 热榜、V2EX创意、即刻·行业内幕 |
| 深度阅读 | 长文，值得存下来慢慢看 | 阮一峰、博海拾贝、知乎日报 |

**为什么热榜不拆**：实测 114 条（占 66%）是平台热榜，
抽样看微博热搜全是「上岸第一件先娶意中人」这类社会娱乐话题，**没有一条技术内容**；
虎扑是消费/游戏，知乎是职场讨论。靠标题关键词拆到「AI/数码」里会大量误判。
平台名由**下层的真实源名**承担 —— 想按平台精确挑依然可以。

**分类表在哪改**：`tools/news-taxonomy.json`，**只有这一处**。
`rss.config.json` 的 `tag` 字段已删除，Python 侧写的 `category` 只当归档线索、不参与决策
（分类决策统一在 `build.mjs` 做，避免两处配置各说各话）。

**两个关键行为**：

- **chip 顺序固定**（按 `categories` 数组顺序），不按条数排 ——
  按条数排的话「AI」今天第 3 位明天第 1 位，位置天天乱跳。
- **一条内容可以属于多个领域**：源的主分类 + 关键词命中的额外分类（最多 2 个）。
  所以微博热搜里真有 AI 新闻时，点「AI」也能捞到。

**漏配新源会直接让构建失败**（不静默归到「其它」）：
源不在 `sourceCategory` 里 → 构建报错并列出已配的源。
```
---

### Task 4: `--retag` 模式（往期重分类）

**Files:**
- Modify: `tools/build.mjs`（parseArgs、main 里的 manifest 读取段）
- Create: `tools/test-retag.mjs`

**Interfaces:**
- Consumes: Task 1 的 `classifyItem` / `orderCategories`；Task 3 已接好的重算段
- Produces: `node tools/build.mjs --date <日期> --no-convert --retag` —— 沿用该期已发布 manifest 的**全部条目**（含图片），只重算见报的分类标签

- [ ] **Step 1: 写失败的测试**

创建 `tools/test-retag.mjs`：

```js
/**
 * --retag 模式测试：往期重分类。
 *
 * 核心保证：**条目内容一个字都不改**，只有分类标签变。
 * 这是往期重分类的安全底线 —— 内容变了等于篡改历史。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const TMP = path.join(SITE, 'tools', '.tmp-retag-test');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

// 造最小工程：照抄 tools/test-keep-manifest.mjs 的隔离模式
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function writeHeadlines(srcDir, date) {
  const dir = path.join(srcDir, 'headlines');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `headlines_${date}.json`), JSON.stringify({
    generatedAt: date + 'T00:00:00+08:00', ts: 1767225600, sources: [],
    items: [{ title: '某公司发布新款 AI 大模型', link: 'https://example.com/a', source: '微博热搜', category: '旧分类名' }],
  }), 'utf8');
}

function buildSite(date) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'tools'), { recursive: true });

  for (const f of [
    'build.mjs', 'paths.mjs', 'env.mjs', 'fetch-rss.mjs',
    'webp.mjs', 'headlines.mjs', 'link-auth.mjs',
    'news-taxonomy.mjs', 'news-taxonomy.json',
  ]) {
    fs.copyFileSync(path.join(SITE, 'tools', f), path.join(TMP, 'tools', f));
  }
  const cfg = path.join(SITE, 'tools', 'rss.config.json');
  if (fs.existsSync(cfg)) fs.copyFileSync(cfg, path.join(TMP, 'tools', 'rss.config.json'));

  copyDir(path.join(SITE, 'site'), path.join(TMP, 'site'));

  const salt = path.join(SITE, '.img-salt');
  if (fs.existsSync(salt)) fs.copyFileSync(salt, path.join(TMP, '.img-salt'));

  const imgRoot = path.join(TMP, 'imageroot');
  const srcDir = path.join(imgRoot, 'src', date);
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
  writeHeadlines(srcDir, date);
}

const DATE = '2026-11-04';
buildSite(DATE);

// 先做一次普通构建，产出「旧分类」的 manifest
function run(args, date = DATE) {
  try {
    const out = execFileSync(process.execPath,
      [path.join(TMP, 'tools', 'build.mjs'), '--date', date, ...args],
      {
        cwd: TMP, stdio: 'pipe', encoding: 'utf8',
        env: { ...process.env, IMAGE_ROOT: path.join(TMP, 'imageroot') },
      });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}
function readManifest(dir) {
  const mf = fs.readdirSync(dir).find((n) => /^manifest\..*\.js$/.test(n));
  return JSON.parse(fs.readFileSync(path.join(dir, mf), 'utf8')
    .replace(/^window\.__DAILY_MANIFEST__=/, '').replace(/;\s*$/, ''));
}

const r1 = run(['--no-rss']);
check('第一次构建成功', r1.ok, r1.out.slice(-600));

if (r1.ok) {
  const pubDir = path.join(TMP, 'published', DATE);
  const before = readManifest(pubDir);
  const newsBefore = before.tabs.find((t) => t.key === 'news');
  check('第一次构建的见报用的是新分类', newsBefore && newsBefore.items[0].tag === '热议', newsBefore && newsBefore.items[0]);

  // 把旧 manifest 抄一份留作比对
  const beforeJson = JSON.stringify(newsBefore.items.map((i) => ({
    title: i.title, link: i.link, source: i.source, time: i.time, desc: i.desc,
  })));

  // 现在改分类配置，再跑 --retag
  const taxPath = path.join(TMP, 'tools', 'news-taxonomy.json');
  const tax = JSON.parse(fs.readFileSync(taxPath, 'utf8'));
  tax.categories[0].label = '热门热议';
  fs.writeFileSync(taxPath, JSON.stringify(tax, null, 2), 'utf8');

  const r2 = run(['--no-rss', '--retag']);
  check('--retag 构建成功', r2.ok, r2.out.slice(-600));

  if (r2.ok) {
    const after = readManifest(pubDir);
    const newsAfter = after.tabs.find((t) => t.key === 'news');
    check('条目内容逐条不变', JSON.stringify(newsAfter.items.map((i) => ({
      title: i.title, link: i.link, source: i.source, time: i.time, desc: i.desc,
    }))) === beforeJson);
    check('分类标签已按新配置重算', newsAfter.items[0].tag === '热门热议', newsAfter.items[0].tag);
    check('分类列表也更新了', newsAfter.tags.includes('热门热议'), newsAfter.tags);
    check('条目条数不变', newsAfter.items.length === newsBefore.items.length, [newsBefore.items.length, newsAfter.items.length]);
  }

  // 闸门：--retag 与 --keep-manifest 互斥
  const r3 = run(['--no-rss', '--retag', '--keep-manifest']);
  check('--retag 与 --keep-manifest 互斥（报错）', !r3.ok && /互斥/.test(r3.out), r3.out.slice(-300));

  // 闸门：目标日期没有已发布 manifest 时拒绝执行
  const r4 = run(['--no-rss', '--retag'], '2026-01-01');
  check('没有已发布 manifest 时拒绝执行', !r4.ok && /没有|找不到|不存在/.test(r4.out), r4.out.slice(-300));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: 跑测试，确认它红**

Run: `node tools/test-retag.mjs`
Expected: FAIL —— `--retag` 还没实现（argparse 不认这个参数，构建要么忽略要么报错）

- [ ] **Step 3: `tools/build.mjs` 加 `--retag` 参数**

在 `parseArgs` 里，`else if (a === '--keep-manifest') args.keepManifest = true;` 那一行后面加：

```js
    else if (a === '--retag') args.retag = true;
```

在 `--help` 的文本里（`--keep-manifest` 那段之后）加：

```text
  --retag           往期重分类：沿用这一期已发布的条目（含图片），只按 news-taxonomy.json
                    重算见报的分类标签。内容一个字都不改。
                    用途：分类体系改了以后，把往期也统一过来（避免新旧两套分类并存）。
                    与 --keep-manifest 互斥（一个要重算分类，一个要原样沿用）。
```

- [ ] **Step 4: `tools/build.mjs` 读取已发布 manifest（retag 用）**

在 `let keptManifest = null;` 那段**之前**插入：

```js
  /* --- 往期重分类（--retag）---
     读这一期已发布的 manifest，当作「条目来源」：
     见报条目原样沿用，只重算分类标签。

     必须在清空 published/<日期>/ 之前读 —— 下面那行 fs.rm 会把目录整个删掉。 */
  let retagBase = null;
  if (args.retag) {
    if (args.keepManifest) {
      throw new Error('--retag 与 --keep-manifest 互斥：一个要重算分类，一个要原样沿用');
    }
    retagBase = await readManifestFile(publishedDir);
    if (!retagBase) {
      throw new Error(
        `--retag 需要这一期已发布的 manifest，但 ${publishedDir} 里没有。` +
        '没有已发布产物就没法「沿用」，直接拒绝（不猜、不退化成普通构建）。'
      );
    }
    console.log(`  · --retag：沿用已发布的 manifest（生成于 ${retagBase.generatedAt}），只重算分类标签`);
  }
```

- [ ] **Step 5: `tools/build.mjs` 实现 retag 分支（把 Task 3 里的占位换掉）**

Task 3 Step 5 里 `--retag` 分支写的是 `throw new Error('--retag 尚未实现')`。现在把它换成真正的实现：

old:

```js
  if (args.retag) {
    // Task 4 会把这里换成真正的实现（读已发布 manifest + 沿用条目）。
    throw new Error('--retag 尚未实现（见计划 Task 4）');
  } else {
```

new:

```js
  if (args.retag) {
    const newsTab = (retagBase.tabs || []).find((t) => t.key === 'news');
    if (newsTab && Array.isArray(newsTab.items) && newsTab.items.length) {
      // 原样沿用条目 —— 只重算分类标签，内容一个字都不改
      newsItems.push(...newsTab.items.map((it) => ({ ...it })));
      console.log(`  · --retag：沿用已发布 manifest 的 ${newsTab.items.length} 条见报条目（只重算分类标签）`);
    } else {
      console.log('  · --retag：已发布 manifest 里没有见报条目');
    }
  } else {
```

- [ ] **Step 6: `tools/build.mjs` 加 retag 的图片闸门**

图片 tab 正常构建（复用转码产物）。构建完 news tab 之后，
在现有的 `--keep-manifest` 闸门**旁边**加 retag 的闸门：

```js
  /* --- --retag 的闸门：图片必须跟已发布的版本一模一样 ---
     往期重分类只该改分类标签。如果图片跟已发布的不一致，
     说明这期源图被动过（删过/移过）—— 那就不该重分类，得走正常发版流程。 */
  if (retagBase) {
    const diffs = diffImageTabs(retagBase, manifest);
    if (diffs.length) {
      console.error('');
      console.error(`  ✗ 图片跟已发布的 manifest 对不上（${diffs.length} 处差异），--retag 已拒绝：`);
      for (const d of diffs.slice(0, 12)) console.error(`      ${d}`);
      if (diffs.length > 12) console.error(`      … 还有 ${diffs.length - 12} 处`);
      throw new Error('图片变了，不能只重分类（请走正常构建 + 审稿流程）');
    }
    console.log('  ✓ 图片与已发布版本一致（只改了分类标签）');
  }
```

- [ ] **Step 7: 跑测试，确认它绿**

Run: `node tools/test-retag.mjs`
Expected: `═══ N 通过 / 0 失败 ═══`，exit 0

- [ ] **Step 8: 跑全套单元测试**

Run:
```powershell
node tools/test-news-taxonomy.mjs
node tools/test-news-taxonomy-mutate.mjs
node tools/test-build-taxonomy.mjs
node tools/test-retag.mjs
node tools/test-likes.mjs
node tools/test-board.mjs
node tools/test-functions.mjs
node tools/test-likes-ui.mjs
node tools/test-board-ui.mjs
node tools/test-contract.mjs
node tools/test-news-ui.mjs
node tools/test-keep-manifest.mjs
```
Expected: 全部 exit 0

---

### Task 5: 往期 11 期 + 当期逐期重建并部署

**Files:**
- Create: `tools/retag-all.mjs`
- Modify: `README.md`（新增一节《往期重分类：`--retag`》）

**Interfaces:**
- Consumes: Task 4 的 `--retag` 模式
- Produces: 11 期往期 + 当期的 manifest 全部换成新分类；线上 12 个日期页的 chip 行统一

**⚠️ 这一步会改线上产物并重新部署。部署前必须向用户确认。**

- [ ] **Step 1: 写 `tools/retag-all.mjs`**

```js
/**
 * 往期重分类：逐期跑 --retag，并自动比对「条目内容一个字都没改」。
 *
 * 为什么要有这个脚本：手工跑 11 次，每次都要人肉比对内容没变 ——
 * 比对逻辑一旦漏了，就会把改过的历史悄悄发出去。
 * 这里把「跑 + 比对」绑在一起，跑完出一份报告。
 *
 * 注意：最新一期必须放最后 —— 根路径 published/index.html 永远指向最后构建的那一期。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SITE = 'PROJECT_ROOT';

/** 从早到晚。最新一期放最后。 */
const DATES = [
  '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30',
  '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05',
];

function readManifest(dir) {
  const mf = fs.readdirSync(dir).find((n) => /^manifest\..*\.js$/.test(n));
  if (!mf) return null;
  return JSON.parse(fs.readFileSync(path.join(dir, mf), 'utf8')
    .replace(/^window\.__DAILY_MANIFEST__=/, '').replace(/;\s*$/, ''));
}

/** 条目内容指纹：只看内容字段，不看分类。 */
function contentOf(items) {
  return JSON.stringify((items || []).map((i) => ({
    title: i.title, link: i.link, source: i.source, time: i.time, desc: i.desc,
  })));
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dates = only.length ? only : DATES;

let bad = 0;
for (const date of dates) {
  const pubDir = path.join(SITE, 'published', date);
  const before = readManifest(pubDir);
  if (!before) { console.log(`  ! ${date} 没有已发布 manifest，跳过`); continue; }
  const beforeNews = before.tabs.find((t) => t.key === 'news');

  let out = '';
  let ok = true;
  try {
    out = execFileSync(process.execPath,
      [path.join(SITE, 'tools', 'build.mjs'), '--date', date, '--no-convert', '--retag'],
      { cwd: SITE, stdio: 'pipe', encoding: 'utf8' });
  } catch (e) {
    ok = false;
    out = (e.stdout || '') + (e.stderr || '');
  }
  if (!ok) {
    console.log(`  ✗ ${date} 构建失败：\n${out.split('\n').slice(-12).map((l) => '      ' + l).join('\n')}`);
    bad++;
    continue;
  }

  const after = readManifest(pubDir);
  const afterNews = after.tabs.find((t) => t.key === 'news');
  const same = contentOf(beforeNews && beforeNews.items) === contentOf(afterNews && afterNews.items);
  const cats = afterNews ? afterNews.tags : [];
  console.log(`  ${same ? '✓' : '✗'} ${date}  内容${same ? '未变' : '变了（！）'}  分类：${cats.join(' ')}`);
  if (!same) bad++;
}

console.log(bad ? `\n${bad} 期有问题` : '\n全部期次：条目内容逐条未改');
process.exit(bad ? 1 : 0);
```

- [ ] **Step 2: 在一个受控目录上先试跑一期**

Run: `node tools/retag-all.mjs 2026-11-04`
Expected: `✓ 2026-11-04  内容未变  分类：热议 ... 科技数码 ...`

**如果报「图片跟已发布的 manifest 对不上」**：说明这期的源图被动过。
查清楚是什么改动 —— **不要**绕过闸门，改走正常发版流程（审稿 → 发布）。

- [ ] **Step 3: 逐期重建全部 12 期**

Run: `node tools/retag-all.mjs`
Expected: 12 行全部 `✓`，末行 `全部期次：条目内容逐条未改`

**⚠️ 这一步改了 `published/` 下的 12 期产物。根路径现在指向 11-05（最后构建的）。**

- [ ] **Step 4: 确认产物自检全过**

Run:
```powershell
foreach ($d in @('2026-10-25','2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01','2026-11-02','2026-11-03','2026-11-04','2026-11-05')) {
  node tools/verify-build.mjs --date $d
  if ($LASTEXITCODE -ne 0) { "FAILED: $d" }
}
```
Expected: 每期 `✓ 通过`，没有 `FAILED`

- [ ] **Step 5: 部署（需用户确认后执行）**

图片没变（manifest 的图片部分字节不变），**不用重传 R2**，只重新部署 Pages：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -Date 2026-11-05 -SkipBuild -SkipUpload
```

**部署前先跟用户确认**（这一步是对外可见的改动）。

- [ ] **Step 6: 线上验证：根页 + 往期页的 chip 行**

写一个临时脚本 `tmp-verify-taxonomy-online.mjs`（用完删）：

```js
import { createRequire } from 'node:module';
import path from 'node:path';
const SITE = 'PROJECT_ROOT';
const req = createRequire(path.join(SITE, 'package.json'));
const { chromium } = req('playwright');
const BASE = 'https://example.com';
const DATES = ['2026-10-25','2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30',
               '2026-10-31','2026-11-01','2026-11-02','2026-11-03','2026-11-04','2026-11-05'];
const PLATFORM = /微博|知乎|即刻|V2EX|虎扑|抽屉/;

async function get(url, tries = 5) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); return r; } catch (e) { lastErr = e; await new Promise(s => setTimeout(s, 1200 * (i + 1))); }
  }
  throw lastErr;
}

let pass = 0, fail = 0;
const check = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); } };

const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

for (const date of DATES) {
  const url = date === '2026-11-05' ? `${BASE}/?_=${Date.now()}` : `${BASE}/${date}/?_=${Date.now()}`;
  let loaded = false;
  for (let i = 1; i <= 4 && !loaded; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); loaded = true; }
    catch (e) { await page.waitForTimeout(1500 * i); }
  }
  if (!loaded) { check(`${date} 页面能打开`, false); continue; }
  await page.waitForTimeout(1800);
  await page.locator('.tab[data-key="news"]').click();
  await page.waitForTimeout(900);
  const chips = await page.locator('.chips-tags .chip').allInnerTexts();
  const bad = chips.filter((c) => PLATFORM.test(c));
  check(`${date} chip 行不含平台名`, bad.length === 0, bad);
  check(`${date} chip 行有内容`, chips.length >= 2, chips);
}

check('全程无 JS 异常', errors.length === 0, errors);
await browser.close();
console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail === 0 ? 0 : 1);
```

Run: `node tmp-verify-taxonomy-online.mjs`
Expected: `═══ N 通过 / 0 失败 ═══`

- [ ] **Step 7: 清理临时脚本**

```powershell
recycle-delete.cmd -- "PROJECT_ROOT/tmp-verify-taxonomy-online.mjs"
```

- [ ] **Step 8: 在 README 记录**

在 Task 1 加的那节**后面**插入：

```markdown
### 往期重分类：`--retag`（2026-11-05 加）

分类体系改了以后，往期页面的 chip 还是旧的（微博/知乎/即刻…），
用户翻往期会看到两套体系。`--retag` 就是解决这个的：

```powershell
node tools/build.mjs --date 2026-11-04 --no-convert --retag
```

它做三件事：

1. **沿用**这一期已发布 manifest 的**全部条目**（含图片）—— 内容一个字都不改
2. 只按 `news-taxonomy.json` **重算见报的分类标签**
3. 闸门：图片跟已发布版本不一致就**拒绝执行**（说明这期源图被动过，该走正常发版流程）

逐期跑用 `node tools/retag-all.mjs`（它把「跑 + 比对内容未变」绑在一起，跑完出报告）。

> ⚠️ **最新一期必须放最后** —— 根路径 `published/index.html` 永远指向最后构建的那一期。
> `retag-all.mjs` 里的日期数组已经按从早到晚排好。

**已知代价**：manifest 字节变了 → 内容哈希变 → **文件名变** → 12 个日期页都要重新部署。
边缘缓存最长 24 小时，部署后短期内老页面可能仍显示旧分类。
```

---

### Task 6: 全量回归与交付

**Files:**
- 无新文件（只跑验证）

- [ ] **Step 1: 全套单元测试**

Run:
```powershell
node tools/test-likes.mjs
node tools/test-board.mjs
node tools/test-functions.mjs
node tools/test-likes-ui.mjs
node tools/test-board-ui.mjs
node tools/test-contract.mjs
node tools/test-news-ui.mjs
node tools/test-keep-manifest.mjs
node tools/test-news-taxonomy.mjs
node tools/test-news-taxonomy-mutate.mjs
node tools/test-build-taxonomy.mjs
node tools/test-retag.mjs
```
Expected: 全部 exit 0

- [ ] **Step 2: 线上真浏览器回归**

Run:
```powershell
node PARENT_DIR\.superpowers\sdd\2026-11-04-image-likes-comments\live-1105.mjs
node PARENT_DIR\.superpowers\sdd\2026-11-04-image-likes-comments\live-news-ui.mjs
node PARENT_DIR\.superpowers\sdd\2026-11-04-image-likes-comments\smoke-online.mjs
```
Expected: 34/34、38/38、35/35

**注意**：`live-news-ui.mjs` 里有一条断言是「下层没有翻译过的大类名」——
它检查 `.chips-srcs` 的文本里不含大类名。新的分类名是「热议/科技数码/AI/效率工具/技术社区/深度阅读」，
而源名是「微博热搜/知乎热榜/驱动之家…」，两者不重叠，这条断言应该照样过。
**如果它红了**，先确认是产品问题还是脚本假设过时（项目踩过 7 次这种坑）。

- [ ] **Step 3: 检查没有残留临时文件**

Run: `Get-ChildItem 'PROJECT_ROOT' -Filter 'tmp-*' -Recurse -File -ErrorAction SilentlyContinue | Select-Object FullName`
Expected: 空（没有输出）

- [ ] **Step 4: 确认根路径指向最新一期**

Run:
```powershell
node -e "fetch('https://example.com/?_='+Date.now()).then(r=>r.text()).then(h=>console.log((h.match(/brand-date\">([^<]+)/)||[])[1]))"
```
Expected: `2026-11-05`

- [ ] **Step 5: 交付说明**

给用户的交付说明里必须包含：

- 新的分类集合和各自的含义、源归属
- chip 顺序固定这个行为
- 多归属行为（各分类条数之和会 > 总条数，这不是 bug）
- 往期 12 期已统一重分类，条目内容逐条未改（引用 `retag-all.mjs` 的比对报告）
- 边缘缓存最长 24 小时，期间可能看到旧分类
- 关键词表的维护约定：**只放明确词**，宽词（如 `App`、`系统`）会大量误判
- 新增源忘了配 taxonomy 会**直接让构建失败**（这是有意的）
- 线上验证数字（12 期 chip 行 + 三个回归脚本）
- **提醒**：投稿口令 `SUBMIT_TOKEN` 那件事仍未处理（用户尚未答复）

---

## 验收清单

- [ ] 线上根页 + 12 个往期日期页的 chip 行**均不含平台名**
- [ ] chip 顺序固定且跨期一致
- [ ] 点任一 chip，可见条目数与 manifest 对得上
- [ ] 多归属条目在两个分类下都能被找到
- [ ] 12 期条目的**内容逐条未改**（`retag-all.mjs` 报告为证）
- [ ] 漏配新源时构建**失败**（有变异测试 M1 为证）
- [ ] 全套单元测试 + 4 个变异测试 + 线上真浏览器全绿
- [ ] 临时文件清理干净
