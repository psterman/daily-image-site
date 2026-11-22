/**
 * 讯飞星火（Loomy）短信登录签名服务 —— HTTP 处理层。
 *
 * 路由：POST /loomy-sign
 *   入参 { path, contentMd5 }
 *     path       —— 只能是 /login/phone/sendMsgCode 或 /login/phone/checkCode
 *     contentMd5 —— 请求体的 Content-MD5 指纹（base64(MD5(body))）
 *     注意：服务端**拿不到 body**，因此看不到手机号和验证码。
 *   出参 { ok: true, headers: { Authorization, Date, Nonce, Content-Type, Accept, Content-MD5 } }
 *
 * 密钥来自 Cloudflare Secret（LOOMY_ACCESS_KEY_ID / LOOMY_ACCESS_KEY_SECRET），不入库。
 *
 * 为什么要限流：这个接口本质上是「用我们的 app 身份给任意 body 签名」，
 * 放开就等于允许别人拿我们的身份给陌生手机号发验证码。
 * 三道闸：自定义头（挡浏览器跨站表单）、单 IP 频次、单窗口全局上限。
 */

import { json } from './r2-json.mjs';
import { SIGNABLE_PATHS, httpDateFromMs, signRequest } from './loomy-signature.mjs';

/** 限流窗口与阈值。窗口 10 分钟。 */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_PER_IP = 20;
const RATE_GLOBAL = 400;

/** 单 IP 计数（同 isolate 内有效 —— 换 isolate 会重置，属于尽力而为，WAF 规则是第二道防线）。 */
const ipHits = new Map();
let globalHits = 0;
let globalResetAt = 0;

function hitRateLimit(request) {
  const now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (now >= globalResetAt) {
    globalHits = 0;
    globalResetAt = now + RATE_WINDOW_MS;
  }
  globalHits += 1;
  if (globalHits > RATE_GLOBAL) return true;

  // 顺手清掉过期项，别让 Map 无限涨。
  if (ipHits.size > 5000) {
    for (const [key, val] of ipHits) {
      if (val.resetAt <= now) ipHits.delete(key);
    }
  }

  const cur = ipHits.get(ip);
  if (!cur || cur.resetAt <= now) {
    ipHits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  cur.count += 1;
  return cur.count > RATE_PER_IP;
}

/** base64(MD5) 定长 24 字符、结尾两个 '=' —— 挡住乱填和注入。 */
const CONTENT_MD5_RE = /^[A-Za-z0-9+/]{22}==$/;

export async function handleSignRequest(request, env) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: '只支持 POST' }, 405);
  }

  // 必须带自定义头：浏览器发起的跨站「简单请求」不带自定义头，
  // 带了就必须先过 CORS 预检 —— 这能挡住「随便一个网页替用户打这个接口」。
  if (request.headers.get('X-Loomy-Sign') !== '1') {
    return json({ ok: false, error: 'missing_sign_header' }, 403);
  }

  if (hitRateLimit(request)) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'JSON 无效' }, 400);
  }

  const path = String(body?.path ?? '');
  const contentMd5 = String(body?.contentMd5 ?? '');

  if (!SIGNABLE_PATHS.includes(path)) {
    return json({ ok: false, error: 'path_not_allowed' }, 400);
  }
  if (!CONTENT_MD5_RE.test(contentMd5)) {
    return json({ ok: false, error: 'bad_content_md5' }, 400);
  }

  const accessKeyId = String(env?.LOOMY_ACCESS_KEY_ID || '');
  const accessKeySecret = String(env?.LOOMY_ACCESS_KEY_SECRET || '');
  if (!accessKeyId || !accessKeySecret) {
    return json({ ok: false, error: 'sign_not_configured' }, 503);
  }

  const now = Date.now();
  const date = httpDateFromMs(now);
  const nonce = `${now.toString(16)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const headers = await signRequest({
    accessKeyId,
    accessKeySecret,
    path,
    contentMd5,
    date,
    nonce,
  });

  return json({ ok: true, headers }, 200);
}

/** 仅供测试重置限流计数。 */
export function _resetRateLimit() {
  ipHits.clear();
  globalHits = 0;
  globalResetAt = 0;
}
