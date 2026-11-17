#!/usr/bin/env node
/**
 * 榜单抓取 v2 的单元测试（**离线** —— 一行外网都不碰）
 *
 * 用法：node tools/test-fetch-rank.mjs
 * 退出码：0 = 全过；1 = 有失败
 *
 * 为什么必须离线：这个工具是构建期抓外部源的，源天天在变（榜单会换、
 * 豆瓣会改 HTML、CDN 会改防盗链策略）。护栏要是每次都联网，
 * 「今天源挂了就红」和「今天代码坏了」根本分不开 —— 所以 fixture 一律内联。
 *
 * 离线怎么做到：
 *   本测试在本机起一个 fixture server（随机空闲端口），
 *   把 fetch-rank.mjs 的基址环境变量指过去（FETCH_RANK_*_BASE），
 *   生产代码就能在**不联网**的情况下吃到假数据。
 *   抓取层的行为（重定向、重试、Referer、单源失败隔离）验的是真代码路径。
 *
 * fixture 是 2026-11-16 从线上原样截下来的形状（真实 HTML / JSON 片段），
 * 里面保留了几个**故意埋的坑**：
 *   · 网易云 / B站封面全是 http://（必须换 https://）
 *   · 猫眼 img 带原有 query（裁图参数必须整段替换掉）
 *   · 豆瓣 /coming 是表格（表头行是 <th>，不是电影）
 *   · 猫眼和豆瓣有同一部片（片名去重）
 *   · 有一个网易云榜是停更老榜（要跳过、且不能进 errors）
 */
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ─────────────────────────── 本机 fixture server ───────────────────────────
 *
 * 必须在 import 被测模块**之前**把基址写进环境变量 ——
 * fetch-rank.mjs 在模块顶层读一次基址（跟 fetch-follow.mjs 一个做法）。
 */

const NOW = Date.parse('2026-11-16T00:00:00.000Z');
const DAY = 86400000;

/** 服务器状态：测试靠改它来模拟「某源挂了 / 某源改版了 / 某接口返回 code≠0」 */
const state = {
  fail: new Set(),        // 源 key → 整个源返回 404
  broken: new Set(),      // 源 key → 返回有数据但解析不出条目（模拟改版）
  biliCode: 0,            // B站接口 code
  staleNeteaseIds: new Set([5338990334]), // 停更老榜（最后更新 = 60 天前）
  requests: [],           // 收到的请求（用来断言 Referer）
};

function neteasePayload(id) {
  if (state.broken.has('netease')) {
    /* 源还活着，但字段全变了 —— 解析出来 0 条 */
    return { code: 200, result: { tracks: [{ id: 1, name: '' }, { id: 2, name: '' }] } };
  }
  const stale = state.staleNeteaseIds.has(Number(id));
  return {
    code: 200,
    result: {
      updateTime: stale ? NOW - 60 * DAY : NOW - 1 * DAY,
      tracks: Array.from({ length: 60 }, (_, i) => ({
        id: 1000000 + i,
        name: `测试歌曲 ${i + 1}`,
        artists: [{ name: '歌手甲' }, { name: '歌手乙' }],
        album: { name: `测试专辑 ${i + 1}`, picUrl: `http://p2.music.126.net/cover${i}.jpg` },
      })),
    },
  };
}

const APPLE_OK = {
  feed: {
    results: [
      {
        name: 'APT.',
        artistName: 'ROSÉ & Bruno Mars',
        albumName: 'APT',
        artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/aaa/100x100bb.jpg',
        url: 'https://music.apple.com/us/song/apt/1001',
      },
      {
        name: 'Die With A Smile',
        artistName: 'Lady Gaga & Bruno Mars',
        albumName: 'DIE WITH A SMILE',
        artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/bbb/100x100bb.jpg',
        url: 'https://music.apple.com/us/song/die-with-a-smile/1002',
      },
    ],
  },
};

const MAOYAN_HOT_OK = {
  data: {
    hot: [
      {
        id: 1500000,
        nm: '肖申克的救赎',
        sc: 9.3,
        star: '蒂姆·罗宾斯 / 摩根·弗里曼',
        showInfo: '今日排片 12.3万',
        wish: 1234567,
        rt: '1994-09-10',
        globalReleased: true,
        /* ⚠️ 带着原有的 query —— 裁图参数必须整段替换掉 */
        img: 'https://p0.pipi.cn/maoyan/hot1.jpg?imageView2/1/w/200',
      },
      {
        id: 1500001,
        nm: '未上映的新片',
        sc: 0,
        star: '演员甲',
        showInfo: '11月20日上映',
        wish: 2345,
        rt: '2026-11-20',
        globalReleased: false,
        img: 'https://p0.pipi.cn/maoyan/hot2.jpg',
      },
    ],
  },
};

const MAOYAN_COMING_OK = {
  coming: [
    {
      id: 1600000, nm: '猫眼新片一', star: '演员乙', sc: 0, wish: 888,
      showInfo: '11月25日上映', rt: '2026-11-25', globalReleased: false,
      img: 'https://p0.pipi.cn/maoyan/coming1.jpg',
    },
    {
      id: 1600001, nm: '猫眼新片二', star: '演员丙', sc: 0, wish: 666,
      showInfo: '11月22日上映', rt: '2026-11-22', globalReleased: false,
      img: 'https://p0.pipi.cn/maoyan/coming2.jpg',
    },
  ],
  movieIds: [1600000, 1600001],
};

/** 豆瓣「即将上映」表格页：表头行是 <th>（不是电影），第 1 行跟猫眼撞片名 */
const DOUBAN_COMING_OK = `<!DOCTYPE html>
<html><body>
<table class="release">
<tbody>
<tr class="head"><th>上映日期</th><th>影片</th><th>类型</th><th>制片国家地区</th><th>想看人数</th></tr>
<tr>
  <td>2026-11-22</td>
  <td><a href="https://movie.douban.com/subject/36000002/" title="猫眼新片二">猫眼新片二</a></td>
  <td>剧情 / 动作</td>
  <td>中国大陆</td>
  <td>1234人 想看</td>
</tr>
<tr>
  <td>2026-11-18</td>
  <td><a href="https://movie.douban.com/subject/36000003/" title="豆瓣新片甲">豆瓣新片甲</a></td>
  <td>喜剧</td>
  <td>中国香港</td>
  <td>876人 想看</td>
</tr>
<tr>
  <td>2026-11-30</td>
  <td><a href="https://movie.douban.com/subject/36000004/" title="豆瓣新片乙">豆瓣新片乙</a></td>
  <td>悬疑 / 惊悚</td>
  <td>美国</td>
  <td>2050人 想看</td>
</tr>
</tbody>
</table>
</body></html>`;

const BILI_OK = {
  code: 0,
  message: '0',
  data: {
    list: [
      {
        title: '【伪纪录片】镜 化',
        pic: 'http://i1.hdslb.com/bfs/archive/aaa.jpg',
        bvid: 'BV1Uesp6yEsM',
        owner: { name: '虚构柠檬' },
        stat: { view: 509587 },
      },
      {
        title: '【2026全球总决赛】GEN vs BLG',
        pic: 'http://i1.hdslb.com/bfs/archive/bbb.jpg',
        bvid: 'BV15es76gEgL',
        owner: { name: '哔哩哔哩英雄联盟赛事' },
        stat: { view: 22613881 },
      },
    ],
  },
};

const DOUYIN_OK = {
  word_list: [
    { word: '高温预警', hot_value: 5200000, label: 1 },
    { word: '秋天的第一杯奶茶', hot_value: 4800000, label: 0 },
  ],
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  state.requests.push({ path: u.pathname, query: u.search, headers: { ...req.headers } });
  const p = u.pathname;

  const send = (status, body, type) => {
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length });
    res.end(buf);
  };
  const json = (obj) => send(200, JSON.stringify(obj), 'application/json');
  const missing = () => send(404, 'not found', 'text/plain');

  if (p === '/api/playlist/detail') {
    if (state.fail.has('netease')) return missing();
    return json(neteasePayload(u.searchParams.get('id')));
  }
  if (p === '/api/v2/us/music/most-played/30/songs.json') {
    if (state.fail.has('apple')) return missing();
    return json(APPLE_OK);
  }
  if (p === '/mmdb/movie/v5/list/hot.json') {
    if (state.fail.has('maoyanHot')) return missing();
    return json(MAOYAN_HOT_OK);
  }
  if (p === '/ajax/comingList') {
    if (state.fail.has('maoyanComing')) return missing();
    return json(MAOYAN_COMING_OK);
  }
  if (p === '/coming') {
    if (state.fail.has('douban')) return missing();
    return send(200, DOUBAN_COMING_OK, 'text/html; charset=utf-8');
  }
  if (p === '/x/web-interface/popular') {
    if (state.fail.has('bili')) return missing();
    if (state.broken.has('bili')) return json({ code: 0, data: { list: [] } });
    return json(state.biliCode ? { code: state.biliCode, message: '风控', data: null } : BILI_OK);
  }
  if (p === '/web/api/v2/hotsearch/billboard/word/') {
    if (state.fail.has('douyin')) return missing();
    return json(DOUYIN_OK);
  }
  return missing();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* 把基址指到本机 fixture server —— 生产代码这一行都改不了。 */
process.env.FETCH_RANK_NETEASE_BASE = BASE;
process.env.FETCH_RANK_APPLE_BASE = BASE;
process.env.FETCH_RANK_MAOYAN_BASE = BASE;
process.env.FETCH_RANK_MAOYAN_M_BASE = BASE;
process.env.FETCH_RANK_DOUBAN_BASE = BASE;
process.env.FETCH_RANK_BILI_BASE = BASE;
process.env.FETCH_RANK_DOUYIN_BASE = BASE;

// 变异测试入口：FETCH_RANK 指向别的文件时，本护栏就对着那个文件跑
// （这样验「护栏能抓住坏版本」不用碰真文件）。
const modUrl = process.env.FETCH_RANK
  ? pathToFileURL(path.resolve(__dirname, process.env.FETCH_RANK)).href
  : new URL('./fetch-rank.mjs', import.meta.url).href;

const mod = await import(modUrl);
const {
  toHttps,
  formatCount,
  maoyanCover,
  releaseSortKey,
  parseNeteaseChart,
  parseAppleFeed,
  parseMaoyan,
  parseDoubanComing,
  parseBiliPopular,
  parseDouyinHot,
  dedupeByTitle,
  sortMovieItems,
  buildRankPayload,
  rankFilePath,
  assertParsed,
  verifyCovers,
  fetchRank,
  NETEASE_CHARTS,
  GROUP_LABEL,
} = mod;

/* ─────────────────────────── 测试骨架 ─────────────────────────── */

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  -> ' + extra : ''}`);
  }
}

function eq(name, actual, expected) {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`,
  );
}

/** fn 应该抛错；re 用来断言错误信息（可省） */
function throws(name, fn, re) {
  let err = null;
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    err = e;
  }
  const msg = String((err && err.message) || err || '');
  check(name, threw && (!re || re.test(msg)), threw ? `抛的是：${msg}` : '没有抛错');
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

/** tags 里的层号（解析不出来返回 null） */
function levelOf(tag) {
  const m = /^@(\d+):(.+)$/.exec(String(tag));
  return m ? Number(m[1]) : null;
}

function tagValue(tag) {
  const m = /^@(\d+):(.+)$/.exec(String(tag));
  return m ? m[2] : '';
}

/** 每个数组的 rank 是不是 1..N 连号 */
function rankSeq(arr) {
  return arr.every((it, i) => it.rank === i + 1);
}

/**
 * 跑一个 node 子进程（**异步**）。
 *
 * 为什么不能用 spawnSync：本机的 fixture server 就跑在**这个进程**里，
 * spawnSync 会把事件循环堵死 —— 子进程来要数据时没人应答，直接死锁。
 */
function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: env || process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 120000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/* ─────────────────────────── 1) 纯函数 ─────────────────────────── */

console.log('\n1) 纯函数');
{
  eq('toHttps：http 换成 https', toHttps('http://p2.music.126.net/a.jpg'), 'https://p2.music.126.net/a.jpg');
  eq('toHttps：https 原样返回', toHttps('https://p2.music.126.net/a.jpg'), 'https://p2.music.126.net/a.jpg');
  eq('toHttps：空串原样返回', toHttps(''), '');
  eq('toHttps：null 原样返回', toHttps(null), '');

  eq('formatCount：51万', formatCount(509587), '51万');
  eq('formatCount：2261.4万', formatCount(22613881), '2261.4万');
  eq('formatCount：1.2亿', formatCount(123456789), '1.2亿');
  eq('formatCount：0 → 空', formatCount(0), '');

  eq(
    '猫眼封面：带 crop/200x200 参数',
    maoyanCover('https://p0.pipi.cn/maoyan/a.jpg'),
    'https://p0.pipi.cn/maoyan/a.jpg?imageMogr2/thumbnail/200x200^/gravity/center/crop/200x200/quality/80',
  );
  check('猫眼封面：不含 thumbnail/!', !maoyanCover('https://p0.pipi.cn/maoyan/a.jpg').includes('thumbnail/!'));
  eq(
    '猫眼封面：原有 query 整段替换掉',
    maoyanCover('https://p0.pipi.cn/maoyan/a.jpg?imageView2/1/w/200'),
    'https://p0.pipi.cn/maoyan/a.jpg?imageMogr2/thumbnail/200x200^/gravity/center/crop/200x200/quality/80',
  );
  eq('猫眼封面：空图 → 空串', maoyanCover(''), '');

  eq('releaseSortKey：标准日期', releaseSortKey('2026-11-20'), '2026-11-20');
  eq('releaseSortKey：没日期排最后', releaseSortKey(''), '9999-99-99');

  eq('网易云榜单表：13 个榜', NETEASE_CHARTS.length, 13);
  eq(
    '网易云榜单表：分组是 cn/intl/scene',
    [...new Set(NETEASE_CHARTS.map((c) => c.group))],
    ['cn', 'intl', 'scene'],
  );
  eq('分组中文名固定', GROUP_LABEL, { cn: '中文榜', intl: '国际榜', scene: '场景榜' });
}

/* ─────────────────────────── 2) 解析器 ─────────────────────────── */

console.log('\n2) 解析器');
{
  const chart = { id: 3778678, label: '热歌榜', group: 'cn' };
  const raw = {
    result: {
      tracks: [
        {
          id: 1973665667,
          name: '海屿你',
          artists: [{ name: '马也_Crabbit' }, { name: '阿梨粤' }],
          album: { name: '海屿你', picUrl: 'http://p2.music.126.net/Enhy6dPn4gpyqrKhVEQvgA==/109951170483249998.jpg' },
        },
        {
          id: 287398,
          name: '我不难过',
          artists: [{ name: '孙燕姿' }],
          album: { name: '未完成', picUrl: 'http://p2.music.126.net/Pzxy6py26NgNmhJjYMf2RQ==/109951169724216323.jpg' },
        },
      ],
    },
  };
  const r = parseNeteaseChart(raw, chart);
  eq('网易云：解析出 2 条', r.length, 2);
  eq('网易云：歌名', r[0].title, '海屿你');
  eq('网易云：歌手用 / 连接', r[0].subtitle, '马也_Crabbit / 阿梨粤');
  eq('网易云：专辑当 meta', r[0].meta, '海屿你');
  eq(
    '网易云：封面 http 换成 https',
    r[0].cover,
    'https://p2.music.126.net/Enhy6dPn4gpyqrKhVEQvgA==/109951170483249998.jpg',
  );
  eq('网易云：外链格式', r[0].link, 'https://music.163.com/#/song?id=1973665667');
  eq('网易云：source = 网易云音乐', r[0].source, '网易云音乐');
  eq('网易云：tag = 热歌榜', r[0].tag, '热歌榜');
  eq('网易云：tags = @1:中文榜 + @2:热歌榜', r[0].tags, ['@1:中文榜', '@2:热歌榜']);
  eq('网易云：国际榜的 @1', parseNeteaseChart(raw, { label: 'Billboard', group: 'intl' })[0].tags[0], '@1:国际榜');
  eq('网易云：场景榜的 @1', parseNeteaseChart(raw, { label: '飙升榜', group: 'scene' })[0].tags[0], '@1:场景榜');
  eq('网易云：吃已解析的对象也行', parseNeteaseChart(JSON.stringify(raw), chart).length, 2);

  const a = parseAppleFeed(APPLE_OK);
  eq('Apple：解析出 2 条', a.length, 2);
  eq('Apple：歌名', a[0].title, 'APT.');
  eq('Apple：歌手当副标题', a[0].subtitle, 'ROSÉ & Bruno Mars');
  eq('Apple：专辑当 meta', a[0].meta, 'APT');
  eq(
    'Apple：封面 100x100bb → 200x200bb',
    a[0].cover,
    'https://is1-ssl.mzstatic.com/image/thumb/aaa/200x200bb.jpg',
  );
  eq('Apple：source = Apple Music', a[0].source, 'Apple Music');
  eq('Apple：tags = @1:国际榜 + @2:Apple Top Songs', a[0].tags, ['@1:国际榜', '@2:Apple Top Songs']);

  const m = parseMaoyan(MAOYAN_HOT_OK.data.hot);
  eq('猫眼：解析出 2 条', m.length, 2);
  eq('猫眼：片名', m[0].title, '肖申克的救赎');
  eq('猫眼：主演当副标题', m[0].subtitle, '蒂姆·罗宾斯 / 摩根·弗里曼');
  eq('猫眼：评分/想看/排片进 meta', m[0].meta, '9.3 分 · 1234567 人想看 · 今日排片 12.3万');
  eq('猫眼：globalReleased=true → 正在放映', m[0].tag, '正在放映');
  eq('猫眼：globalReleased=false → 近期即将上映', m[1].tag, '近期即将上映');
  eq('猫眼：tags = @1:电影 + @2:<tag>', m[1].tags, ['@1:电影', '@2:近期即将上映']);
  eq('猫眼：source = 猫眼', m[0].source, '猫眼');
  eq('猫眼：外链是 films/<id>', m[0].link, 'https://www.maoyan.com/films/1500000');
  check('猫眼：封面带裁图参数', m[0].cover.includes('crop/200x200'), m[0].cover);
  check('猫眼：封面不带 thumbnail/!', !m[0].cover.includes('thumbnail/!'), m[0].cover);

  const d = parseDoubanComing(DOUBAN_COMING_OK);
  eq('豆瓣 /coming：解析出 3 条（表头行不算）', d.length, 3);
  eq('豆瓣 /coming：片名', d[0].title, '猫眼新片二');
  eq('豆瓣 /coming：类型当副标题', d[0].subtitle, '剧情 / 动作');
  eq('豆瓣 /coming：meta 含上映日/地区/想看', d[0].meta, '2026-11-22 上映 · 中国大陆 · 1234 人想看');
  eq('豆瓣 /coming：封面留空', d[0].cover, '');
  eq('豆瓣 /coming：link 是 subject 链接', d[0].link, 'https://movie.douban.com/subject/36000002/');
  eq('豆瓣 /coming：source = 豆瓣', d[0].source, '豆瓣');
  eq('豆瓣 /coming：tag = 近期即将上映', d[0].tag, '近期即将上映');
  eq('豆瓣 /coming：tags = @1:电影 + @2:近期即将上映', d[0].tags, ['@1:电影', '@2:近期即将上映']);
  eq('豆瓣 /coming：空输入不炸', parseDoubanComing('').length, 0);

  const b = parseBiliPopular(BILI_OK);
  eq('B站：解析出 2 条', b.length, 2);
  eq('B站：标题', b[0].title, '【伪纪录片】镜 化');
  eq('B站：UP主当副标题', b[0].subtitle, '虚构柠檬');
  eq('B站：播放数进 meta', b[0].meta, '播放 51万');
  eq('B站：大播放量也进 meta', b[1].meta, '播放 2261.4万');
  eq(
    'B站：封面 http 换成 https',
    b[0].cover,
    'https://i1.hdslb.com/bfs/archive/aaa.jpg',
  );
  eq('B站：bvid 拼外链', b[0].link, 'https://www.bilibili.com/video/BV1Uesp6yEsM');
  eq('B站：source = 哔哩哔哩', b[0].source, '哔哩哔哩');
  eq('B站：tags = @1:B站热门（v3 起升为大目录，不再套一层「视频」壳）', b[0].tags, ['@1:B站热门']);

  const dy = parseDouyinHot(DOUYIN_OK);
  eq('抖音：解析出 2 条', dy.length, 2);
  eq('抖音：词当标题', dy[0].title, '高温预警');
  eq('抖音：热度进 meta', dy[0].meta, '热度 5200000');
  eq('抖音：封面留空', dy[0].cover, '');
  eq('抖音：link 是搜索页', dy[0].link, 'https://www.douyin.com/search/%E9%AB%98%E6%B8%A9%E9%A2%84%E8%AD%A6');
  eq('抖音：source = 抖音', dy[0].source, '抖音');
  eq('抖音：tags = @1:抖音热门（v3 起升为大目录，不再套一层「视频」壳）', dy[0].tags, ['@1:抖音热门']);
}

/* ─────────────────────────── 3) 输出契约 ─────────────────────────── */

console.log('\n3) 输出契约（前端和护栏都靠它）');
{
  const music = parseNeteaseChart(
    {
      result: {
        tracks: [
          { id: 1, name: '甲', artists: [], album: { name: '', picUrl: 'http://x/y.jpg' } },
          { id: 2, name: '乙', artists: [], album: { name: '', picUrl: 'http://x/z.jpg' } },
        ],
      },
    },
    { label: '热歌榜', group: 'cn' },
  );
  const movie = sortMovieItems(
    dedupeByTitle([
      ...parseMaoyan(MAOYAN_HOT_OK.data.hot),
      ...parseMaoyan(MAOYAN_COMING_OK.coming),
      ...parseDoubanComing(DOUBAN_COMING_OK),
    ]),
  );
  const video = [...parseBiliPopular(BILI_OK), ...parseDouyinHot(DOUYIN_OK)];

  const p = buildRankPayload({ music, movie, video, date: '2026-11-16' });

  eq('契约：顶层字段就这 6 个', Object.keys(p), ['date', 'generatedAt', 'music', 'movie', 'video', 'errors']);
  eq('契约：条目字段就这 9 个', Object.keys(p.music[0]), [
    'rank', 'title', 'subtitle', 'meta', 'cover', 'link', 'source', 'tag', 'tags',
  ]);
  eq('契约：三个数组的条目字段顺序一致', Object.keys(p.movie[0]), Object.keys(p.video[0] || {}));
  eq('契约：date', p.date, '2026-11-16');
  eq('契约：generatedAt 是当天零点', p.generatedAt, '2026-11-16T00:00:00.000Z');
  eq('契约：errors 默认空数组', p.errors, []);
  eq('契约：music 条数', p.music.length, 2);
  eq('契约：movie 条数', p.movie.length, 6);
  eq('契约：video 条数', p.video.length, 4);
  check('契约：video 数组非空', p.video.length > 0, `video=${p.video.length}`);

  check('契约：music rank 从 1 连号', rankSeq(p.music), JSON.stringify(p.music.map((x) => x.rank)));
  check('契约：movie rank 从 1 连号', rankSeq(p.movie), JSON.stringify(p.movie.map((x) => x.rank)));
  check('契约：video rank 从 1 连号', rankSeq(p.video), JSON.stringify(p.video.map((x) => x.rank)));

  const all = [...p.music, ...p.movie, ...p.video];
  check(
    '契约：每个条目 tags 非空',
    all.every((it) => Array.isArray(it.tags) && it.tags.length > 0),
  );
  check(
    '契约：tags 形如 @<数字>:<非空文字>',
    all.every((it) => it.tags.every((t) => /^@\d+:\S/.test(t))),
    JSON.stringify(all.flatMap((it) => it.tags).filter((t) => !/^@\d+:\S/.test(t)).slice(0, 3)),
  );
  check(
    '契约：每个条目恰好一个 @1 标签',
    all.every((it) => it.tags.filter((t) => levelOf(t) === 1).length === 1),
    JSON.stringify(all.filter((it) => it.tags.filter((t) => levelOf(t) === 1).length !== 1).slice(0, 2)),
  );
  check(
    '契约：tags 层号连续不跳号',
    all.every((it) => {
      const lv = [...new Set(it.tags.map(levelOf))].sort((x, y) => x - y);
      return lv.length > 0 && lv.every((n, i) => n === i + 1);
    }),
  );
  check(
    '契约：source ≠ tag',
    all.every((it) => it.source && it.tag && it.source !== it.tag),
    JSON.stringify(all.filter((it) => it.source === it.tag).slice(0, 2)),
  );
  /* v3：B站热门 / 抖音热门 升为 @1 大目录，「视频」这个壳去掉了。 */
  const KNOWN_L1 = ['中文榜', '国际榜', '场景榜', '电影', 'B站热门', '抖音热门'];
  check(
    '契约：@1 的值都在已知板块里',
    all.every((it) => KNOWN_L1.includes(tagValue(it.tags.find((t) => levelOf(t) === 1)))),
    JSON.stringify([...new Set(all.map((it) => tagValue(it.tags.find((t) => levelOf(t) === 1))))]),
  );
  check(
    '契约：所有 cover 要么空、要么 https 开头',
    all.every((it) => it.cover === '' || it.cover.startsWith('https://')),
    JSON.stringify(all.filter((it) => it.cover && !it.cover.startsWith('https://')).slice(0, 2)),
  );
  check(
    '契约：所有 link 要么空、要么 https 开头',
    all.every((it) => it.link === '' || it.link.startsWith('https://')),
    JSON.stringify(all.filter((it) => it.link && !it.link.startsWith('https://')).slice(0, 2)),
  );
  const maoyanCovers = p.movie.filter((it) => it.source === '猫眼').map((it) => it.cover);
  check(
    '契约：猫眼封面带 crop/200x200',
    maoyanCovers.length > 0 && maoyanCovers.every((c) => c.includes('crop/200x200')),
    JSON.stringify(maoyanCovers.slice(0, 2)),
  );
  check(
    '契约：猫眼封面不含 thumbnail/!',
    maoyanCovers.every((c) => !c.includes('thumbnail/!')),
    JSON.stringify(maoyanCovers.slice(0, 2)),
  );

  /* 「近期即将上映」里：有封面的必须排在无封面的前面 */
  const soon = p.movie.filter((it) => it.tag === '近期即将上映');
  const soonCovers = soon.map((it) => (it.cover ? 1 : 0));
  check(
    '契约：近期即将上映里，有封面的排在无封面的前面',
    soonCovers.length > 0 && soonCovers.every((v, i) => i === 0 || soonCovers[i - 1] >= v),
    JSON.stringify(soon.map((it) => `${it.title}:${it.cover ? '有图' : '无图'}`)),
  );
  eq(
    '契约：猫眼和豆瓣同名片只留一条',
    p.movie.filter((it) => it.title === '猫眼新片二').length,
    1,
  );
  eq(
    '契约：电影顺序（封面优先 + 上映日升序）',
    p.movie.map((it) => it.title),
    ['肖申克的救赎', '未上映的新片', '猫眼新片二', '猫眼新片一', '豆瓣新片甲', '豆瓣新片乙'],
  );

  /* 落盘路径 */
  const f = rankFilePath('2026-11-16');
  check('路径：落在 <date>/rank_<date>.json', f.endsWith(path.join('2026-11-16', 'rank_2026-11-16.json')), f);
  check('路径：绝对路径', path.isAbsolute(f), f);
  check('路径：用 path.join 拼（跨平台）', f.includes(path.sep), f);
}

/* ─────────────────────────── 4) 抓取层 ─────────────────────────── */

console.log('\n4) 抓取层（对着本机 fixture server，不联网）');
{
  const r = await fetchRank({ date: '2026-11-16', checkCovers: false, now: NOW });
  const p = r.payload;

  check('抓取：music 有条目', p.music.length > 0, `music=${p.music.length}`);
  check('抓取：movie 有条目', p.movie.length > 0, `movie=${p.movie.length}`);
  check('抓取：video 有条目', p.video.length > 0, `video=${p.video.length}`);
  eq('抓取：正常情况下 errors 为空', p.errors, []);
  eq('抓取：顶层 6 个字段', Object.keys(p), ['date', 'generatedAt', 'music', 'movie', 'video', 'errors']);
  check('抓取：music rank 从 1 连号', rankSeq(p.music));
  check('抓取：movie rank 从 1 连号', rankSeq(p.movie));
  check('抓取：video rank 从 1 连号', rankSeq(p.video));

  const all = [...p.music, ...p.movie, ...p.video];
  check('抓取：每条都有且只有一个 @1', all.every((it) => it.tags.filter((t) => levelOf(t) === 1).length === 1));
  check('抓取：source ≠ tag', all.every((it) => it.source !== it.tag));

  /* 每个网易云榜最多 50 条 */
  const perChart = new Map();
  for (const it of p.music) {
    const k = it.tags.filter((t) => levelOf(t) === 2).map(tagValue).join('/');
    perChart.set(k, (perChart.get(k) || 0) + 1);
  }
  check(
    '抓取：网易云每榜最多 50 条',
    [...perChart.entries()].every(([k, n]) => (k.startsWith('Apple') ? n <= 30 : n <= 50)),
    JSON.stringify([...perChart.entries()].filter(([k, n]) => n > 50)),
  );
  check(
    '抓取：停更老榜被跳过（不进 errors）',
    r.notes.some((n) => /停更老榜/.test(n)) && !r.payload.errors.some((e) => /停更/.test(e)),
    JSON.stringify(r.notes),
  );
  check(
    '抓取：停更老榜真的没进 music',
    !p.music.some((it) => it.tag === '潜力爆款'),
    JSON.stringify([...new Set(p.music.map((it) => it.tag))]),
  );

  /* Referer 要带对（豆瓣/猫眼挑食） */
  const refOf = (p2) => (state.requests.filter((x) => x.path === p2).slice(-1)[0] || {}).headers || {};
  check('抓取：网易云请求带 Referer', refOf('/api/playlist/detail').referer === 'https://music.163.com/',
    JSON.stringify(refOf('/api/playlist/detail').referer));
  check('抓取：猫眼热映榜带 Referer', refOf('/mmdb/movie/v5/list/hot.json').referer === 'https://www.maoyan.com/',
    JSON.stringify(refOf('/mmdb/movie/v5/list/hot.json').referer));
  check('抓取：猫眼 comingList 带 Referer', refOf('/ajax/comingList').referer === 'https://m.maoyan.com/',
    JSON.stringify(refOf('/ajax/comingList').referer));
  check('抓取：豆瓣 /coming 带 Referer', refOf('/coming').referer === 'https://movie.douban.com/',
    JSON.stringify(refOf('/coming').referer));
  check('抓取：B站请求带 Referer', refOf('/x/web-interface/popular').referer === 'https://www.bilibili.com/',
    JSON.stringify(refOf('/x/web-interface/popular').referer));
  check('抓取：抖音请求带 Referer', refOf('/web/api/v2/hotsearch/billboard/word/').referer === 'https://www.douyin.com/',
    JSON.stringify(refOf('/web/api/v2/hotsearch/billboard/word/').referer));

  /* 单源失败 → 进 errors，其它源照常 */
  state.fail.add('bili');
  const r2 = await fetchRank({ date: '2026-11-16', checkCovers: false, now: NOW });
  state.fail.delete('bili');
  check('抓取：单源失败 → 进 errors', r2.payload.errors.some((e) => /B站热门/.test(e)), JSON.stringify(r2.payload.errors));
  check('抓取：单源失败 → 其它源照常', r2.payload.music.length > 0 && r2.payload.movie.length > 0 && r2.payload.video.length > 0,
    `music=${r2.payload.music.length} movie=${r2.payload.movie.length} video=${r2.payload.video.length}`);

  /* 源有数据但解析出 0 条 → 抛错（源可能改版了） */
  state.broken.add('netease');
  const r3 = await fetchRank({ date: '2026-11-16', checkCovers: false, now: NOW });
  state.broken.delete('netease');
  check(
    '抓取：源有数据但解析出 0 条 → 抛错',
    r3.payload.errors.some((e) => /解析出 0 条/.test(e)),
    JSON.stringify(r3.payload.errors.slice(0, 2)),
  );
  throws('抓取：assertParsed 对 0 条直接抛', () => assertParsed(2, []), /解析出 0 条/);
  eq('抓取：assertParsed 对有数据不抛', assertParsed(2, [{ title: 'x' }]).length, 1);

  /* B站 code≠0 → 当失败处理 */
  state.biliCode = -352;
  const r4 = await fetchRank({ date: '2026-11-16', checkCovers: false, now: NOW });
  state.biliCode = 0;
  check(
    '抓取：B站 code≠0 → 当失败处理',
    r4.payload.errors.some((e) => /code=-352/.test(e)),
    JSON.stringify(r4.payload.errors),
  );

  /* 封面验：按 host 分组探测（不逐条探） */
  let probed = 0;
  const items = [
    { cover: 'https://a.example.com/1.jpg' },
    { cover: 'https://a.example.com/2.jpg' },
    { cover: 'https://b.example.com/3.jpg' },
  ];
  const info = await verifyCovers(items, {
    samplePerHost: 4,
    probe: async () => { probed++; return true; },
  });
  eq('封面验：按 host 分组（2 个 host）', info.hosts, 2);
  /* a.example.com：先探 1 张 + 抽 2 张 = 3；b.example.com：先探 1 张 + 抽 1 张 = 2 */
  eq('封面验：每 host 先探 1 张再均匀抽（不是逐条探）', probed, 5);
  eq('封面验：探测通过的不置空', info.blanked, 0);

  const items2 = [
    { cover: 'https://a.example.com/1.jpg' },
    { cover: 'https://b.example.com/3.jpg' },
  ];
  const info2 = await verifyCovers(items2, { probe: async () => false });
  eq('封面验：host 探不通 → 该 host 全部置空', info2.blanked, 2);
  check('封面验：置空后 cover 是空串', items2.every((it) => it.cover === ''));
}

/* ─────────────────────────── 5) CLI 入口 ───────────────────────────
 *
 * 这条曾经是假绿（2026-11-15 踩过：CLI 入口判断写错 → main() 根本不跑，
 * 进程 exit 0、一行输出都没有）。所以要单独钉住「CLI 是活的」。
 * 日期给个非法值 → 必须在联网之前就退出（顺便保证这条用例是离线的）。
 */
if (!process.env.FETCH_RANK) {
  console.log('\n5) CLI 入口');
  {
    const cli = path.join(__dirname, 'fetch-rank.mjs');
    const bad = await runNode([cli, '--date', '2026-1-1', '--dry-run']);
    const out = (bad.stdout || '') + (bad.stderr || '');
    check('CLI：日期格式不对 → exit 非 0', bad.code !== 0, `exit=${bad.code}`);
    eq('CLI：日期非法退出码 = 2', bad.code, 2);
    check('CLI：并且真的打印了用法（说明入口活着）', /用法/.test(out), out.trim().slice(0, 120));

    const help = await runNode([cli, '--help']);
    check('CLI：--help → exit 0', help.code === 0, `exit=${help.code}`);
    check('CLI：--help 打印用法', /用法/.test(help.stdout || ''), (help.stdout || '').trim().slice(0, 120));
    check('CLI：--help 用法文本含 --dry-run', /--dry-run/.test(help.stdout || ''), (help.stdout || '').trim().slice(0, 120));

    /* 所有源全挂 → exit 1 */
    for (const k of ['netease', 'apple', 'maoyanHot', 'maoyanComing', 'douban', 'bili', 'douyin']) {
      state.fail.add(k);
    }
    const dead = await runNode([cli, '--date', '2026-11-16', '--dry-run']);
    for (const k of ['netease', 'apple', 'maoyanHot', 'maoyanComing', 'douban', 'bili', 'douyin']) {
      state.fail.delete(k);
    }
    check('CLI：所有源全挂 → exit 1', dead.code === 1, `exit=${dead.code}`);
    check('CLI：全挂时打印了失败摘要', /失败摘要/.test((dead.stdout || '') + (dead.stderr || '')),
      ((dead.stdout || '') + (dead.stderr || '')).trim().slice(0, 160));
  }
}

/* ─────────────────────────── 6) 变异测试（护栏有没有牙齿） ───────────────────────────
 *
 * 护栏有没有牙齿，判定标准就是变异测试：改坏实现，测试必须变红。全绿 = 护栏是空的。
 *
 * 手法：把 fetch-rank.mjs 的源码按变异规则改写，复制到临时目录（连 paths.mjs /
 * env.mjs 一起复制，否则副本 import 不到 ./paths.mjs 会「崩」而不是断言红），
 * 再用 FETCH_RANK 指过去跑一遍本测试，看是不是**指定的那几条断言**红了。
 *
 * 变异清单和独立的变异脚本 tools/test-fetch-rank-mutate.mjs 共用一份。
 *
 * FETCH_RANK 已经设了 → 说明自己正在当变异体跑 → 跳过这一段（不然会无限递归）。
 */
if (!process.env.FETCH_RANK) {
  console.log('\n6) 变异测试：故意改坏实现，看本护栏抓不抓得住');
  const { runMutationSuite } = await import('./test-fetch-rank-mutate.mjs');
  const suite = runMutationSuite({ quiet: true });
  for (const res of suite.results) {
    if (res.id === 'baseline') continue;
    check(
      `变异 ${res.id}（${res.name}）被抓到`,
      res.verdict === 'CAUGHT',
      res.note || res.verdict,
    );
  }
  eq(`变异：${suite.total} 个变异全被抓到`, suite.caught, suite.total);
}

/* ─────────────────────────── 收尾 ─────────────────────────── */

server.close();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
