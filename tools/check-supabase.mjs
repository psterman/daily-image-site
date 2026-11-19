/**
 * check-supabase.mjs —— Supabase 迁移与客户端的静态护栏
 *
 * 本机无法启动 Node 子进程，但校验逻辑本身是纯文本检查，
 * 可内联到浏览器自检页跑。这里同时提供 CLI 版供正常环境用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const EXPECTED_TABLES = [
  'users', 'platforms', 'tag_packs', 'platform_columns', 'sources',
  'tag_pack_sources', 'content_items', 'content_bodies', 'content_tags',
  'candidate_entries', 'issues', 'issue_items', 'follows',
  'delivery_channels', 'issue_deliveries', 'ad_slots', 'ad_creatives',
  'ad_placements', 'ad_events', 'reader_events', 'ai_runs',
  'rights_complaints', 'audit_logs',
];

export function checkMigration(sql) {
  const errs = [];
  const has = (re) => re.test(sql);

  if (!has(/auth\.users/)) errs.push('缺少 auth.users 集成');
  if (!has(/create trigger[\s\S]*on_auth_user_created[\s\S]*auth\.users/i)) {
    errs.push('缺少新用户自动建行业触发器');
  }
  if (!has(/security definer/i)) errs.push('缺少 security definer 辅助函数');

  for (const t of EXPECTED_TABLES) {
    const enableRe = new RegExp(`alter table ${t}\\s+enable row level security`, 'i');
    if (!enableRe.test(sql)) errs.push(`表 ${t} 未开启 RLS`);
  }

  // 关键隔离策略
  const needPolicies = [
    ['users_select_self', '本人读'],
    ['platforms_owner_all', '平台 owner 全权'],
    ['platforms_public_read', '公开平台读'],
    ['candidates_owner_all', '候选池隔离'],
    ['issues_public_read', '已发布公开读'],
    ['content_read', '共享内容池读'],
  ];
  for (const [name, desc] of needPolicies) {
    if (!sql.includes(name)) errs.push(`缺少策略 ${name} (${desc})`);
  }

  // 只用 auth.uid()，不硬编码用户
  if (!has(/auth\.uid\(\)/)) errs.push('未使用 auth.uid() 做归属判断');

  return { ok: errs.length === 0, errors: errs, checkedTables: EXPECTED_TABLES.length };
}

export function checkClient(src) {
  const errs = [];
  const needExports = ['createClient', 'signUp', 'signIn', 'upsert', 'select', 'Authorization', 'apikey'];
  for (const token of needExports) {
    if (!src.includes(token)) errs.push(`sb-client 缺少 ${token}`);
  }
  if (/from\s+['"]node:/.test(src)) errs.push('sb-client 不应依赖 node:* 模块');
  return { ok: errs.length === 0, errors: errs };
}

export function checkRepo(src) {
  const errs = [];
  for (const token of ['loadDb', 'saveDb', 'runRemotePipeline', 'tag_packs', 'issue_items']) {
    if (!src.includes(token)) errs.push(`sb-repo 缺少 ${token}`);
  }
  if (/from\s+['"]node:/.test(src)) errs.push('sb-repo 不应依赖 node:* 模块');
  // save 不得写共享池
  const saveBody = src.slice(src.indexOf('export async function saveDb'));
  if (/upsert\(['"]content_items['"]/.test(saveBody)) {
    errs.push('saveDb 不应写共享池 content_items');
  }
  return { ok: errs.length === 0, errors: errs };
}

/** 主源映射层护栏：把版权纪律锁死在代码里，防止后续改动破坏红线。 */
export function checkIngest(src) {
  const errs = [];
  const need = ['toContentItem', 'mapFeedItems', 'CATEGORY_TO_TAGS', 'MAX_SUMMARY', 'contentHash'];
  for (const token of need) {
    if (!src.includes(token)) errs.push(`ingest-map 缺少 ${token}`);
  }
  if (/from\s+['"]node:/.test(src)) errs.push('ingest-map 不应依赖 node:* 模块（需浏览器可跑）');
  // 版权红线：配图只许远程热链索引（allowImage 门控），rights 默认 unknown、摘要截断
  if (!/allowImage/.test(src) || !/imageUrl/.test(src)) {
    errs.push('ingest-map 配图必须经 allowImage 门控（只存远程 URL，不转存）');
  }
  if (/download|writeFile|createWriteStream/.test(src)) {
    errs.push('ingest-map 禁止下载/落盘图片');
  }
  if (!/rights_status:\s*String\(opts\.rightsStatus\s*\|\|\s*'unknown'\)/.test(src)) {
    errs.push("ingest-map 的 rights_status 默认值必须是 'unknown'");
  }
  if (!/slice\(0,\s*MAX_SUMMARY\)/.test(src)) errs.push('ingest-map 必须截断摘要到 MAX_SUMMARY');
  // 时政/热榜不进平台
  if (!/hot:\s*\[\]/.test(src) || !/current:\s*\[\]/.test(src)) {
    errs.push('ingest-map 的 hot/current 分类必须映射为空（不进平台）');
  }
  return { ok: errs.length === 0, errors: errs };
}

export function runAll() {
  const mig = fs.readFileSync(path.join(ROOT, 'supabase', 'migration.sql'), 'utf8');
  const cli = fs.readFileSync(path.join(ROOT, 'lib', 'sb-client.mjs'), 'utf8');
  const repo = fs.readFileSync(path.join(ROOT, 'lib', 'sb-repo.mjs'), 'utf8');
  const schema = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
  const ingest = fs.readFileSync(path.join(ROOT, 'lib', 'ingest-map.mjs'), 'utf8');

  // schema 必须 23 表齐全
  const schemaErrs = EXPECTED_TABLES.filter(
    (t) => !new RegExp(`create table if not exists ${t}\\s*\\(`, 'i').test(schema)
  );

  const results = {
    schema: { ok: schemaErrs.length === 0, errors: schemaErrs.map((t) => `缺表 ${t}`), checkedTables: EXPECTED_TABLES.length },
    migration: checkMigration(mig),
    client: checkClient(cli),
    repo: checkRepo(repo),
    ingest: checkIngest(ingest),
  };
  results.ok = Object.values(results).every((r) => r && r.ok !== false);
  return results;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const r = runAll();
  for (const [k, v] of Object.entries(r)) {
    if (k === 'ok') continue;
    const line = v.ok ? 'OK  ' : 'FAIL';
    const err = v.errors && v.errors.length ? ' :: ' + v.errors.join('; ') : '';
    console.log(`${line} ${k}${err}`);
  }
  process.exit(r.ok ? 0 : 1);
}
