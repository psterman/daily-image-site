/**
 * 留言板 API —— /board/api
 *
 * 存储放在 R2（和图片同一个 bucket，用 board/ 前缀隔开）：
 *   board/messages.json   所有留言
 *   board/rate.json       限流计数
 *
 * 为什么用 R2 而不是 D1/KV：
 *   - R2 binding 已经配好（IMAGES），Pages Functions 直接就有写权限，
 *     不需要额外申请 token，也不用新建数据库实例
 *   - 留言量极小（一天几条到几十条），一次 get 读全部足够
 *   - 不引入第二个有状态依赖，部署链路不用改
 *
 * 为什么是「单文件 + etag 乐观锁」而不是「一条留言一个对象」：
 *   - 读的时候只要 1 次 R2 请求，不用 list + N 次 get
 *   - 写的时候用 onlyIf.etagMatches 做条件写，并发提交不会互相覆盖；
 *     真撞上了（etag 不匹配）就重读重写，最多重试 8 次
 *   - 读写层和限流器抽到 ../../lib/ 下了（留言板和点赞接口共用一份）
 *
 * 安全要点：
 *   - 口令由 _middleware.js 校验，这里不再重复校验
 *   - 写操作校验 Origin，防 CSRF
 *   - 限流按 IP 哈希（不存原始 IP），1 分钟 3 条 / 1 小时 20 条
 *   - 外链只放行 http/https，挡掉 javascript: 伪协议
 *   - 留言正文由前端用 textContent 插入，不拼 HTML
 */

import { json, clip, sha256hex, sameOrigin, readJson, mutate, isWriteConflict } from '../../lib/r2-json.mjs';
import { makeRateLimiter } from '../../lib/rate-limit.mjs';

const MSG_KEY = 'board/messages.json';
const RATE_KEY = 'board/rate.json';

const MAX_ITEMS = 500;
const MAX_BODY = 2000;
const MAX_NAME = 40;
const MAX_LINK = 500;

/* 跟图评论：三个字段要么都不给，要么都给且都合法 */
const IMG_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IMG_ID_RE = /^[a-z]{3,10}_\d{3}$/;
const IMG_THUMB_RE = /^\/img\/\d{4}-\d{2}-\d{2}\/[a-z]+\/[0-9a-f]{10}_\d{3}_t\.webp$/;

/* 交叉校验用的「带捕获组」版本：抠出日期 / 栏目 / 序号三段。
   它必须跟 IMG_THUMB_RE 描述**完全同一种字符串** —— 两边一旦漂移，
   就会出现「白名单拒了、交叉校验却收了」的缝（或者反过来）。
   单独命名是为了让 tools/test-contract.mjs 能从这里抠出来比对，
   不用在测试里手抄一遍正则 —— 手抄的那份会自己漂移，而且没人会发现。 */
const IMG_THUMB_PARTS_RE = /^\/img\/(\d{4}-\d{2}-\d{2})\/([a-z]+)\/[0-9a-f]{10}_(\d{3})_t\.webp$/;

const limiter = makeRateLimiter({
  key: RATE_KEY,
  salt: 'board-rate-v1',
  perMinute: 3,
  perHour: 20,
  historyMax: 500,
});

function randomId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 只放行 http/https，挡掉 javascript: / data: 这类伪协议 */
function safeUrl(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (s.length > MAX_LINK) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
  } catch {
    return '';
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.IMAGES) {
    return json({ ok: false, error: '留言板存储未就绪（R2 没绑定）' }, 503);
  }
  const bucket = env.IMAGES;

  if (request.method === 'GET') {
    const data = await readJson(bucket, MSG_KEY, { items: [] });
    const items = (Array.isArray(data.items) ? data.items : []).slice().reverse();

    // 客户端带 x-author-token 过来，服务端比出哪些留言是自己发的
    const rawAuthor = request.headers.get('x-author-token');
    let authorHash = null;
    if (rawAuthor) authorHash = await sha256hex('board-author-v1|' + rawAuthor);

    const out = items.map((it) => ({
      id: it.id,
      ts: it.ts,
      name: it.name,
      body: it.body,
      link: it.link,
      cat: it.cat,
      imgDate: it.imgDate || '',
      imgId: it.imgId || '',
      imgThumb: it.imgThumb || '',
      mine: !!(authorHash && it.author === authorHash),
    }));
    return json({ ok: true, items: out });
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: '只支持 GET / POST' }, 405, { Allow: 'GET, POST' });
  }

  if (!sameOrigin(request)) {
    return json({ ok: false, error: '跨站请求被拒绝' }, 403);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  // ── 删除自己的留言 ────────────────────────────────────────
  if (payload && payload.action === 'delete') {
    const id = clip(payload.id, 64);
    const authorToken = clip(payload.authorToken, 128);
    if (!id || !authorToken) return json({ ok: false, error: '参数不全' }, 400);
    const authorHash = await sha256hex('board-author-v1|' + authorToken);

    // 写冲突重试 8 次仍失败 —— 返回 503，别让异常逃出去变成没有正文的 500
    let removed;
    try {
      removed = await mutate(bucket, MSG_KEY, { items: [] }, (data) => {
        const items = Array.isArray(data.items) ? data.items : [];
        const idx = items.findIndex((it) => it && it.id === id && it.author === authorHash);
        if (idx < 0) return false;
        items.splice(idx, 1);
        data.items = items;
        return true;
      });
    } catch (err) {
      // 冲突 -> 503（可重试）；其它异常 -> 是代码 bug，必须让它炸出来。
      // 一律伪装成 503 的话，键名再写错一次就永远没人查
      //（本项目已经被 etagMatch 这个坑埋过两次）。
      console.error('[board] 删除留言写入失败:', err);
      if (!isWriteConflict(err)) throw err;
      return json({ ok: false, error: '写入冲突，请稍后重试' }, 503);
    }

    if (removed === false) return json({ ok: false, error: '找不到这条留言（或不是你的）' }, 404);
    return json({ ok: true });
  }

  // ── 提交留言 ──────────────────────────────────────────────
  const body = clip(payload?.body, MAX_BODY);
  if (!body) return json({ ok: false, error: '留言内容不能为空' }, 400);

  const name = clip(payload?.name, MAX_NAME);
  const link = safeUrl(payload?.link);
  const cat = ['见闻', '见她', '见笑', '求图', '其他'].includes(payload?.cat) ? payload.cat : '';

  // ── 跟图评论（可选三件套） ────────────────────────────────
  const hasImgDate = payload?.imgDate !== undefined && payload?.imgDate !== null && payload?.imgDate !== '';
  const hasImgId = payload?.imgId !== undefined && payload?.imgId !== null && payload?.imgId !== '';
  const hasImgThumb = payload?.imgThumb !== undefined && payload?.imgThumb !== null && payload?.imgThumb !== '';
  const anyImg = hasImgDate || hasImgId || hasImgThumb;
  const allImg = hasImgDate && hasImgId && hasImgThumb;

  let imgDate = '';
  let imgId = '';
  let imgThumb = '';
  if (anyImg) {
    // 要么都给，要么都不给 —— 给一半是客户端 bug，直接报出来
    if (!allImg) {
      return json({ ok: false, error: '图片信息不完整（imgDate / imgId / imgThumb 要一起给）' }, 400);
    }
    imgDate = clip(payload.imgDate, 10);
    imgId = clip(payload.imgId, 32);
    imgThumb = clip(payload.imgThumb, 200);
    // 白名单：imgThumb 会被渲染成 <img src>，放开等于允许任意 URL 注入
    if (!IMG_DATE_RE.test(imgDate) || !IMG_ID_RE.test(imgId) || !IMG_THUMB_RE.test(imgThumb)) {
      return json({ ok: false, error: '图片信息格式不对' }, 400);
    }
    // 三件套必须互相自洽：缩略图里嵌着日期、栏目和序号，
    // 它们必须跟 imgDate / imgId 对得上。
    //
    // 为什么还要查这一层：三条白名单各自都合法，但内容可以互相矛盾
    //（imgDate=2026-10-25 + imgId=jianwen_001 + imgThumb=/img/2026-11-03/jianwen/..._001_t.webp）。
    // 这种数据会落库，然后留言板上就出现「挂在 10-25 那张图上的评论，
    // 缩略图却是 11-03 的」—— 点缩略图跳过去看到的也不是被评论的那张。
    //
    // 不是漏洞（提交者本来就能自由选），但补上它零误杀成本：
    // 真实数据 2258/2258 三件套完全自洽（见 tools/test-contract.mjs）。
    const tm = imgThumb.match(IMG_THUMB_PARTS_RE);
    if (!tm || tm[1] !== imgDate || tm[2] + '_' + tm[3] !== imgId) {
      return json({ ok: false, error: '图片信息对不上（日期 / 栏目 / 序号与缩略图不一致）' }, 400);
    }
  }

  // 注意：上面所有校验都在限流检查**之前**。
  // 这个顺序是 Task 2 定下的，不是随手排的 —— 无效投稿不应该吃掉调用者的配额。
  // 要是 400 放在限流后面，一个乱试的人就能把正常访客的额度耗光。
  const rate = await limiter.check(bucket, request);
  if (!rate.ok) {
    return json(
      { ok: false, error: `提交太频繁了，${rate.retryAfter} 秒后再试` },
      429,
      { 'Retry-After': String(rate.retryAfter) },
    );
  }

  const authorToken = randomId() + randomId();
  const authorHash = await sha256hex('board-author-v1|' + authorToken);
  const item = {
    id: randomId() + randomId(),
    ts: Date.now(),
    name,
    body,
    link,
    cat,
    imgDate,
    imgId,
    imgThumb,
    author: authorHash,
  };

  // 写冲突重试 8 次仍失败 —— 返回 503，别让异常逃出去变成没有正文的 500
  try {
    await mutate(bucket, MSG_KEY, { items: [] }, (data) => {
      const items = Array.isArray(data.items) ? data.items : [];
      items.push(item);
      // 超量就丢最旧的
      data.items = items.slice(-MAX_ITEMS);
    });
  } catch (err) {
    // 冲突 -> 503（可重试）；其它异常 -> 是代码 bug，必须让它炸出来。
    // 一律伪装成 503 的话，键名再写错一次就永远没人查。
    console.error('[board] 提交留言写入失败:', err);
    if (!isWriteConflict(err)) throw err;
    return json({ ok: false, error: '写入冲突，请稍后重试' }, 503);
  }

  await limiter.record(bucket, rate.ipHash, rate.now);

  // 作者令牌只在这里返回一次，客户端自己存着（localStorage）。
  // 服务端只留哈希，泄漏 R2 内容也删不掉别人的留言。
  return json({ ok: true, id: item.id, authorToken });
}
