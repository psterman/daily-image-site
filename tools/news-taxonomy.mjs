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

  const ktTags = new Set();
  for (const kt of Array.isArray(t.keywordTags) ? t.keywordTags : []) {
    if (!kt || typeof kt !== 'object' || !kt.tag) { errs.push('有 keywordTag 缺 tag'); continue; }
    if (!keys.has(kt.tag)) errs.push(`keywordTags 指向不存在的 category：${kt.tag}`);
    // 同一个 tag 配多条关键词规则会让条目挂上重复分类、chip 计数虚高 ——
    // 这是用户看得见的错数字，必须在配置层就响亮失败。
    if (ktTags.has(kt.tag)) errs.push(`keywordTags 的 tag 重复：${kt.tag}`);
    ktTags.add(kt.tag);
    if (!Array.isArray(kt.words) || !kt.words.length) errs.push(`keywordTags[${kt.tag}] 的 words 为空`);
  }

  // maxExtraTags 写错（2.5 / -1）会被 classifyItem 静默回落成默认值 ——
  // 宁可配置报错，也不要悄悄按另一套上限算。
  // 0 是合法的：表示「只挂主分类，不追加」。
  if (t.maxExtraTags !== undefined) {
    if (!Number.isInteger(t.maxExtraTags)) errs.push(`maxExtraTags 必须是整数：${t.maxExtraTags}`);
    else if (t.maxExtraTags < 0) errs.push(`maxExtraTags 不能是负数：${t.maxExtraTags}`);
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
    if (!matchWords(text, kt.words || []).length) continue;
    // 去重兜底：重名 tag 已被 validateTaxonomy 拒掉，但 classifyItem 也会被
    // 直接喂临时 taxonomy（测试、脚本），不能在这里产出重复标签。
    if (!extraKeys.includes(kt.tag)) extraKeys.push(kt.tag);
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
