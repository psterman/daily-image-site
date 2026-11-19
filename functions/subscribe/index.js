/**
 * 订阅入口 —— /subscribe/
 *
 * GET  -> 订阅页（六分类勾选表单）
 * POST -> 订阅/退订处理（同一个路径，表单提交到这里）
 *
 * 为什么页面也放在 Function 里，而不是 site/ 下当静态文件：
 *   publish.ps1 部署的是整个 published/ 目录，而 published/ 每次构建会被清空重建。
 *   放 site/ 下的订阅页不会自动进 published/，得改构建器 copy —— 多一处改动多一处坑。
 *   做成 Function 则天然随 functions/ 一起部署，不依赖构建产物。
 *
 * 为什么 GET 不读订阅者数据：
 *   页面是纯静态 HTML，不需要知道有多少人订阅（那是 /api 的事）。
 *   分开之后页面可被边缘缓存，/api 的统计走 no-store。
 */
import {
  json,
  clip,
  sha256hex,
  sameOrigin,
  readJson,
  mutate,
  isWriteConflict,
} from '../../lib/r2-json.mjs';
import { makeRateLimiter } from '../../lib/rate-limit.mjs';

const LIST_KEY = 'subscribers/list.json';
const RATE_KEY = 'subscribers/rate.json';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CATS = [
  ['jianwen', '见闻'],
  ['jianshe', '见她'],
  ['jianxiao', '见笑'],
  ['news', '见报'],
  ['music', '听乐'],
  ['movie', '看片'],
];
const CAT_KEYS = CATS.map(([k]) => k);

const limiter = makeRateLimiter({
  key: RATE_KEY,
  salt: 'subscribe-v1',
  perMinute: 10,
  perHour: 60,
  historyMax: 1000,
});

function normalizeCats(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const set = [...new Set(arr.map((c) => String(c).trim()).filter((c) => CAT_KEYS.includes(c)))];
  return set.length ? set : null;
}

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(msg) {
  const boxes = CATS.map(
    ([key, label], i) =>
      `<label class="cat"><input type="checkbox" name="cats" value="${key}" ${
        i === 2 ? 'checked' : ''
      }><span>${label}</span></label>`
  ).join('');
  const note = msg
    ? `<div class="note ${msg.ok ? 'ok' : 'err'}">${esc(msg.text)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>订阅每日推送</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#f5f5f7;color:#1a1a1e;
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:520px;margin:0 auto;padding:32px 18px 60px}
  h1{font-size:22px;margin:0 0 6px}
  .sub{color:#888;font-size:13px;margin:0 0 24px}
  .card{background:#fff;border-radius:14px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
  label.f{display:block;font-size:13px;color:#666;margin:0 0 6px}
  input[type=email]{width:100%;padding:12px 14px;border:1px solid #ddd;border-radius:10px;
       font-size:15px;outline:none;-webkit-appearance:none}
  input[type=email]:focus{border-color:#4a8cff}
  .cats{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 8px}
  .cat{position:relative}
  .cat input{position:absolute;opacity:0;width:0;height:0}
  .cat span{display:inline-block;padding:7px 14px;border:1px solid #ddd;border-radius:20px;
       font-size:13px;color:#666;cursor:pointer;user-select:none}
  .cat input:checked+span{background:#4a8cff;border-color:#4a8cff;color:#fff}
  button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:10px;
       background:#4a8cff;color:#fff;font-size:15px;-webkit-appearance:none}
  .note{padding:10px 14px;border-radius:10px;margin:0 0 16px;font-size:13px}
  .note.ok{background:#e8f5e9;color:#1b5e20}
  .note.err{background:#fdecea;color:#b3261e}
  .hint{color:#999;font-size:12px;margin-top:14px;line-height:1.7}
</style></head>
<body><div class="wrap">
  <h1>订阅每日推送</h1>
  <p class="sub">每天早上，把你感兴趣的分类直接发到邮箱，不用再登录网站。</p>
  ${note}
  <div class="card">
    <form method="POST" action="/subscribe/">
      <label class="f">邮箱地址</label>
      <input type="email" name="email" required placeholder="you@example.com" autocomplete="email">
      <label class="f" style="margin-top:18px">想看哪些分类（可多选，全不选 = 全部）</label>
      <div class="cats">${boxes}</div>
      <button type="submit">订阅</button>
    </form>
    <div class="hint">每天一封，随时可退订。我们只发你勾选的内容。<br>
      退订链接在每封邮件底部，点一下即可。</div>
  </div>
</div></body></html>`;
}

async function readPayload(request) {
  const type = request.headers.get('Content-Type') || '';
  if (type.includes('application/json')) {
    try {
      const body = await request.json();
      return { email: body.email, cats: body.cats };
    } catch {
      return null;
    }
  }
  const form = await request.formData().catch(() => null);
  if (!form) return null;
  const catsRaw = form.getAll('cats');
  return { email: form.get('email'), cats: catsRaw.length ? catsRaw : form.get('cats') };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // GET 是订阅页；统计数字走 /subscribe/api（另一个 Function 文件）
  if (request.method === 'GET') {
    return new Response(page(null), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: '只支持 GET / POST' }, 405);
  }
  if (!env.IMAGES) {
    return new Response(page({ ok: false, text: '订阅存储未就绪，请稍后再试' }), {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  if (!sameOrigin(request)) {
    return new Response(page({ ok: false, text: '来源校验失败' }), {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const gate = await limiter.check(env.IMAGES, request);
  if (!gate.ok) {
    return new Response(page({ ok: false, text: '操作太频繁，稍后再试' }), {
      status: 429,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': String(gate.retryAfter) },
    });
  }
  await limiter.record(env.IMAGES, gate.ipHash, gate.now);

  const payload = await readPayload(request);
  const email = clip(payload && payload.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return new Response(page({ ok: false, text: '邮箱格式不对，请检查后重试' }), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const cats = normalizeCats(payload && payload.cats);
  const key = await sha256hex(email);
  const bucket = env.IMAGES;

  try {
    await mutate(bucket, LIST_KEY, {}, (list) => {
      const prev = list[key];
      if (prev && prev.email === email) {
        prev.cats = cats; // 更新偏好，保留 token
        return true;
      }
      list[key] = { email, cats, addedAt: new Date().toISOString(), token: randomToken() };
      return true;
    });
    return new Response(page({ ok: true, text: '订阅成功！明早就能收到第一封。' }), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    if (isWriteConflict(err)) {
      return new Response(page({ ok: false, text: '写入冲突，请重试' }), {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    throw err;
  }
}
