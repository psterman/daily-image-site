/**
 * sb-client.mjs —— Supabase REST / Auth 客户端（零依赖，浏览器 / Workers / Node 通用）
 *
 * 为什么自己写而不用 @supabase/supabase-js：
 *   1. 项目纪律：lib/ 下的业务层不许依赖 node:*；这个模块连 npm 包都不依赖，
 *      浏览器直接 <script type=module> import 就能跑，workers 里也能跑。
 *   2. 可注入 fetch：本机没有真实 Supabase 实例，注入一个 mock fetch 就能
 *      验证请求契约（URL / headers / body / 错误语义）。
 *   3. 只覆盖这个项目真正用到的 PostgREST 子集，不引一整个 SDK 的体积。
 *
 * 安全边界：
 *   - 浏览器端只能用 anon key（受 RLS 约束）。
 *   - service_role key 绝不能进前端；灌主源 / 发送等特权操作走 Edge Function。
 *   - 登录后把 user 的 access_token 作为 Bearer 带上，让 auth.uid() 生效。
 */

const DEFAULT_TIMEOUT = 15000;

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');
}

/** 把 filters 编译成 PostgREST 查询串。 */
function compileFilters(filters = []) {
  const qs = [];
  for (const f of filters) {
    const col = encodeURIComponent(f.col);
    const op = f.op || 'eq';
    const v = f.value;
    if (op === 'is') qs.push(`${col}=is.${v}`);
    else if (op === 'in') {
      const list = Array.isArray(v) ? v : [];
      qs.push(`${col}=in.(${list.map(escVal).join(',')})`);
    } else if (op === 'gte' || op === 'lte' || op === 'gt' || op === 'lt' || op === 'neq') {
      qs.push(`${col}=${op}.${escVal(v)}`);
    } else if (op === 'like' || op === 'ilike') {
      qs.push(`${col}=${op}.${escVal(v)}`);
    } else {
      qs.push(`${col}=eq.${escVal(v)}`);
    }
  }
  return qs;
}

function escVal(v) {
  if (v == null) return 'null';
  return encodeURIComponent(String(v)).replace(/,/g, '%2C');
}

/** 解析 PostgREST / GoTrue 的错误体，给出可读 message。 */
async function readError(res) {
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j.message || j.msg || j.error_description || j.error || body;
  } catch { /* 非 JSON 原样返回 */ }
  return new Error(`Supabase ${res.status}: ${msg}`);
}

/**
 * 创建客户端。
 * @param {object} cfg
 * @param {string} cfg.url        Supabase Project URL，如 https://xxx.supabase.co
 * @param {string} cfg.key        anon key（浏览器端）或 service_role key（仅服务端）
 * @param {Function} [cfg.fetchImpl] 可注入 fetch（测试用）；默认取 globalThis.fetch
 * @param {Function} [cfg.getToken]  返回当前用户 access_token 的同步/异步函数
 * @param {number} [cfg.timeout]
 */
export function createClient(cfg = {}) {
  if (!cfg.url) throw new Error('createClient 需要 url');
  if (!cfg.key) throw new Error('createClient 需要 key（浏览器端请用 anon key）');

  const fetchImpl = cfg.fetchImpl || (typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : null);
  if (!fetchImpl) throw new Error('当前环境没有 fetch，请通过 fetchImpl 注入');

  const timeout = cfg.timeout || DEFAULT_TIMEOUT;
  let sessionToken = null;

  async function authHeaders() {
    const bearer = typeof cfg.getToken === 'function'
      ? await cfg.getToken()
      : sessionToken;
    const headers = {
      apikey: cfg.key,
      Authorization: `Bearer ${bearer || cfg.key}`,
      'Content-Type': 'application/json',
    };
    // 非默认 schema：PostgREST 用 Accept-Profile 选 schema（不是 URL 前缀）。
    // 我们把 backend 表装在独立的 platform schema，与既有 public 表隔离，
    // 所以浏览器访问必须带这个头；写操作还需要 Content-Profile。
    if (cfg.schema && cfg.schema !== 'public') {
      headers['Accept-Profile'] = cfg.schema;
      headers['Content-Profile'] = cfg.schema;
    }
    return headers;
  }

  async function request(method, path, { body, headers, signal } = {}) {
    const url = joinUrl(cfg.url, path);
    const base = await authHeaders();
    const init = {
      method,
      headers: { ...base, ...(headers || {}) },
    };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);

    // 超时：优先用外部 signal，否则自建 AbortController
    let ctrl = null;
    if (!signal && typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      init.signal = ctrl.signal;
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetchImpl(url, init);
        clearTimeout(timer);
        return res;
      } catch (e) {
        clearTimeout(timer);
        throw e;
      }
    }
    return fetchImpl(url, init);
  }

  async function jsonRequest(method, path, opts) {
    const res = await request(method, path, opts);
    if (!res.ok) throw await readError(res);
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  // ---- PostgREST 数据接口 ----

  async function select(table, opts = {}) {
    const params = compileFilters(opts.filters);
    if (opts.columns) params.push(`select=${encodeURIComponent(opts.columns)}`);
    if (opts.order) params.push(`order=${encodeURIComponent(opts.order)}`);
    if (typeof opts.limit === 'number') params.push(`limit=${opts.limit}`);
    if (typeof opts.offset === 'number') params.push(`offset=${opts.offset}`);
    if (opts.head) params.push('head=true');
    const qs = params.length ? '?' + params.join('&') : '';
    const rows = await jsonRequest('GET', `rest/v1/${encodeURIComponent(table)}${qs}`);
    return rows || [];
  }

  async function insert(table, rows, opts = {}) {
    const params = [];
    if (opts.onConflict) params.push(`on_conflict=${encodeURIComponent(opts.onConflict)}`);
    const qs = params.length ? '?' + params.join('&') : '';
    const prefer = opts.resolve
      ? 'resolution=merge-duplicates,return=representation'
      : (opts.returnMinimal ? 'return=minimal' : 'return=representation');
    const payload = Array.isArray(rows) ? rows : [rows];
    return jsonRequest('POST', `rest/v1/${encodeURIComponent(table)}${qs}`, {
      body: payload,
      headers: { Prefer: prefer },
    });
  }

  /** upsert = insert + on_conflict + merge-duplicates */
  async function upsert(table, rows, onConflict) {
    return insert(table, rows, { onConflict, resolve: true });
  }

  async function update(table, patch, opts = {}) {
    const qs = compileFilters(opts.filters).length
      ? '?' + compileFilters(opts.filters).join('&') : '';
    return jsonRequest('PATCH', `rest/v1/${encodeURIComponent(table)}${qs}`, {
      body: patch,
      headers: { Prefer: 'return=representation' },
    });
  }

  async function remove(table, opts = {}) {
    const qs = compileFilters(opts.filters).length
      ? '?' + compileFilters(opts.filters).join('&') : '';
    return jsonRequest('DELETE', `rest/v1/${encodeURIComponent(table)}${qs}`, {
      headers: { Prefer: 'return=minimal' },
    });
  }

  // ---- GoTrue Auth 接口 ----

  function takeSession(data) {
    if (data && data.access_token) sessionToken = data.access_token;
    return data;
  }

  const auth = {
    async signUp(email, password, meta = {}) {
      return takeSession(await jsonRequest('POST', 'auth/v1/signup', {
        body: { email, password, data: meta },
      }));
    },

    async signIn(email, password) {
      return takeSession(await jsonRequest('POST', 'auth/v1/token?grant_type=password', {
        body: { email, password },
      }));
    },

    /** 用 refresh_token 换新的 access_token（JWT 默认 1 小时过期）。 */
    async refreshSession(refreshToken) {
      if (!refreshToken) throw new Error('缺少 refresh_token');
      return takeSession(await jsonRequest('POST', 'auth/v1/token?grant_type=refresh_token', {
        body: { refresh_token: refreshToken },
      }));
    },

    /** 发送重置密码邮件（回调落到 Auth 配置的 site_url）。 */
    async recover(email) {
      return jsonRequest('POST', 'auth/v1/recover', {
        body: { email },
      });
    },

    /** 重发注册确认邮件。 */
    async resend(email, type = 'signup') {
      return jsonRequest('POST', 'auth/v1/resend', {
        body: { type, email },
      });
    },

    /** 已持有 recovery/session token 时设置新密码。 */
    async updatePassword(password) {
      if (!sessionToken) throw new Error('未登录，无法改密');
      return jsonRequest('PUT', 'auth/v1/user', {
        body: { password },
      });
    },

    async signOut() {
      if (!sessionToken) return;
      try {
        await jsonRequest('POST', 'auth/v1/logout', {});
      } finally {
        sessionToken = null;
      }
    },

    async user() {
      if (!sessionToken) return null;
      const data = await jsonRequest('GET', 'auth/v1/user');
      return data && data.id ? data : null;
    },

    setToken(token) { sessionToken = token || null; },
    getToken() { return sessionToken; },
  };

  return {
    url: String(cfg.url),
    auth,
    select,
    insert,
    upsert,
    update,
    delete: remove,
    /** 暴露给测试：查看某次请求会带什么 headers */
    _headers: authHeaders,
  };
}

export default createClient;
