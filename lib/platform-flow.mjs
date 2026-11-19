/**
 * 用户自建平台：第一阶段最小闭环（纯函数流水线）。
 *
 * 闭环六步，一步一步都对应 db/schema.sql 的真表：
 *   1. registerUser        -> users
 *   2. createPlatform      -> platforms + platform_columns（由选中的标签包生成栏目）
 *   3. ingestContent       -> sources + content_items + content_tags（版权过滤在这里）
 *   4. buildCandidates     -> candidate_entries（打分 + 去重 + 分栏）
 *   5. reviewCandidates    -> candidate_entries.status（人工 / AI 自动审稿）
 *   6. publishIssue        -> issues + issue_items + digest.json
 *
 * 为什么要做成纯函数 + 可注入 db：
 *   本机跑不了 Node 子进程，且真实后端（Supabase / 内置云服务）还没接。
 *   把每一步写成 (db, input) -> output 的纯函数，护栏测试可以用一个内存 db
 *   把整条链跑通；等后端接上时，只需替换 platform-store 的 loadDb/saveDb，
 *   这六个函数一行都不用改。
 *
 * 版权纪律（这是产品的红线，不是可选项）：
 *   - blocked 源整条丢弃，连标题都不进库；
 *   - allow_snippet=false 的源不存摘要；
 *   - allow_image=false 的源不存图片 URL；
 *   - 永远不存正文（content_bodies 第一阶段不启用）；
 *   - 分发一律 link_card：标题 + 短导读 + 原文链接。
 */
// 只依赖纯数据原语，不 import 任何 node:* —— 整条流水线因此能在浏览器里跑。
// 落盘由 platform-store.mjs 单独负责，业务函数与存储解耦。
import {
  newId,
  now,
  audit,
  ensureMainSource,
  seedTagPacks,
  contentHash as hashContent,
} from './platform-model.mjs';
import {
  normalizeSourceSelection,
  itemMatchesSources,
  defaultSourceNames,
} from './tag-options.mjs';
import { cleanSummary } from './ingest-map.mjs';

// 从 model 重导出，保持既有 import 路径（测试从 flow 引 contentHash）不变。
export { contentHash } from './platform-model.mjs';

/** 与 schema 的 status 枚举对齐，避免在业务代码里散落字符串。 */
export const CANDIDATE_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PINNED: 'pinned',
  TRASHED: 'trashed',
});

export const REVIEW_ACTIONS = Object.freeze({
  APPROVE: 'approve',
  REJECT: 'reject',
  PIN: 'pin',
});

function str(v, fallback = '') {
  return v == null ? fallback : String(v);
}

function dateOk(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
}

/** 简单 slug：小写、非字母数字转连字符、去首尾连字符。 */
export function slugify(s) {
  return str(s)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'platform';
}

// ---------------------------------------------------------------------------
// 1. 注册用户
// ---------------------------------------------------------------------------

/**
 * @param {object} db
 * @param {{email?:string, phone?:string, displayName?:string}} input
 * @returns {object} user
 */
export function registerUser(db, input = {}) {
  const email = str(input.email).trim().toLowerCase();
  const phone = str(input.phone).trim();
  if (!email && !phone) throw new Error('注册需要 email 或 phone 至少一项');
  if (email && Object.values(db.users).some((u) => u.email === email)) {
    throw new Error(`邮箱已存在：${email}`);
  }
  if (phone && Object.values(db.users).some((u) => u.phone === phone)) {
    throw new Error(`手机号已存在：${phone}`);
  }
  // 真后端：Supabase Auth 的 uid 就是业务 user id，允许显式传入（向后兼容：不传则新建）
  // 这样 auth.uid() 能直接命中 public.users.id，RLS 才成立。
  const user = {
    id: str(input.id) || newId(),
    email: email || null,
    phone: phone || null,
    display_name: str(input.displayName, '用户'),
    avatar_url: null,
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    status: 'active',
    plan: 'free',
    created_at: now(),
    updated_at: now(),
  };
  db.users[user.id] = user;
  audit(db, 'user.register', {
    actor_user_id: user.id,
    target_type: 'user',
    target_id: user.id,
  });
  return user;
}

// ---------------------------------------------------------------------------
// 2. 建平台 + 由标签包生成栏目
// ---------------------------------------------------------------------------

/**
 * 由标签包生成栏目行。createPlatform 与 setPlatformTagPacks 共用，避免两处漂移。
 * sourceSelections: { [tagKey]: string[] } 用户勾选的子来源（rebang 节点订阅）。
 * prevByKey: 旧栏目按 key 复用 id，避免云端 (platform_id,key) 唯一约束 409。
 */
function makeColumns(db, platform, packs, sourceSelections = {}, prevByKey = {}) {
  return packs.map((p, i) => {
    const sources = normalizeSourceSelection(p.key, sourceSelections && sourceSelections[p.key]);
    const prev = prevByKey[p.key];
    const col = {
      id: (prev && prev.id) || newId(),
      platform_id: platform.id,
      tag_pack_id: p.id,
      key: p.key,
      name: p.name,
      position: i,
      max_items: (prev && prev.max_items) || 40,
      enabled: prev && typeof prev.enabled === 'boolean' ? prev.enabled : true,
      source_mode: 'tag_pack',
      settings: {
        risk_level: p.risk_level,
        sources,
        sources_catalog_n: defaultSourceNames(p.key).length,
      },
      created_at: (prev && prev.created_at) || now(),
      updated_at: now(),
    };
    db.platform_columns[col.id] = col;
    return col;
  });
}

/**
 * @param {object} db
 * @param {{userId:string, name:string, slug?:string, tagKeys:string[], siteUrl?:string,
 *          aiMode?:string, reviewPolicy?:string, sourceSelections?:Record<string,string[]>}} input
 * @returns {{platform:object, columns:object[]}}
 */
export function createPlatform(db, input = {}) {
  const user = db.users[str(input.userId)];
  if (!user) throw new Error(`用户不存在：${input.userId}`);

  const tagKeys = Array.isArray(input.tagKeys) ? [...new Set(input.tagKeys.map((k) => str(k)))] : [];
  if (!tagKeys.length) throw new Error('至少选择一个标签包才能生成栏目');

  seedTagPacks(db);
  const packs = tagKeys.map((k) => {
    const p = db.tag_packs[k];
    if (!p || p.status !== 'active') throw new Error(`标签包不存在或已停用：${k}`);
    return p;
  });

  const name = str(input.name).trim() || '我的头条';
  // 默认 slug 带上 owner 短 id：RLS 下看不到别人的平台，本地 taken 挡不住全局 platforms_slug_key
  let slug = input.slug
    ? slugify(input.slug)
    : `${slugify(name)}-${user.id.slice(0, 8)}`;
  const taken = new Set(Object.values(db.platforms).map((p) => p.slug));
  if (taken.has(slug)) slug = `${slug}-${newId().slice(0, 8)}`;

  const platform = {
    id: newId(),
    owner_user_id: user.id,
    slug,
    name,
    description: input.description || null,
    site_url: input.siteUrl || null,
    custom_domain: null,
    visibility: input.visibility || 'private',
    status: 'draft',
    default_timezone: 'Asia/Shanghai',
    publish_time: '07:30',
    ai_mode: input.aiMode || 'assisted',
    review_policy: input.reviewPolicy || 'human_confirm',
    theme: {},
    settings: {},
    created_at: now(),
    updated_at: now(),
  };
  db.platforms[platform.id] = platform;

  // 栏目 = 用户选的每个标签包一项；settings.sources = 勾选的子来源（可后续扩目录）
  const columns = makeColumns(db, platform, packs, input.sourceSelections || {});

  audit(db, 'platform.create', {
    actor_user_id: user.id,
    platform_id: platform.id,
    target_type: 'platform',
    target_id: platform.id,
    metadata: { tagKeys, slug, sourceSelections: input.sourceSelections || {} },
  });
  return { platform, columns };
}

/**
 * 改平台的标签包组合：删掉旧栏目，按新标签重建，清掉该平台所有期的旧候选
 * （栏目换了，旧候选的 column_id 已失效，留着会在审稿台里变成孤儿）。
 * @returns {{platform:object, columns:object[]}}
 */
export function setPlatformTagPacks(db, input = {}) {
  const platform = db.platforms[str(input.platformId)];
  if (!platform) throw new Error(`平台不存在：${input.platformId}`);
  const tagKeys = Array.isArray(input.tagKeys) ? [...new Set(input.tagKeys.map((k) => str(k)))] : [];
  if (!tagKeys.length) throw new Error('至少选择一个标签包');

  seedTagPacks(db);
  const packs = tagKeys.map((k) => {
    const p = db.tag_packs[k];
    if (!p || p.status !== 'active') throw new Error(`标签包不存在或已停用：${k}`);
    return p;
  });

  // 未传 sourceSelections 时尽量保留旧栏目已勾选的子来源；同 key 复用旧行 id
  const prevByKey = {};
  const prevSources = {};
  const prevIds = [];
  for (const col of Object.values(db.platform_columns)) {
    if (col.platform_id !== platform.id) continue;
    prevByKey[col.key] = col;
    prevIds.push(col.id);
    if (col.settings && Array.isArray(col.settings.sources)) prevSources[col.key] = col.settings.sources;
  }
  const sourceSelections = { ...prevSources, ...(input.sourceSelections || {}) };

  for (const id of prevIds) delete db.platform_columns[id];
  for (const id of Object.keys(db.candidate_entries)) {
    if (db.candidate_entries[id].platform_id === platform.id) delete db.candidate_entries[id];
  }
  const columns = makeColumns(db, platform, packs, sourceSelections, prevByKey);

  // 云端可能残留「上次同步失败」的旧栏目 id（同 platform_id+key 另一 uuid）→
  // 只按 id 删不够。记 platform 整表替换：saveDb 先按 platform_id 清空栏目+候选再 upsert。
  if (!db._pendingDeletes) {
    db._pendingDeletes = {
      platform_columns: [],
      candidate_platform_ids: [],
      replace_columns_platform_ids: [],
    };
  }
  db._pendingDeletes.replace_columns_platform_ids.push(platform.id);
  db._pendingDeletes.candidate_platform_ids.push(platform.id);

  platform.updated_at = now();
  audit(db, 'platform.tags_changed', {
    actor_user_id: platform.owner_user_id,
    platform_id: platform.id,
    target_type: 'platform',
    target_id: platform.id,
    metadata: { tagKeys, sourceSelections },
  });
  return { platform, columns };
}

/**
 * 栏目排序：把 keys 顺序写成 position。keys 必须覆盖当前全部栏目，
 * 否则拒绝（避免静默丢栏目）。
 */
export function reorderColumns(db, input = {}) {
  const platform = db.platforms[str(input.platformId)];
  if (!platform) throw new Error(`平台不存在：${input.platformId}`);
  const keys = Array.isArray(input.keys) ? input.keys.map((k) => str(k)) : [];
  const cols = Object.values(db.platform_columns).filter((c) => c.platform_id === platform.id);
  if (keys.length !== cols.length || new Set(keys).size !== cols.length) {
    throw new Error('排序 keys 必须与当前栏目一一对应');
  }
  const byKey = new Map(cols.map((c) => [c.key, c]));
  for (const k of keys) {
    if (!byKey.has(k)) throw new Error(`栏目不存在：${k}`);
  }
  keys.forEach((k, i) => {
    byKey.get(k).position = i;
    byKey.get(k).updated_at = now();
  });
  audit(db, 'platform.columns_reordered', {
    actor_user_id: platform.owner_user_id,
    platform_id: platform.id,
    target_type: 'platform',
    target_id: platform.id,
    metadata: { keys },
  });
  return cols.sort((a, b) => a.position - b.position);
}

// ---------------------------------------------------------------------------
// 3. 灌入内容（版权过滤发生在这里）
// ---------------------------------------------------------------------------

/**
 * @param {object} db
 * @param {Array<{title:string,url:string,summary?:string,imageUrl?:string,
 *                tagKeys?:string[],author?:string,publishedAt?:string}>} items
 * @param {{sourceId?:string}} [opts]
 * @returns {{created:object[], skipped:number, reasons:object}}
 */
export function ingestContent(db, items = [], opts = {}) {
  const source = db.sources[opts.sourceId] || ensureMainSource(db);
  const created = [];
  const reasons = { blocked: 0, noUrl: 0, noTitle: 0, duplicate: 0 };

  for (const raw of items) {
    const title = str(raw.title).trim();
    const url = str(raw.url).trim();
    if (!title) { reasons.noTitle++; continue; }
    if (!/^https?:\/\//i.test(url)) { reasons.noUrl++; continue; }

    // blocked 源整条丢弃：连标题都不进库
    if (source.rights_status === 'blocked') { reasons.blocked++; continue; }

    const hash = hashContent(url, title);
    if (Object.values(db.content_items).some(
      (c) => c.source_id === source.id && c.content_hash === hash
    )) {
      reasons.duplicate++;
      continue;
    }

    const item = {
      id: newId(),
      source_id: source.id,
      canonical_url: url,
      content_hash: hash,
      content_type: 'article',
      title,
      // 只有授权短摘要的源才存 summary；否则一律 null
      summary: source.allow_snippet
        ? (raw.summary
          ? str(raw.summary).slice(
            0,
            /(?:twitter\.com|\/\/x\.com\/|xgo\.ing)/i.test(str(raw.url || raw.canonical_url || ''))
              ? 280
              : 200,
          )
          : null)
        : null,
      author: raw.author ? str(raw.author) : null,
      // 不允许转存图片时直接丢掉 URL，避免后续渲染器误用
      image_url: source.allow_image && raw.imageUrl ? str(raw.imageUrl) : null,
      published_at: raw.publishedAt || now(),
      language: 'zh-CN',
      rights_status: source.rights_status,
      license: source.license || null,
      metadata: {},
      created_at: now(),
      updated_at: now(),
    };
    db.content_items[item.id] = item;

    // 打标签：只认真实存在的包
    for (const k of Array.isArray(raw.tagKeys) ? raw.tagKeys : []) {
      const pack = db.tag_packs[str(k)];
      if (!pack) continue;
      const key = `${item.id}:${pack.id}`;
      if (!db.content_tags.some((t) => `${t.content_item_id}:${t.tag_pack_id}` === key)) {
        db.content_tags.push({
          content_item_id: item.id,
          tag_pack_id: pack.id,
          confidence: 100,
          created_at: now(),
        });
      }
    }
    created.push(item);
  }

  audit(db, 'content.ingest', {
    target_type: 'source',
    target_id: source.id,
    metadata: { created: created.length, skipped: reasons },
  });
  return { created, skipped: Object.values(reasons).reduce((a, b) => a + b, 0), reasons };
}

// ---------------------------------------------------------------------------
// 4. 生成候选池（打分 + 去重 + 分栏）
// ---------------------------------------------------------------------------

/** 默认打分：可信度 + 有摘要 + 时效，全部可注入替换。 */
export function defaultScore(item, source) {
  let s = 60;
  s += Math.round(Number(source && source.trust_score ? source.trust_score : 0) / 10);
  if (item.summary) s += 10;
  const ageDays = (Date.now() - new Date(item.published_at).getTime()) / 86400000;
  if (ageDays <= 1) s += 10;
  else if (ageDays <= 7) s += 5;
  else if (ageDays > 30) s -= 15;
  return Math.max(0, Math.min(100, s));
}

/**
 * @param {object} db
 * @param {{platformId:string, date:string, scoreFn?:Function}} input
 * @returns {object[]} candidate_entries
 */
export function buildCandidates(db, input = {}) {
  const platform = db.platforms[str(input.platformId)];
  if (!platform) throw new Error(`平台不存在：${input.platformId}`);
  if (!dateOk(input.date)) throw new Error(`日期不合法：${input.date}`);

  const scoreFn = typeof input.scoreFn === 'function' ? input.scoreFn : defaultScore;
  const columns = Object.values(db.platform_columns)
    .filter((c) => c.platform_id === platform.id && c.enabled)
    .sort((a, b) => a.position - b.position);

  const created = [];
  for (const col of columns) {
    const taggedIds = new Set(
      db.content_tags.filter((t) => t.tag_pack_id === col.tag_pack_id)
        .map((t) => t.content_item_id)
    );
    // 仅当用户缩减了子来源时才按 publisher/域名过滤；全选=整包，不过滤（兼容旧池无 publisher）
    const wantSources = col.settings && Array.isArray(col.settings.sources) ? col.settings.sources : null;
    const allSrc = defaultSourceNames(col.key);
    const narrowed = !!(wantSources && wantSources.length && allSrc.length && wantSources.length < allSrc.length);
    const tagged = Object.values(db.content_items)
      .filter((c) => taggedIds.has(c.id) && c.rights_status !== 'blocked');
    let matched = narrowed
      ? tagged.filter((c) => itemMatchesSources(c, wantSources, col.key))
      : tagged;
    // 勾了尚未入库的芯片时匹配为空 → 回退整包，避免栏目空白（预览颗粒会同步按源过滤提示）
    let usedFallback = false;
    if (narrowed && !matched.length && tagged.length) {
      matched = tagged;
      usedFallback = true;
    }
    const pool = matched
      .map((c) => ({ item: c, score: scoreFn(c, db.sources[c.source_id]) }))
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
    const reasonSuffix = usedFallback ? '（所选来源暂无入库，已用整包）' : '';

    let placed = 0;
    const usedGroups = new Set();
    for (const { item, score } of pool) {
      if (placed >= col.max_items) break;

      // 同栏目内按 dedupe_group 再去一次重（同站同题只留最高分那条）
      const group = item.content_hash;
      if (usedGroups.has(group)) continue;

      const exists = Object.values(db.candidate_entries).some(
        (e) => e.platform_id === platform.id && e.issue_date === input.date && e.content_item_id === item.id
      );
      if (exists) continue;

      const entry = {
        id: newId(),
        platform_id: platform.id,
        column_id: col.id,
        content_item_id: item.id,
        issue_date: input.date,
        source_type: 'tag_pack',
        score: Math.round(score * 100) / 100,
        ai_reason: `按 ${col.name} 标签匹配与可信度打分${reasonSuffix}`,
        dedupe_group: group,
        status: CANDIDATE_STATUS.PENDING,
        rank: placed + 1,
        created_at: now(),
        updated_at: now(),
      };
      db.candidate_entries[entry.id] = entry;
      usedGroups.add(group);
      placed++;
      created.push(entry);
    }
  }

  audit(db, 'candidates.build', {
    actor_user_id: platform.owner_user_id,
    platform_id: platform.id,
    target_type: 'platform',
    target_id: platform.id,
    metadata: { date: input.date, count: created.length },
  });
  return created;
}

/**
 * 给「今日尚无已放行条目」的栏目，从 pending 里按分补放行。
 * 解决：首次 auto 审过后又建出新栏目候选，digest 一直空白。
 */
export function fillEmptyColumnApprovals(db, input = {}) {
  const platform = db.platforms[str(input.platformId)];
  if (!platform) throw new Error(`平台不存在：${input.platformId}`);
  if (!dateOk(input.date)) throw new Error(`日期不合法：${input.date}`);
  const per = Number.isFinite(input.autoPerColumn) ? Math.max(0, input.autoPerColumn) : 6;
  const columns = Object.values(db.platform_columns)
    .filter((c) => c.platform_id === platform.id && c.enabled);
  const all = Object.values(db.candidate_entries).filter(
    (e) => e.platform_id === platform.id && e.issue_date === input.date
  );
  let filled = 0;
  for (const col of columns) {
    const rows = all.filter((e) => e.column_id === col.id);
    const hasOk = rows.some(
      (e) => e.status === CANDIDATE_STATUS.APPROVED || e.status === CANDIDATE_STATUS.PINNED
    );
    if (hasOk) continue;
    const pending = rows
      .filter((e) => e.status === CANDIDATE_STATUS.PENDING)
      .sort((a, b) => b.score - a.score);
    for (const e of pending.slice(0, per)) {
      e.status = CANDIDATE_STATUS.APPROVED;
      e.updated_at = now();
      filled++;
    }
  }
  if (filled) {
    audit(db, 'candidates.fill_empty', {
      actor_user_id: platform.owner_user_id,
      platform_id: platform.id,
      target_type: 'platform',
      target_id: platform.id,
      metadata: { date: input.date, filled, per },
    });
  }
  return filled;
}

// ---------------------------------------------------------------------------
// 5. 审稿（人工决策 / AI 自动）
// ---------------------------------------------------------------------------

/**
 * @param {object} db
 * @param {{platformId:string, date:string, decisions?:Array<{candidateId:string,
 *          action:string, note?:string}>, auto?:boolean, autoPerColumn?:number}} input
 * @returns {{approved:number, rejected:number, pinned:number, skipped:number}}
 */
export function reviewCandidates(db, input = {}) {
  const platform = db.platforms[str(input.platformId)];
  if (!platform) throw new Error(`平台不存在：${input.platformId}`);
  if (!dateOk(input.date)) throw new Error(`日期不合法：${input.date}`);

  const all = Object.values(db.candidate_entries).filter(
    (e) => e.platform_id === platform.id && e.issue_date === input.date
  );
  const result = { approved: 0, rejected: 0, pinned: 0, skipped: 0 };

  if (input.auto) {
    // AI 自动模式：每个栏目只放行前 N 条，其余保持 pending（不误删）
    const per = Number.isFinite(input.autoPerColumn) ? Math.max(0, input.autoPerColumn) : 3;
    const byCol = new Map();
    for (const e of [...all].sort((a, b) => b.score - a.score)) {
      const list = byCol.get(e.column_id) || [];
      if (list.length >= per) continue;
      e.status = CANDIDATE_STATUS.APPROVED;
      e.updated_at = now();
      list.push(e);
      byCol.set(e.column_id, list);
      result.approved++;
    }
    audit(db, 'candidates.auto_review', {
      actor_user_id: platform.owner_user_id,
      platform_id: platform.id,
      target_type: 'platform',
      target_id: platform.id,
      metadata: { date: input.date, ...result, perColumn: per },
    });
    return result;
  }

  const decisions = Array.isArray(input.decisions) ? input.decisions : [];
  for (const d of decisions) {
    const e = db.candidate_entries[str(d.candidateId)];
    if (!e || e.platform_id !== platform.id || e.issue_date !== input.date) {
      result.skipped++;
      continue;
    }
    if (d.action === REVIEW_ACTIONS.APPROVE) {
      e.status = CANDIDATE_STATUS.APPROVED;
      result.approved++;
    } else if (d.action === REVIEW_ACTIONS.REJECT) {
      e.status = CANDIDATE_STATUS.REJECTED;
      result.rejected++;
    } else if (d.action === REVIEW_ACTIONS.PIN) {
      e.status = CANDIDATE_STATUS.PINNED;
      result.pinned++;
    } else {
      result.skipped++;
      continue;
    }
    if (d.note) e.ai_reason = str(d.note);
    e.updated_at = now();
  }

  audit(db, 'candidates.review', {
    actor_user_id: platform.owner_user_id,
    platform_id: platform.id,
    target_type: 'platform',
    target_id: platform.id,
    metadata: { date: input.date, ...result },
  });
  return result;
}

// ---------------------------------------------------------------------------
// 6. 发布（issue + issue_items + digest）
// ---------------------------------------------------------------------------

/** content_item → digest highlight；见笑/见她一期带 images[] 整墙。 */
function highlightFromContent(item, extra = {}) {
  const image = item.image_url || null;
  const meta = item.metadata || {};
  const pub = String(meta.publisher || '').trim();
  const sum = cleanSummary(item.summary || '', item.title) || null;
  const note = [pub, sum].filter(Boolean).join(' · ') || null;
  const images = Array.isArray(meta.images)
    ? meta.images.filter((im) => im && /^https?:\/\//i.test(String(im.full || im.thumb || '')))
    : null;
  return {
    title: item.title,
    url: item.canonical_url,
    note,
    image,
    thumb: image,
    full: image,
    contentType: item.content_type || 'article',
    source: pub || null,
    publishedAt: item.published_at || item.created_at || null,
    ...(images && images.length ? { images } : {}),
    ...(meta.issue_kind ? { issueKind: meta.issue_kind } : {}),
    ...(meta.issue_date ? { issueDate: meta.issue_date } : {}),
    ...extra,
  };
}

/**
 * 今日阅读：汇总用户已选栏目 × 已选源的共享池内容（近 maxAgeDays 天），
 * 不依赖审稿放行。「今日转发 / 发布」仍用 buildPlatformDigest（只含已选用）。
 *
 * @param {object} db
 * @param {{platformId:string, date:string, siteUrl?:string, maxPerColumn?:number, maxAgeDays?:number}} input
 */
export function buildReadingDigest(db, input = {}) {
  const platform = db.platforms[str(input.platformId)];
  if (!platform) throw new Error(`平台不存在：${input.platformId}`);
  if (!dateOk(input.date)) throw new Error(`日期不合法：${input.date}`);

  const site = str(input.siteUrl || platform.site_url || 'https://example.invalid').replace(/\/+$/, '');
  const maxPerColumn = Math.max(8, Number(input.maxPerColumn) || 60);
  const maxAgeDays = Math.max(1, Number(input.maxAgeDays) || 2);
  const cutoff = Date.now() - maxAgeDays * 86400000;

  const columns = Object.values(db.platform_columns)
    .filter((c) => c.platform_id === platform.id && c.enabled)
    .sort((a, b) => a.position - b.position);

  const tabs = columns.map((col) => {
    const taggedIds = new Set(
      db.content_tags.filter((t) => t.tag_pack_id === col.tag_pack_id)
        .map((t) => t.content_item_id),
    );
    const wantSources = col.settings && Array.isArray(col.settings.sources) ? col.settings.sources : null;
    const allSrc = defaultSourceNames(col.key);
    const narrowed = !!(wantSources && wantSources.length && allSrc.length && wantSources.length < allSrc.length);

    let matched = Object.values(db.content_items).filter(
      (c) => taggedIds.has(c.id) && c.rights_status !== 'blocked',
    );
    if (narrowed) {
      const filtered = matched.filter((c) => itemMatchesSources(c, wantSources, col.key));
      if (filtered.length) matched = filtered;
    }

    matched = matched.filter((c) => {
      const ts = Date.parse(String(c.published_at || c.created_at || ''));
      if (!Number.isFinite(ts)) return true; // 无时间戳保留（周榜等）
      return ts >= cutoff;
    });
    matched.sort((a, b) =>
      String(b.published_at || b.created_at || '').localeCompare(String(a.published_at || a.created_at || '')),
    );
    if (matched.length > maxPerColumn) matched = matched.slice(0, maxPerColumn);

    const highlights = matched.map((item) => highlightFromContent(item, {
      columnKey: col.key,
      columnLabel: col.name,
    }));
    const withImg = highlights.filter((h) => h.image).length;
    const visual = ['funny', 'portrait', 'sight', 'movie'].includes(col.key);
    const imgTotal = highlights.reduce((n, h) => n + (Array.isArray(h.images) && h.images.length ? h.images.length : (h.image ? 1 : 0)), 0);
    return {
      key: col.key,
      label: col.name,
      // 见笑/见她/见闻按「期」计数；图墙张数放 countImages 给 UI
      count: highlights.length,
      countImages: imgTotal,
      type: visual && withImg >= Math.max(1, Math.ceil(highlights.length / 2)) ? 'media' : 'text',
      highlights,
    };
  });

  const counts = {};
  for (const t of tabs) counts[t.key] = t.count;
  const total = tabs.reduce((n, t) => n + t.count, 0);
  const summary = total
    ? `已选源近${maxAgeDays}日 ${total} 条 · ` + tabs.map((t) => `${t.label} ${t.count}`).join(' · ')
    : '已选栏目下暂无近两日内容（共享池未入库或来源未勾选）';

  return {
    schema: 2,
    reading: true,
    platformId: platform.id,
    platformSlug: platform.slug,
    platformName: platform.name,
    date: input.date,
    title: `${platform.name} · 今日阅读`,
    generatedAt: now(),
    siteUrl: site,
    issueUrl: `${site}/p/${platform.slug}/${input.date}/`,
    feedUrl: `${site}/p/${platform.slug}/feed.xml`,
    subscribeUrl: `${site}/p/${platform.slug}/subscribe/`,
    defaultTab: columns.length ? columns[0].key : '',
    tabKeys: columns.map((c) => c.key),
    counts,
    total,
    summary,
    tabs,
  };
}

export function buildPlatformDigest(db, input = {}) {
  const platform = db.platforms[str(input.platformId)];
  if (!platform) throw new Error(`平台不存在：${input.platformId}`);
  if (!dateOk(input.date)) throw new Error(`日期不合法：${input.date}`);

  const site = str(input.siteUrl || platform.site_url).replace(/\/+$/, '');
  if (!site) throw new Error('缺少站点地址：需要 --site-url 或 platform.site_url');

  const columns = Object.values(db.platform_columns)
    .filter((c) => c.platform_id === platform.id && c.enabled)
    .sort((a, b) => a.position - b.position);

  const chosen = Object.values(db.candidate_entries).filter(
    (e) => e.platform_id === platform.id
      && e.issue_date === input.date
      && (e.status === CANDIDATE_STATUS.APPROVED || e.status === CANDIDATE_STATUS.PINNED)
  );

  const tabs = columns.map((col) => {
    const rows = chosen
      .filter((e) => e.column_id === col.id)
      .sort((a, b) => {
        if (a.status === CANDIDATE_STATUS.PINNED && b.status !== CANDIDATE_STATUS.PINNED) return -1;
        if (b.status === CANDIDATE_STATUS.PINNED && a.status !== CANDIDATE_STATUS.PINNED) return 1;
        return (a.rank || 99) - (b.rank || 99) || b.score - a.score;
      });
    const highlights = rows.map((e) => {
      const item = db.content_items[e.content_item_id];
      if (!item) return null;
      return highlightFromContent(item);
    }).filter(Boolean);
    const withImg = highlights.filter((h) => h.image).length;
    const visual = ['funny', 'portrait', 'sight', 'movie'].includes(col.key);
    return {
      key: col.key,
      label: col.name,
      count: highlights.length,
      // 轻松一刻 / 人像 / 见闻 / 电影音乐 → 图片格；其余文字列表
      type: visual && withImg >= Math.max(1, Math.ceil(highlights.length / 2)) ? 'media' : 'text',
      highlights,
    };
  });

  const counts = {};
  for (const t of tabs) counts[t.key] = t.count;
  const total = tabs.reduce((n, t) => n + t.count, 0);
  const summary = tabs.map((t) => `${t.label} ${t.count}`).join(' · ');

  return {
    schema: 2, // 2 = 平台 digest；1 = 老单站 digest
    platformId: platform.id,
    platformSlug: platform.slug,
    platformName: platform.name,
    date: input.date,
    title: `${platform.name} · 今日`,
    generatedAt: now(),
    siteUrl: site,
    issueUrl: `${site}/p/${platform.slug}/${input.date}/`,
    feedUrl: `${site}/p/${platform.slug}/feed.xml`,
    subscribeUrl: `${site}/p/${platform.slug}/subscribe/`,
    defaultTab: columns.length ? columns[0].key : '',
    // 让渲染器知道「这一期的栏目是什么」，不必硬编码老六栏
    tabKeys: columns.map((c) => c.key),
    counts,
    total,
    summary,
    tabs,
  };
}

/**
 * @param {object} db
 * @param {{platformId:string, date:string, siteUrl?:string, title?:string}} input
 * @returns {{issue:object, digest:object}}
 */
export function publishIssue(db, input = {}) {
  const platform = db.platforms[str(input.platformId)];
  if (!platform) throw new Error(`平台不存在：${input.platformId}`);
  if (!dateOk(input.date)) throw new Error(`日期不合法：${input.date}`);

  const existing = Object.values(db.issues).find(
    (i) => i.platform_id === platform.id && i.issue_date === input.date
  );
  if (existing && existing.status === 'published') {
    throw new Error(`该期已发布：${platform.slug}/${input.date}（幂等保护）`);
  }

  const digest = buildPlatformDigest(db, input);
  if (!digest.total) throw new Error('没有任何已通过的候选，拒绝发布空刊');

  const issue = existing || {
    id: newId(),
    platform_id: platform.id,
    issue_date: input.date,
    status: 'draft',
    title: null,
    summary: null,
    digest_json: null,
    public_url: null,
    published_at: null,
    created_at: now(),
    updated_at: now(),
  };

  // 发布即固化：旧 issue_items 清掉，按当前已审内容重建（幂等重跑不会翻倍）
  db.issue_items = db.issue_items.filter((it) => it.issue_id !== issue.id);
  const chosen = Object.values(db.candidate_entries).filter(
    (e) => e.platform_id === platform.id
      && e.issue_date === input.date
      && (e.status === CANDIDATE_STATUS.APPROVED || e.status === CANDIDATE_STATUS.PINNED)
  );
  for (const e of chosen) {
    db.issue_items.push({
      issue_id: issue.id,
      content_item_id: e.content_item_id,
      column_id: e.column_id,
      rank: e.rank || 0,
      editor_note: e.ai_reason || null,
      is_headline: e.status === CANDIDATE_STATUS.PINNED,
      display_mode: 'link_card',
      created_at: now(),
    });
  }

  issue.status = 'published';
  issue.title = input.title || digest.title;
  issue.summary = digest.summary;
  issue.digest_json = digest;
  issue.public_url = digest.issueUrl;
  issue.published_at = now();
  issue.updated_at = now();
  db.issues[issue.id] = issue;

  audit(db, 'issue.publish', {
    actor_user_id: platform.owner_user_id,
    platform_id: platform.id,
    target_type: 'issue',
    target_id: issue.id,
    metadata: { date: input.date, total: digest.total, slug: platform.slug },
  });

  return { issue, digest };
}

// ---------------------------------------------------------------------------
// 便捷：一次跑通整条链
// ---------------------------------------------------------------------------

/**
 * @param {object} db
 * @param {object} config  { user, platform, items, date, siteUrl, review }
 * @returns {object} 各步产物
 */
export function runPipeline(db, config = {}) {
  const user = registerUser(db, config.user || {});
  const { platform, columns } = createPlatform(db, {
    ...(config.platform || {}),
    userId: user.id,
  });
  const ingest = ingestContent(db, config.items || []);
  const candidates = buildCandidates(db, {
    platformId: platform.id,
    date: config.date,
    scoreFn: config.scoreFn,
  });
  const review = reviewCandidates(db, {
    platformId: platform.id,
    date: config.date,
    auto: !!(config.review && config.review.auto),
    autoPerColumn: config.review && config.review.autoPerColumn,
    decisions: config.review && config.review.decisions,
  });
  const published = publishIssue(db, {
    platformId: platform.id,
    date: config.date,
    siteUrl: config.siteUrl,
  });
  return { user, platform, columns, ingest, candidates, review, ...published };
}
