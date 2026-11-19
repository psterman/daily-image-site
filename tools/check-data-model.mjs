#!/usr/bin/env node
/**
 * 数据模型静态护栏。
 *
 * 这个脚本不连数据库、不执行 DDL，只检查 db/schema.sql 和 seed-core.sql
 * 是否包含产品闭环必需的表、字段、索引与版权字段。
 *
 * 为什么要有它：
 *   数据模型一旦漏字段，后面 API、前端、AI 流水线都会围绕错结构生长。
 *   把关键约束写成护栏，任何改动把核心字段删掉都能立刻被发现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT } from './paths.mjs';

const SCHEMA = path.join(ROOT, 'db', 'schema.sql');
const SEED = path.join(ROOT, 'db', 'seed-core.sql');
const DOC = path.join(ROOT, 'docs', 'data-model.md');

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function hasTable(sql, name) {
  return new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${name}\\s*\\(`, 'i').test(sql);
}

function tableBlock(sql, name) {
  const m = sql.match(
    new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${name}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i')
  );
  return m ? m[1] : '';
}

function hasColumn(sql, table, column) {
  const block = tableBlock(sql, table);
  return new RegExp(`\\b${column}\\b`, 'i').test(block);
}

function hasColumns(sql, table, columns) {
  return columns.every((c) => hasColumn(sql, table, c));
}

console.log('数据模型静态护栏\n');

let schema = '';
let seed = '';
let doc = '';

t('db/schema.sql 存在', () => {
  schema = read(SCHEMA);
  if (!schema.trim()) throw new Error('文件为空');
});

t('db/seed-core.sql 存在', () => {
  seed = read(SEED);
  if (!seed.trim()) throw new Error('文件为空');
});

t('docs/data-model.md 存在', () => {
  doc = read(DOC);
  if (!doc.trim()) throw new Error('文件为空');
});

const tables = [
  'users',
  'platforms',
  'tag_packs',
  'platform_columns',
  'sources',
  'tag_pack_sources',
  'content_items',
  'content_bodies',
  'content_tags',
  'candidate_entries',
  'issues',
  'issue_items',
  'follows',
  'delivery_channels',
  'issue_deliveries',
  'ad_slots',
  'ad_creatives',
  'ad_placements',
  'ad_events',
  'reader_events',
  'ai_runs',
  'rights_complaints',
  'audit_logs',
];

for (const table of tables) {
  t(`核心表存在：${table}`, () => {
    if (!hasTable(schema, table)) throw new Error('缺少建表语句');
  });
}

t('users 有账号基础字段', () => {
  if (!hasColumns(schema, 'users', ['id', 'email', 'status', 'plan', 'created_at', 'updated_at'])) {
    throw new Error('字段不完整');
  }
});

t('platforms 以用户为核心资产', () => {
  if (!hasColumns(schema, 'platforms', ['owner_user_id', 'slug', 'visibility', 'ai_mode', 'review_policy'])) {
    throw new Error('缺少平台核心字段');
  }
});

t('sources 带版权与授权字段', () => {
  if (!hasColumns(schema, 'sources', [
    'rights_status', 'allow_snippet', 'allow_image', 'allow_fulltext',
    'allow_cache', 'takedown_contact',
  ])) {
    throw new Error('缺少版权字段');
  }
});

t('content_items 默认索引化而非全文化', () => {
  if (!hasColumns(schema, 'content_items', ['canonical_url', 'content_hash', 'rights_status', 'summary'])) {
    throw new Error('缺少索引字段');
  }
});

t('content_bodies 独立存放授权正文', () => {
  if (!hasColumns(schema, 'content_bodies', ['content_item_id', 'rights_basis', 'body_html', 'body_text'])) {
    throw new Error('正文表字段不完整');
  }
});

t('candidate_entries 表达每日候选池', () => {
  if (!hasColumns(schema, 'candidate_entries', ['platform_id', 'content_item_id', 'issue_date', 'score', 'status'])) {
    throw new Error('候选池字段不完整');
  }
});

t('issues 保留 digest 快照', () => {
  if (!hasColumns(schema, 'issues', ['platform_id', 'issue_date', 'digest_json', 'public_url'])) {
    throw new Error('issues 字段不完整');
  }
});

t('follows 支持平台 / 栏目 / 标签包关注', () => {
  if (!hasColumns(schema, 'follows', ['follower_user_id', 'target_type', 'target_id'])) {
    throw new Error('关注字段不完整');
  }
  if (!/platform.*column.*tag_pack/i.test(tableBlock(schema, 'follows'))) {
    throw new Error('target_type 缺少三类枚举');
  }
});

t('delivery_channels 默认提醒而非全文搬运', () => {
  if (!hasColumns(schema, 'delivery_channels', ['channel_type', 'send_mode', 'verified', 'enabled'])) {
    throw new Error('分发渠道字段不完整');
  }
  if (!/reminder/i.test(tableBlock(schema, 'delivery_channels'))) {
    throw new Error('缺少 reminder 模式');
  }
});

t('广告素材带授权声明', () => {
  if (!hasColumn(schema, 'ad_creatives', 'rights_attestation')) {
    throw new Error('广告素材缺少 rights_attestation');
  }
});

t('版权投诉表存在', () => {
  if (!hasColumns(schema, 'rights_complaints', ['target_type', 'target_id', 'reason', 'status'])) {
    throw new Error('投诉表字段不完整');
  }
});

t('关键索引存在', () => {
  const required = [
    'idx_platforms_owner',
    'idx_candidates_platform_date',
    'idx_issues_platform_date',
    'idx_follows_follower',
    'idx_reader_events_platform',
    'idx_ai_runs_platform_date',
  ];
  for (const idx of required) {
    if (!schema.includes(idx)) throw new Error(`缺少索引 ${idx}`);
  }
});

t('种子数据包含九个标签包', () => {
  const keys = ['news', 'hot', 'funny', 'portrait', 'sight', 'opensource', 'ai', 'design', 'finance', 'tech', 'movie'];
  for (const key of keys) {
    if (!seed.includes(`'${key}'`)) throw new Error(`缺少标签 ${key}`);
  }
});

t('文档包含 ERD 与实现顺序', () => {
  if (!doc.includes('erDiagram')) throw new Error('缺少 ERD');
  if (!doc.includes('第一阶段实现顺序')) throw new Error('缺少实现顺序');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && fail) {
  process.exit(1);
}
