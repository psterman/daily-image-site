#!/usr/bin/env node
/**
 * 第一阶段闭环的可运行入口：从零跑通「注册 → 建平台 → 灌内容 → 候选池
 * → 审稿 → 发布 → 落盘 digest.json」，并把库持久化到 .data/platform/。
 *
 * 为什么要有这个 CLI：
 *   纯函数再好，用户也需要一个「按一下就能看到产物」的入口。这一步跑通，
 *   才算把 docs/data-model.md 里那张 ERD 变成了真能产出内容的管线。
 *
 * 两种审稿模式：
 *   --review auto    AI 自动放行（每栏目前 N 条），演示「用户不用动手」
 *   --review manual  只生成候选池，等审稿台决策（默认演示走 auto）
 *
 * 数据存在哪：
 *   默认 .data/platform/db.json（本地 JSON，后端中立）。接上 Supabase / 内置
 *   云服务后，只需替换 platform-store 的 loadDb/saveDb，本文件不用改。
 *
 * 用法：
 *   node tools/platform-cli.mjs --date 2026-11-18 --site-url https://demo.pages.dev
 *   node tools/platform-cli.mjs --date 2026-11-18 --review manual
 *   node tools/platform-cli.mjs --demo            # 用内置演示数据跑一遍
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDb, saveDb, DEFAULT_DB_PATH } from '../lib/platform-store.mjs';
import {
  registerUser,
  createPlatform,
  ingestContent,
  buildCandidates,
  reviewCandidates,
  publishIssue,
} from '../lib/platform-flow.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { review: 'auto', perColumn: 3, demo: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i];
    else if (a.startsWith('--date=')) out.date = a.slice(7);
    else if (a === '--site-url') out.siteUrl = argv[++i];
    else if (a.startsWith('--site-url=')) out.siteUrl = a.slice(11);
    else if (a === '--review') out.review = argv[++i];
    else if (a.startsWith('--review=')) out.review = a.slice(9);
    else if (a === '--per-column') out.perColumn = Number(argv[++i]);
    else if (a === '--email') out.email = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--tags') out.tags = argv[++i];
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--demo') out.demo = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/** 演示数据：三个标签包各几条，带一条重复链接用于验证去重。 */
const DEMO_ITEMS = [
  { title: '用零依赖 Node 写的静态站生成器', url: 'https://github.com/demo/staticgen', summary: '配置驱动，构建即出页面', tagKeys: ['opensource'] },
  { title: '一个把 RSS 变成每日简报的 Agent', url: 'https://github.com/demo/rss-agent', summary: '支持邮件与 Telegram 分发', tagKeys: ['opensource', 'ai'] },
  { title: '开源多用户聚合平台参考架构', url: 'https://github.com/demo/aggregate', summary: 'Supabase + 静态站', tagKeys: ['opensource'] },
  { title: '新模型发布：推理成本砍半', url: 'https://news.example.com/model-release', summary: '今日头条', tagKeys: ['ai'] },
  { title: 'Agent 实践：审稿台的人机协作', url: 'https://news.example.com/agent-review', summary: 'Human-in-the-loop', tagKeys: ['ai'] },
  { title: '海报配色灵感合集', url: 'https://design.example.com/palette', summary: '配色与字体', tagKeys: ['design'] },
  { title: '同一链接不应重复入库', url: 'https://github.com/demo/staticgen', summary: 'duplicate', tagKeys: ['opensource'] },
];

function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`第一阶段闭环：注册→建平台→灌内容→候选池→审稿→发布→digest

用法：
  node tools/platform-cli.mjs --date <YYYY-MM-DD> [--site-url <url>] [--review auto|manual]

  --review auto      AI 自动放行每栏目前 N 条（默认）
  --per-column       auto 模式每栏目放行条数（默认 3）
  --review manual    只生成候选池，不发布，等审稿台决策
  --email / --name / --tags   自定义用户邮箱 / 平台名 / 逗号分隔标签包
  --db               自定义 db.json 路径
  --demo             用内置演示数据（默认行为）

  --site-url 省略时取环境变量 SITE_URL，再省略则报错。
`);
    return;
  }

  const date = args.date || todayLocal();
  const siteUrl = args.siteUrl || process.env.SITE_URL || '';
  if (!siteUrl && args.review !== 'manual') {
    throw new Error('缺少站点地址：请传 --site-url 或设置 SITE_URL');
  }

  const dbFile = args.db ? path.resolve(process.cwd(), args.db) : DEFAULT_DB_PATH;
  const db = await loadDb(dbFile);

  const email = args.email || 'demo@example.com';
  const name = args.name || '我的头条';
  const tags = (args.tags || 'opensource,ai,design').split(',').map((s) => s.trim()).filter(Boolean);

  // 用户已存在时复用，方便一天多次演示不炸在「邮箱已存在」
  let user = Object.values(db.users).find((u) => u.email === email);
  if (!user) user = registerUser(db, { email, displayName: '演示用户' });

  let platform = Object.values(db.platforms).find((p) => p.owner_user_id === user.id && p.name === name);
  if (!platform) {
    const made = createPlatform(db, { userId: user.id, name, tagKeys: tags, siteUrl: siteUrl || null });
    platform = made.platform;
    console.log(`栏目生成：${made.columns.map((c) => `${c.name}(${c.key})`).join('、')}`);
  }

  const ingest = ingestContent(db, DEMO_ITEMS);
  console.log(`灌入内容：新增 ${ingest.created.length} 条，跳过 ${ingest.skipped} 条 ${JSON.stringify(ingest.reasons)}`);

  const candidates = buildCandidates(db, { platformId: platform.id, date });
  console.log(`候选池：${candidates.length} 条`);

  if (args.review === 'manual') {
    await saveDb(db, dbFile);
    console.log(`\n审稿模式：manual。候选已写入 ${dbFile}`);
    console.log('人工审稿后调用 publishIssue 即可。');
    return;
  }

  const review = reviewCandidates(db, {
    platformId: platform.id,
    date,
    auto: true,
    autoPerColumn: args.perColumn,
  });
  console.log(`AI 审稿：放行 ${review.approved} 条 / 每栏目上限 ${args.perColumn}`);

  const { issue, digest } = publishIssue(db, {
    platformId: platform.id, date, siteUrl,
  });

  // digest 落盘到平台目录，供邮件 / Telegram / agent 共用（跟老站 digest.json 同构）
  const outDir = path.join(ROOT, '.data', 'platform', 'published', platform.slug, date);
  await fs.promises.mkdir(outDir, { recursive: true });
  const digestFile = path.join(outDir, 'digest.json');
  await fs.promises.writeFile(digestFile, JSON.stringify(digest, null, 2) + '\n', 'utf8');
  await saveDb(db, dbFile);

  console.log(`\n✓ 一期已发布：${issue.public_url}`);
  console.log(`  库       ：${dbFile}`);
  console.log(`  推送稿   ：${digestFile}`);
  console.log(`  栏目概览 ：${digest.summary}`);
  console.log(`  总条数   ：${digest.total}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (e) {
    console.error(`✗ ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  }
}
