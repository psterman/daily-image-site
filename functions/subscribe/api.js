/**
 * 退订接口 —— /subscribe/api
 *
 * 退订链接由发信脚本写进每封邮件，形如：
 *   /subscribe/api?action=unsubscribe&email=<sha256>&token=<随机token>
 *
 * 为什么 email 用 hash 而不是明文：
 *   链接会经过邮件服务器、聊天记录、浏览器历史，明文邮箱等于二次泄露。
 *   hash 不可逆；token 是每人独立的随机凭证，两者都拿到才能退订。
 *
 * 为什么退订要做成 GET（点链接即可）：
 *   邮件客户端里没有 JS、不能发 POST。要求"登录后退订"只会让人点举报垃圾邮件 ——
 *   那比退订伤得多（拉低发件域名信誉）。
 *
 * GET 无参数 -> 返回订阅人数统计（no-store，不带任何订阅者信息）。
 */
import { json, clip, readJson, mutate, isWriteConflict } from '../../lib/r2-json.mjs';

const LIST_KEY = 'subscribers/list.json';

function resultPage(ok, text) {
  const color = ok ? '#1b5e20' : '#b3261e';
  const bg = ok ? '#e8f5e9' : '#fdecea';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>退订${ok ? '成功' : '失败'}</title></head>
<body style="margin:0;background:#f5f5f7;color:#1a1a1e;
 font:15px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">
<div style="max-width:460px;margin:80px auto;padding:28px;background:#fff;border-radius:14px">
<div style="padding:12px 16px;border-radius:10px;background:${bg};color:${color}">${text}</div>
<p style="color:#888;font-size:13px;margin-top:20px">退订后立即生效，不会再收到本站邮件。</p>
</div></body></html>`;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.IMAGES) return json({ ok: false, error: '订阅存储未就绪' }, 503);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (request.method === 'GET' && action !== 'unsubscribe') {
    const list = await readJson(env.IMAGES, LIST_KEY, {});
    return json({ ok: true, subscribers: Object.keys(list).length });
  }

  if (action !== 'unsubscribe') {
    return json({ ok: false, error: '不支持的操作' }, 400);
  }

  const emailHash = clip(url.searchParams.get('email'), 64);
  const token = clip(url.searchParams.get('token'), 64);
  if (!/^[0-9a-f]{64}$/.test(emailHash) || !/^[0-9a-f]{32}$/.test(token)) {
    return new Response(resultPage(false, '退订链接无效'), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  try {
    const removed = await mutate(env.IMAGES, LIST_KEY, {}, (list) => {
      const rec = list[emailHash];
      // token 不匹配就当没这人 —— 不告诉对方"邮箱存在但 token 错了"
      if (!rec || rec.token !== token) return false;
      delete list[emailHash];
      return true;
    });
    return new Response(
      resultPage(true, removed ? '已退订成功' : '该邮箱本来就没有订阅，无需退订'),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  } catch (err) {
    if (isWriteConflict(err)) {
      return new Response(resultPage(false, '操作冲突，请再点一次链接'), {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    throw err;
  }
}
