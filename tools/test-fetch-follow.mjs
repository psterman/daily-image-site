#!/usr/bin/env node
/**
 * 追更抓取 v2 的单元测试（**离线** —— 一行外网都不碰）
 *
 * 用法：node tools/test-fetch-follow.mjs
 * 退出码：0 = 全过；1 = 有失败
 *
 * 为什么必须离线：这个工具是构建期抓外部源的，源天天在变（TVmaze 改字段、
 * 豆瓣改 HTML、CDN 改防盗链）。护栏要是每次都联网，「今天源挂了就红」和
 * 「今天代码坏了」根本分不开 —— 所以 fixture 一律内联，网络行为用**本机
 * fixture server**（127.0.0.1）打桩，不出网。
 *
 * fixture 是 2026-11-16 从线上原样截下来的（真实 JSON / HTML 片段），
 * 里面保留了几个**故意埋的坑**：
 *   · /schedule/full：条目结构是 `_embedded.show`（不是 `show`）；
 *     `date=` 是**窗口起点**（fixture 里横跨 2026-11-15 ~ 17）；
 *     同一剧同一天两集；type 缺失；language 缺失与 '(none)'；officialSite 是 http://；
 *     有的条目 webChannel / network 都是空的
 *   · 豆瓣：海报在 data-lazy 里（src 是 blank.gif 占位图）
 *   · 豆瓣：地点串是「城市 行政区 场馆 地址」拼的，场馆本身也可能带空格
 *   · 豆瓣：有一条活动没有 <time>（解析不出日期，必须排最后）
 *   · 豆瓣：侧栏推荐位也是 list-entry（没有 itemprop="summary"，必须挡掉）
 *   · 兜底：页面正文里带播放地址（必须被丢弃）
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 变异测试入口：FETCH_FOLLOW 指向别的文件时，本护栏就对着那个文件跑
// （这样验「护栏能抓住坏版本」不用碰真文件）。
const modUrl = process.env.FETCH_FOLLOW
  ? pathToFileURL(path.resolve(__dirname, process.env.FETCH_FOLLOW)).href
  : new URL('./fetch-follow.mjs', import.meta.url).href;
const CLI_PATH = process.env.FETCH_FOLLOW
  ? path.resolve(__dirname, process.env.FETCH_FOLLOW)
  : path.join(__dirname, 'fetch-follow.mjs');

const mod = await import(modUrl);
const {
  parseTvmazeFull,
  parseBiliBangumi,
  parseDoubanHK,
  parseDoubanEvents,
  parseCityMeta,
  parseFallbackMeta,
  buildFollowPayload,
  fetchFollow,
  loadFallbackConfig,
  httpGet,
  doubanReferer,
  followFilePath,
  splitVenueAddress,
  doubanSearchLink,
  addDays,
  isDate,
  bucketChannel,
  normalizeTags,
  normalizeLanguage,
  classifyEventType,
  groupSchedule,
  localizeCovers,
  CITIES,
  SERIES_TYPES,
  CHANNEL_ALIAS,
  CHANNEL_PRIORITY,
  CHANNEL_SOURCES,
  ITEM_FIELDS,
  PAYLOAD_FIELDS,
  UA,
  HTTP_TIMEOUT_MS,
  RETRY_BACKOFF_MS,
  L1_SCHEDULE,
  L1_EVENTS,
  OTHER_CHANNEL,
  OTHER_LANGUAGE,
  DOUBAN_SEARCH_BASE,
  DOUBAN_IMAGE_REFERER,
  SCHEDULE_SOURCE,
  EVENTS_SOURCE,
  BILI_SOURCE,
  HK_SOURCE,
  main,
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

/** 断言「这段代码会抛」 */
function throws(name, fn, re = /./) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  check(name, !!err && re.test(String(err && err.message)), err ? `抛的是：${err.message}` : '根本没抛');
}

/* ─────────────────────────── fixture ─────────────────────────── */

/**
 * TVmaze `/schedule/full` 的条目工厂。
 * ⚠️ 结构是 `_embedded.show` —— 不是 `show`（`/schedule` 才是 `show`）。
 */
const tvmazeEp = (o) => ({
  id: o.eid,
  name: o.epName || '',
  season: o.season === undefined ? 1 : o.season,
  number: o.number === undefined ? 1 : o.number,
  airdate: o.airdate,
  airtime: o.airtime || '20:00',
  airstamp: o.airstamp || `${o.airdate}T20:00:00+00:00`,
  _embedded: {
    show: {
      id: o.id,
      name: o.name,
      type: o.type,
      language: o.language,
      image: o.image === null ? null : o.image || { medium: `https://static.tvmaze.com/u/${o.id}.jpg` },
      officialSite: o.officialSite,
      webChannel: o.webChannel ? { id: 900, name: o.webChannel } : null,
      network: o.network ? { id: 800, name: o.network } : null,
    },
  },
  /* ⚠️ 故意同时给一个 `show` 字段（内容是假的）——
     `/schedule/full` 的结构是 `_embedded.show`，不是 `show`（那是 `/schedule` 的结构）。
     解析器必须只认 `_embedded.show`。 */
  ...(o.shadow ? { show: { id: 999, name: 'Shadow Show', type: 'Scripted', language: 'English' } } : {}),
});

/** 目标日 2026-11-16 的 /schedule/full 样本（外加窗口里的前后两天） */
const TVMAZE_FULL = [
  /* —— 目标日 —— */
  tvmazeEp({ eid: 1, id: 1, name: 'Night Show', webChannel: 'Netflix', language: 'English', type: 'Scripted', airdate: '2026-11-16', airstamp: '2026-11-16T20:00:00+00:00', season: 2, number: 3, epName: 'The One', officialSite: 'https://example.com/night' }),
  /* 同一剧同一天第二集 → 只留一条（留最早播出的一集） */
  tvmazeEp({ eid: 2, id: 1, name: 'Night Show', webChannel: 'Netflix', language: 'English', type: 'Scripted', airdate: '2026-11-16', airstamp: '2026-11-16T21:00:00+00:00', season: 2, number: 4, epName: 'The Two' }),
  tvmazeEp({ eid: 3, id: 3, name: 'China Drama', webChannel: 'Tencent QQ', language: 'Chinese', type: 'Scripted', airdate: '2026-11-16' }),
  tvmazeEp({ eid: 4, id: 4, name: 'China Movie', webChannel: 'iQIYI', language: 'Chinese', type: 'Scripted', airdate: '2026-11-16' }),
  tvmazeEp({ eid: 5, id: 5, name: 'China Show', webChannel: 'Youku', language: 'Chinese', type: 'Scripted', airdate: '2026-11-16' }),
  tvmazeEp({ eid: 6, id: 6, name: 'Disney Show', webChannel: 'Disney+', language: 'English', type: 'Scripted', airdate: '2026-11-16' }),
  tvmazeEp({ eid: 7, id: 7, name: 'Five Show', webChannel: '5', language: 'English', type: 'Scripted', airdate: '2026-11-16' }),
  /* type 缺失 → 保留（判不出来就不丢数据） */
  tvmazeEp({ eid: 8, id: 8, name: 'No Type Show', webChannel: 'BBC iPlayer', language: 'English', airdate: '2026-11-16' }),
  /* News → 过滤掉 */
  tvmazeEp({ eid: 9, id: 9, name: 'News Show', webChannel: 'CBS', language: 'English', type: 'News', airdate: '2026-11-16' }),
  /* language 缺失 / '(none)' → 其他语言 */
  tvmazeEp({ eid: 10, id: 10, name: 'No Language Show', webChannel: 'NBC', type: 'Scripted', airdate: '2026-11-16' }),
  tvmazeEp({ eid: 11, id: 11, name: 'None Language Show', webChannel: 'NBC', language: '(none)', type: 'Scripted', airdate: '2026-11-16' }),
  /* officialSite 是 http:// → 必须升 https */
  tvmazeEp({ eid: 12, id: 12, name: 'Http Site Show', network: 'ABC', officialSite: 'http://www.abc.net.au/x', language: 'English', type: 'Scripted', airdate: '2026-11-16' }),
  /* webChannel / network 都是空的 → 归「其他平台」 */
  tvmazeEp({ eid: 13, id: 13, name: 'No Channel Show', language: 'English', type: 'Scripted', airdate: '2026-11-16' }),
  tvmazeEp({ eid: 14, id: 14, name: 'Doc Show', webChannel: 'HBO Max', language: 'English', type: 'Documentary', airdate: '2026-11-16' }),
  /* 同时带 `show`（假）—— 结构必须读 _embedded.show */
  tvmazeEp({ eid: 15, id: 30, name: 'Real Show', webChannel: 'Netflix', language: 'English', type: 'Scripted', airdate: '2026-11-16', airstamp: '2026-11-16T22:00:00+00:00', shadow: true }),
  /* —— 窗口里的别的日子（必须被 airdate 过滤掉）—— */
  tvmazeEp({ eid: 20, id: 20, name: 'Yesterday Show', webChannel: 'Netflix', language: 'English', type: 'Scripted', airdate: '2026-11-15' }),
  tvmazeEp({ eid: 21, id: 21, name: 'Tomorrow Show', webChannel: 'Netflix', language: 'English', type: 'Scripted', airdate: '2026-11-17' }),
];

/** 把 fixture 的日期整体平移到任意一天（CLI 测试用 2099 年，不能写死日期） */
function tvmazeForDate(d) {
  return TVMAZE_FULL.map((e) => {
    const off = e.airdate === '2026-11-15' ? -1 : e.airdate === '2026-11-17' ? 1 : 0;
    const airdate = addDays(d, off);
    return {
      ...e,
      airdate,
      airstamp: String(e.airstamp).replace(/^\d{4}-\d{2}-\d{2}/, airdate),
      _embedded: { show: { ...e._embedded.show } },
    };
  });
}

/** B站番剧 timeline */
const BILI_JSON = {
  code: 0,
  result: [
    {
      date: '2026-11-16',
      episodes: [
        {
          title: '斗罗大陆 第七季',
          cover: 'https://i0.hdslb.com/bfs/archive/cover-a.jpg',
          square: 'https://i0.hdslb.com/bfs/archive/square-b.jpg',
          pub_index: '12',
          pub_time: '19:00',
          ep_id: 12345,
          link: 'https://www.bilibili.com/bangumi/play/ep12345',
        },
      ],
    },
  ],
};

/**
 * 豆瓣「港剧」标签
 * @param {string} imgBase 封面基址 —— 单元测试用真的豆瓣域名，CLI 测试用本机 fixture server
 *                          （不指本机的话，CLI 子进程会真的去连豆瓣 —— 护栏必须完全离线）
 */
function hkJson(imgBase = 'https://img9.doubanio.com') {
  return {
    subjects: [
      {
        id: '1292052',
        title: '使徒行者',
        subtitle: '2025',
        cover: `${imgBase}/view/photo/s_ratio_poster/public/p/25912521.jpg`,
        url: 'https://movie.douban.com/subject/1292052/',
        rate: '8.4',
      },
    ],
  };
}
const HK_JSON = hkJson();

/**
 * 豆瓣同城城市页。
 * @param {string} imgBase 图片基址 —— 单元测试用真的豆瓣域名，CLI 测试用本机 fixture server
 */
function doubanHtml(imgBase = 'https://img3.doubanio.com') {
  return `
<div class="events-nav">
  <div class="events-nav-item">
    <label class="events-nav-title">类型：</label>
    <ul>
      <li><span>全部</span></li>
      <li><a href="https://beijing.douban.com/events/week-music">
                    音乐
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-comedy">
                    喜剧
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-drama">
                    戏剧
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-salon">
                    讲座
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-film">
                    电影
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-exhibition">
                    展览
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-sports">
                    运动
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-commonweal">
                    公益
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-travel">
                    旅行
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-competition">
                    赛事
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-course">
                    课程
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-kids">
                    亲子
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-others">
                    其他
                </a></li>
    </ul>
  </div>
  <div class="events-nav-item events-filter-loc">
    <ul class="ui-fbox">
      <li><a href="https://beijing.douban.com/events/week-all">
                    全部
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-all-128519">
                    东城区
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-all-128523">
                    朝阳区
                </a></li>
      <li><a href="https://beijing.douban.com/events/week-all-128524">
                    海淀区
                </a></li>
    </ul>
  </div>
</div>
<ul class="events-list events-list-pic100">
<li class="list-entry" itemscope itemtype="http://data-vocabulary.org/Event">
  <div class="pic">
    <a href="https://www.douban.com/event/36976894/">
      <img data-lazy="${imgBase}/pview/event_poster/median/public/277e82fb25aaf29.jpg" src="${imgBase}/f/shire/a1fdee122b95748d81cee426d717c05b5174fe96/pics/blank.gif" width="110" itemprop="photo"/>
    </a>
  </div>
  <div class="info">
    <div class="title">
      <a href="https://www.douban.com/event/36976894/" title="交响版《天空之城》交响音乐会" itemprop="url">
        <span itemprop="summary">交响版《天空之城》交响音乐会</span>
      </a>
    </div>
    <ul class="event-meta">
      <li class="event-time">
      <span class="hidden-xs">时间：</span>
        11月18日 周三 10:30 ~ 11月25日 周三 23:00
        <time itemprop="startDate" datetime="2026-11-18T10:30:00"></time>
        <time itemprop="endDate" datetime="2026-11-25T23:00:00"></time>
      </li>
      <li title="北京 朝阳区 老舍茶馆 前门大街9号">
        <span class="hidden-xs">地点：</span>
          朝阳区
          老舍茶馆 前门大街9号
      </li>
      <li class="fee">
        <span class="hidden-xs">费用：</span>
          <strong>120.00元</strong>
      </li>
    </ul>
  </div>
</li>
<li class="list-entry" itemscope itemtype="http://data-vocabulary.org/Event">
  <div class="pic">
    <a href="https://www.douban.com/event/38171742/">
      <img data-lazy="${imgBase}/pview/event_poster/median/public/fd83cd573ebb195.jpg" src="${imgBase}/f/shire/a1fdee122b95748d81cee426d717c05b5174fe96/pics/blank.gif" width="110" itemprop="photo"/>
    </a>
  </div>
  <div class="info">
    <div class="title">
      <a href="https://www.douban.com/event/38171742/" title="第八届费那奇动画周·2026北京" itemprop="url">
        <span itemprop="summary">第八届费那奇动画周·2026北京</span>
      </a>
    </div>
    <ul class="event-meta">
      <li class="event-time">
      <span class="hidden-xs">时间：</span>
        11月17日 周二 12:30-15:28
        <time itemprop="startDate" datetime="2026-11-17T12:30:00"></time>
        <time itemprop="endDate" datetime="2026-11-17T15:28:00"></time>
      </li>
      <li title="北京 海淀区 杏石口路50号中间艺术区中间剧场">
        <span class="hidden-xs">地点：</span>
          海淀区
          杏石口路50号中间艺术区中间剧场
      </li>
    </ul>
  </div>
</li>
<li class="list-entry" itemscope itemtype="http://data-vocabulary.org/Event">
  <div class="pic">
    <a href="https://www.douban.com/event/34815376/">
      <img data-lazy="${imgBase}/pview/event_poster/median/public/1ce1a91dd769e78.jpg" src="${imgBase}/f/shire/a1fdee122b95748d81cee426d717c05b5174fe96/pics/blank.gif" width="110" itemprop="photo"/>
    </a>
  </div>
  <div class="info">
    <div class="title">
      <a href="https://www.douban.com/event/34815376/" title="城市里的周末慢生活" itemprop="url">
        <span itemprop="summary">城市里的周末慢生活</span>
      </a>
    </div>
    <ul class="event-meta">
      <li class="event-time">
      <span class="hidden-xs">时间：</span>
        11月17日 周二 12:30-15:28
        <time itemprop="startDate" datetime="2026-11-17T12:30:00"></time>
        <time itemprop="endDate" datetime="2026-11-17T15:28:00"></time>
      </li>
      <li title="北京 中影国际影城天天中影CINITY LED店">
        <span class="hidden-xs">地点：</span>
          中影国际影城天天中影CINITY LED店
      </li>
    </ul>
  </div>
</li>
<li class="list-entry" itemscope itemtype="http://data-vocabulary.org/Event">
  <div class="pic">
    <a href="https://www.douban.com/event/38043989/">
      <img data-lazy="${imgBase}/pview/event_poster/median/public/abcd1234.jpg" src="${imgBase}/f/shire/a1fdee122b95748d81cee426d717c05b5174fe96/pics/blank.gif" width="110" itemprop="photo"/>
    </a>
  </div>
  <div class="info">
    <div class="title">
      <a href="https://www.douban.com/event/38043989/" title="城市公益行" itemprop="url">
        <span itemprop="summary">城市公益行</span>
      </a>
    </div>
    <ul class="event-meta">
      <li class="event-time">
      <span class="hidden-xs">时间：</span>
        时间待定
      </li>
      <li title="北京 东城区 玉桃园">
        <span class="hidden-xs">地点：</span>
          东城区
          玉桃园
      </li>
    </ul>
  </div>
</li>
<li class="list-entry">
  <div class="aside">
    <span>侧栏推荐位（不是活动，必须挡掉）</span>
  </div>
</li>
`;
}

/** 兜底源页面：正文里带播放地址（必须被丢弃） */
const FALLBACK_HTML = `
<div class="list">
  <li><a href="https://pirate.example/watch/abc123">https://pirate.example/watch/abc123 《三体》动画版 第3集 2026-11-16 20:00</a></li>
  <li>庆余年2 第12集 2026-11-17 21:00</li>
  <li>漫长的季节 2026-11-18</li>
</div>
`;

/* ─────────────────────────── 0) 导出名 ─────────────────────────── */

console.log('\n0) 导出名（build.mjs / 别的工具要 import，名字不能改）');
{
  const need = [
    'parseTvmazeFull',
    'parseDoubanEvents',
    'parseFallbackMeta',
    'buildFollowPayload',
    'fetchFollow',
    'CITIES',
    'main',
    'groupSchedule',
    'localizeCovers',
    'parseCityMeta',
  ];
  need.forEach((n) => check(`导出：${n} 存在`, typeof mod[n] !== 'undefined', `导出的是 ${typeof mod[n]}`));
  eq('导出：CITIES 是 12 项数组', Array.isArray(mod.CITIES) ? mod.CITIES.length : -1, 12);
  check('导出：main 是函数', typeof mod.main === 'function');
  check('导出：fetchFollow 是函数', typeof mod.fetchFollow === 'function');
}

/* ─────────────────────────── 1) TVmaze /schedule/full 解析 ─────────────────────────── */

console.log('\n1) TVmaze /schedule/full 解析');
{
  const r = parseTvmazeFull(TVMAZE_FULL, '2026-11-16');
  const titles = r.map((x) => x.title);

  eq('TVmaze：目标日 13 条（15 条 episode 去掉同剧第二集 + News 那条）', r.length, 13);
  check(
    'TVmaze：条目结构是 _embedded.show（不是 show —— 那是 /schedule 的结构）',
    r.some((x) => x.title === 'Real Show') && !r.some((x) => x.title === 'Shadow Show'),
    r.map((x) => x.title).join('、'),
  );
  check('TVmaze：昨天/明天的条目被过滤掉（date= 是窗口起点，必须按 airdate 精确过滤）', !titles.includes('Yesterday Show') && !titles.includes('Tomorrow Show'), titles.join('、'));
  check('TVmaze：同一剧同一天多集 → 只留一条', titles.filter((t) => t === 'Night Show').length === 1, titles.join('、'));
  eq('TVmaze：留的是最早播出的一集', r.find((x) => x.title === 'Night Show').subtitle, 'S2E3 · The One');
  check('TVmaze：type 缺失的条目照样保留', titles.includes('No Type Show'), titles.join('、'));
  check('TVmaze：News 类型的条目被过滤掉', !titles.includes('News Show'), titles.join('、'));
  check('TVmaze：Documentary 保留', titles.includes('Doc Show'), titles.join('、'));

  eq('TVmaze：条目字段就这 9 个', Object.keys(r[0]), ITEM_FIELDS);
  eq('TVmaze：ITEM_FIELDS 常量就是这 9 个', ITEM_FIELDS, ['rank', 'title', 'subtitle', 'meta', 'cover', 'link', 'source', 'tag', 'tags']);
  check(
    'TVmaze：_key 不可枚举（JSON 里看不到 —— 契约里只能有 9 个字段）',
    !Object.keys(r[0]).includes('_key') && !JSON.stringify(r[0]).includes('_key'),
    Object.keys(r[0]).join(','),
  );
  check('TVmaze：source = TVmaze 播出表', r[0].source === SCHEDULE_SOURCE, r[0].source);
  check('TVmaze：link 优先 officialSite', r.find((x) => x.title === 'Night Show').link === 'https://example.com/night', r.find((x) => x.title === 'Night Show').link);
  eq(
    'TVmaze：officialSite 是 http:// 时升级成 https://（mixed content）',
    r.find((x) => x.title === 'Http Site Show').link,
    'https://www.abc.net.au/x',
  );
  eq(
    'TVmaze：没有 officialSite 时回退 tvmaze 剧页',
    r.find((x) => x.title === 'China Drama').link,
    'https://www.tvmaze.com/shows/3',
  );
  check('TVmaze：image 为 null 时 cover 为空', parseTvmazeFull([tvmazeEp({ eid: 90, id: 90, name: 'No Image', webChannel: 'Netflix', airdate: '2026-11-16', image: null })], '2026-11-16')[0].cover === '', '');
  check('TVmaze：空输入不炸', parseTvmazeFull([], '2026-11-16').length === 0);
  check('TVmaze：null 不炸', parseTvmazeFull(null, '2026-11-16').length === 0);
}

console.log('\n1b) TVmaze：平台别名归并');
{
  const r = parseTvmazeFull(TVMAZE_FULL, '2026-11-16');
  const tagOf = (name) => (r.find((x) => x.title === name) || {}).tag;
  eq('别名：Tencent QQ → 腾讯视频', tagOf('China Drama'), '腾讯视频');
  eq('别名：iQIYI → 爱奇艺', tagOf('China Movie'), '爱奇艺');
  eq('别名：Youku → 优酷', tagOf('China Show'), '优酷');
  eq('别名：Disney+ → 迪士尼+', tagOf('Disney Show'), '迪士尼+');
  eq("别名：'5' → Channel 5（英国五台）", tagOf('Five Show'), 'Channel 5（英国五台）');
  eq('别名：Netflix 原样', tagOf('Night Show'), 'Netflix');
  eq('别名：HBO Max 原样', tagOf('Doc Show'), 'HBO Max');
  eq('别名：没标频道的 → 其他平台', tagOf('No Channel Show'), OTHER_CHANNEL);
  eq('别名表：Tencent Video / Tencent 也归腾讯视频', bucketChannel('Tencent Video'), '腾讯视频');
  eq('别名表：Bilibili → 哔哩哔哩', bucketChannel('Bilibili'), '哔哩哔哩');
  eq('别名表：Mango TV → 芒果TV', bucketChannel('Mango TV'), '芒果TV');
}

console.log('\n1c) TVmaze：语言维度');
{
  const r = parseTvmazeFull(TVMAZE_FULL, '2026-11-16');
  const tagsOf = (name) => (r.find((x) => x.title === name) || {}).tags;
  eq('语言：Night Show → English', tagsOf('Night Show'), ['@1:频道更新', '@2:Netflix', '@3:English']);
  eq('语言：China Drama → Chinese', tagsOf('China Drama'), ['@1:频道更新', '@2:腾讯视频', '@3:Chinese']);
  eq('语言：缺 language → 其他语言', tagsOf('No Language Show'), ['@1:频道更新', '@2:NBC', '@3:其他语言']);
  eq("语言：'(none)' → 其他语言", tagsOf('None Language Show'), ['@1:频道更新', '@2:NBC', '@3:其他语言']);
  eq('语言：normalizeLanguage', normalizeLanguage(''), OTHER_LANGUAGE);
  eq('语言：normalizeLanguage 保留原值', normalizeLanguage('Japanese'), 'Japanese');
}

/* ─────────────────────────── 2) 平台分组顺序 ─────────────────────────── */

console.log('\n2) 平台分组顺序（点名平台 → 独立源 → 长尾 → 其他平台）');
{
  const tvm = parseTvmazeFull(TVMAZE_FULL, '2026-11-16');
  const bili = parseBiliBangumi(BILI_JSON.result);
  const hk = parseDoubanHK(HK_JSON.subjects);
  const grouped = groupSchedule(tvm, bili, hk);
  const chans = [];
  for (const it of grouped) {
    const v = it.tags.find((t) => t.startsWith('@2:'));
    if (!chans.includes(v)) chans.push(v);
  }

  eq('分组：channels 顺序 = 点名平台 → B站番剧 → 港剧 → 长尾 → 其他平台', chans, [
    '@2:Netflix',
    '@2:HBO Max',
    '@2:迪士尼+',
    '@2:腾讯视频',
    '@2:优酷',
    '@2:爱奇艺',
    '@2:B站番剧',
    '@2:港剧',
    '@2:NBC',
    '@2:ABC',
    '@2:BBC iPlayer',
    '@2:Channel 5（英国五台）',
    '@2:其他平台',
  ]);
  eq('分组：最后一个是「其他平台」', chans[chans.length - 1], `@2:${OTHER_CHANNEL}`);
  check('分组：港剧不是独立板块（它就是平台 chip 里的一个）', chans.includes('@2:港剧') && chans.indexOf('@2:港剧') < chans.indexOf('@2:NBC'), chans.join(' '));
  check('分组：B站番剧排在长尾之前', chans.indexOf('@2:B站番剧') < chans.indexOf('@2:NBC'), chans.join(' '));
  check('分组：长尾按条目数从多到少（NBC 有 2 条，排最前）', chans.indexOf('@2:NBC') < chans.indexOf('@2:ABC'), chans.join(' '));
  check('分组：没标频道的剧归「其他平台」', grouped.some((x) => x.title === 'No Channel Show' && x.tag === OTHER_CHANNEL), '');
  check('分组：「其他平台」的条目 @2 也是其他平台', grouped.filter((x) => x.title === 'No Channel Show')[0].tags.includes(`@2:${OTHER_CHANNEL}`), '');

  /* 组内按 (airdate, airstamp) 升序 */
  const netflix = grouped.filter((x) => x.tag === 'Netflix');
  eq('分组：组内按播出时间升序', netflix.map((x) => x.subtitle), ['S2E3 · The One', 'S1E1']);

  /* 长尾合并的封顶：20 个平台 × 每平台 10 条 → 前 10 个平台自己成组，
     剩下 10 个平台进「其他平台」，每平台最多 6 条、总共最多 40 条。 */
  const many = [];
  for (let p = 0; p < 20; p++) {
    for (let i = 0; i < 10; i++) {
      many.push({
        rank: 0,
        title: `Tail ${p}-${i}`,
        subtitle: '',
        meta: '',
        cover: '',
        link: 'https://example.com/x',
        source: SCHEDULE_SOURCE,
        tag: `Tail Channel ${p}`,
        tags: [`@1:频道更新`, `@2:Tail Channel ${p}`, '@3:English'],
      });
    }
  }
  const merged = groupSchedule(many, [], []);
  const otherItems = merged.filter((x) => x.tag === OTHER_CHANNEL);
  eq('分组：长尾合并后总数封顶 40', otherItems.length, 40);
  eq('分组：长尾平台前 10 个自己成组（不在合并组里）', merged.filter((x) => x.tag.startsWith('Tail Channel')).length, 100);
  check('分组：合并进来的条目 tag 变成「其他平台」', otherItems.length > 0 && otherItems.every((x) => x.tag === OTHER_CHANNEL), '');
  check('分组：合并进来的条目 @2 也变成「其他平台」', otherItems.length > 0 && otherItems.every((x) => x.tags.includes(`@2:${OTHER_CHANNEL}`)), '');
  check('分组：合并进来的条目保留 @3 语言', otherItems.length > 0 && otherItems.every((x) => x.tags.includes('@3:English')), '');
}

/* ─────────────────────────── 3) B站番剧 ─────────────────────────── */

console.log('\n3) B站番剧');
{
  const r = parseBiliBangumi(BILI_JSON.result);
  eq('B站：条数对', r.length, 1);
  eq('B站：标题', r[0].title, '斗罗大陆 第七季');
  eq('B站：subtitle = 第N话', r[0].subtitle, '第12话');
  eq('B站：meta = 日期 · 时间', r[0].meta, '2026-11-16 · 19:00');
  eq('B站：cover 取 cover 字段', r[0].cover, 'https://i0.hdslb.com/bfs/archive/cover-a.jpg');
  eq('B站：link 指向正版播放页', r[0].link, 'https://www.bilibili.com/bangumi/play/ep12345');
  eq('B站：source = 哔哩哔哩番剧', r[0].source, BILI_SOURCE);
  eq('B站：tag = B站番剧', r[0].tag, 'B站番剧');
  eq('B站：tags 只有 @1/@2（没有语言层）', r[0].tags, ['@1:频道更新', '@2:B站番剧']);
  eq('B站：空输入不炸', parseBiliBangumi(null).length, 0);
  eq('B站：episodes 为空不炸', parseBiliBangumi([{ date: '2026-11-16', episodes: [] }]).length, 0);
}

/* ─────────────────────────── 4) 豆瓣港剧 ─────────────────────────── */

console.log('\n4) 豆瓣港剧（和别的平台混排）');
{
  const r = parseDoubanHK(HK_JSON.subjects);
  eq('港剧：条数对', r.length, 1);
  eq('港剧：标题', r[0].title, '使徒行者');
  eq('港剧：meta = 评分', r[0].meta, '8.4 分');
  eq('港剧：source = 豆瓣港剧', r[0].source, HK_SOURCE);
  eq('港剧：tag = 港剧', r[0].tag, '港剧');
  eq('港剧：tags = @1/@2（没有语言层）', r[0].tags, ['@1:频道更新', '@2:港剧']);
  eq('港剧：空输入不炸', parseDoubanHK(null).length, 0);
}

/* ─────────────────────────── 5) 豆瓣同城 ─────────────────────────── */

console.log('\n5) 豆瓣同城解析（行政区保留 + 类型）');
{
  const r = parseDoubanEvents(doubanHtml(), '北京');
  const titles = r.map((x) => x.title);

  eq('豆瓣：条数对（侧栏推荐位被挡掉）', r.length, 4);
  check('豆瓣：侧栏推荐位（没有 summary）被挡掉', !titles.includes('侧栏推荐位（不是活动，必须挡掉）'), titles.join('、'));
  eq('豆瓣：按开始时间升序（解析不出日期的排最后）', titles, [
    '第八届费那奇动画周·2026北京',
    '城市里的周末慢生活',
    '交响版《天空之城》交响音乐会',
    '城市公益行',
  ]);
  eq('豆瓣：条目字段就这 9 个', Object.keys(r[0]), ITEM_FIELDS);
  eq('豆瓣：tag = 城市中文名', r[0].tag, '北京');
  eq('豆瓣：source = 豆瓣同城', r[0].source, EVENTS_SOURCE);
  check('豆瓣：link = 活动页 URL', r.find((x) => x.title === '交响版《天空之城》交响音乐会').link === 'https://www.douban.com/event/36976894/', r[0].link);
  check('豆瓣：cover 取 data-lazy（不是 src）', r[0].cover === 'https://img3.doubanio.com/pview/event_poster/median/public/fd83cd573ebb195.jpg', r[0].cover);
  check('豆瓣：cover 里没有 blank.gif', !r[0].cover.includes('blank.gif'), r[0].cover);

  /* ⚠️ 防回归：旧代码把行政区 slice 掉了 —— 这一条不能退化 */
  const music = r.find((x) => x.title === '交响版《天空之城》交响音乐会');
  eq('豆瓣：行政区**保留**在 tags 的 @3（v2 核心：旧代码 slice 掉了）', music.tags, ['@1:本地演出', '@2:北京', '@3:朝阳区', '@4:音乐']);
  check('豆瓣：行政区也出现在 subtitle（用户直接看得到）', music.subtitle.includes('朝阳区'), music.subtitle);
  eq('豆瓣：subtitle = 行政区 · 场馆 · 地址', music.subtitle, '朝阳区 · 老舍茶馆 · 前门大街9号');

  /* 类型判定不出来 → 不写 @4 */
  const anim = r.find((x) => x.title === '第八届费那奇动画周·2026北京');
  eq('豆瓣：判不出类型 → 不写 @4（不能瞎填）', anim.tags, ['@1:本地演出', '@2:北京', '@3:海淀区']);
  check('豆瓣：判不出类型时没有 @4', !anim.tags.some((t) => t.startsWith('@4:')), JSON.stringify(anim.tags));

  /* 没有行政区 → 不写 @3 */
  const noDistrict = r.find((x) => x.title === '城市里的周末慢生活');
  eq('豆瓣：没有行政区 → 不写 @3', noDistrict.tags, ['@1:本地演出', '@2:北京']);
  check('豆瓣：没有行政区时没有 @3', !noDistrict.tags.some((t) => t.startsWith('@3:')), JSON.stringify(noDistrict.tags));
  check('豆瓣：没有行政区时也没有 @4', !noDistrict.tags.some((t) => t.startsWith('@4:')), JSON.stringify(noDistrict.tags));

  /* 有区 + 有类型 */
  const charity = r.find((x) => x.title === '城市公益行');
  eq('豆瓣：有区有类型 → @3 + @4 都有', charity.tags, ['@1:本地演出', '@2:北京', '@3:东城区', '@4:公益']);

  eq('豆瓣：跨天结束时间带日期', music.meta, '2026-11-18 10:30 - 2026-11-25 23:00');
  check('豆瓣：没有 <time> 时退回可见文字', charity.meta.includes('时间待定'), charity.meta);

  /* 地点串的拆分规则（豆瓣给的是「城市 行政区 场馆 地址」） */
  eq('地点：城市 + 行政区 + 场馆 + 地址', splitVenueAddress('上海 静安区 Fotografiska影像艺术中心单日通票 光复路127号', '上海'), {
    district: '静安区',
    venue: 'Fotografiska影像艺术中心单日通票',
    address: '光复路127号',
  });
  eq('地点：场馆本身带空格时不误切', splitVenueAddress('北京 中影国际影城天天中影CINITY LED店', '北京'), {
    district: '',
    venue: '中影国际影城天天中影CINITY LED店',
    address: '',
  });
  eq('地点：没有地址时 address 为空', splitVenueAddress('北京 海淀区 中关村演出广场', '北京'), {
    district: '海淀区',
    venue: '中关村演出广场',
    address: '',
  });
  eq('地点：空串不炸', splitVenueAddress('', '北京'), { district: '', venue: '', address: '' });

  /* 类型判定 */
  eq('类型：音乐会 → 音乐', classifyEventType('交响版《天空之城》交响音乐会'), '音乐');
  eq('类型：脱口秀 → 喜剧', classifyEventType('喜番喜剧脱口秀之夜'), '喜剧');
  eq('类型：话剧 → 戏剧', classifyEventType('孟京辉经典戏剧作品'), '戏剧');
  eq('类型：展览 → 展览', classifyEventType('当代艺术特展'), '展览');
  eq('类型：观影 → 电影', classifyEventType('CINITY 全球超前观影'), '电影');
  eq('类型：判不出来 → 空串', classifyEventType('第八届费那奇动画周·2026北京'), '');

  /* 类型候选集校验：城市页没列出来的类型不写 */
  const onlyMusic = parseDoubanEvents(doubanHtml(), '北京', { allowedTypes: ['音乐'] });
  eq('类型：在候选集里 → 照写', onlyMusic.find((x) => x.title === '交响版《天空之城》交响音乐会').tags, ['@1:本地演出', '@2:北京', '@3:朝阳区', '@4:音乐']);
  eq('类型：不在城市页候选集里 → 不写 @4', onlyMusic.find((x) => x.title === '城市公益行').tags, ['@1:本地演出', '@2:北京', '@3:东城区']);

  eq('豆瓣：空 HTML 不炸', parseDoubanEvents('', '北京').length, 0);
  eq('豆瓣：换个城市名 tag 就换', parseDoubanEvents(doubanHtml(), '上海')[0].tag, '上海');
}

console.log('\n5b) 城市页的区级 / 类型候选清单');
{
  const meta = parseCityMeta(doubanHtml());
  eq('城市页：区级清单', meta.districts, ['东城区', '朝阳区', '海淀区']);
  eq('城市页：类型清单', meta.types, [
    '音乐',
    '喜剧',
    '戏剧',
    '讲座',
    '电影',
    '展览',
    '运动',
    '公益',
    '旅行',
    '赛事',
    '课程',
    '亲子',
    '其他',
  ]);
  check('城市页：「全部」不算类型', !meta.types.includes('全部'), JSON.stringify(meta.types));
  eq('城市页：空 HTML 不炸', parseCityMeta('').districts.length, 0);
}

/* ─────────────────────────── 6) tags 归一化 ─────────────────────────── */

console.log('\n6) tags 归一化（层级标签）');
{
  eq('tags：格式对的留下', normalizeTags(['@1:频道更新', '@2:Netflix']), ['@1:频道更新', '@2:Netflix']);
  eq('tags：层号递增（排序后）', normalizeTags(['@3:English', '@1:频道更新', '@2:Netflix']), ['@1:频道更新', '@2:Netflix', '@3:English']);
  eq('tags：同一层最多一个', normalizeTags(['@2:Netflix', '@2:HBO Max']), ['@2:Netflix']);
  eq('tags：格式不对的丢掉', normalizeTags(['频道更新', '@x:坏', '@2:Netflix', '']), ['@2:Netflix']);
  eq('tags：值为空丢掉', normalizeTags(['@1:频道更新', '@2:  ']), ['@1:频道更新']);
  eq('tags：空输入', normalizeTags(null), []);
  eq('tags：层号从 1 开始', normalizeTags(['@0:x']), []);
}

/* ─────────────────────────── 7) 豆瓣封面本地化 ─────────────────────────── */

console.log('\n7) 豆瓣封面本地化（418 → 必须自己存）');
{
  const dir = path.join(__dirname, '.tmp-fetch-follow-cli/covers');
  /* 先清空：封面文件名是 URL 的 sha1，文件在就会跳过下载 ——
     那会让「下载时带 Referer」这条断言变成空跑。 */
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了，不影响判定 */
  }
  const calls = [];
  const fakeBin = async (url, init) => {
    calls.push({ url: String(url), headers: (init && init.headers) || {} });
    if (String(url).includes('bad')) return new Response('nope', { status: 404 });
    if (String(url).includes('tiny')) return new Response(Buffer.alloc(10, 1), { status: 200 });
    return new Response(Buffer.alloc(1024, 7), { status: 200 });
  };
  const items = [
    { title: 'A', cover: 'https://img3.doubanio.com/pview/good.jpg' },
    { title: 'B', cover: 'https://img3.doubanio.com/pview/bad.jpg' },
    { title: 'C', cover: 'https://img3.doubanio.com/pview/tiny.jpg' },
    { title: 'D', cover: 'https://static.tvmaze.com/u/1.jpg' },
  ];
  const r = await localizeCovers(items, { dir, fetchImpl: fakeBin });

  eq('封面：成功 1 张', r.ok, 1);
  eq('封面：失败 2 张（404 + 字节数不足）', r.fail, 2);
  eq('封面：下载时带 Referer（不带就是 418）', calls[0].headers.Referer, DOUBAN_IMAGE_REFERER);
  const hash = crypto.createHash('sha1').update('https://img3.doubanio.com/pview/good.jpg').digest('hex').slice(0, 16);
  eq('封面：cover 写成 local: 标记', items[0].cover, `local:follow-covers/${hash}.jpg`);
  check('封面：文件真的落盘了', fs.existsSync(path.join(dir, `${hash}.jpg`)), path.join(dir, `${hash}.jpg`));
  eq('封面：下载失败的留空字符串（不能留一个会裂的远程 URL）', items[1].cover, '');
  eq('封面：字节数不足的也留空字符串', items[2].cover, '');
  eq('封面：非豆瓣图不动', items[3].cover, 'https://static.tvmaze.com/u/1.jpg');
  check('封面：输出里不许残留 doubanio.com 的远程 URL', !JSON.stringify(items).includes('doubanio.com'), JSON.stringify(items));
}

/* ─────────────────────────── 8) 兜底通道 ─────────────────────────── */

console.log('\n8) 兜底通道（默认关闭 · 输出绝不含 URL）');
{
  let fb = [];
  let fbErr = null;
  try {
    fb = parseFallbackMeta(FALLBACK_HTML, { name: '备用聚合', tag: '兜底', tags: ['@1:频道更新', '@2:兜底'] });
  } catch (e) {
    fbErr = e;
  }
  check('兜底：正常配置不抛', !fbErr, fbErr ? String(fbErr.message) : '');
  eq('兜底：条数对', fb.length, 3);
  eq('兜底：标题里的《》保留', fb[0] ? fb[0].title : '', '《三体》动画版');
  eq('兜底：识别第 N 集', fb[0] ? fb[0].subtitle : '', '第3集');
  eq('兜底：识别日期', fb[0] ? fb[0].meta : '', '2026-11-16');
  eq('兜底：source = 配置里的 name', fb[0] ? fb[0].source : '', '备用聚合');
  eq('兜底：tag = 兜底', fb[0] ? fb[0].tag : '', '兜底');
  eq('兜底：tags 带层级', fb[0] ? fb[0].tags : [], ['@1:频道更新', '@2:兜底']);
  eq('兜底：cover 恒为空', fb.every((x) => x.cover === ''), true);
  eq('兜底：link = 豆瓣站内搜索', fb[0] ? fb[0].link : '', DOUBAN_SEARCH_BASE + encodeURIComponent('《三体》动画版'));
  check('兜底：link 里标题做了 encodeURIComponent', (fb[0] ? fb[0].link : '').includes('%E3%80%8A'), fb[0] ? fb[0].link : '');
  const urls = fb.filter((x) => Object.entries(x).some(([k, v]) => k !== 'link' && /https?:\/\//i.test(String(v))));
  eq('兜底：输出里一个 URL 都不许有', urls.length, 0);
  check('兜底：正文里的播放地址被丢弃', !JSON.stringify(fb).includes('pirate.example'), JSON.stringify(fb).slice(0, 200));
  eq('兜底：条目字段就这 9 个', Object.keys(fb[0] || {}), ITEM_FIELDS);
  eq('兜底：空输入不炸', parseFallbackMeta('', { name: 'x' }).length, 0);
  throws('兜底：自检会抛（配置名里带 URL）', () => parseFallbackMeta(FALLBACK_HTML, { name: 'https://evil.example' }), /URL/);
}

/* ─────────────────────────── 9) 城市表 ─────────────────────────── */

console.log('\n9) 12 城市 slug 表');
{
  eq('城市表：正好 12 个城市', CITIES.length, 12);
  const expect = [
    ['北京', 'beijing'],
    ['上海', 'shanghai'],
    ['广州', 'guangzhou'],
    ['深圳', 'shenzhen'],
    ['杭州', 'hangzhou'],
    ['成都', 'chengdu'],
    ['武汉', 'wuhan'],
    ['南京', 'nanjing'],
    ['重庆', 'chongqing'],
    ['西安', 'xian'],
    ['苏州', 'suzhou'],
    ['天津', 'tianjin'],
  ];
  expect.forEach(([name, slug]) => {
    eq(`城市表：${name} = ${slug}`, CITIES.find((c) => c.name === name)?.slug, slug);
  });
  check('城市表：slug 全是小写英文', CITIES.every((c) => /^[a-z]+$/.test(c.slug)), JSON.stringify(CITIES.map((c) => c.slug)));
  check('城市表：没有重复 slug', new Set(CITIES.map((c) => c.slug)).size === CITIES.length);
  check('城市表：没有重复城市名', new Set(CITIES.map((c) => c.name)).size === CITIES.length);
}

/* ─────────────────────────── 10) 输出契约 ─────────────────────────── */

console.log('\n10) 输出契约（build.mjs 按这个结构读）');
{
  const schedule = groupSchedule(
    parseTvmazeFull(TVMAZE_FULL, '2026-11-16'),
    parseBiliBangumi(BILI_JSON.result),
    parseDoubanHK(HK_JSON.subjects),
  );
  const events = parseDoubanEvents(doubanHtml(), '北京');
  const p = buildFollowPayload({ date: '2026-11-16', schedule, events, cities: CITIES });

  eq('契约：顶层字段就这 8 个', Object.keys(p), PAYLOAD_FIELDS);
  eq('契约：PAYLOAD_FIELDS 常量就是这 8 个', PAYLOAD_FIELDS, ['date', 'generatedAt', 'cities', 'schedule', 'events', 'channels', 'languages', 'errors']);
  eq('契约：条目字段就这 9 个', Object.keys(p.schedule[0]), ITEM_FIELDS);
  eq('契约：date', p.date, '2026-11-16');
  eq('契约：generatedAt 是固定零点（不是墙上时钟）', p.generatedAt, '2026-11-16T00:00:00.000Z');
  eq('契约：cities 是 12 个城市名', p.cities.length, 12);
  eq('契约：cities 是中文名', p.cities[0], '北京');
  eq('契约：errors 默认空数组', p.errors, []);
  eq('契约：schedule rank 从 1 连号', p.schedule.map((x) => x.rank), p.schedule.map((_, i) => i + 1));
  eq('契约：events rank 从 1 连号', p.events.map((x) => x.rank), p.events.map((_, i) => i + 1));
  eq('契约：两个板块的条目字段顺序一致', Object.keys(p.events[0]), Object.keys(p.schedule[0]));
  eq('契约：channels 是有序的平台清单', p.channels[0], 'Netflix');
  check('契约：channels 里有 B站番剧', p.channels.includes('B站番剧'), JSON.stringify(p.channels));
  check('契约：channels 里有港剧', p.channels.includes('港剧'), JSON.stringify(p.channels));
  check('契约：channels 里每个值都有条目', p.channels.every((c) => p.schedule.some((x) => x.tags.includes(`@2:${c}`))), JSON.stringify(p.channels));
  check('契约：languages 是有序的语言清单', p.languages[0] === 'English', JSON.stringify(p.languages));
  check('契约：languages 里每个值都有条目', p.languages.every((l) => p.schedule.some((x) => x.tags.includes(`@3:${l}`))), JSON.stringify(p.languages));

  /* 语言顺序：**按条目数从多到少**，不是首次出现顺序 —— 这两条要能分开 */
  const pL = buildFollowPayload({
    date: '2026-11-16',
    schedule: [
      { tags: ['@1:频道更新', '@2:A', '@3:Japanese'] },
      { tags: ['@1:频道更新', '@2:B', '@3:English'] },
      { tags: ['@1:频道更新', '@2:B', '@3:English'] },
    ],
  });
  eq('契约：languages 按条目数从多到少（不是首次出现顺序）', pL.languages, ['English', 'Japanese']);
  check('契约：JSON 序列化后顶层还是 8 个键', Object.keys(JSON.parse(JSON.stringify(p))).length === 8, '');
  check('契约：_key 不可枚举（JSON 里看不到）', !JSON.stringify(p).includes('_key'), '');

  /* 每条都检查一遍标签形状 */
  const all = [...p.schedule, ...p.events];
  check('契约：每个条目 tags 非空', all.every((x) => Array.isArray(x.tags) && x.tags.length > 0), '');
  check(
    '契约：每个标签形如 @<数字>:<非空文字>',
    all.every((x) => x.tags.every((t) => /^@\d+:\S/.test(t))),
    JSON.stringify(all.flatMap((x) => x.tags).filter((t) => !/^@\d+:\S/.test(t))),
  );
  check(
    '契约：每层最多一个标签',
    all.every((x) => new Set(x.tags.map((t) => t.slice(0, t.indexOf(':')))).size === x.tags.length),
    '',
  );
  check(
    '契约：层号严格递增',
    all.every((x) => {
      const layers = x.tags.map((t) => Number(t.slice(1, t.indexOf(':'))));
      return layers.every((n, i) => i === 0 || n > layers[i - 1]);
    }),
    '',
  );
  check(
    '契约：schedule 条目含 @1:频道更新 和 @2:<平台>（且 @2 == tag）',
    p.schedule.every((x) => x.tags.includes('@1:频道更新') && x.tags.includes(`@2:${x.tag}`)),
    JSON.stringify(p.schedule.filter((x) => !(x.tags.includes('@1:频道更新') && x.tags.includes(`@2:${x.tag}`))).slice(0, 2)),
  );
  check(
    '契约：events 条目含 @1:本地演出 和 @2:<城市>（且 @2 == tag）',
    p.events.every((x) => x.tags.includes('@1:本地演出') && x.tags.includes(`@2:${x.tag}`)),
    JSON.stringify(p.events.filter((x) => !(x.tags.includes('@1:本地演出') && x.tags.includes(`@2:${x.tag}`))).slice(0, 2)),
  );
  check(
    '契约：schedule 条目都带语言层 @3（只有 B站番剧 / 港剧 没有语言层）',
    p.schedule.every((x) => x.tags.some((t) => t.startsWith('@3:')) || x.tag === 'B站番剧' || x.tag === '港剧'),
    JSON.stringify(p.schedule.filter((x) => !x.tags.some((t) => t.startsWith('@3:'))).map((x) => x.tag)),
  );

  const p2 = buildFollowPayload({ date: '2026-11-16', schedule: [], events, cities: CITIES, errors: ['X: y'] });
  eq('契约：某个板块空了不影响另一个', p2.schedule.length, 0);
  eq('契约：失败原因进 errors', p2.errors, ['X: y']);
  eq('契约：不传 cities 时给全部 12 个城市', buildFollowPayload({ date: '2026-11-16' }).cities.length, 12);
  eq('契约：非法日期时退回今天', isDate(buildFollowPayload({ date: '2026-13-45' }).date), true);
  eq('契约：addDays 跨月', addDays('2026-11-30', 1), '2026-12-01');
  eq('契约：addDays 跨年', addDays('2026-12-31', 1), '2027-01-01');
  check('契约：落盘路径在 <date>/follow_<date>.json', followFilePath('2026-11-16').endsWith(path.join('2026-11-16', 'follow_2026-11-16.json')), followFilePath('2026-11-16'));
  check('契约：落盘路径是绝对路径', path.isAbsolute(followFilePath('2026-11-16')));
  eq(
    '契约：落盘路径来自 paths.mjs 的 SRC_LOCAL（没写死盘符）',
    followFilePath('2026-11-16'),
    path.join(mod.SRC_LOCAL, '2026-11-16', 'follow_2026-11-16.json'),
  );
}

/* ─────────────────────────── 11) 网络层 ─────────────────────────── */

function startServer(handler) {
  return new Promise((resolve) => {
    const reqs = [];
    const sockets = new Set();
    const srv = http.createServer((req, res) => {
      const rec = { url: req.url, headers: req.headers };
      reqs.push(rec);
      try {
        handler(req, res, reqs.length);
      } catch (e) {
        res.writeHead(500);
        res.end(String(e && e.message));
      }
    });
    // keep-alive 连接会让 server.close() 一直挂着 —— 关的时候把 socket 全 destroy 掉
    srv.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({
        port,
        reqs,
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            srv.close(() => r());
          }),
      });
    });
  });
}

console.log('\n11) 网络层护栏（本机 127.0.0.1 打桩，不出网）');
{
  eq('网络：默认超时 20s', HTTP_TIMEOUT_MS, 20000);
  eq('网络：重试 2 次退避 1s/3s', RETRY_BACKOFF_MS, [1000, 3000]);
  check('网络：UA 是桌面 Chrome', /Chrome\/\d+/.test(UA), UA);

  // 11.1 UA
  const s1 = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await httpGet(`${s1.base}/x`);
  check('网络：请求带桌面 Chrome UA', /Chrome\/\d+/.test(s1.reqs[0].headers['user-agent'] || ''), s1.reqs[0].headers['user-agent']);
  eq('网络：UA 与常量一致', s1.reqs[0].headers['user-agent'], UA);
  await s1.close();

  // 11.2 重试 + 退避
  const s2 = await startServer((req, res, n) => {
    if (n === 1) {
      req.socket.destroy(); // 模拟 ECONNRESET
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const t0 = Date.now();
  let body = '';
  let retryErr = null;
  try {
    body = await httpGet(`${s2.base}/x`);
  } catch (e) {
    retryErr = e;
  }
  const dt = Date.now() - t0;
  eq('网络：失败会重试并最终拿到内容', body, 'ok');
  check('网络：重试到成功就不该抛错', !retryErr, retryErr ? String(retryErr.message) : '');
  eq('网络：至少请求了 2 次', s2.reqs.length >= 2, true);
  check('网络：重试之间有退避（>=900ms）', dt >= 900, `${dt}ms`);
  await s2.close();

  // 11.3 4xx 不重试
  const s3 = await startServer((req, res) => {
    res.writeHead(404);
    res.end('nope');
  });
  let e404 = null;
  try {
    await httpGet(`${s3.base}/x`);
  } catch (e) {
    e404 = e;
  }
  check('网络：4xx 抛错', !!e404 && /404/.test(String(e404.message)), e404 ? e404.message : '没抛');
  eq('网络：4xx 不重试（只请求 1 次）', s3.reqs.length, 1);
  await s3.close();

  // 11.4 超时会 abort
  const s4 = await startServer(() => {
    /* 故意不响应 */
  });
  let eTimeout = null;
  try {
    await httpGet(`${s4.base}/x`, { timeoutMs: 300 });
  } catch (e) {
    eTimeout = e;
  }
  check('网络：超时会被 Abort', !!eTimeout && (eTimeout.name === 'AbortError' || /abort/i.test(eTimeout.message)), eTimeout ? `${eTimeout.name}: ${eTimeout.message}` : '没抛');
  await s4.close();

  // 11.5 自己跟跳转（豆瓣的 301 是软跳转，undici 停在 301 不跟完）
  const s5 = await startServer((req, res) => {
    if (req.url === '/from') {
      res.writeHead(301, { location: '/to' });
      res.end('redirect');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('landed');
  });
  // 这一段必须 try/catch —— 变异把「自己跟跳转」关掉时，httpGet 会直接抛
  // 「HTTP 301」，测试在第一个 await 就死了，后面所有断言都没机会跑：
  // 变异测试会判成「假红」（红是崩出来的，不是断言判出来的），真实缺口被盖住。
  let landed = null;
  let landedErr = null;
  try {
    landed = await httpGet(`${s5.base}/from`, { headers: { Referer: 'https://www.douban.com/' } });
  } catch (e) {
    landedErr = e;
  }
  check('网络：301 跟到底不抛错', !landedErr, landedErr ? String(landedErr.message) : '');
  eq('网络：301 会自己跟到底', landed, 'landed');
  eq('网络：跳转真的发生了（请求了两次）', s5.reqs.length, 2);
  // 这里必须用 ?. —— 只发了一次请求时 s5.reqs[1] 是 undefined，
  // 直接 .headers 会抛 TypeError 把整个测试打崩，后面所有断言都没机会跑。
  // 变异测试里这叫「假红」：红是崩出来的，不是断言判出来的，护栏的真实缺口会被盖住。
  eq('网络：跳转后 Referer 还在（豆瓣对 Referer 敏感）', s5.reqs[1]?.headers?.referer ?? '(没有第二次请求)', 'https://www.douban.com/');
  await s5.close();
}

/* ─────────────────────────── 12) 源请求与 Referer ─────────────────────────── */

console.log('\n12) 源请求（假 fetch · 不出网）');
{
  const calls = [];
  const fake = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, headers: (init && init.headers) || {} });
    if (u.includes('/schedule/full')) {
      return new Response(JSON.stringify(TVMAZE_FULL), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/pgc/web/timeline')) {
      return new Response(JSON.stringify(BILI_JSON), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/j/search_subjects')) {
      return new Response(JSON.stringify(HK_JSON), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/\.jpg$/.test(u)) {
      return new Response(Buffer.alloc(1024, 3), { status: 200 });
    }
    return new Response(doubanHtml(), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const coverDir = path.join(__dirname, '.tmp-fetch-follow-cli/covers-inline');
  const p = await fetchFollow({
    date: '2026-11-16',
    days: 1,
    cities: [{ name: '北京', slug: 'beijing' }],
    fetchImpl: fake,
    dryRun: true,
    cityDelayMs: 0,
    coverDelayMs: 0,
    coverDir,
  });

  const tvmazeCall = calls.find((c) => c.url.includes('/schedule/full'));
  check('源：走的是 /schedule/full（不是 /schedule?country=）', !!tvmazeCall, JSON.stringify(calls.map((c) => c.url)));
  check('源：/schedule/full 不带 country 参数', !tvmazeCall.url.includes('country='), tvmazeCall.url);
  check('源：/schedule/full 带 date 参数', /[?&]date=\d{4}-\d{2}-\d{2}/.test(tvmazeCall.url), tvmazeCall.url);

  const biliCall = calls.find((c) => c.url.includes('/pgc/web/timeline'));
  check('源：B站请求带 Referer', biliCall.headers.Referer === 'https://www.bilibili.com/', String(biliCall.headers.Referer));

  const hkCall = calls.find((c) => c.url.includes('/j/search_subjects'));
  check('源：豆瓣港剧请求带 Referer', hkCall.headers.Referer === 'https://movie.douban.com/', String(hkCall.headers.Referer));

  const doubanCall = calls.find((c) => c.url.includes('/location/beijing/events'));
  check('Referer：豆瓣请求确实发出去了', !!doubanCall, JSON.stringify(calls.map((c) => c.url)));
  check('Referer：豆瓣同城请求带 Referer', !!doubanCall && /\/location\/beijing\/?$/.test(String(doubanCall.headers.Referer || '')), doubanCall ? String(doubanCall.headers.Referer) : '没这个请求');
  check('Referer：TVmaze 请求不带豆瓣 Referer', !tvmazeCall.headers.Referer, JSON.stringify(tvmazeCall.headers));
  check('Referer：豆瓣 Referer 默认指向 douban.com', /douban\.com\/location\/beijing\/$/.test(doubanReferer('beijing')), doubanReferer('beijing'));

  /* 封面下载也要带 Referer（不带就是 418） */
  const imgCall = calls.find((c) => /\.jpg$/.test(c.url));
  check('Referer：豆瓣封面下载带 Referer', !!imgCall && imgCall.headers.Referer === DOUBAN_IMAGE_REFERER, imgCall ? String(imgCall.headers.Referer) : '没有下载封面');

  /* 产出的 payload */
  eq('产出：schedule 条数（13 + B站 1 + 港剧 1）', p.schedule.length, 15);
  eq('产出：events 条数', p.events.length, 4);
  eq('产出：顶层 8 个键', Object.keys(p), PAYLOAD_FIELDS);
  eq('产出：channels 第一个是 Netflix', p.channels[0], 'Netflix');
  check('产出：港剧混排在平台里（不是独立板块）', p.channels.includes('港剧'), JSON.stringify(p.channels));
  check('产出：events 的封面是 local: 标记', p.events.every((e) => e.cover.startsWith('local:follow-covers/')), JSON.stringify(p.events.map((e) => e.cover)));
  check('产出：输出里没有 doubanio.com 的远程 URL', !JSON.stringify(p).includes('doubanio.com'), '');
}

/* ─────────────────────────── 13) 失败隔离 ─────────────────────────── */

console.log('\n13) 失败隔离');
{
  const fake = async (url) => {
    const u = String(url);
    if (u.includes('/location/beijing/events')) return new Response('gone', { status: 404 });
    if (u.includes('/schedule/full')) return new Response('gone', { status: 404 });
    if (u.includes('/pgc/web/timeline')) {
      return new Response(JSON.stringify(BILI_JSON), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/j/search_subjects')) {
      return new Response(JSON.stringify(HK_JSON), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/\.jpg$/.test(u)) return new Response(Buffer.alloc(1024, 3), { status: 200 });
    return new Response(doubanHtml(), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const p = await fetchFollow({
    date: '2026-11-16',
    days: 1,
    cities: [
      { name: '北京', slug: 'beijing' },
      { name: '上海', slug: 'shanghai' },
    ],
    fetchImpl: fake,
    dryRun: true,
    cityDelayMs: 0,
    coverDelayMs: 0,
    coverDir: path.join(__dirname, '.tmp-fetch-follow-cli/covers-inline'),
  });
  check('隔离：一个城市失败，其它城市照常', p.events.length === 4, String(p.events.length));
  check('隔离：失败的城市不产出条目', !p.events.some((e) => e.tag === '北京'), JSON.stringify(p.events.map((e) => e.tag)));
  check('隔离：失败的城市进 errors', p.errors.some((e) => e.includes('豆瓣同城(北京)')), JSON.stringify(p.errors));
  check('隔离：TVmaze 失败进 errors', p.errors.some((e) => e.includes(SCHEDULE_SOURCE)), JSON.stringify(p.errors));
  check('隔离：TVmaze 挂了但别的源照常', p.schedule.length === 2, String(p.schedule.length));

  /* 全挂 */
  const dead = async () => new Response('gone', { status: 404 });
  const p2 = await fetchFollow({
    date: '2026-11-16',
    days: 1,
    cities: [{ name: '北京', slug: 'beijing' }],
    fetchImpl: dead,
    dryRun: true,
    cityDelayMs: 0,
    coverDelayMs: 0,
    coverDir: path.join(__dirname, '.tmp-fetch-follow-cli/covers-inline'),
  });
  eq('隔离：全挂时两个板块都空', [p2.schedule.length, p2.events.length], [0, 0]);
  check('隔离：全挂时 errors 记满了', p2.errors.length >= 2, JSON.stringify(p2.errors));

  /* 源返回了 N 条却解析出 0 条 → 报「源结构可能变了」 */
  const broken = async (url) => {
    const u = String(url);
    if (u.includes('/schedule/full')) {
      return new Response(JSON.stringify([{ airdate: '2026-11-16', name: 'x' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/pgc/web/timeline')) {
      return new Response(JSON.stringify({ code: 0, result: [{ date: '2026-11-16', episodes: [] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/j/search_subjects')) {
      return new Response(JSON.stringify({ subjects: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/\.jpg$/.test(u)) return new Response(Buffer.alloc(1024, 3), { status: 200 });
    return new Response(doubanHtml(), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const p3 = await fetchFollow({
    date: '2026-11-16',
    days: 1,
    cities: [{ name: '北京', slug: 'beijing' }],
    fetchImpl: broken,
    dryRun: true,
    cityDelayMs: 0,
    coverDelayMs: 0,
    coverDir: path.join(__dirname, '.tmp-fetch-follow-cli/covers-inline'),
  });
  check(
    '结构自检：源返回了条目却解析出 0 条 → 报「源结构可能变了」',
    p3.errors.some((e) => e.includes('源结构可能变了')),
    JSON.stringify(p3.errors),
  );
  check('结构自检：出问题的源不产出条目', !p3.schedule.some((x) => x.title === 'x'), JSON.stringify(p3.schedule.map((x) => x.title)));
}

/* ─────────────────────────── 14) 兜底配置默认关闭 ─────────────────────────── */

console.log('\n14) 兜底通道默认关闭');
{
  const missing = loadFallbackConfig(path.join(__dirname, '不存在的兜底配置.json'));
  eq('兜底配置：文件不存在 → 通道关闭', missing.enabled, false);
  eq('兜底配置：文件不存在 → fallbacks 为空', missing.fallbacks.length, 0);
  const badFile = path.join(__dirname, '.tmp-fetch-follow-cli/badjson.json');
  fs.mkdirSync(path.dirname(badFile), { recursive: true });
  fs.writeFileSync(badFile, '{ 这不是 JSON ', 'utf8');
  const bad = loadFallbackConfig(badFile);
  eq('兜底配置：坏 JSON → 通道关闭且不抛', bad.enabled, false);
  check('兜底配置：坏 JSON 会记原因', /JSON/.test(bad.reason || ''), bad.reason);
}

/* ─────────────────────────── 15) CLI ─────────────────────────── */

/**
 * 异步跑 CLI。
 *
 * 为什么要异步不能用 spawnSync：fixture server 就跑在本进程里，
 * spawnSync 会把本进程的事件循环堵死 —— server 没法回话，子进程一直等，
 * 父进程一直等子进程 → **死锁**（踩过）。
 */
function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: opts.env || process.env,
    });
    let out = '';
    let err = '';
    /* 超时兜底：CLI 卡死时不能把整份护栏吊死 —— 直接杀掉并把子进程输出带回来 */
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 杀不掉就算了 */
      }
      resolve({ status: -1, stdout: out, stderr: err + '\n[护栏] CLI 超时未退出' });
    }, opts.timeoutMs || 30000);
    child.stdout.on('data', (d) => {
      out += d;
      if (process.env.FETCH_FOLLOW_TEST_TRACE) process.stderr.write(`[cli] ${d}`);
    });
    child.stderr.on('data', (d) => {
      err += d;
      if (process.env.FETCH_FOLLOW_TEST_TRACE) process.stderr.write(`[cli-err] ${d}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout: out, stderr: err });
    });
  });
}

console.log('\n15) CLI 入口');
{
  const help = spawnSync(process.execPath, [CLI_PATH, '--help'], { encoding: 'utf8' });
  check('CLI：--help → exit 0', help.status === 0, `exit=${help.status}`);
  check('CLI：--help 打印用法', /--dry-run/.test(help.stdout || ''), (help.stdout || '').trim().slice(0, 120));

  const bad = spawnSync(process.execPath, [CLI_PATH, '--date', '2026-1-1'], { encoding: 'utf8' });
  check('CLI：日期格式不对 → exit 非 0', bad.status !== 0, `exit=${bad.status}`);
  check(
    'CLI：日期格式不对 → 打印用法',
    /用法/.test((bad.stdout || '') + (bad.stderr || '')),
    ((bad.stdout || '') + (bad.stderr || '')).trim().slice(0, 120),
  );

  const bad2 = spawnSync(process.execPath, [CLI_PATH, '--date', '2026-13-45'], { encoding: 'utf8' });
  check('CLI：不存在的日子 → exit 非 0', bad2.status !== 0, `exit=${bad2.status}`);

  // 15.1 全流程（本机 fixture server）
  let imgBase = 'https://img3.doubanio.com';
  const srv = await startServer((req, res) => {
    const u = String(req.url);
    if (u.startsWith('/schedule/full')) {
      const d = new URL(u, 'http://x').searchParams.get('date') || '2026-11-16';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(tvmazeForDate(d)));
      return;
    }
    if (u.startsWith('/pgc/web/timeline')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(BILI_JSON));
      return;
    }
    if (u.startsWith('/j/search_subjects')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(hkJson(`${srv.base}/img9.doubanio.com`)));
      return;
    }
    if (u.includes('doubanio.com/')) {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(Buffer.alloc(1024, 5));
      return;
    }
    if (u.includes('/events')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(doubanHtml(imgBase));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  /* 封面图床指向本机 fixture server —— URL 里仍然带 doubanio.com，
     这样「带 Referer 下载 + 写 local: 标记」这条路径能被真跑到，又不出网。 */
  imgBase = `${srv.base}/img3.doubanio.com`;

  /* 每次跑用**独立目录** —— 不能沿用同一个固定目录。
     原因（2026-11-16 实测）：沿用固定目录时，上一轮跑留下的封面文件会让这一轮
     CLI 认为「文件已存在」→ **跳过下载** → 「下载带了 Referer」那条断言
     只看到干跑那一次探测 → **空跑变绿**（连跑三次就能复现：前两次红、第三次绿）。
     一个会自己变绿的护栏等于没有护栏。独立目录让「上一轮的残留」根本不可能存在。

     ⚠ 下面两行的顺序也是修的：原来清理封面目录的那段用了 DATE，
       而 DATE 是在它**后面**才 `const` 声明的 → 运行时是 ReferenceError（TDZ），
       又被 `catch {}` 吞掉 → **清理从来没真正执行过**。 */
  const DATE = '2099-01-01';
  const DRY_DATE = '2099-01-02'; // 只给 --dry-run 用：这一天的目录永远不该被建出来
  const runId = `run-${process.pid}-${Date.now()}`;
  const imgRoot = path.join(__dirname, '.tmp-fetch-follow-cli/cli', runId);
  const env = {
    ...process.env,
    FETCH_FOLLOW_TVMAZE_BASE: srv.base,
    FETCH_FOLLOW_DOUBAN_BASE: srv.base,
    FETCH_FOLLOW_BILI_BASE: srv.base,
    FETCH_FOLLOW_DOUBAN_MOVIE_BASE: srv.base,
    FETCH_FOLLOW_CITY_DELAY_MS: '0',
    FETCH_FOLLOW_COVER_DELAY_MS: '0',
    IMAGE_ROOT: imgRoot,
  };
  const outFile = path.join(imgRoot, 'src', DATE, `follow_${DATE}.json`);
  /* 先删掉上一轮的产物 —— 万一这次 CLI 挂了，读到旧文件会给出误导性的「通过」；
     干跑那一天的目录也删掉：干跑不该建目录，有残留就说明上次的干跑留了东西。 */
  try {
    fs.rmSync(outFile, { force: true });
    fs.rmSync(path.join(imgRoot, 'src', DRY_DATE), { recursive: true, force: true });
  } catch {
    /* 删不掉就算了 */
  }

  const dry = await runCli(['--date', DRY_DATE, '--dry-run'], { env });
  eq('CLI：--dry-run exit 0', dry.status, 0);
  check('CLI：--dry-run 不写文件', !fs.existsSync(path.join(imgRoot, 'src', DRY_DATE, `follow_${DRY_DATE}.json`)), path.join(imgRoot, 'src', DRY_DATE));
  check('CLI：--dry-run 连目录都不建', !fs.existsSync(path.join(imgRoot, 'src', DRY_DATE)), path.join(imgRoot, 'src', DRY_DATE));
  check('CLI：--dry-run 打印统计', /频道更新/.test(dry.stdout || ''), (dry.stdout || '').trim().slice(0, 160));

  /* 只看**实跑这一段**的请求 —— 干跑只探一张（带 Referer），
     如果把干跑的探测混进来统计，实跑一旦没下载（残留文件让它跳过），
     「every(带 Referer)」就会**空跑变绿**。这里必须按段切。 */
  const reqsBeforeWet = srv.reqs.length;
  const wet = await runCli(['--date', DATE], { env });
  eq('CLI：正常跑 exit 0', wet.status, 0);
  check('CLI：正常跑会写文件', fs.existsSync(outFile), outFile);
  if (fs.existsSync(outFile)) {
    const j = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    eq('CLI：写出来的文件符合契约', Object.keys(j), PAYLOAD_FIELDS);
    eq('CLI：写出来的条目字段符合契约', Object.keys(j.schedule[0]), ITEM_FIELDS);
    // fixture：目标日 13 + 次日 2 + 第三日 13 = 28，加 B站 1 + 港剧 1 = 30；12 城 × 4 条 = 48
    eq('CLI：写出来的 schedule 条数', j.schedule.length, 30);
    eq('CLI：写出来的 events 条数', j.events.length, 48);
    eq('CLI：写出来的 date', j.date, DATE);
    eq('CLI：写出来的 cities 是 12 个', j.cities.length, 12);
    check('CLI：写出来的 channels 里有 Netflix', j.channels.includes('Netflix'), JSON.stringify(j.channels));
    check('CLI：写出来的 channels 里有港剧', j.channels.includes('港剧'), JSON.stringify(j.channels));
    check('CLI：写出来的封面是 local: 标记', j.events.every((e) => e.cover.startsWith('local:follow-covers/')), '');
    check('CLI：写出来的文件里没有 doubanio.com 的远程 URL', !JSON.stringify(j).includes('doubanio.com'), '');
  }
  const coverDir = path.join(imgRoot, 'src', DATE, 'follow-covers');
  check('CLI：封面真的落盘了', fs.existsSync(coverDir) && fs.readdirSync(coverDir).length > 0, coverDir);

  const doubanReq = srv.reqs.filter((r) => r.url.includes('/events'));
  check('CLI：豆瓣请求带了 Referer', doubanReq.length > 0 && doubanReq.every((r) => /\/location\/[a-z]+\/?$/.test(String(r.headers.referer || ''))), JSON.stringify(doubanReq.map((r) => r.headers.referer)));
  check('CLI：请求带了 Chrome UA', srv.reqs.every((r) => /Chrome\/\d+/.test(String(r.headers['user-agent'] || ''))), JSON.stringify(srv.reqs.map((r) => r.headers['user-agent'])));
  const imgReqs = srv.reqs.slice(reqsBeforeWet).filter((r) => r.url.includes('doubanio.com'));
  check('CLI：豆瓣封面真的下载了（实跑这一段自己发出的请求，不是干跑那一次探测）', imgReqs.length > 0, String(imgReqs.length));
  check('CLI：豆瓣封面下载带了 Referer', imgReqs.length > 0 && imgReqs.every((r) => String(r.headers.referer || '') === DOUBAN_IMAGE_REFERER), JSON.stringify(imgReqs.map((r) => r.headers.referer)));

  // 15.2 全挂 → exit 1
  const dead = await startServer((req, res) => {
    res.writeHead(404);
    res.end('nope');
  });
  const deadRoot = path.join(__dirname, '.tmp-fetch-follow-cli/dead');
  const deadRun = await runCli(['--date', '2099-01-03'], {
    env: { ...env, IMAGE_ROOT: deadRoot, FETCH_FOLLOW_TVMAZE_BASE: dead.base, FETCH_FOLLOW_DOUBAN_BASE: dead.base, FETCH_FOLLOW_BILI_BASE: dead.base, FETCH_FOLLOW_DOUBAN_MOVIE_BASE: dead.base },
  });
  check('CLI：全挂 → exit 非 0', deadRun.status !== 0, `exit=${deadRun.status}`);
  check('CLI：全挂 → 不写空文件', !fs.existsSync(path.join(deadRoot, 'src', '2099-01-03', 'follow_2099-01-03.json')));
  await dead.close();
  await srv.close();
}

/* 收尾：清掉测试自己造的临时目录。
   ⚠️ 不清的话**每跑一次回归就在工程里堆一坨垃圾**（夹具 + 按 `run-<pid>-<ts>`
   分的 CLI 运行目录，会一轮轮累积）—— 2026-11-16 回归后发现它躺在 tools\ 里没走掉。
   判据：跑完这个目录不该存在。 */
try {
  fs.rmSync(path.join(__dirname, '.tmp-fetch-follow-cli'), { recursive: true, force: true });
} catch { /* 删不掉就算了，不影响判定 */ }

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
