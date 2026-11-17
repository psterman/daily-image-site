/**
 * 可选访问口令中间件
 *
 * 默认关闭（不设置 GATE_TOKEN 即完全公开）。
 *
 * 设计要点 —— 为什么只锁 /img/ 而不是整个站点：
 *   微信把链接粘贴进聊天框时，会用爬虫抓页面生成分享卡片（标题 + 封面图）。
 *   爬虫不带 cookie。如果整个站点都要口令，卡片就会变成空白或「需要访问口令」。
 *   所以：
 *     - 页面 HTML  -> 公开（爬虫能拿到 <title> 和 og:image，卡片才好看）
 *     - /assets/   -> 公开（logo 是品牌标识，本来就该公开）
 *     - /img/*     -> 需口令（真正要保护的图片内容）
 *   用户通过带 ?k=<token> 的链接进入 -> 下发 cookie -> 图片正常。
 *   分享到群里时也必须带 ?k=，这样群友点开即用。
 *
 * 设置方法（Cloudflare Pages 项目级 secret）：
 *   npx wrangler pages secret put GATE_TOKEN --project-name your-project
 */
const COOKIE = 'dgate';

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

function gatePage() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>需要访问口令</title>
<style>
  html,body{background:#0b0b0f;color:#e8e8ee;height:100%}
  body{margin:0;display:-webkit-box;display:-webkit-flex;display:flex;
       -webkit-box-orient:vertical;-webkit-flex-direction:column;flex-direction:column;
       -webkit-align-items:center;align-items:center;-webkit-justify-content:center;justify-content:center;
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  h1{font-size:17px;font-weight:600;margin:0 0 10px}
  p{color:#8b8b99;font-size:13px;margin:0 0 20px;text-align:center;padding:0 24px}
  form{display:-webkit-box;display:-webkit-flex;display:flex}
  input{background:#16161d;border:1px solid #2b2b36;color:#e8e8ee;border-radius:10px;
        padding:11px 14px;font-size:15px;width:210px;outline:none;-webkit-appearance:none}
  input:focus{border-color:#4a8cff}
  button{margin-left:8px;background:#4a8cff;border:0;color:#fff;border-radius:10px;
         padding:11px 18px;font-size:15px;-webkit-appearance:none}
</style></head>
<body>
  <h1>需要访问口令</h1>
  <p>请在链接后加上 <code>?k=口令</code>，或直接向发送者索取完整链接。</p>
  <form method="GET">
    <input name="k" placeholder="访问口令" autocapitalize="off" autocorrect="off" autocomplete="off">
    <button type="submit">进入</button>
  </form>
</body></html>`;
}

export async function onRequest(context) {
  const { request, env, next } = context;

  const token = env.GATE_TOKEN;
  if (!token) return next(); // 未启用 -> 全站公开

  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get('Cookie'));
  const authorized = cookies[COOKIE] === token;
  const q = url.searchParams.get('k');

  // 带正确口令：下发 cookie 并跳到干净 URL（不在地址栏留 token）
  if (!authorized && q === token) {
    const headers = new Headers();
    headers.append(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; SameSite=Lax`,
    );
    url.searchParams.delete('k');
    headers.set('Location', url.pathname + (url.search || ''));
    // 必须 no-store：这个 302 带着 Set-Cookie，被边缘缓存住就等于把
    // 「带口令才能进」的行为缓存下来了，缓存命中时浏览器拿不到新 cookie。
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    headers.set('CDN-Cache-Control', 'no-store, no-cache, must-revalidate');
    headers.set('Cloudflare-CDN-Cache-Control', 'no-store, no-cache, must-revalidate');
    return new Response(null, { status: 302, headers });
  }

  // 只有图片内容需要口令；页面 HTML 与静态资源保持公开，
  // 这样微信爬虫仍能生成带标题和封面的分享卡片。
  const isProtected = url.pathname.startsWith('/img/');
  if (!isProtected) return next();

  if (authorized) return next();
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // 同样必须 no-store：Pages 会给没有 Cache-Control 的 Function 响应
      // 默认套 max-age=14400（4 小时）。一旦这个 401 被缓存，
      // 用户后来带对了口令，边缘依然直接吐缓存里的 401，图片永远裂着。
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'CDN-Cache-Control': 'no-store, no-cache, must-revalidate',
      'Cloudflare-CDN-Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
