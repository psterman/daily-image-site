/**
 * 用户自建平台：纯数据原语（浏览器 / Node 通用）。
 *
 * 为什么单独拆出这个文件：
 *   platform-flow.mjs 的业务函数不该依赖 node:fs / node:crypto —— 否则这套闭环
 *   只能在命令行跑，网页里调用不了。而产品的方向是「用户登录网页就能搭平台」。
 *   把 newId / 空库 / seed / 审计 / 内容指纹这些纯数据原语放到这里，
 *   整条流水线在浏览器和 Node 里都能跑；只有落盘（platform-store.mjs）需要 Node。
 *
 * 依赖纪律：这个文件不许 import 任何 node:* 模块。
 *   - randomUUID 用 globalThis.crypto（浏览器与 Node 19+ 都有）；
 *   - 内容指纹用纯 JS FNV-1a（去重够用，不做密码学用途）。
 */
export const ROOT_KEY = 'platform';

export function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // 兜底：非安全上下文（http）里 crypto.randomUUID 可能缺失，用时间戳 + 随机数组一个
  const r = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${r}-${r}`;
}

export function now() {
  return new Date().toISOString();
}

/** 追踪参数：剥这些，保留 id/name 等身份参数（喷嚏网 more.asp?id=）。 */
const TRACKING_PARAM = /^(utm(_|$)|fbclid$|gclid$|mc_|spm$|from$|ref$|source$|campaign$)/i;

/**
 * URL 归一化（去重用）：去协议、尾斜杠；只剥追踪查询参数。
 * - 整段砍掉 ?query 会把 more.asp?id=1 / id=2 并成一条
 * - 整段砍掉 #hash 会把网易云 /#/song?id=1 / id=2 并成一条（SPA 路由）
 */
export function normalizeUrl(u) {
  let s = String(u == null ? '' : u).trim()
    .replace(/^https?:\/\//i, '')
    .toLowerCase();

  // SPA hash 路由保留为路径：music.163.com/#/song?id=1 → music.163.com/song?id=1
  let hashPath = '';
  const hashIdx = s.indexOf('#');
  if (hashIdx >= 0) {
    const hash = s.slice(hashIdx + 1);
    if (hash.startsWith('/') || hash.startsWith('!/')) hashPath = hash.replace(/^!/, '');
    s = s.slice(0, hashIdx);
  }

  const qi = s.indexOf('?');
  let path;
  let query = '';
  if (qi >= 0) {
    path = s.slice(0, qi).replace(/\/+$/, '');
    query = s.slice(qi + 1);
  } else {
    path = s.replace(/\/+$/, '');
  }

  if (hashPath) {
    const hq = hashPath.indexOf('?');
    if (hq >= 0) {
      path = (path.replace(/\/+$/, '') + hashPath.slice(0, hq)).replace(/\/{2,}/g, '/');
      query = [query, hashPath.slice(hq + 1)].filter(Boolean).join('&');
    } else {
      path = (path.replace(/\/+$/, '') + hashPath).replace(/\/{2,}/g, '/');
    }
  }

  if (query) {
    const kept = query.split('&')
      .filter((p) => {
        if (!p) return false;
        const key = p.split('=')[0];
        return key && !TRACKING_PARAM.test(key);
      })
      .sort();
    return kept.length ? `${path}?${kept.join('&')}` : path;
  }
  return path;
}

/**
 * 稳定内容指纹：FNV-1a 32 位，输出 8 位十六进制。
 *
 * 去重语义要以 URL 为准：同一个链接改个标题就绕过去重、重复进候选池，
 * 是聚合类产品最常见也最伤信任的 bug。标题只在没有 URL 时作兜底。
 * 只用于去重判定，不用于任何安全场景。
 */
export function contentHash(url, title) {
  let h = 0x811c9dc5;
  const normalized = normalizeUrl(url);
  const s = normalized || String(title == null ? '' : title).trim();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 与 db/schema.sql 同构的空库。数组用 []，实体用 id -> row 字典。 */
export function emptyDb() {
  return {
    schema: 1,
    users: {},
    platforms: {},
    tag_packs: {},
    platform_columns: {},
    sources: {},
    content_items: {},
    content_tags: [],
    candidate_entries: {},
    issues: {},
    issue_items: [],
    delivery_channels: {},
    audit_logs: [],
  };
}

import { toCoreTagPacks, DIRECTORIES, TAG_OPTIONS } from './tag-options.mjs';

/**
 * 主源预配置内容包 = tag-options 标签选项。
 * 与 db/seed-core.sql / tools/tag-options.json 对齐。
 */
export const CORE_TAG_PACKS = toCoreTagPacks();
export { DIRECTORIES, TAG_OPTIONS };

/**
 * 幂等 seed：补缺失包；已有包刷新中文名/目录。
 * schema===2（Supabase）禁止前端假造 uuid——共享池只能管理端写入，否则建栏目 FK 炸、源池对不上。
 */
export function seedTagPacks(db) {
  const invent = !(db && db.schema === 2);
  for (const p of CORE_TAG_PACKS) {
    const row = db.tag_packs[p.key];
    if (!row) {
      if (!invent) continue;
      db.tag_packs[p.key] = {
        id: newId(),
        key: p.key,
        name: p.name,
        description: p.description || '',
        group_name: p.group_name,
        risk_level: p.risk_level,
        status: 'active',
        sample_payload: {},
        created_at: now(),
        updated_at: now(),
      };
      continue;
    }
    row.name = p.name;
    row.group_name = p.group_name;
    row.description = p.description || '';
    row.risk_level = p.risk_level;
  }
  return db;
}

/** 唯一的「主源编辑池」。rights 与 seed-core.sql 保持一致：只给摘要，不给图片。 */
export function ensureMainSource(db) {
  let src = Object.values(db.sources).find((s) => s.name === '主源编辑池');
  if (!src) {
    src = {
      id: newId(),
      kind: 'manual',
      name: '主源编辑池',
      url: null,
      feed_url: null,
      homepage_url: null,
      trust_score: 100,
      rights_status: 'authorized',
      license: null,
      allow_snippet: true,
      allow_image: false,
      allow_fulltext: false,
      allow_cache: false,
      takedown_contact: null,
      status: 'active',
      created_at: now(),
      updated_at: now(),
    };
    db.sources[src.id] = src;
  }
  return src;
}

/** 所有写操作都留痕。接 Supabase 后直接映射 audit_logs 表。 */
export function audit(db, action, meta = {}) {
  const row = {
    id: newId(),
    actor_user_id: meta.actor_user_id || null,
    platform_id: meta.platform_id || null,
    action,
    target_type: meta.target_type || null,
    target_id: meta.target_id || null,
    metadata: meta.metadata || {},
    created_at: now(),
  };
  db.audit_logs.push(row);
  return row;
}
