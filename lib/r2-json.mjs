/**
 * 共享的 R2 JSON 读写层 —— 留言板和点赞接口都用它。
 *
 * 为什么要抽出来：
 *   这层里有安全性和正确性要求最高的部分（条件写、CSRF 校验）。
 *   之前 board 和 likes 各存一份，结果两份都用了错的 etag 键名 ——
 *   留言板的乐观锁从来没生效过。改一处漏一处就是一次真实事故，所以只留一份。
 *
 * R2 条件写的官方契约（https://developers.cloudflare.com/r2/api/workers/workers-api-reference/）：
 *   - R2Conditional 的字段是 etagMatches / etagDoesNotMatch / uploadedBefore / uploadedAfter。
 *     没有 etagMatch —— 传了会被忽略，条件写退化成无条件写。
 *   - 条件不满足时 put() 返回 null（不是抛异常），对象不会被存。
 *   - etagDoesNotMatch 的语义是「对象的 etag 不等于给定字符串就执行」，
 *     所以 '*' 不等于「对象必须不存在」。
 *     「仅当不存在才创建」的正确写法是传 Headers：If-None-Match: *。
 */

export function clip(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max);
}

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const view = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
  return out;
}

const noStore = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'CDN-Cache-Control': 'no-store, no-cache, must-revalidate',
  'Cloudflare-CDN-Cache-Control': 'no-store, no-cache, must-revalidate',
};

/** 统一 JSON 响应（默认 no-store —— Pages 会给没设 Cache-Control 的响应套 4 小时缓存） */
export function json(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...noStore,
      ...(extraHeaders || {}),
    },
  });
}

/** 校验 Origin，防 CSRF（跨站表单提交） */
export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // 同源 fetch / 部分客户端不带 Origin
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/** 读 R2 对象并解析 JSON；不存在或内容坏了返回 fallback */
export async function readJson(bucket, key, fallback) {
  const obj = await bucket.get(key);
  if (!obj) return fallback;
  try {
    return JSON.parse(await obj.text());
  } catch {
    return fallback;
  }
}

/**
 * 条件写。
 *   currentEtag 有值 -> 只在 etag 匹配时写（etagMatches）
 *   没有           -> 只在对象不存在时写（If-None-Match: *）
 *
 * 返回 true = 写成功；false = 前置条件不满足（有人同时在写），调用方该重读重试。
 */
export async function writeJson(bucket, key, data, currentEtag) {
  const opts = currentEtag
    ? { onlyIf: { etagMatches: currentEtag } }
    : { onlyIf: new Headers({ 'If-None-Match': '*' }) };
  try {
    const obj = await bucket.put(key, JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      ...opts,
    });
    // 官方契约：前置条件不满足时 put() 返回 null，对象不会被存。
    // 不看返回值的话，冲突会被当成「写成功了」—— 返回一个从未落盘的计数。
    if (obj === null) return false;
    return true;
  } catch (err) {
    const msg = String(err?.message || err);
    // 真运行时是返回 null 不是抛异常；这里只是兜底。
    // 注意正则里不要带 "etag" —— mock 抛「拼错键名」时消息里含 etag，
    // 会被误当成冲突吞掉，把真错误变成「重试 8 次仍失败」。
    if (/precondition|412/i.test(msg)) return false;
    throw err;
  }
}

/**
 * 写冲突错误的标记。
 *
 * mutate 重试用尽时抛的是带 code = 'R2_CONFLICT' 的错误；
 * 其它异常（键名写错、类型不对、R2 调用挂了）都是**别的**问题。
 *
 * 为什么要分开：调用方原来一律 catch 成 503「写入冲突，请稍后重试」。
 * 那是个**可重试**的语义 —— 客户端会一直重试。
 * 如果真正的病因是代码 bug（比如 onlyIf 的键名又写错了），
 * 伪装成 503 就等于把 bug 永久藏起来：用户看到的是「稍后重试」，
 * 日志里是干净的 503，没人查。
 *
 * 本项目已经被「键名写错」坑过两次（likes 和 board 各一次 etagMatch），
 * 所以这条必须分清。
 */
export const R2_CONFLICT = 'R2_CONFLICT';

/** 这个异常是不是「写冲突重试耗尽」 */
export function isWriteConflict(err) {
  return !!(err && err.code === R2_CONFLICT);
}

/**
 * 读-改-写，带 etag 乐观锁重试。
 *   mutateFn 返回 false -> 放弃这次写（mutate 也返回 false）
 *   写成功             -> 返回 mutateFn 的返回值；没返回值则返回 true
 *   重试用尽           -> 抛 R2_CONFLICT 错误（调用方负责兜成 503）
 */
export async function mutate(bucket, key, fallback, mutateFn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const obj = await bucket.get(key);
    const etag = obj?.etag || null;
    let data;
    try {
      data = obj ? JSON.parse(await obj.text()) : structuredClone(fallback);
    } catch {
      data = structuredClone(fallback);
    }
    const result = mutateFn(data);
    if (result === false) return false; // mutateFn 主动放弃
    const ok = await writeJson(bucket, key, data, etag);
    if (ok) return result === undefined ? true : result;
    // etag 不匹配 -> 有人同时在写 -> 重新读再来。
    // 必须加随机退避：所有人点赞都写同一个对象，不错开的话
    // 所有写入者会「同步」地读同一份、撞同一份 etag、一起失败，
    // 退避把它们打散，几轮就能收敛。
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 40) + 5));
  }
  const err = new Error('写入冲突，重试 8 次仍失败');
  err.code = R2_CONFLICT;
  throw err;
}
