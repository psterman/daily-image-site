/**
 * 留言板 —— 投稿口令中间件
 *
 * 这个口令和图片访问口令（GATE_TOKEN）是两回事，刻意分成两个 secret：
 *
 *   GATE_TOKEN   保护「读」—— 给分享链接用，可以随时关掉、随时轮换
 *   SUBMIT_TOKEN 保护「写」—— 只有拿到口令的人才能留言，要长期稳定
 *
 * 混成一个会有两个麻烦：
 *   1. 为了投稿把阅读口令发出去，等于把图片的访问权也发出去了
 *   2. 轮换阅读口令会把投稿的人一起踢掉
 *
 * 口令怎么进：
 *   - 访问 /board/?k=<口令>  → 校验通过 → 下发 cookie → 302 到干净 URL
 *   - 调 /board/api 时带 x-board-token 头 → 校验通过 → 响应里下发 cookie
 *
 * 校验通过后下发 cookie（dboard），30 天内不用重复输入口令。
 *
 * 没设置 SUBMIT_TOKEN 时整个留言板是关闭的（503），不是「无口令开放」——
 * 这个站的定位是公域图片站，留言是写操作，默认可写是不能接受的默认值。
 */

const COOKIE = 'dboard';
const COOKIE_MAX_AGE = 30 * 24 * 3600;

// cookie 的派生盐。只用来让 cookie 值不等于口令本身，
// 万一 cookie 被日志/截图泄露，攻击者拿到的不是可直接复用的口令。
const COOKIE_SALT = 'your-project/board/v1';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const view = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * 常量时间字符串比较。
 *
 * 直接用 === 比较会在第一个不等的字节就短路，理论上会泄露前缀长度。
 * 这里逐字符异或累积差异，最后一次性判断，耗时与内容无关。
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 口令比对。
 *
 * 输入和密文都先算 SHA-256 再比 64 位十六进制串，长度恒定，
 * 比较本身也逐字符做，避免运行时把 === 优化成提前返回。
 */
export async function isValidToken(input, secret) {
  if (!input || !secret) return false;
  const got = await sha256hex(input);
  const want = await sha256hex(secret);
  return timingSafeEqual(got, want);
}

/** 从请求里挖出口令：query 参数 / x-board-token 头 */
export function extractToken(request, url) {
  const q = url.searchParams.get('k') || url.searchParams.get('token');
  if (q) return q;
  const h = request.headers.get('x-board-token');
  if (h) return h;
  return null;
}

/** 由口令派生 cookie 值 */
export async function cookieValueFor(secret) {
  return (await sha256hex(COOKIE_SALT + '|' + secret)).slice(0, 40);
}

/** 请求是否已带着有效的 cookie */
export async function hasValidCookie(request, secret) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const v = cookies[COOKIE];
  if (!v) return false;
  return timingSafeEqual(v, await cookieValueFor(secret));
}

/** 下发 cookie 的响应头 */
export async function setCookieHeader(secret) {
  return `${COOKIE}=${await cookieValueFor(secret)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly`;
}

function noStoreHeaders(extra) {
  return {
    'Content-Type': 'text/plain; charset=utf-8',
    // Pages 给没有 Cache-Control 的 Function 响应默认套 max-age=14400（4 小时）。
    // 留言是动态数据，401/503 一旦被缓存，后面带着正确口令也照样被挡。
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'CDN-Cache-Control': 'no-store, no-cache, must-revalidate',
    'Cloudflare-CDN-Cache-Control': 'no-store, no-cache, must-revalidate',
    ...(extra || {}),
  };
}

export async function onRequest(context) {
  const { request, env, next } = context;

  const token = env.SUBMIT_TOKEN;
  if (!token) {
    // 没配置口令 = 留言板没开。这是「写」入口，默认必须关。
    return new Response(
      '留言板未启用（站点没有配置投稿口令）',
      { status: 503, headers: noStoreHeaders() },
    );
  }

  const url = new URL(request.url);

  // 只有 /board/api 里的数据需要口令。
  // /board/ 本身是公开的页面外壳（它只是一张静态 HTML，留言数据都在 API 里），
  // 公开的意义是：投稿人知道有这个地方，页面里会提示「需要口令」。
  // 真正敏感的是留言内容和提交动作，都锁在 /board/api 后面。
  const isApi = url.pathname.startsWith('/board/api');

  const cookieOk = await hasValidCookie(request, token);

  // 带 ?k=<口令>：校验通过就发 cookie 并跳到干净 URL（不在地址栏留口令）
  const q = url.searchParams.get('k');
  if (q && !cookieOk) {
    if (await isValidToken(q, token)) {
      const headers = new Headers();
      headers.append('Set-Cookie', await setCookieHeader(token));
      url.searchParams.delete('k');
      headers.set('Location', url.pathname + (url.search || ''));
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      headers.set('CDN-Cache-Control', 'no-store, no-cache, must-revalidate');
      headers.set('Cloudflare-CDN-Cache-Control', 'no-store, no-cache, must-revalidate');
      return new Response(null, { status: 302, headers });
    }
    if (isApi) return new Response('口令不对', { status: 401, headers: noStoreHeaders() });
    // 页面路径：口令错了不拦，让页面自己提示「口令不对」
    return next();
  }

  if (!isApi) return next();

  if (cookieOk) return next();

  // 没带 cookie —— 看是不是在请求头里直接带了口令
  const hdr = extractToken(request, url);
  if (hdr && (await isValidToken(hdr, token))) {
    const res = await next();
    // next() 返回的 Response 的 header 可能不可变，克隆一份再塞 cookie
    const out = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: new Headers(res.headers),
    });
    out.headers.append('Set-Cookie', await setCookieHeader(token));
    return out;
  }

  return new Response('需要投稿口令', { status: 401, headers: noStoreHeaders() });
}
