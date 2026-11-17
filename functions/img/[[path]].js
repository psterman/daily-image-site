/**
 * 图片代理：/img/<date>/<tab>/<nonce>_<seq>.webp  ->  R2 bucket
 *
 * 走代理而不是给 R2 开公共读的好处：
 * - bucket 保持私有，随时可以整目录撤回
 * - 统一在这里控制缓存策略
 *
 * 绑定：R2 bucket，binding 名 IMAGES
 *
 * 文件名里的 <nonce> 是一段不可猜的随机段（见 tools/build.mjs 里的 getSalt）。
 * 它存在的唯一理由：/img/<日期>/<分类>/<序号>.webp 这个规律完全可猜，
 * 只要知道日期和分类名，490 次请求就能把当天所有图片全抓走（实测过）。
 * 加上 nonce 之后路径无法枚举，而 R2 / published/img 里的目录结构没变，
 * 撤回逻辑（删 r2/<日期>/<分类>/ 整目录）一行都不用改。
 *
 * 兜底：如果没有 R2 绑定（R2 还没在 Dashboard 启用），或者 R2 里没有这个对象，
 * 就退回部署包内的静态资源（published/img/...）。这样在 R2 开通之前，
 * 站点依然能正常出图，不至于发到群里全是裂图。
 */
export async function onRequest(context) {
  const { request, env, params } = context;

  const raw = params.path;
  const key = Array.isArray(raw) ? raw.join('/') : raw || '';

  if (!key || key.includes('..')) {
    return new Response('Bad Request', { status: 400 });
  }

  // ── 0. 校验路径格式 ──────────────────────────────────────
  // 合法形式：<日期>/<分类>/<10位随机段>_<序号>[_t].webp
  //
  // 随机段编在文件名里（而不是单独一段 URL 路径），有两个好处：
  //   1. 存储键与 URL 完全一致，代理不用重组路径，静态兜底也能直接复用原请求
  //   2. 随机段参与查找 —— 否则任何格式正确的随机段都能命中同一张图
  //
  // 旧格式 001.webp 不符合这个规则，一律 404：
  // /img/<日期>/<分类>/<序号>.webp 这个规律完全可猜，只要知道日期和分类名，
  // 490 次请求就能把当天所有图片全抓走（实测过），所以必须堵死。
  const m = key.match(/^(\d{4}-\d{2}-\d{2})\/([a-z0-9]+)\/([0-9a-f]{10}_[0-9]{3}(_t)?\.webp)$/);
  if (!m) {
    return notFound();
  }
  const storageKey = key;

  // ── 1. R2 优先 ────────────────────────────────────────────
  if (env.IMAGES) {
    try {
      const object = await env.IMAGES.get(storageKey);
      if (object) {
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('Content-Type', object.httpMetadata?.contentType || 'image/webp');
        headers.set('Cache-Control', 'public, max-age=86400');
        headers.set('ETag', object.httpEtag);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('X-Content-Type-Options', 'nosniff');

        // 条件请求
        const inm = request.headers.get('If-None-Match');
        if (inm && inm === object.httpEtag) {
          return new Response(null, { status: 304, headers });
        }

        if (request.method === 'HEAD') {
          return new Response(null, { status: 200, headers });
        }

        return new Response(object.body, { status: 200, headers });
      }
    } catch (err) {
      // bucket 被删 / 绑定失效 —— 继续走静态兜底，别把整个站打挂
      console.error('R2 读取失败，改用静态兜底:', err?.message || err);
    }
  }

  // ── 2. 静态兜底 ───────────────────────────────────────────
  if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
    try {
      // 静态资源的路径与 URL 完全一致（published/img/<日期>/<分类>/<随机段>_<序号>.webp），
      // 直接用原请求即可。
      const res = await env.ASSETS.fetch(request);
      // Pages 对找不到的路径会回退到 index.html 并返回 200 + text/html。
      // 对 /img/* 来说那就是一张「状态正常但内容是坏的」图片，
      // 必须按 Content-Type 挡掉，否则浏览器会拿 HTML 去解码图片。
      //
      // 注意状态码不能只认 200：请求带 Range 头时 ASSETS 会返回 206，
      // 微信 X5、部分代理和 CDN 都会对图片发 Range，
      // 只认 200 会让带 Range 的请求全部变成 404。
      if (res && res.status >= 200 && res.status < 300) {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.startsWith('image/')) {
          // 显式指定缓存策略。注意 zone 的「浏览器缓存 TTL」会改写 Cache-Control 里的
          // max-age，所以真正管边缘缓存的是 CDN-Cache-Control / Cloudflare-CDN-Cache-Control
          // —— 后者优先级最高，任何其他 Cloudflare 功能都改不动它。
          const headers = new Headers(res.headers);
          headers.set('Cache-Control', 'public, max-age=86400');
          headers.set('CDN-Cache-Control', 'public, max-age=86400');
          headers.set('Cloudflare-CDN-Cache-Control', 'public, max-age=86400');
          // 206 必须原样保留状态码和 Content-Range
          return new Response(res.body, { status: res.status, headers });
        }
      }
    } catch (err) {
      console.error('静态兜底失败:', err?.message || err);
    }
  }

  return notFound();
}

/**
 * 404 响应。
 *
 * 关键：错误响应绝不能被缓存。
 * Pages 给没有 Cache-Control 的 Function 响应默认套 max-age=14400（4 小时），
 * 一旦域名刚生效那几秒资产没就绪返回了 404，这个 404 就会黏在边缘缓存里，
 * 后面即使资源已经可用也一直返回缓存里的 404。
 * Cloudflare-CDN-Cache-Control 优先级最高，zone 的浏览器缓存 TTL 也改不动它。
 */
function notFound() {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'CDN-Cache-Control': 'no-store, no-cache, must-revalidate',
      'Cloudflare-CDN-Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
