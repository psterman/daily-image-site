/**
 * 点赞接口 Pages Functions 单元测试
 *
 * workerd 在本机因 VC++ 运行库问题崩溃，跑不了 wrangler pages dev，
 * 所以直接用 Node 的 Web API（Request/Response/Headers/crypto.subtle）模拟 Cloudflare 运行时。
 * mock R2 与留言板测试共用 tools/r2-mock.mjs —— 那份 mock 严格按官方契约实现，
 * 冲突会真的发生，所以并发用例测得到乐观锁。
 */
import { onRequest as likesApi } from '../functions/likes/api.js';
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

const DATE = '2026-11-03';
const ID = 'jianxiao_012';
const VISITOR = 'a1b2c3d4e5f60718';

function makeCtx(request, store, opts) {
  const bucket = makeR2(store, opts);
  return { request, env: { IMAGES: bucket }, bucket };
}

function getReq(date) {
  return new Request(`http://x/likes/api?date=${date}`);
}

function postReq(body, headers) {
  return new Request('http://x/likes/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-daily-visitor': VISITOR, ...(headers || {}) },
    body: JSON.stringify(body),
  });
}

async function main() {
  const store = {};

  console.log('\n── 基本点赞 ──');
  {
    const r = await likesApi(makeCtx(postReq({ date: DATE, id: ID, on: true }), store));
    const j = await r.json();
    check('首次点赞返回 200', r.status === 200, r.status);
    check('首次点赞 count = 1', j.count === 1, j);
    check('首次点赞 on = true', j.on === true, j);
  }
  {
    // 同一个访客重复赞 —— 幂等，不能变成 2
    const r = await likesApi(makeCtx(postReq({ date: DATE, id: ID, on: true }), store));
    const j = await r.json();
    check('同一访客重复点赞 count 仍为 1', j.count === 1, j);
  }
  {
    const r = await likesApi(makeCtx(postReq({ date: DATE, id: ID, on: false }), store));
    const j = await r.json();
    check('取消点赞 count = 0', j.count === 0, j);
  }
  {
    const r = await likesApi(makeCtx(postReq({ date: DATE, id: ID, on: false }), store));
    const j = await r.json();
    check('重复取消仍为 0（幂等）', j.count === 0, j);
  }
  {
    const r = await likesApi(makeCtx(postReq({ date: DATE, id: ID, on: true }), store));
    const j = await r.json();
    check('重新点赞 count = 1', j.count === 1, j);
  }

  console.log('\n── 换一个访客 ──');
  {
    const r = await likesApi(
      makeCtx(postReq({ date: DATE, id: ID, on: true }, { 'x-daily-visitor': 'ffffffffffffffff' }), store),
    );
    const j = await r.json();
    check('换访客点赞 count = 2', j.count === 2, j);
  }

  console.log('\n── 读取计数 ──');
  {
    const r = await likesApi(makeCtx(getReq(DATE), store));
    const j = await r.json();
    check('GET 返回 200', r.status === 200, r.status);
    check('GET counts 含该图', j.counts && j.counts[ID] === 2, j);
    check('GET 可缓存', (r.headers.get('Cache-Control') || '').includes('max-age=30'), r.headers.get('Cache-Control'));
    // 不要只查 mine / voters 两个具体键名 —— 换个名字就漏了。
    // 「不含任何访客相关字段」的判据是：整个响应里找不到访客 id 本体。
    check(
      'GET 不含访客字段',
      !JSON.stringify(j).includes(VISITOR) && !JSON.stringify(j).includes('voters'),
      j,
    );
  }
  {
    const r = await likesApi(makeCtx(getReq('2026-11-02'), store));
    const j = await r.json();
    check('GET 别的日期 counts 为空', j.counts && Object.keys(j.counts).length === 0, j);
  }
  {
    const r = await likesApi(makeCtx(getReq('不是日期'), store));
    check('GET 非法日期 → 400', r.status === 400, r.status);
  }

  console.log('\n── 参数校验 ──');
  {
    const r = await likesApi(makeCtx(postReq({ date: '2026/11/03', id: ID, on: true }), store));
    check('非法 date → 400', r.status === 400, r.status);
  }
  {
    const r = await likesApi(makeCtx(postReq({ date: DATE, id: '../../etc/passwd', on: true }), store));
    check('非法 id → 400', r.status === 400, r.status);
  }
  {
    // 注意：这里必须用纯 ASCII 的非法值。
    // HTTP 头值是 ByteString，塞中文会让 Node 的 undici 在构造 Request 时
    // 直接抛 TypeError，测试会崩在构造请求上，根本走不到断言。
    const r = await likesApi(makeCtx(postReq({ date: DATE, id: ID, on: true }, { 'x-daily-visitor': 'nothex' }), store));
    check('非法 visitor → 400', r.status === 400, r.status);
  }
  {
    const r = await likesApi(
      makeCtx(new Request('http://x/likes/api', { method: 'DELETE' }), store),
    );
    check('非 GET/POST → 405', r.status === 405, r.status);
  }

  console.log('\n── CSRF ──');
  {
    const r = await likesApi(
      makeCtx(postReq({ date: DATE, id: ID, on: true }, { Origin: 'http://evil.example.com' }), store),
    );
    check('跨站 Origin → 403', r.status === 403, r.status);
  }
  {
    const r = await likesApi(
      makeCtx(postReq({ date: DATE, id: ID, on: true }, { Origin: 'http://x' }), store),
    );
    check('同站 Origin → 放行', r.status === 200, r.status);
  }

  console.log('\n── 评论计数随 GET 一起返回 ──');
  {
    store['board/messages.json'] = JSON.stringify({
      items: [
        { id: 'm1', imgDate: DATE, imgId: ID },
        { id: 'm2', imgDate: DATE, imgId: ID },
        { id: 'm3', imgDate: '2026-11-02', imgId: ID },
        { id: 'm4' },
      ],
    });
    const r = await likesApi(makeCtx(getReq(DATE), store));
    const j = await r.json();
    check('该图评论数 = 2', j.comments && j.comments[ID] === 2, j);
  }

  console.log('\n── 存储形状 ──');
  {
    const raw = JSON.parse(store['likes/' + DATE + '.json']);
    check('voters 里只存哈希不存原始 vid', !JSON.stringify(raw).includes(VISITOR), raw);
    check('voters 列表非空', Array.isArray(raw.voters[ID]) && raw.voters[ID].length >= 2, raw);
  }

  console.log('\n── 并发点赞不丢 ──');
  {
    // 单独一个 store：前面的用例已经攒了一些限流命中，别互相干扰
    const cStore = {};
    const N = 6;
    const CONC = 'jianwen_001';
    const posts = [];
    // 6 个并发请求必须共用**同一个** mock 实例 —— 真实的 R2 就是一个 bucket。
    // 各用各的 mock 的话，stats 是分开计的，断言只能看到「最后一个请求」的计数，
    // 不是整场竞争 —— 实测最后那个请求有约 1/6 的概率一次冲突都没撞上 → 假红。
    const cBucket = makeR2(cStore);
    for (let i = 0; i < N; i++) {
      const vid = ('000000000000000' + i.toString(16)).slice(-16);
      posts.push(
        likesApi({
          request: postReq({ date: DATE, id: CONC, on: true }, { 'x-daily-visitor': vid }),
          env: { IMAGES: cBucket },
        }),
      );
    }
    const results = await Promise.all(posts);
    const statuses = results.map((r) => r.status);
    check('并发点赞全部返回 200', statuses.every((s) => s === 200), statuses);
    const raw = JSON.parse(cStore['likes/' + DATE + '.json']);
    check('并发后计数 = ' + N + '（没有互相覆盖）', raw.counts && raw.counts[CONC] === N, raw.counts);
    // 关键：必须真的撞上过冲突，否则这条断言是假护栏。
    // 初版 mock 没有延迟，6 个请求被天然串行化，实测 12 次写、0 次冲突 ——
    // 把乐观锁整个删掉，这条断言照样通过。
    check('并发时真的撞上了 etag 冲突（否则断言是假护栏）', cBucket.stats.conflicts > 0, cBucket.stats);
  }

  console.log('\n── 单图点赞人数上限 ──');
  {
    // MAX_VOTERS_PER_IMAGE = 500。用不同 IP 绕过限流（限流是按 IP 算的），
    // delayMs 0 是因为这里是顺序跑的、不需要制造并发窗口。
    const capStore = {};
    let last = null;
    let got409 = false;
    for (let i = 0; i < 501; i++) {
      // 必须是**正好 16 位**小写 hex —— VISITOR_RE 是 /^[0-9a-f]{16}$/。
      // 别用 '前缀' + i.toString(16) 再 slice(-16)：i < 16 时整个串只有 15 位，
      // 会全部被判成非法访客（400），计数永远到不了上限。
      const vid = i.toString(16).padStart(16, '0');
      const ip = { 'CF-Connecting-IP': '10.0.' + Math.floor(i / 256) + '.' + (i % 256) };
      const ctx = makeCtx(
        postReq({ date: DATE, id: 'jianxiao_099', on: true }, { 'x-daily-visitor': vid, ...ip }),
        capStore,
        { delayMs: 0 },
      );
      last = await likesApi(ctx);
      if (last.status === 409) {
        got409 = true;
        break;
      }
    }
    check('第 501 个访客点赞 → 409', got409, last && last.status);
    const raw = JSON.parse(capStore['likes/' + DATE + '.json']);
    check('撞上限时计数没有被误改', raw.counts['jianxiao_099'] === 500, raw.counts);
  }

  console.log('\n── 限流 ──');
  {
    // 又是独立的 store：限流是按 IP 哈希算的，mock 没有 CF-Connecting-IP，
    // 全部请求都算同一个 IP，所以这个 store 必须干净
    const rStore = {};
    let last = null;
    for (let i = 0; i < 31; i++) {
      last = await likesApi(makeCtx(postReq({ date: DATE, id: 'jianwen_002', on: true }), rStore));
    }
    check('一分钟内第 31 次 → 429', last.status === 429, last.status);
    check('429 带 Retry-After', !!last.headers.get('Retry-After'));
  }

  console.log('\n── R2 没绑定 ──');
  {
    const r = await likesApi({ request: getReq(DATE), env: {} });
    check('没绑定 R2 → 503', r.status === 503, r.status);
  }

  console.log('\n── 代码 bug 不能被伪装成 503 ──');
  {
    /* 写失败时，API 层必须区分两种情况：
         · 写冲突重试耗尽  -> 503「写入冲突，请稍后重试」（可重试语义）
         · 其它异常（键名写错、R2 调用挂了）-> **重新抛出去**，让它变成响亮的 500

       以前一律 catch 成 503。那是个「可重试」语义 —— 客户端会一直重试。
       真正的病因如果是代码 bug，伪装成 503 就等于把 bug 永久藏起来：
       用户看到「稍后重试」，日志里是干净的 503，没人查。
       本项目已经被「键名写错」坑过两次（likes 和 board 各一次 etagMatch）。 */
    const boomBucket = {
      async get() { return null; },
      async put() { throw new Error('模拟 R2 调用失败'); },
    };

    let threwLikes = null;
    try {
      await likesApi({ request: postReq({ date: DATE, id: ID, on: true }), env: { IMAGES: boomBucket } });
    } catch (e) { threwLikes = e; }
    check('点赞写入的非冲突异常被抛出（不是 503）', !!threwLikes, threwLikes && String(threwLikes.message));

    let threwBoard = null;
    try {
      await boardApi({
        request: new Request('http://x/board/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: 'x' }),
        }),
        env: { IMAGES: boomBucket },
      });
    } catch (e) { threwBoard = e; }
    check('留言板写入的非冲突异常被抛出（不是 503）', !!threwBoard, threwBoard && String(threwBoard.message));

    /* 而真正的「冲突耗尽」仍然应该是 503 —— 不能把两类都变成 500。
       造法：让 put 一直返回 null（前置条件不满足），
       mutate 重试 8 次后抛 R2_CONFLICT，API 应该回 503。 */
    const conflictBucket = {
      async get() { return null; },
      async put() { return null; },   // 官方契约：前置条件不满足时返回 null
    };
    const conflictRes = await likesApi({
      request: postReq({ date: DATE, id: ID, on: true }),
      env: { IMAGES: conflictBucket },
    });
    check('写冲突重试耗尽仍然是 503', conflictRes.status === 503, conflictRes.status);
  }

  console.log('\n── mock 遇到不认识的条件头必须抛错 ──');
  {
    /* mock 认不出来的 onlyIf 键 / 不支持的条件头，一律直接抛错 ——
       拼错键名要当场炸，不能悄悄退化成无条件写。
       这条行为以前没有测试覆盖，改动 mock 时容易在没人察觉的情况下改坏。 */
    const m = makeR2({});
    let err = null;
    try {
      await m.put('k', 'v', { onlyIf: { etagMatch: 'abc' } });
    } catch (e) { err = e; }
    check('mock 遇到未实现的 onlyIf 键抛错', !!err, err && String(err.message));
    check('mock 的报错文案不含 precondition / 412（别被当成冲突吞掉）',
      !!err && !/precondition|412/i.test(String(err.message)), err && String(err.message));

    let err2 = null;
    try {
      await m.put('k', 'v', { onlyIf: new Headers({ 'If-None-Match': '*', 'If-Match': 'abc' }) });
    } catch (e) { err2 = e; }
    check('mock 遇到不支持的条件头抛错', !!err2, err2 && String(err2.message));
    check('mock 的条件头报错提到具体是哪个头', !!err2 && /if-match/i.test(String(err2.message)), err2 && String(err2.message));
  }

  console.log('\n── 留言板：跟图评论字段 ──');
  {
    const boardStore = {};
    const boardCtx = (request) => ({ request, env: { IMAGES: makeR2(boardStore) } });

    // 合法三件套
    {
      const r = await boardApi(
        boardCtx(
          new Request('http://x/board/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              body: '这张图绝了',
              imgDate: DATE,
              imgId: ID,
              imgThumb: '/img/2026-11-03/jianxiao/ab12cd34ef_012_t.webp',
            }),
          }),
        ),
      );
      check('带图字段投稿 → 200', r.status === 200, r.status);
    }
    {
      const r = await boardApi(boardCtx(new Request('http://x/board/api')));
      const j = await r.json();
      const it = j.items && j.items[0];
      check('GET 回传 imgDate', it && it.imgDate === DATE, it);
      check('GET 回传 imgId', it && it.imgId === ID, it);
      check('GET 回传 imgThumb', it && it.imgThumb === '/img/2026-11-03/jianxiao/ab12cd34ef_012_t.webp', it);
    }
    // 老留言（没有图字段）不受影响
    {
      const r = await boardApi(
        boardCtx(
          new Request('http://x/board/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: '普通留言' }),
          }),
        ),
      );
      check('普通留言仍能提交 → 200', r.status === 200, r.status);
      const g = await boardApi(boardCtx(new Request('http://x/board/api')));
      const j = await g.json();
      const plain = j.items && j.items.find((x) => x.body === '普通留言');
      check('普通留言图字段为空', plain && plain.imgId === '' && plain.imgThumb === '', plain);
    }
    // 伪造的缩略图必须被挡
    const badThumbs = [
      'https://evil.example.com/x.png',
      '/img/2026-11-03/jianxiao/../../secret.png',
      'javascript:alert(1)',
      '/img/2026-11-03/jianxiao/ab12cd34ef_012.webp',
      '/img/2026-11-03/JIANXIAO/ab12cd34ef_012_t.webp',
    ];
    for (const bt of badThumbs) {
      const r = await boardApi(
        boardCtx(
          new Request('http://x/board/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: 'x', imgDate: DATE, imgId: ID, imgThumb: bt }),
          }),
        ),
      );
      check(`伪造缩略图被拒 → 400：${bt}`, r.status === 400, r.status);
    }
    // 只给一部分 → 400
    {
      const r = await boardApi(
        boardCtx(
          new Request('http://x/board/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: 'x', imgDate: DATE }),
          }),
        ),
      );
      check('只给 imgDate → 400', r.status === 400, r.status);
    }

    // ── 白名单边界：行为已经是对的，但以前没锁进仓库 ──────────
    // 评审指出：这些组合的行为当时是对的（评审用 44 组探针实测过），
    // 但没有一条断言锁住 —— 以后改代码就可能静默改掉行为。
    // 这里把边界钉死。

    const THUMB = '/img/2026-11-03/jianxiao/ab12cd34ef_012_t.webp';
    /* 新加的用例全部用同一个独立 IP（'9.9.9.8'）——
       否则它们跟本节已有的成功投稿抢同一份额流配额，
       配额用光之后后面的断言会拿到 429，看起来像是「行为变了」，
       其实是配额被前面的用例吃光了。 */
    const IP = '9.9.9.8';
    const postImg = async (payload) => {
      const r = await boardApi({
        request: new Request('http://x/board/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
          body: JSON.stringify(payload),
        }),
        env: { IMAGES: makeR2(boardStore) },
      });
      return r;
    };

    // 2-of-3：给两个也必须 400（要么都不给，要么都给）
    const twoOf3 = [
      ['imgDate+imgId', { imgDate: DATE, imgId: ID }],
      ['imgDate+imgThumb', { imgDate: DATE, imgThumb: THUMB }],
      ['imgId+imgThumb', { imgId: ID, imgThumb: THUMB }],
    ];
    for (const [label, part] of twoOf3) {
      const r = await postImg(Object.assign({ body: 'x' }, part));
      check(`只给两件套（${label}）→ 400`, r.status === 400, r.status);
    }

    // 大小写 / URL 编码穿越 / 畸形日期
    const badValues = [
      ['大写栏目', { imgDate: DATE, imgId: 'JIANXIAO_012', imgThumb: THUMB }],
      ['月份不补零', { imgDate: '2026-1-03', imgId: ID, imgThumb: THUMB }],
      ['月份 13', { imgDate: '2026-13-03', imgId: ID, imgThumb: THUMB }],
      ['日期多一段', { imgDate: 'x2026-11-03', imgId: ID, imgThumb: THUMB }],
      // 注意：'2026-11-03x' 这种「前 10 个字符正好是合法日期」的会**被截断成合法日期**然后放行
      // —— 这是 clip() 的统一行为（正文截到 2000、昵称截到 40，同一个道理），不是漏洞。
      ['URL 编码穿越', { imgDate: DATE, imgId: 'jianxiao_012', imgThumb: '/img/2026-11-03/jianxiao/%2e%2e%2f%2e%2e/x_t.webp' }],
      ['序号 4 位', { imgDate: DATE, imgId: 'jianxiao_0123', imgThumb: THUMB }],
      ['栏目名超长', { imgDate: DATE, imgId: 'averyveryverylongcolumnname_012', imgThumb: THUMB }],
    ];
    for (const [label, part] of badValues) {
      const r = await postImg(Object.assign({ body: 'x' }, part));
      check(`非法三件套（${label}）→ 400`, r.status === 400, r.status);
    }

    // 0 / false 算「给了」但格式不对 → 400
    for (const [label, v] of [['0', 0], ['false', false]]) {
      const r = await postImg({ body: 'x', imgDate: v, imgId: ID, imgThumb: THUMB });
      check(`imgDate = ${label} → 400`, r.status === 400, r.status);
    }

    // 三件套互相矛盾（各自格式都合法，但内容对不上）→ 400
    const mismatched = [
      ['日期对不上', { imgDate: DATE, imgId: ID, imgThumb: '/img/2026-10-25/jianxiao/ab12cd34ef_012_t.webp' }],
      ['栏目对不上', { imgDate: DATE, imgId: ID, imgThumb: '/img/2026-11-03/jianwen/ab12cd34ef_012_t.webp' }],
      ['序号对不上', { imgDate: DATE, imgId: ID, imgThumb: '/img/2026-11-03/jianxiao/ab12cd34ef_013_t.webp' }],
    ];
    for (const [label, part] of mismatched) {
      const r = await postImg(Object.assign({ body: 'x' }, part));
      check(`三件套自相矛盾（${label}）→ 400`, r.status === 400, r.status);
    }

    // 三个都 null = 「没给图字段」→ 当成普通留言放行（不是 400）
    {
      const r = await boardApi({
        request: new Request('http://x/board/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' },
          body: JSON.stringify({ body: '三个都 null', imgDate: null, imgId: null, imgThumb: null }),
        }),
        env: { IMAGES: makeR2(boardStore) },
      });
      check('三个图字段都是 null → 当普通留言放行', r.status === 200, r.status);
    }
    // 非法 id
    {
      const r = await boardApi(
        boardCtx(
          new Request('http://x/board/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              body: 'x',
              imgDate: DATE,
              imgId: '../../etc/passwd',
              imgThumb: '/img/2026-11-03/jianxiao/ab12cd34ef_012_t.webp',
            }),
          }),
        ),
      );
      check('非法 imgId → 400', r.status === 400, r.status);
    }
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
