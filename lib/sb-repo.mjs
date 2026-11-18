/**
 * sb-repo.mjs —— Supabase 数据访问层（浏览器 / Workers / Node 通用，零 node:* 依赖）
 *
 * 职责：把 lib/platform-flow.mjs 操作的「内存 db」与 Supabase 表双向桥接。
 * 于是业务函数（注册/建平台/灌候选/审稿/发布）一行都不用改，只换存储。
 *
 * 严格的读写边界（与 supabase/migration.sql 的 RLS 一一对应）：
 *   - 共享池（只读，由管理端用 service_role 灌入）：
 *       tag_packs / sources / content_items / content_tags
 *   - 用户私有（登录用户可读写，RLS 按 owner 隔离）：
 *       users(本人) / platforms / platform_columns / candidate_entries /
 *       issues / issue_items / audit_logs
 *
 * 结构差异处理：
 *   - 内存 tag_packs 以 key 索引，SQL 以 uuid id 为主键 + key unique
 *     -> load 时按 key 重索引，行内保留 SQL 的真实 id（column.tag_pack_id 外键要用）
 *   - 内存 content_tags / issue_items 是数组，SQL 是关联表
 *     -> load 拼成数组，save 用复合主键 upsert
 */

import { emptyDb } from './platform-model.mjs';

/**
 * 只拉共享池（标签包 / 源 / 内容 / 标签关联）。匿名 key + RLS 可读。
 * 演示模式也可拿真实目录与样例，不必依赖硬编码 DEMO_ITEMS。
 */
export async function loadSharedPool(client) {
  const [tagPacks, sources, items, tags] = await Promise.all([
    client.select('tag_packs', { filters: [{ col: 'status', op: 'eq', value: 'active' }] }),
    client.select('sources', { filters: [{ col: 'status', op: 'eq', value: 'active' }] }),
    client.select('content_items', { order: 'created_at.desc', limit: 5000 }),
    client.select('content_tags'),
  ]);
  return {
    tagPacks: Array.isArray(tagPacks) ? tagPacks : [],
    sources: Array.isArray(sources) ? sources : [],
    items: Array.isArray(items) ? items : [],
    tags: Array.isArray(tags) ? tags : [],
  };
}

/** 把共享池合并进内存 db（覆盖同 key / 同 id）。 */
export function mergeSharedPool(db, pool) {
  if (!db || !pool) return db;
  for (const t of pool.tagPacks || []) {
    if (t && t.key) db.tag_packs[t.key] = t;
  }
  for (const s of pool.sources || []) {
    if (s && s.id) db.sources[s.id] = s;
  }
  for (const it of pool.items || []) {
    if (it && it.id) db.content_items[it.id] = it;
  }
  db.content_tags = (pool.tags || []).map((t) => ({
    content_item_id: t.content_item_id,
    tag_pack_id: t.tag_pack_id,
    confidence: t.confidence,
    created_at: t.created_at,
  }));
  db._sharedContentIds = new Set(
    (pool.items || []).map((it) => it.id).filter(Boolean)
  );
  return db;
}

/** 私有表写回顺序：先父后子，避免外键瞬时悬空。audit_logs 单独 insert（无 UPDATE 策略）。 */
const PRIVATE_TABLES = [
  'platforms',
  'platform_columns',
  'candidate_entries',
  'issues',
  'issue_items',
];

/**
 * 从 Supabase 拉取当前用户可见的数据，组装成 platform-flow 期望的内存 db。
 * 共享池是全量可读的（内容池），私有表由 RLS 自动过滤到当前用户。
 */
export async function loadDb(client) {
  const db = emptyDb();
  db.schema = 2; // Supabase 后端

  const [
    users, platforms, tagPacks, columns, sources,
    items, tags, candidates, issues, issueItems, audits,
  ] = await Promise.all([
    client.select('users'),
    client.select('platforms'),
    client.select('tag_packs', { filters: [{ col: 'status', op: 'eq', value: 'active' }] }),
    client.select('platform_columns'),
    client.select('sources', { filters: [{ col: 'status', op: 'eq', value: 'active' }] }),
    client.select('content_items', { order: 'created_at.desc', limit: 5000 }),
    client.select('content_tags'),
    client.select('candidate_entries', { order: 'created_at.desc', limit: 5000 }),
    client.select('issues', { order: 'created_at.desc', limit: 2000 }),
    client.select('issue_items'),
    client.select('audit_logs', { order: 'created_at.desc', limit: 2000 }),
  ]);

  for (const u of users) db.users[u.id] = u;
  for (const p of platforms) db.platforms[p.id] = p;
  // tag_packs 按 key 重索引，但保留行里的 uuid id
  for (const t of tagPacks) db.tag_packs[t.key] = t;
  for (const c of columns) db.platform_columns[c.id] = c;
  for (const s of sources) db.sources[s.id] = s;
  for (const it of items) db.content_items[it.id] = it;
  // 共享池 id 快照：前端无权写 content_items，候选/issue_items 只能引用池内已有行
  db._sharedContentIds = new Set(items.map((it) => it.id));
  db.content_tags = tags.map((t) => ({
    content_item_id: t.content_item_id,
    tag_pack_id: t.tag_pack_id,
    confidence: t.confidence,
    created_at: t.created_at,
  }));
  for (const e of candidates) db.candidate_entries[e.id] = e;
  for (const i of issues) db.issues[i.id] = i;
  db.issue_items = issueItems.map((x) => ({ ...x }));
  db.audit_logs = audits.map((a) => ({ ...a }));
  // 审计不可改删：只有 INSERT 策略。记住已落库 id，避免 upsert 走 UPDATE 被 RLS 挡。
  db._persistedAuditIds = new Set(audits.map((a) => a.id));

  return db;
}

/**
 * 把内存 db 的用户私有表写回 Supabase。共享池不写（那是管理端的职责）。
 * 用 upsert + 复合/主键冲突键保证幂等，重复跑不翻倍。
 */
export async function saveDb(client, db) {
  const report = {};

  // 先删后写：避免 upsert(id) 碰上云端残留的同 (platform_id,key) 另一行 → 409
  const pending = db._pendingDeletes || {};
  const delCols = [...new Set(pending.platform_columns || [])].filter(Boolean);
  const delCandPlatforms = [...new Set([
    ...(pending.candidate_platform_ids || []),
    ...(pending.replace_columns_platform_ids || []),
  ])].filter(Boolean);
  const replaceColPlatforms = [...new Set(pending.replace_columns_platform_ids || [])].filter(Boolean);

  for (const pid of delCandPlatforms) {
    await client.delete('candidate_entries', {
      filters: [{ col: 'platform_id', op: 'eq', value: pid }],
    });
  }
  if (delCandPlatforms.length) report.cleared_candidate_platforms = delCandPlatforms.length;

  // 整平台替换栏目（覆盖「同步失败留下的幽灵行」）
  for (const pid of replaceColPlatforms) {
    await client.delete('platform_columns', {
      filters: [{ col: 'platform_id', op: 'eq', value: pid }],
    });
  }
  if (replaceColPlatforms.length) report.replaced_column_platforms = replaceColPlatforms.length;

  if (delCols.length) {
    await client.delete('platform_columns', {
      filters: [{ col: 'id', op: 'in', value: delCols }],
    });
    report.deleted_columns = delCols.length;
  }
  db._pendingDeletes = {
    platform_columns: [],
    candidate_platform_ids: [],
    replace_columns_platform_ids: [],
  };

  if (Object.keys(db.users).length) {
    await client.upsert('users', Object.values(db.users), 'id');
    report.users = Object.keys(db.users).length;
  }

  // audit_logs RLS：仅 INSERT（actor_user_id = auth.uid()），无 UPDATE。
  // upsert(id) 遇已有行会走 ON CONFLICT UPDATE → USING 403。
  // 所以审计只 insert；并发/重试撞到已有 id 当成功（409）。
  if (!db._persistedAuditIds) db._persistedAuditIds = new Set();
  const auditRows = (Array.isArray(db.audit_logs) ? db.audit_logs : [])
    .filter((a) => a && a.actor_user_id && !db._persistedAuditIds.has(a.id))
    .map((a) => ({
      id: a.id,
      actor_user_id: a.actor_user_id,
      platform_id: a.platform_id || null,
      action: a.action,
      target_type: a.target_type || null,
      target_id: a.target_id || null,
      metadata: a.metadata && typeof a.metadata === 'object' ? a.metadata : {},
      created_at: a.created_at || new Date().toISOString(),
    }));
  // 先占坑，避免并发 saveDb 把同一批审计再打一遍
  for (const a of auditRows) db._persistedAuditIds.add(a.id);

  const shared = db._sharedContentIds;
  const inShared = (id) => !shared || shared.has(id);
  const byTable = {
    platforms: Object.values(db.platforms),
    platform_columns: Object.values(db.platform_columns),
    candidate_entries: Object.values(db.candidate_entries)
      .filter((e) => e && inShared(e.content_item_id)),
    issues: Object.values(db.issues),
    issue_items: (Array.isArray(db.issue_items) ? db.issue_items : [])
      .filter((x) => x && inShared(x.content_item_id)),
  };
  const conflictKey = {
    platforms: 'id',
    platform_columns: 'id',
    candidate_entries: 'id',
    issues: 'id',
    issue_items: 'issue_id,content_item_id',
  };

  for (const t of PRIVATE_TABLES) {
    const rows = byTable[t];
    if (!rows || !rows.length) continue;
    // 分批，避免单请求体过大
    for (let i = 0; i < rows.length; i += 200) {
      await client.upsert(t, rows.slice(i, i + 200), conflictKey[t]);
    }
    report[t] = rows.length;
  }

  if (auditRows.length) {
    try {
      for (let i = 0; i < auditRows.length; i += 200) {
        await client.insert('audit_logs', auditRows.slice(i, i + 200), { returnMinimal: true });
      }
      report.audit_logs = auditRows.length;
    } catch (e) {
      const msg = String((e && e.message) || e);
      // 另一路并发已写入同一 id：当作成功
      if (!/409|duplicate key|unique constraint/i.test(msg)) throw e;
      report.audit_logs_dup = auditRows.length;
    }
  }

  return report;
}

/**
 * 完整远程闭环：load → 业务函数 → save → 返回 digest。
 * 仅用纯函数 + repo，浏览器可直接调用；注入 mock client 即可离线验证。
 *
 * @param {object} client createClient() 的产物（已带登录 token）
 * @param {object} cfg { flow, email, name, tagKeys, siteUrl, date, items, review, perColumn }
 *   flow 为 lib/platform-flow.mjs 的命名空间（避免本模块硬依赖具体导出）
 */
export async function runRemotePipeline(client, cfg) {
  const {
    flow, email, name = '我的头条', tagKeys, siteUrl, date,
    items = [], review = 'auto', perColumn = 3, authUid = null,
  } = cfg;
  if (!flow) throw new Error('runRemotePipeline 需要 flow（platform-flow 命名空间）');
  if (!tagKeys || !tagKeys.length) throw new Error('至少选择一个标签包');
  if (!siteUrl) throw new Error('缺少 siteUrl');

  const db = await loadDb(client);

  // 登录用户已经在 public.users（Auth 触发器同步）；找不到再用纯函数补一行。
  let user = Object.values(db.users).find((u) => u.email === email)
    || (authUid ? db.users[authUid] : null);
  if (!user) {
    user = flow.registerUser(db, {
      id: authUid || undefined,
      email,
      displayName: name,
    });
  }

  let platform = Object.values(db.platforms).find(
    (p) => p.owner_user_id === user.id && p.name === name
  );
  let columns;
  if (platform) {
    columns = Object.values(db.platform_columns)
      .filter((c) => c.platform_id === platform.id)
      .sort((a, b) => a.position - b.position);
  } else {
    const made = flow.createPlatform(db, {
      userId: user.id, name, tagKeys, siteUrl,
      reviewPolicy: review === 'auto' ? 'auto_trusted' : 'human_confirm',
    });
    platform = made.platform;
    columns = made.columns;
  }

  // 内容灌入在真后端里通常由管理端完成；这里若传了 items 则走纯函数（用 service_role 时有效）
  if (items.length) flow.ingestContent(db, items);
  flow.buildCandidates(db, { platformId: platform.id, date });

  if (review === 'auto') {
    flow.reviewCandidates(db, {
      platformId: platform.id, date, auto: true, autoPerColumn: perColumn,
    });
  }

  const { issue, digest } = flow.publishIssue(db, {
    platformId: platform.id, date, siteUrl,
  });

  const saved = await saveDb(client, db);
  return { user, platform, columns, issue, digest, saved };
}

export default { loadDb, saveDb, runRemotePipeline };
