#!/usr/bin/env node
/**
 * 从 published/<日期>/ 生成「与渠道无关」的每日推送稿 digest.json。
 *
 * 为什么要有这一层：
 *   同一期内容要发给邮件、Telegram、agent……每个渠道的排版都不一样。
 *   如果每个渠道各自去读 manifest 再拼文案，六分类的取名、数量口径、
 *   绝对 URL 的拼法就会各自漂移 —— 改一处漏一处。
 *   所以先收敛成一份 digest（唯一真源），各渠道只做「渲染」，不做「取数」。
 *
 * 数据源的真源：
 *   published/<日期>/index.html 里 <script src="manifest.xxx.js"> 指向的那份 manifest。
 *   目录里可能残留旧 manifest（--retag 场景），按 readdir 挑第一个会挑错 ——
 *   这里跟 build.mjs 的 findLiveManifestName 用同一套认法。
 *
 * 图片 URL 必须是绝对地址：
 *   manifest 里的 thumb/full 是 /img/<日期>/... 相对路径，只有挂在本站域名下才成立。
 *   邮件客户端、Telegram、agent 都没有「站点根」这个概念 —— 相对路径在它们那里
 *   就是坏链。所以推送稿里一律拼成 SITE_URL + 路径（跟 og:image 必须绝对同理）。
 *
 * 内容形态沿用 tab-kinds.mjs 的判定：
 *   媒体型（无 type）= 图片 tab，取前 N 张做代表图 + 缩略图
 *   文本型（有 type）= 见报/榜单，取前 N 条标题 + 链接
 *   绝不把文本型 tab 当图片处理（那会去 R2 母本找不存在的图，直接失败）。
 *
 * 用法：
 *   node tools/build-digest.mjs --date 2026-11-17
 *   node tools/build-digest.mjs --date 2026-11-17 --out .exp/digest
 *   node tools/build-digest.mjs --date 2026-11-17 --per-tab 6
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT } from './paths.mjs';
import { isMediaTab } from './tab-kinds.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 六分类的可订阅顺序（跟页面 tab 顺序一致）；digest 只暴露这些 key。 */
export const SUBSCRIBABLE_TABS = ['jianwen', 'jianshe', 'jianxiao', 'news', 'music', 'movie'];

/** 分类 key -> 中文名，跟 build-feed.mjs 的 FEED_CN_NAMES 保持一致。 */
export const TAB_CN_NAMES = {
  jianwen: '见闻',
  jianshe: '见她',
  jianxiao: '见笑',
  news: '见报',
  music: '听乐',
  movie: '看片',
};

function parseArgs(argv) {
  const out = { perTab: 6 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    // 空格写法与 --date= 都要认（publish.ps1 传的是空格写法）
    if (a === '--date') out.date = argv[++i];
    else if (a.startsWith('--date=')) out.date = a.slice(7);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--site-url') out.siteUrl = argv[++i];
    else if (a === '--per-tab') out.perTab = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/** 认准 index.html 实际引用的那份 manifest（残留旧 manifest 时不会挑错）。 */
export async function findLiveManifestPath(dayDir) {
  let names = [];
  try {
    names = (await fs.readdir(dayDir)).filter((n) => /^manifest\..*\.js$/.test(n)).sort();
  } catch {
    return null;
  }
  if (!names.length) return null;
  try {
    const html = await fs.readFile(path.join(dayDir, 'index.html'), 'utf8');
    const m = html.match(/manifest\.[A-Za-z0-9]+\.js/);
    if (m && names.includes(m[0])) return path.join(dayDir, m[0]);
  } catch {
    /* 没有 index.html，退回第一个 */
  }
  return path.join(dayDir, names[0]);
}

/** 读 manifest 文件：形如 window.__DAILY_MANIFEST__={...}; */
export async function readManifest(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const i = raw.indexOf('=');
    if (i < 0) return null;
    return JSON.parse(raw.slice(i + 1).replace(/;\s*$/, '').trim());
  } catch {
    return null;
  }
}

/** 去结尾斜杠，避免拼出 https://a.com//img/... */
function base(s) {
  return String(s || '').replace(/\/+$/, '');
}

/**
 * 把一个 tab 收敛成可推送的摘要。
 * 图片 tab 与文本 tab 走不同分支 —— 判定统一用 tab-kinds.mjs，不在这里重写条件。
 */
function summarizeTab(tab, site, perTab) {
  const key = String(tab.key || '');
  const label = TAB_CN_NAMES[key] || tab.label || key;
  const items = Array.isArray(tab.items) ? tab.items : [];
  const count = tab.count != null ? Number(tab.count) : items.length;
  const out = { key, label, count, type: tab.type || 'media', highlights: [] };

  if (isMediaTab(tab)) {
    for (const it of items.slice(0, perTab)) {
      if (!it.full) continue;
      out.highlights.push({
        thumb: it.thumb ? site + it.thumb : null,
        full: site + it.full,
      });
    }
  } else {
    // 文本型：title + url。url 可能缺失（见报里有的条目只有标题）——跳过，
    // 不把 null 链接塞进邮件（点了没反应的链接比没有链接更伤信任）。
    for (const it of items.slice(0, perTab)) {
      const title = String(it.title || '').trim();
      const url = String(it.url || it.link || '').trim();
      if (!title) continue;
      out.highlights.push({ title, url: /^https?:\/\//i.test(url) ? url : null });
    }
  }
  return out;
}

/**
 * 生成 digest 对象（纯函数，方便护栏测试喂夹具）。
 * @param {object} manifest
 * @param {object} opts  { siteUrl, perTab, date }
 */
export function buildDigest(manifest, opts = {}) {
  if (!manifest || typeof manifest !== 'object') throw new Error('buildDigest 需要 manifest 对象');
  const date = String(opts.date || manifest.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期不合法：${date}`);

  const site = base(opts.siteUrl || manifest.siteUrl || process.env.SITE_URL || '');
  if (!site) throw new Error('缺少站点地址：需要 --site-url 或 manifest.siteUrl 或 SITE_URL');

  const tabs = (Array.isArray(manifest.tabs) ? manifest.tabs : [])
    .filter((t) => SUBSCRIBABLE_TABS.includes(String(t.key)))
    .map((t) => summarizeTab(t, site, opts.perTab || 6));

  const counts = {};
  for (const t of tabs) counts[t.key] = t.count;
  const summary = tabs.map((t) => `${t.label} ${t.count}`).join(' · ');

  return {
    schema: 1,
    date,
    title: String(manifest.title || process.env.SITE_TITLE || '每日图片站'),
    generatedAt: new Date().toISOString(),
    siteUrl: site,
    issueUrl: `${site}/${date}/`,
    feedUrl: `${site}/feed.xml`,
    subscribeUrl: `${site}/subscribe/`,
    ogImage: `${site}/${date}/og.jpg`,
    defaultTab: manifest.defaultTab || 'jianxiao',
    summary,
    counts,
    tabs,
  };
}

/** 写 digest.json：先写临时文件再原子改名，避免半截文件被读到。 */
export async function writeDigest(digest, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const final = path.join(outDir, 'digest.json');
  const tmp = path.join(outDir, `.digest.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(digest, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, final);
  return final;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`生成每日推送稿 digest.json（邮件/Telegram/agent 共用）

用法：
  node tools/build-digest.mjs --date <YYYY-MM-DD> [--out <目录>] [--site-url <s>] [--per-tab <N>]

  --date      期号，默认 published/ 里最新的日期目录
  --out       输出目录，默认 published/<日期>/
  --site-url  站点根地址，默认读 manifest.siteUrl 或 SITE_URL
  --per-tab   每个分类带几条代表内容，默认 6
`);
    return;
  }

  let date = args.date;
  if (!date) {
    const dirs = (await fs.readdir(path.join(ROOT, 'published')))
      .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
      .sort();
    date = dirs[dirs.length - 1];
  }
  if (!date) throw new Error('找不到日期目录，请用 --date 指定');

  const dayDir = path.join(ROOT, 'published', date);
  const manifestPath = await findLiveManifestPath(dayDir);
  if (!manifestPath) throw new Error(`${dayDir} 里没有 manifest.*.js —— 先跑 build.mjs`);

  const manifest = await readManifest(manifestPath);
  if (!manifest) throw new Error(`读不出 ${manifestPath} 的内容（JSON 解析失败？）`);

  const digest = buildDigest(manifest, { date, siteUrl: args.siteUrl, perTab: args.perTab });
  const outDir = args.out ? path.resolve(process.cwd(), args.out) : dayDir;
  const file = await writeDigest(digest, outDir);

  console.log(`推送稿已生成：${file}`);
  console.log(`  期号   : ${digest.date}`);
  console.log(`  站点   : ${digest.siteUrl}`);
  console.log(`  概览   : ${digest.summary}`);
  console.log(`  分类数 : ${digest.tabs.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (e) {
    console.error(`✗ ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  }
}
