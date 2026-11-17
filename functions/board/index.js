/**
 * 留言板页面 —— /board/
 *
 * 页面本体是一张静态 HTML（site/board.html，构建时复制到 published/board.html），
 * 这里只负责把它取出来吐出去。
 *
 * 为什么不用 published/board/index.html 直接做静态页：
 *   /board/ 这个路径已经被本 Function 占住了（Pages 里 Function 优先于静态资源），
 *   静态文件放同路径会取不到。放到 /board.html 就没有冲突。
 *
 * 为什么页面本身公开、数据接口才要口令：
 *   页面只是一张空壳（表单 + 列表容器），留言内容全在 /board/api 后面，
 *   那儿有 _middleware.js 把关。公开页面等于「告诉投稿人门在哪」，
 *   门本身是锁着的。
 */

const noStore = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'CDN-Cache-Control': 'no-store, no-cache, must-revalidate',
  'Cloudflare-CDN-Cache-Control': 'no-store, no-cache, must-revalidate',
};

export async function onRequest(context) {
  const { request, env } = context;

  if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
    try {
      const res = await env.ASSETS.fetch(new URL('/board.html', request.url));
      if (res && res.status === 200) {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('text/html')) {
          // Pages 的 ASSETS 绑定对**找不到**的路径会回退到首页并返回 200 + text/html。
          // 光看状态码和 Content-Type 分不出「留言板」和「首页」，
          // 那样页面缺失时用户会莫名其妙看到首页，还以为是 bug。
          // 靠 board.html 里的专属标记确认拿到的确实是留言板。
          const html = await res.clone().text();
          if (html.includes('name="board-page"')) {
            return new Response(html, {
              status: 200,
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                ...noStore,
              },
            });
          }
          console.error('留言板页面标记缺失：ASSETS 返回的不是 board.html');
        }
      }
    } catch (err) {
      console.error('留言板页面读取失败:', err?.message || err);
    }
  }

  return new Response('留言板页面缺失（构建时没有把 site/board.html 复制到 published/）', {
    status: 500,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...noStore },
  });
}
