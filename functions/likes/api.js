/**
 * 点赞接口 —— /likes/api
 *
 * 存储放在 R2（和图片同一个 bucket，用 likes/ 前缀隔开）：
 *   likes/<日期>.json   该期的计数 + 点过赞的访客哈希
 *   likes/rate.json     限流计数
 *
 * 为什么是「一期一个文件」而不是「一张图一个对象」：
 *   页面加载时要把 243 张图的赞数全画到格子上。
 *   一张图一个对象 = 243 次 R2 请求，页面直接卡死；
 *   一期一个文件 = 1 次请求拿全部计数。
 *
 * 为什么写入用 etag 乐观锁（具体契约见 lib/r2-json.mjs 的文件头）：
 *   所有人点赞都写同一个对象，不加条件写的话并发提交会互相覆盖
 *   （后写的把先写的计数抹掉）。
 *
 * 安全要点：
 *   - 写操作校验 Origin，防 CSRF
 *   - 限流按 IP 哈希（不存原始 IP）
 *   - 访客只存哈希，不存原始 id
 *   - GET 的响应**不能带访客相关字段** —— 它要被边缘缓存，
 *     混进访客数据会把一个人的点赞清单发给所有人
 */

import { json, clip, sha256hex, sameOrigin, readJson, mutate, isWriteConflict } from '../../lib/r2-json.mjs';
import { makeRateLimiter } from '../../lib/rate-limit.mjs';

const RATE_KEY = 'likes/rate.json';
const BOARD_KEY = 'board/messages.json';

const MAX_VOTERS_PER_IMAGE = 500;
const RATE_HISTORY_MAX = 2000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z]{3,10}_\d{3}$/;
const VISITOR_RE = /^[0-9a-f]{16}$/;

// 计数是可以被边缘缓存的（访客无关），30 秒后自然过期。
// 本项目 API Token 没有 Cache Purge 权限（实测 401），所以不做主动失效。
const publicCache = {
  'Cache-Control': 'public, max-age=30',
  'CDN-Cache-Control': 'public, max-age=30',
  'Cloudflare-CDN-Cache-Control': 'public, max-age=30',
};

const limiter = makeRateLimiter({
  key: RATE_KEY,
  salt: 'like-rate-v1',
  perMinute: 30,
  perHour: 300,
  historyMax: RATE_HISTORY_MAX,
});

function likesKey(date) {
  return 'likes/' + date + '.json';
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.IMAGES) {
    return json({ ok: false, error: '点赞存储未就绪（R2 没绑定）' }, 503);
  }
  const bucket = env.IMAGES;
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const date = clip(url.searchParams.get('date'), 10);
    if (!DATE_RE.test(date)) {
      return json({ ok: false, error: 'date 格式不对（要 YYYY-MM-DD）' }, 400);
    }

    const data = await readJson(bucket, likesKey(date), { counts: {}, voters: {} });
    const counts = data && data.counts && typeof data.counts === 'object' ? data.counts : {};

    // 评论数顺带从留言板文件统计 —— 省一次往返，留言板文件本来就小（≤500 条）
    const board = await readJson(bucket, BOARD_KEY, { items: [] });
    const comments = {};
    const items = Array.isArray(board.items) ? board.items : [];
    for (const it of items) {
      if (!it || it.imgDate !== date || !it.imgId) continue;
      comments[it.imgId] = (comments[it.imgId] || 0) + 1;
    }

    return json({ ok: true, date, counts, comments }, 200, publicCache);
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: '只支持 GET / POST' }, 405, { Allow: 'GET, POST' });
  }

  if (!sameOrigin(request)) {
    return json({ ok: false, error: '跨站请求被拒绝' }, 403);
  }

  const vid = clip(request.headers.get('x-daily-visitor'), 64);
  if (!VISITOR_RE.test(vid)) {
    return json({ ok: false, error: '缺少有效的访客标识' }, 400);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  const date = clip(payload?.date, 10);
  const id = clip(payload?.id, 32);
  const on = payload?.on === true;

  if (!DATE_RE.test(date)) {
    return json({ ok: false, error: 'date 格式不对（要 YYYY-MM-DD）' }, 400);
  }
  if (!ID_RE.test(id)) {
    return json({ ok: false, error: 'id 格式不对（要 栏目_序号）' }, 400);
  }

  const rate = await limiter.check(bucket, request);
  if (!rate.ok) {
    return json(
      { ok: false, error: `点赞太频繁了，${rate.retryAfter} 秒后再试` },
      429,
      { 'Retry-After': String(rate.retryAfter) },
    );
  }

  const voterHash = await sha256hex('like-voter-v1|' + vid);
  const key = likesKey(date);

  let out = { ok: true, count: 0 };

  let written;
  try {
    written = await mutate(bucket, key, { counts: {}, voters: {} }, (data) => {
      const counts = data.counts && typeof data.counts === 'object' ? data.counts : {};
      const voters = data.voters && typeof data.voters === 'object' ? data.voters : {};
      const list = Array.isArray(voters[id]) ? voters[id].slice() : [];
      const has = list.indexOf(voterHash) >= 0;

      if (on) {
        if (has) {
          // 已经赞过 —— 幂等，不能重复计数
          out = { ok: true, count: counts[id] || 0 };
          return;
        }
        if (list.length >= MAX_VOTERS_PER_IMAGE) {
          out = { ok: false, error: '这张图点赞太多啦' };
          return false; // 放弃这次写
        }
        list.push(voterHash);
        voters[id] = list;
        counts[id] = (counts[id] || 0) + 1;
        out = { ok: true, count: counts[id] };
      } else {
        if (!has) {
          out = { ok: true, count: counts[id] || 0 };
          return;
        }
        const kept = list.filter((h) => h !== voterHash);
        if (kept.length) voters[id] = kept;
        else delete voters[id];
        const c = Math.max(0, (counts[id] || 0) - 1);
        if (c) counts[id] = c;
        else delete counts[id];
        out = { ok: true, count: c };
      }

      data.counts = counts;
      data.voters = voters;
    });
  } catch (err) {
    // 冲突 -> 503（可重试）；其它异常 -> 是代码 bug，必须让它炸出来。
    // 一律伪装成 503 的话，键名再写错一次就永远没人查
    //（本项目已经被 etagMatch 这个坑埋过两次）。
    console.error('[likes] 点赞写入失败:', err);
    if (!isWriteConflict(err)) throw err;
    return json({ ok: false, error: '写入冲突，请重试' }, 503);
  }

  /* mutate 只有两种返回：写成功（written === true），或 mutateFn 主动放弃（written === false）。
     放弃的那条分支已经把 out 设成了 { ok: false }，状态码由 out 决定：
     「这张图点赞太多啦」是 409；万一以后加了别的放弃原因而忘了设 out，
     这里会退化成 503，而不是误报成功。
     （写成两段 if 的话，第二段是走不到的死代码 —— 那正是上一轮评审挑出来的。） */
  if (written === false) {
    return json({ ok: false, error: out.error || '写入未完成，请重试' }, out.ok ? 503 : 409);
  }

  await limiter.record(bucket, rate.ipHash, rate.now);

  return json({ ok: true, id, count: out.count, on }, 200);
}
