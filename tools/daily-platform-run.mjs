#!/usr/bin/env node
/**
 * daily-platform-run.mjs —— 日更编排（可挂 cron / 任务计划）
 *
 * 步骤：
 *   1) （可选）ingest-platform 灌共享池
 *   2) service_role load 全库
 *   3) 对每个平台：buildCandidates →（按 review_policy）auto review
 *   4) saveDb 写回私有表
 *
 * 不自动 publishIssue（人审红线：默认 human_confirm 只灌候选，不发日报）。
 *
 * 用法：
 *   node tools/daily-platform-run.mjs
 *   node tools/daily-platform-run.mjs --date 2026-11-18
 *   node tools/daily-platform-run.mjs --skip-ingest
 *   node tools/daily-platform-run.mjs --auto-per-column 3
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createClient } from '../lib/sb-client.mjs';
import { loadDb, saveDb } from '../lib/sb-repo.mjs';
import {
  buildCandidates,
  reviewCandidates,
} from '../lib/platform-flow.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  const raw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  return Object.fromEntries(
    raw.split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v == null || v.startsWith('-') ? fallback : v;
}

function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function runNode(script, args = []) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) throw new Error(`${script} 失败 exit=${r.status}`);
}

function runIngest() {
  // 扩源后 ~900 源；配额过小会把 BestBlogs/timqian 新源挤成「版块空」
  // per-tag 软顶抬高：流水源按 pipeline-sources.json 的 dailyCap 收满日窗
  runNode('ingest-platform.mjs', ['--per-tag', '400', '--max-items', '3200']);
  // 轻松一刻/人像：站内见笑·见她图；电影音乐：听乐看片榜
  runNode('ingest-visual-packs.mjs', ['--per-tag', '12']);
}

async function main() {
  const skipIngest = process.argv.includes('--skip-ingest');
  const date = arg('--date', todayShanghai());
  const perColumn = Math.max(1, Number(arg('--auto-per-column', '3')) || 3);

  if (!skipIngest) {
    console.log('== 1/2 灌共享池 ==');
    runIngest();
  } else {
    console.log('== 跳过灌池 --skip-ingest ==');
  }

  const env = loadEnv();
  const admin = createClient({
    url: env.SUPABASE_URL,
    key: env.SUPABASE_SERVICE_ROLE_KEY,
    schema: 'platform',
  });

  console.log(`== 2/2 各平台候选 ${date} ==`);
  const db = await loadDb(admin);
  const platforms = Object.values(db.platforms).filter((p) => p.status !== 'archived');
  console.log(`平台数 ${platforms.length}；共享内容 ${Object.keys(db.content_items).length}`);

  let built = 0;
  let reviewed = 0;
  for (const platform of platforms) {
    const created = buildCandidates(db, { platformId: platform.id, date });
    built += created.length;
    if (platform.review_policy === 'auto_trusted') {
      const r = reviewCandidates(db, {
        platformId: platform.id,
        date,
        auto: true,
        autoPerColumn: perColumn,
      });
      reviewed += (r && r.approved) || 0;
    }
  }

  const report = await saveDb(admin, db);
  console.log('候选新建', built, '自动放行', reviewed);
  console.log('saveDb', report);
  console.log('ALLPASS daily-platform-run');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
