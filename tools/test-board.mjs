/**
 * 留言板 Pages Functions 单元测试
 *
 * workerd 在本机因 VC++ 运行库问题崩溃，跑不了 wrangler pages dev，
 * 所以直接用 Node 的 Web API（Request/Response/Headers/crypto.subtle）模拟 Cloudflare 运行时。
 *
 * 重点覆盖四件容易出错的事：
 *   1. 口令鉴权（页面公开、接口要口令、cookie 换口令）
 *   2. 没配口令时必须整个关掉（写入口不能默认可写）
 *   3. 并发提交不能互相覆盖（etag 乐观锁）
 *   4. 限流 / CSRF / 伪协议外链
 */
import { onRequest as boardMiddleware } from '../functions/board/_middleware.js';
import { onRequest as boardApi } from '../functions/board/api.js';
import { makeR2 } from './r2-mock.mjs';

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`);
  }
}

const TOKEN = 'test-token-123';
const BAD_TOKEN = 'wrong-token';

/* ── mock R2 见 tools/r2-mock.mjs（留言板和点赞两边共用一份） ── */

function makeCtx(request, env, nextImpl) {
  return {
    request,
    env,
    next:
      nextImpl ||
      (() => new Response('NEXT', { status: 200, headers: { 'Content-Type': 'text/plain' } })),
  };
}

/* 拿到 middleware 下发的 cookie 值 */
function cookieOf(res) {
  const sc = res.headers.get('set-cookie');
  if (!sc) return null;
  const m = /^dboard=([^;]*)/.exec(sc);
  return m ? m[1] : null;
}

function postJSON(body, headers) {
  return new Request('http://x/board/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
}

/* ═══════════════ 中间件 ═══════════════ */

console.log('\n=== 留言板中间件 ===');
{
  // 1. 没配口令 -> 整个关掉
  let res = await boardMiddleware(
    makeCtx(new Request('http://x/board/api'), { SUBMIT_TOKEN: undefined }),
  );
  check('没配 SUBMIT_TOKEN 时返回 503', res.status === 503, res.status);

  // 2. 页面路径公开（只锁 /board/api）
  let called = false;
  res = await boardMiddleware(
    makeCtx(
      new Request('http://x/board/'),
      { SUBMIT_TOKEN: TOKEN },
      () => {
        called = true;
        return new Response('PAGE', { status: 200 });
      },
    ),
  );
  check('/board/ 页面公开可访问', res.status === 200 && called, res.status);

  // 3. 接口没凭证 -> 401
  res = await boardMiddleware(makeCtx(new Request('http://x/board/api'), { SUBMIT_TOKEN: TOKEN }));
  check('/board/api 无凭证返回 401', res.status === 401, res.status);

  // 4. 401 带 no-store（否则会被边缘缓存住）
  check('401 带 no-store', /no-store/.test(res.headers.get('cache-control') || ''));

  // 5. 请求头带对的口令 -> 放行 + 下发 cookie
  res = await boardMiddleware(
    makeCtx(new Request('http://x/board/api', { headers: { 'x-board-token': TOKEN } }), {
      SUBMIT_TOKEN: TOKEN,
    }),
  );
  check('带对口令的请求被放行', res.status === 200, res.status);
  check('通过后下发 dboard cookie', !!cookieOf(res));

  // 6. 口令不对 -> 401
  res = await boardMiddleware(
    makeCtx(new Request('http://x/board/api', { headers: { 'x-board-token': BAD_TOKEN } }), {
      SUBMIT_TOKEN: TOKEN,
    }),
  );
  check('口令不对返回 401', res.status === 401, res.status);

  // 7. ?k= 正确 -> 302 跳到干净 URL + 下发 cookie
  res = await boardMiddleware(
    makeCtx(new Request('http://x/board/?k=' + TOKEN), { SUBMIT_TOKEN: TOKEN }),
  );
  check('?k= 正确时 302', res.status === 302, res.status);
  check('302 的 Location 去掉了 k', (res.headers.get('location') || '') === '/board/', res.headers.get('location'));
  check('302 同时下发 cookie', !!cookieOf(res));

  // 8. ?k= 不对 -> 页面路径不拦（页面自己提示），接口路径 401
  res = await boardMiddleware(
    makeCtx(new Request('http://x/board/?k=' + BAD_TOKEN), { SUBMIT_TOKEN: TOKEN }),
  );
  check('?k= 不对时页面路径仍放行', res.status === 200, res.status);

  res = await boardMiddleware(
    makeCtx(new Request('http://x/board/api?k=' + BAD_TOKEN), { SUBMIT_TOKEN: TOKEN }),
  );
  check('?k= 不对时接口返回 401', res.status === 401, res.status);

  // 9. 带有效 cookie -> 放行
  const good = await boardMiddleware(
    makeCtx(new Request('http://x/board/api', { headers: { 'x-board-token': TOKEN } }), {
      SUBMIT_TOKEN: TOKEN,
    }),
  );
  const cv = cookieOf(good);
  res = await boardMiddleware(
    makeCtx(new Request('http://x/board/api', { headers: { Cookie: 'dboard=' + cv } }), {
      SUBMIT_TOKEN: TOKEN,
    }),
  );
  check('带有效 cookie 被放行', res.status === 200, res.status);

  // 10. 伪造 cookie -> 401
  res = await boardMiddleware(
    makeCtx(new Request('http://x/board/api', { headers: { Cookie: 'dboard=deadbeef' } }), {
      SUBMIT_TOKEN: TOKEN,
    }),
  );
  check('伪造 cookie 返回 401', res.status === 401, res.status);
}

/* ═══════════════ API ═══════════════ */

console.log('\n=== 留言板 API ===');
{
  const store = {};
  const env = { SUBMIT_TOKEN: TOKEN, IMAGES: makeR2(store) };

  // 1. 空列表
  let res = await boardApi(makeCtx(new Request('http://x/board/api'), env));
  let data = await res.json();
  check('空库返回空列表', res.status === 200 && data.items.length === 0, data);

  // 2. 提交
  res = await boardApi(
    makeCtx(
      postJSON({ name: '小明', body: '求今天的写真', cat: '求图', link: 'https://example.com/a' }),
      env,
    ),
  );
  data = await res.json();
  check('提交成功', res.status === 200 && data.ok === true, data);
  check('提交返回 id', !!data.id);
  check('提交返回作者令牌', !!data.authorToken);
  const authorToken = data.authorToken;
  const msgId = data.id;

  // 3. 读回来
  res = await boardApi(makeCtx(new Request('http://x/board/api'), env));
  data = await res.json();
  check('能读回留言', data.items.length === 1, data.items);
  check('留言内容正确', data.items[0] && data.items[0].body === '求今天的写真');
  check('栏目正确', data.items[0] && data.items[0].cat === '求图');
  check('链接正确', data.items[0] && data.items[0].link === 'https://example.com/a');

  // 4. 没带作者令牌时 mine 应为 false
  check('未带作者令牌时 mine=false', data.items[0].mine === false);

  // 5. 带作者令牌时 mine 应为 true
  res = await boardApi(
    makeCtx(new Request('http://x/board/api', { headers: { 'x-author-token': authorToken } }), env),
  );
  data = await res.json();
  check('带作者令牌时 mine=true', data.items[0].mine === true);

  // 6. 空内容 -> 400
  res = await boardApi(makeCtx(postJSON({ body: '   ' }), env));
  check('空留言返回 400', res.status === 400, res.status);

  // 7. 伪协议外链被丢掉
  res = await boardApi(
    makeCtx(postJSON({ body: 'x', link: 'javascript:alert(1)' }), env),
  );
  data = await res.json();
  res = await boardApi(makeCtx(new Request('http://x/board/api'), env));
  let all = (await res.json()).items;
  const jsItem = all.find((it) => it.body === 'x');
  check('javascript: 外链被清空', jsItem && jsItem.link === '', jsItem);

  // 8. 跨站 Origin -> 403
  res = await boardApi(
    makeCtx(postJSON({ body: 'csrf' }, { Origin: 'http://evil.example' }), env),
  );
  check('跨站 Origin 返回 403', res.status === 403, res.status);

  // 9. 同站 Origin -> 放行
  res = await boardApi(
    makeCtx(postJSON({ body: 'same origin ok' }, { Origin: 'http://x' }), env),
  );
  check('同站 Origin 放行', res.status === 200, res.status);

  // 10. 删自己的留言 -> 成功
  res = await boardApi(
    makeCtx(postJSON({ action: 'delete', id: msgId, authorToken }), env),
  );
  check('删除自己的留言成功', res.status === 200, res.status);

  // 11. 删不存在的 / 不是自己的 -> 404
  res = await boardApi(
    makeCtx(postJSON({ action: 'delete', id: msgId, authorToken: 'someone-else' }), env),
  );
  check('用别人的令牌删除返回 404', res.status === 404, res.status);

  // 12. 没有 R2 绑定 -> 503
  res = await boardApi(makeCtx(new Request('http://x/board/api'), { SUBMIT_TOKEN: TOKEN }));
  check('没有 R2 绑定返回 503', res.status === 503, res.status);
}

console.log('\n=== 留言板 API：限流 ===');
{
  const store = {};
  const env = { SUBMIT_TOKEN: TOKEN, IMAGES: makeR2(store) };
  const ip = { 'CF-Connecting-IP': '1.2.3.4' };

  let last = null;
  for (let i = 0; i < 3; i++) {
    last = await boardApi(
      makeCtx(postJSON({ body: '第 ' + i + ' 条' }, ip), env),
    );
  }
  check('一分钟内前 3 条放行', last.status === 200, last.status);

  const fourth = await boardApi(makeCtx(postJSON({ body: '第 4 条' }, ip), env));
  check('一分钟内第 4 条被限流（429）', fourth.status === 429, fourth.status);
  check('429 带 Retry-After', !!fourth.headers.get('retry-after'));

  // 换个 IP 就不受影响
  const other = await boardApi(
    makeCtx(postJSON({ body: '别的 IP' }, { 'CF-Connecting-IP': '5.6.7.8' }), env),
  );
  check('换个 IP 不受影响', other.status === 200, other.status);
}

console.log('\n=== 留言板 API：并发提交不能互相覆盖 ===');
{
  const store = {};
  const env = { SUBMIT_TOKEN: TOKEN, IMAGES: makeR2(store) };

  // 5 条同时提交。etag 乐观锁会让冲突的那几个重读重写，
  // 结果应该是 5 条全在 —— 一条都不能丢。
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      boardApi(makeCtx(postJSON({ body: '并发 ' + i }), env)),
    ),
  );
  check('5 条并发提交全部成功', results.every((r) => r.status === 200), results.map((r) => r.status));

  /* 护栏：乐观锁真的会撞上冲突吗？
     如果 mock 去掉 2ms 延迟，这 5 个请求会被同步体天然串行化，
     一次冲突都不会有 —— 那「一条都没丢」就永远绿，变成假护栏
     （跟当初 likes 侧被评审挑出的 I1 是同一类）。
     所以必须断言「冲突真的发生过」，否则上面那条断言没有牙齿。 */
  check(
    '并发时真的撞上了 etag 冲突（否则上面那条是假护栏）',
    env.IMAGES.stats.conflicts > 0,
    env.IMAGES.stats.conflicts,
  );

  const res = await boardApi(makeCtx(new Request('http://x/board/api'), env));
  const data = await res.json();
  check('5 条并发提交一条都没丢', data.items.length === 5, data.items.length);
  const bodies = data.items.map((i) => i.body).sort();
  check(
    '5 条内容各不相同',
    new Set(bodies).size === 5,
    bodies,
  );
}

console.log('\n=== 留言板 API：内容边界 ===');
{
  const store = {};
  const env = { SUBMIT_TOKEN: TOKEN, IMAGES: makeR2(store) };

  // 超长正文被截断
  await boardApi(makeCtx(postJSON({ body: 'x'.repeat(5000) }), env));
  let res = await boardApi(makeCtx(new Request('http://x/board/api'), env));
  let item = (await res.json()).items[0];
  check('超长正文被截断到 2000 字', item.body.length === 2000, item.body.length);

  // 非法的栏目值被忽略
  await boardApi(makeCtx(postJSON({ body: 'y', cat: '<script>alert(1)</script>' }), env));
  res = await boardApi(makeCtx(new Request('http://x/board/api'), env));
  item = (await res.json()).items[0];
  check('非法栏目被忽略', item.cat === '', item.cat);

  // 昵称超长被截断
  await boardApi(makeCtx(postJSON({ body: 'z', name: 'n'.repeat(100) }), env));
  res = await boardApi(makeCtx(new Request('http://x/board/api'), env));
  item = (await res.json()).items[0];
  check('超长昵称被截断到 40 字', item.name.length === 40, item.name.length);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
