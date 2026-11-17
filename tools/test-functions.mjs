/**
 * Pages Functions 单元测试
 *
 * workerd 在本机因 VC++ 运行库问题崩溃，无法用 wrangler pages dev 跑，
 * 所以直接用 Node 的 Web API（Request/Response/Headers）模拟 Cloudflare 运行时。
 */
import { onRequest as imgHandler } from '../functions/img/[[path]].js';
import { onRequest as gateHandler } from '../functions/_middleware.js';

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  -> ' + JSON.stringify(extra) : ''}`);
  }
}

/* 文件名里的随机段（10 位十六进制） */
const NONCE = 'a1b2c3d4e5';
/* 真实存储键 = 公开 URL 的路径部分（两者完全一致） */
const KEY = `2026-10-25/jianwen/${NONCE}_001.webp`;
/* 公开 URL */
const URL_NEW = `http://x/img/${KEY}`;
const PARAMS_NEW = { path: ['2026-10-25', 'jianwen', `${NONCE}_001.webp`] };
/* 旧的三段格式（可枚举），必须被拒 */
const URL_OLD = 'http://x/img/2026-10-25/jianwen/001.webp';
const PARAMS_OLD = { path: ['2026-10-25', 'jianwen', '001.webp'] };

/* ── mock R2 ─────────────────────────────────────────────── */
function makeR2(store) {
  return {
    async get(key) {
      if (!(key in store)) return null;
      const buf = store[key];
      return {
        body: buf,
        httpMetadata: { contentType: 'image/webp' },
        httpEtag: '"etag-' + key.length + '"',
        writeHttpMetadata(headers) {
          headers.set('Content-Type', 'image/webp');
        },
      };
    },
  };
}

/* ── mock 静态资源绑定（Pages 的 env.ASSETS） ───────────────── */
function makeAssets(store) {
  return {
    async fetch(request) {
      const key = new URL(request.url).pathname;
      if (!(key in store)) return new Response('Not Found', { status: 404 });
      const buf = store[key];
      const range = request.headers.get('Range');
      // Pages 的 ASSETS 在带 Range 时返回 206 + Content-Range
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : buf.length - 1;
          const slice = buf.slice(start, end + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              'Content-Type': 'image/webp',
              'Content-Range': `bytes ${start}-${end}/${buf.length}`,
              'Content-Length': String(slice.length),
            },
          });
        }
      }
      return new Response(buf, {
        status: 200,
        headers: { 'Content-Type': 'image/webp' },
      });
    },
  };
}

console.log('\n=== 图片代理 /img/[[path]].js ===');
{
  const env = { IMAGES: makeR2({ [KEY]: new Uint8Array([1, 2, 3]) }) };

  // 1. 正常命中
  let res = await imgHandler({
    request: new Request(URL_NEW),
    env,
    params: PARAMS_NEW,
  });
  check('命中返回 200', res.status === 200, res.status);
  check('Content-Type 为 image/webp', res.headers.get('content-type') === 'image/webp');
  check('带 Cache-Control', /max-age=\d+/.test(res.headers.get('cache-control') || ''));
  check('带 ETag', !!res.headers.get('etag'));

  // 2. 条件请求 304
  const etag = res.headers.get('etag');
  res = await imgHandler({
    request: new Request(URL_NEW, {
      headers: { 'If-None-Match': etag },
    }),
    env,
    params: PARAMS_NEW,
  });
  check('If-None-Match 命中返回 304', res.status === 304, res.status);

  // 3. 未命中 404
  res = await imgHandler({
    request: new Request('http://x/img/2026-10-25/jianwen/' + NONCE + '_999.webp'),
    env,
    params: { path: ['2026-10-25', 'jianwen', NONCE + '_999.webp'] },
  });
  check('未命中返回 404', res.status === 404, res.status);

  // 4. 路径穿越拦截
  res = await imgHandler({
    request: new Request('http://x/img/..%2F..%2Fetc'),
    env,
    params: { path: ['..', '..', 'etc'] },
  });
  check('路径穿越被拒（400）', res.status === 400, res.status);

  // 5. 未配置绑定且没有静态兜底 -> 404
  res = await imgHandler({
    request: new Request(URL_NEW),
    env: {},
    params: PARAMS_NEW,
  });
  check('无 R2 无静态资源返回 404', res.status === 404, res.status);

  // 6. 旧命名 001.webp（可枚举）必须被拒
  res = await imgHandler({
    request: new Request(URL_OLD),
    env,
    params: PARAMS_OLD,
  });
  check('旧三段格式被拒（否则路径可枚举）', res.status === 404, res.status);
  check(
    '旧格式 404 带 no-store',
    /no-store/.test(res.headers.get('cache-control') || ''),
    res.headers.get('cache-control'),
  );

  // 7. 随机段长度不对 -> 404
  res = await imgHandler({
    request: new Request('http://x/img/2026-10-25/jianwen/abc_001.webp'),
    env,
    params: { path: ['2026-10-25', 'jianwen', 'abc_001.webp'] },
  });
  check('随机段格式不对返回 404', res.status === 404, res.status);

  // 8. 随机段不对但格式正确 -> 存储层找不到 -> 404（不会误命中别的图）
  res = await imgHandler({
    request: new Request('http://x/img/2026-10-25/jianwen/0123456789_001.webp'),
    env,
    params: { path: ['2026-10-25', 'jianwen', '0123456789_001.webp'] },
  });
  check('随机段错误返回 404（随机段必须参与查找）', res.status === 404, res.status);
}

console.log('\n=== 图片代理：静态兜底（R2 未启用时） ===');
{
  const assets = makeAssets({ [`/img/${KEY}`]: new Uint8Array([9, 9]) });

  // 1. 没有 R2 绑定 -> 直接走静态资源
  let res = await imgHandler({
    request: new Request(URL_NEW),
    env: { ASSETS: assets },
    params: PARAMS_NEW,
  });
  check('无 R2 绑定时回落到静态资源', res.status === 200, res.status);
  check('静态资源 Content-Type 正确', res.headers.get('content-type') === 'image/webp');

  // 2. 有 R2 但对象不存在 -> 回落到静态资源
  res = await imgHandler({
    request: new Request(URL_NEW),
    env: { IMAGES: makeR2({}), ASSETS: assets },
    params: PARAMS_NEW,
  });
  check('R2 未命中时回落到静态资源', res.status === 200, res.status);

  // 3. R2 读抛异常（bucket 被删 / 绑定失效）-> 仍能出图
  res = await imgHandler({
    request: new Request(URL_NEW),
    env: {
      IMAGES: {
        async get() {
          throw new Error('bucket not found');
        },
      },
      ASSETS: assets,
    },
    params: PARAMS_NEW,
  });
  check('R2 抛异常时回落到静态资源', res.status === 200, res.status);

  // 4. R2 优先级：两边都有时走 R2
  res = await imgHandler({
    request: new Request(URL_NEW),
    env: {
      IMAGES: makeR2({ [KEY]: new Uint8Array([1, 2, 3]) }),
      ASSETS: assets,
    },
    params: PARAMS_NEW,
  });
  check(
    'R2 与静态资源同时存在时优先 R2',
    res.headers.get('etag') === `"etag-${KEY.length}"`,
    res.headers.get('etag'),
  );

  // 5. 静态资源也没有 -> 404
  res = await imgHandler({
    request: new Request('http://x/img/2026-10-25/jianwen/' + NONCE + '_999.webp'),
    env: { ASSETS: makeAssets({}) },
    params: { path: ['2026-10-25', 'jianwen', NONCE + '_999.webp'] },
  });
  check('两边都没有返回 404', res.status === 404, res.status);
  check(
    '404 响应带 no-store（否则会被 Pages 默认缓存 4 小时）',
    /no-store/.test(res.headers.get('cache-control') || ''),
    res.headers.get('cache-control'),
  );

  // 6. Pages 把找不到的路径回退成 index.html（200 + text/html）——
  //    这种必须挡成 404，否则浏览器会拿 HTML 去解码图片
  res = await imgHandler({
    request: new Request(URL_NEW),
    env: {
      ASSETS: {
        async fetch() {
          return new Response('<!DOCTYPE html><html></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        },
      },
    },
    params: PARAMS_NEW,
  });
  check('静态资源回退成 HTML 时返回 404', res.status === 404, res.status);

  // 7. 带 Range 的请求：ASSETS 返回 206，必须原样透传
  res = await imgHandler({
    request: new Request(URL_NEW, {
      headers: { Range: 'bytes=0-1' },
    }),
    env: { ASSETS: makeAssets({ [`/img/${KEY}`]: new Uint8Array([1, 2, 3, 4]) }) },
    params: PARAMS_NEW,
  });
  check('带 Range 时返回 206（只认 200 会让微信加载不出图）', res.status === 206, res.status);
  check(
    '206 保留 Content-Range',
    (res.headers.get('content-range') || '').includes('bytes 0-1/4'),
    res.headers.get('content-range'),
  );
}

console.log('\n=== 访问口令中间件 /_middleware.js ===');
{
  const mk = (opts = {}) => {
    const { token, cookie, query, path: p } = opts;
    const url = new URL('http://x' + (p || '/2026-10-25/') + (query ? '?k=' + query : ''));
    return {
      request: new Request(url, cookie ? { headers: { Cookie: cookie } } : {}),
      env: token ? { GATE_TOKEN: token } : {},
      next: async () => new Response('OK-PASSED-THROUGH', { status: 200 }),
    };
  };

  // 1. 未设置 GATE_TOKEN -> 全站公开
  let res = await gateHandler(mk({}));
  check('未启用口令时放行', (await res.text()).includes('PASSED-THROUGH'));

  // 2. 启用口令，页面 HTML 仍公开（微信爬虫要能抓标题和 og:image）
  res = await gateHandler(mk({ token: 'secret123' }));
  check('页面 HTML 公开（爬虫可抓卡片信息）', (await res.text()).includes('PASSED-THROUGH'));

  // 3. 启用口令，静态资源公开
  res = await gateHandler(mk({ token: 'secret123', path: '/assets/logo.jpg' }));
  check('/assets/ 公开（logo 是分享封面）', (await res.text()).includes('PASSED-THROUGH'));

  // 4. 启用口令，图片内容受保护 -> 401
  res = await gateHandler(mk({ token: 'secret123', path: '/img/2026-10-25/jianwen/001.webp' }));
  check('无凭证访问图片返回 401', res.status === 401, res.status);
  check(
    '401 响应带 no-store（否则 Pages 默认缓存 4 小时，带对口令也照样裂图）',
    /no-store/.test(res.headers.get('cache-control') || ''),
    res.headers.get('cache-control'),
  );
  check(
    '401 响应带 Cloudflare-CDN-Cache-Control: no-store',
    /no-store/.test(res.headers.get('cloudflare-cdn-cache-control') || ''),
    res.headers.get('cloudflare-cdn-cache-control'),
  );

  // 5. ?k= 正确 -> 302 + 下发 cookie
  res = await gateHandler(mk({ token: 'secret123', query: 'secret123' }));
  check('正确 k 参数返回 302', res.status === 302, res.status);
  const setCookie = res.headers.get('set-cookie') || '';
  check('下发 cookie', setCookie.includes('dgate='), setCookie);
  check('Location 去掉 k 参数', !String(res.headers.get('location')).includes('k='));
  check(
    '302 响应带 no-store（带 Set-Cookie 的跳转被缓存就拿不到 cookie）',
    /no-store/.test(res.headers.get('cache-control') || ''),
    res.headers.get('cache-control'),
  );

  // 6. cookie 正确 -> 图片放行
  res = await gateHandler(mk({ token: 'secret123', cookie: 'dgate=secret123', path: '/img/x.webp' }));
  check('正确 cookie 访问图片放行', (await res.text()).includes('PASSED-THROUGH'));

  // 7. cookie 错误 -> 图片 401
  res = await gateHandler(mk({ token: 'secret123', cookie: 'dgate=wrong', path: '/img/x.webp' }));
  check('错误 cookie 访问图片返回 401', res.status === 401, res.status);

  // 8. 错误 cookie 但访问页面 -> 仍公开
  res = await gateHandler(mk({ token: 'secret123', cookie: 'dgate=wrong' }));
  check('错误 cookie 访问页面仍公开', (await res.text()).includes('PASSED-THROUGH'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
