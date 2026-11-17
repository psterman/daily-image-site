#!/usr/bin/env node
/**
 * 护栏：榜单 tab（听乐 / 看片）
 *
 * 这个功能是 2026-11-16 加的第二个**文本型 tab**（第一个是见报）。
 * 它同时踩了四类坑，每一类都值得钉死：
 *
 *   1. 形态 —— 榜单 tab 的产物**不在 r2 母本里**（封面是外站热链）。
 *      被当成图片 tab 的话，构建自检会去母本里找它的图 → 直接拒绝生成 manifest，
 *      --keep-manifest 更是直接拒绝构建。所以 type 字段和 tab-kinds.mjs 的判定
 *      必须一起改对，不能只改一头。
 *
 *   2. 契约 —— 栏目的 key / label 必须写成**字符串字面量**。
 *      tools/test-contract.mjs 靠正则从 build.mjs 源码里抠「栏目 → 中文名」，
 *      抠不到就没有任何保护：留言板上会显示内部 key 而不是「听乐」「看片」，
 *      而且**不报任何错**。
 *
 *   3. 前端分支 —— gridClass 的 grid-rank、渲染分叉、.rank-no / .rank-cover /
 *      .rank-sep 少一处，榜单就会掉进图片 tab 的渲染路径（整页变成图片网格）。
 *
 *   4. 安全 —— 榜单的 link / cover 是**外部来的**，必须做协议校验
 *      （只允许 http(s):，不能是 javascript:）。封面更不能套见报那套
 *      newsImgSrc —— 那套只认 '/' 开头的站内路径，用在远程封面上会把封面全洗掉。
 *
 * 全部离线：不联网、不读线上站点、不跑构建、不碰线上产物。
 *
 * 变异测试入口：环境变量指向别的文件时，本护栏就对着那个文件跑
 * （tools/test-rank-tab-mutate.mjs 用这个机制验证「护栏能抓住坏版本」）。
 *
 * 2026-11-16 v3：「追更」tab **取消了**（站点从 7 个 tab 变成 6 个）：
 * 见闻 / 见她 / 见笑 / 见报 / 听乐 / 看片。
 * 追更的两块内容（schedule 频道更新、events 本地演出）
 * 整体并进「看片」，于是「看片」这一个 tab 现在吃**五段**数据：
 *
 *     频道更新 → 电影 → B站热门 → 抖音热门 → 本地演出      （共 440 条）
 *
 * 段顺序 = 用户看到的 chip 顺序（前端 renderChips 按条目在列表里的
 * 出现顺序现推 chip，**不排序**），所以拼接顺序写错 → 目录顺序悄悄变，
 * 而且**不报任何错**。第 12 段专门钉这一条，外加分项上限、合并重编号、
 * 降级（源文件缺失要跳过）、封面本地化、chip 现推这几件事。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 变异测试入口：给了环境变量就用那个文件，否则用生产文件。 */
function srcPath(envName, defRel) {
  const v = process.env[envName];
  if (!v) return path.join(ROOT, defRel);
  return path.isAbsolute(v) ? v : path.resolve(ROOT, v);
}

const BUILD = fs.readFileSync(srcPath('RANK_BUILD_MJS', 'tools/build.mjs'), 'utf8');
const APPJS = fs.readFileSync(srcPath('RANK_APP_JS', 'site/app.js'), 'utf8');
const APPCSS = fs.readFileSync(srcPath('RANK_APP_CSS', 'site/app.css'), 'utf8');
const BOARD = fs.readFileSync(srcPath('RANK_BOARD_HTML', 'site/board.html'), 'utf8');
const VERIFY_NEWS = fs.readFileSync(srcPath('RANK_VERIFY_NEWS', 'tools/verify-news.mjs'), 'utf8');
const VERIFY_BUILD = fs.readFileSync(srcPath('RANK_VERIFY_BUILD', 'tools/verify-build.mjs'), 'utf8');
const R2PRUNE = fs.readFileSync(srcPath('RANK_R2_PRUNE', 'tools/r2-prune.mjs'), 'utf8');
const ORPHAN_CLEAN = fs.readFileSync(srcPath('RANK_ORPHAN_CLEAN', 'tools/orphan-clean.mjs'), 'utf8');
const FETCH_RANK = fs.readFileSync(srcPath('RANK_FETCH_RANK', 'tools/fetch-rank.mjs'), 'utf8');
const FETCH_FOLLOW = fs.readFileSync(srcPath('RANK_FETCH_FOLLOW', 'tools/fetch-follow.mjs'), 'utf8');
const { TEXT_TAB_TYPES, isMediaTab, isTextTab } = await import(
  pathToFileURL(srcPath('RANK_TAB_KINDS', 'tools/tab-kinds.mjs')).href
);

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? '  —— ' + detail : ''}`);
  }
}

/** 抠出一段源码：从 fromMarker 到 toMarker（找不到就返回空串） */
function region(src, fromMarker, toMarker) {
  const a = src.indexOf(fromMarker);
  if (a < 0) return '';
  const b = toMarker ? src.indexOf(toMarker, a + fromMarker.length) : -1;
  return b < 0 ? src.slice(a) : src.slice(a, b);
}

/**
 * 类名是不是作为**完整 token** 出现过。
 * 不能用 includes —— '.rank-cover' 是 '.rank-cover-empty' 的子串，
 * 用子串判会以为样式还在（改名的样式照样能蒙混过关）。
 */
function hasClass(src, name) {
  return new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`).test(src);
}

/** 某个片段在源码里出现了几次（锚点必须唯一命中，见变异脚本的自检纪律）。 */
function countOf(src, needle) {
  let n = 0;
  let i = src.indexOf(needle);
  while (i >= 0) { n++; i = src.indexOf(needle, i + needle.length); }
  return n;
}

/**
 * 抠出源码里所有 catch 子句的**函数体**（大括号配对）。
 *
 * 为什么不能只看 "catch {"：catch 后面那一整段代码都会被算进去，
 * 里面的一个 throw 会被误判成「catch 里抛了」。
 * 这里用括号配对数一遍，只取 catch 自己的那一对大括号。
 */
function catchBodies(src) {
  const out = [];
  const re = /\bcatch\s*(\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(open + 1, i));
    re.lastIndex = i;
  }
  return out;
}

/**
 * 看板契约抠出来的「栏目 key → 中文名」。
 *
 * 跟 tools/test-contract.mjs 用**同一条正则**（最多跨 60 字符）：
 * 抠不到就说明这个栏目不受契约保护 —— 留言板上会显示内部 key，
 * 而且**不报任何错**。
 */
const contractPairs = [];
for (const m of BUILD.matchAll(/key:\s*'([a-z]+)'[\s\S]{0,60}?label:\s*'([^']+)'/g)) {
  contractPairs.push({ key: m[1], label: m[2] });
}
const contractOf = (k) => contractPairs.find((p) => p.key === k) || null;

/* board.html 的 TAB_LABELS（留言板拿 key 去换中文名）。 */
const boardTabLabels = {};
{
  const tm = BOARD.match(/var\s+TAB_LABELS\s*=\s*\{([^}]*)\}/);
  for (const m of (tm ? tm[1] : '').matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']*)'/g)) {
    boardTabLabels[m[1]] = m[2];
  }
}

/**
 * 榜单/追更条目的字段契约 —— fetch-rank.mjs 的 ITEM_FIELDS / build.mjs 的映射都按这个。
 *
 * 第 9 个字段 tags 是 2026-11-16 v2 加的：层级标签数组（'@<层号>:<值>'）。
 * 前端的多层 chip 全靠它 —— 少一个字段，筛选就只剩一排点不动的板块。
 */
const RANK_ITEM_FIELDS = ['rank', 'title', 'subtitle', 'meta', 'cover', 'link', 'source', 'tag', 'tags'];

console.log('\n1) tab 形态：榜单是文本型（产物不在 r2 母本里）');
{
  const rankTab = { key: 'music', label: '听乐', type: 'rank' };
  const imgTab = { key: 'jianxiao', label: '见笑' };
  check('isTextTab 对 type:\'rank\' 返回 true（否则构建会去母本里找它的图，直接拒绝出 manifest）',
    isTextTab(rankTab) === true, `实际=${isTextTab(rankTab)}`);
  check('isMediaTab 对 type:\'rank\' 返回 false',
    isMediaTab(rankTab) === false, `实际=${isMediaTab(rankTab)}`);
  check('图片 tab（没有 type 字段）isTextTab 返回 false（否则图片 tab 的产物不会被上传）',
    isTextTab(imgTab) === false, `实际=${isTextTab(imgTab)}`);
  check('图片 tab（没有 type 字段）isMediaTab 返回 true',
    isMediaTab(imgTab) === true, `实际=${isMediaTab(imgTab)}`);
  check('TEXT_TAB_TYPES 里登记了 \'rank\'（新增文本型 tab 必须登记，否则各处判定漏掉它）',
    Array.isArray(TEXT_TAB_TYPES) && TEXT_TAB_TYPES.includes('rank'),
    JSON.stringify(TEXT_TAB_TYPES));
}

console.log('\n2) build.mjs：两个榜单 tab 的定义');
/* v3：榜单 tab 不再是一个字面量数组，而是「空了才不 push」的两个定义块。
   区间取「const rankTabs = [];」到「for (const rt of rankTabs)」之间 ——
   这一段里正好是那两个 rankTabs.push({...}) 定义。 */
const rankBlock = region(BUILD, 'const rankTabs = [];', '\n  for (const rt of rankTabs)');
const rankDefs = [];
for (const m of rankBlock.matchAll(/rankTabs\.push\(\{([\s\S]*?)\n\s*\}\);/g)) {
  const key = (m[1].match(/key:\s*'([a-z]+)'/) || [])[1];
  if (key) rankDefs.push({ key, body: m[1] });
}
const defOf = (k) => rankDefs.find((d) => d.key === k) || null;
{
  check('build.mjs 里能抠出 music / movie 两个榜单 tab 的定义',
    !!defOf('music') && !!defOf('movie'),
    `抠到的 key：${rankDefs.map((d) => d.key).join(',') || '(一个都没有)'}`);
  check('榜单 tab **只有听乐 / 看片两个**（v3 起「追更」不再是独立 tab，不能有多余的第三个）',
    rankDefs.length === 2,
    `抠到 ${rankDefs.length} 个：${rankDefs.map((d) => d.key).join(',') || '(一个都没有)'}`);
}
{
  /* 用 test-contract.mjs 的**同一条正则**抠 —— 抠不到就是不受契约保护。 */
  const pairOf = contractOf;
  check('music 的 key/label 必须是字符串字面量（写成变量的话 test-contract.mjs 抠不到，新栏目就脱离契约保护）',
    !!pairOf('music'), `抠到的栏目：${contractPairs.map((p) => p.key).join(',') || '(一个都没有)'}`);
  check('movie 的 key/label 必须是字符串字面量',
    !!pairOf('movie'), `抠到的栏目：${contractPairs.map((p) => p.key).join(',') || '(一个都没有)'}`);
  check('music 的中文名是「听乐」',
    !!pairOf('music') && pairOf('music').label === '听乐',
    pairOf('music') ? `实际「${pairOf('music').label}」` : '抠不到');
  check('movie 的中文名是「看片」',
    !!pairOf('movie') && pairOf('movie').label === '看片',
    pairOf('movie') ? `实际「${pairOf('movie').label}」` : '抠不到');
}
{
  const music = defOf('music');
  const movie = defOf('movie');
  check('music 的 type 是 \'rank\'（写成别的值就会被当成图片 tab，构建自检去母本里找图）',
    !!music && /type:\s*'rank'/.test(music.body),
    music ? (music.body.match(/type:\s*'([^']+)'/) || [, '(没有 type 字段)'])[1] : '定义抠不到');
  check('movie 的 type 是 \'rank\'',
    !!movie && /type:\s*'rank'/.test(movie.body),
    movie ? (movie.body.match(/type:\s*'([^']+)'/) || [, '(没有 type 字段)'])[1] : '定义抠不到');
  check('两个榜单 tab 的中文名分别是「听乐」/「看片」',
    !!music && !!movie &&
      /label:\s*'听乐'/.test(music.body) && /label:\s*'看片'/.test(movie.body),
    `music=${music ? (music.body.match(/label:\s*'([^']+)'/) || [, '?'])[1] : '?'} movie=${movie ? (movie.body.match(/label:\s*'([^']+)'/) || [, '?'])[1] : '?'}`);
  check('两个榜单 tab 都定义了 search（音乐走 iTunes、影视跳豆瓣）',
    !!music && !!movie && /search:\s*\{/.test(music.body) && /search:\s*\{/.test(movie.body));
  check('音乐 tab 的 search 开着 itunes、影视 tab 开着 douban（回车行为全靠这两个开关分叉）',
    !!music && !!movie && /itunes:\s*true/.test(music.body) && /douban:\s*true/.test(movie.body));
  /* chips 不再写死在 tab 定义里：
     第 1 层（板块）的选项是**从条目的 @1: 标签现推**的（level1Chips）——
     换城市组、换平台都不用改前端；写死一份就有一排点不动的死 chip。
     断言放在第 4 段（那里能看到真正的 push 代码）。 */
}

console.log('\n3) build.mjs：单 tab 条目上限（防止 manifest 无限膨胀）');
{
  /* ⚠️ 上限是**按 tab 分别设的映射**，不是单个数字。
     影视榜的顺序是「豆瓣 250 条在前、B站 50 条在后」——
     统一卡 200 条的话，B站那 50 条视频会被整段砍掉，
     影视 tab 就只剩电影、没有视频了（2026-11-16 实踩）。
     2026-11-16 v2：听乐变多榜、看片拆成电影段 + 视频段，所以是三个分项。 */
  const capM = BUILD.match(/const\s+MAX_RANK_ITEMS\s*=\s*\{([\s\S]*?)\}\s*;/);
  check('MAX_RANK_ITEMS 常量存在（榜单条目每条约 150 字节，没有上限 manifest 会肉眼可见地变大）',
    !!capM, 'build.mjs 里找不到 const MAX_RANK_ITEMS = { ... };');
  const caps = {};
  if (capM) {
    for (const m of capM[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) caps[m[1]] = Number(m[2]);
  }
  check('上限按 tab 分别定义（music / movie / video 都有）',
    caps.music > 0 && caps.movie > 0 && caps.video > 0, JSON.stringify(caps));
  check('上限都是有限正数（≤800，manifest 不许无限膨胀）',
    Object.keys(caps).length > 0 && Object.values(caps).every((v) => v > 0 && v <= 800),
    JSON.stringify(caps));
  check('影视 tab 的上限够放下猫眼 21 + 豆瓣 15（实测 36 条）',
    caps.movie >= 36, `movie 上限=${caps.movie}`);
  check('视频段的上限够放下 B站 50 + 抖音 50（实测 100 条）',
    caps.video >= 100, `video 上限=${caps.video}`);
  check('听乐的上限够放下 13 张榜的实测条数（550 条）',
    caps.music >= 550, `music 上限=${caps.music}`);
  check('**三个上限不是同一个数**（统一成一个数 = 把「哪一段被砍掉了」从代码上藏起来）',
    new Set([caps.music, caps.movie, caps.video]).size > 1, JSON.stringify(caps));
  check('music 的 list 用它自己的上限截断',
    /\.slice\(0,\s*MAX_RANK_ITEMS\.music\)/.test(BUILD),
    (BUILD.match(/.*MAX_RANK_ITEMS\.music.*/g) || []).join(' | '));
  check('movie 的 list 用它自己的上限截断',
    /\.slice\(0,\s*MAX_RANK_ITEMS\.movie\)/.test(BUILD),
    (BUILD.match(/.*MAX_RANK_ITEMS\.movie.*/g) || []).join(' | '));
  check('video 的 list 用它自己的上限截断',
    /\.slice\(0,\s*MAX_RANK_ITEMS\.video\)/.test(BUILD),
    (BUILD.match(/.*MAX_RANK_ITEMS\.video.*/g) || []).join(' | '));
}

console.log('\n4) build.mjs：榜单 item 的字段映射');
/* push 的代码块：从 for (const rt of rankTabs) 到 --keep-manifest 那一段之前。
   用这段而不是 manifest.tabs.push —— 文件里有好几处 push（图片 tab / 榜单 …），
   按出现顺序抠会抠到图片 tab 那处，断言就全在检查不相干的东西。 */
const pushBody = region(BUILD, 'for (const rt of rankTabs) {', '\n  /* --- --keep-manifest');
/* 字段映射现在收在 rankItem() 里（榜单和追更共用一套契约） */
const mapBody = region(BUILD, 'function rankItem(it) {', '\n}\n');
const mappedFields = [
  ...mapBody.matchAll(/(?:^|[\s,{])(\w+):\s*(?:it\.|flattenTags\(it\.)(\w+)/g),
].map((m) => m[1]);
{
  check('manifest 的榜单 item 映射抠得到', !!mapBody, 'build.mjs 里找不到 function rankItem(it)');
  check('映射出来的字段就是契约里的那 9 个（少一个字段前端就渲染不出对应信息）',
    mappedFields.length === RANK_ITEM_FIELDS.length &&
      RANK_ITEM_FIELDS.every((f) => mappedFields.includes(f)),
    `实际=${mappedFields.join(',') || '(空)'}；应该是=${RANK_ITEM_FIELDS.join(',')}`);
  check('tags 必须透传（多层 chip 全靠它；丢了就只剩一排点不动的板块）',
    /tags:\s*flattenTags\(it\.tags\)/.test(mapBody),
    (mapBody.match(/tags:[^\n]*/) || [, '(没有 tags 字段)'])[0]);
  check('cover 直接取自榜单 JSON（不是站内路径拼出来的）',
    /cover:\s*it\.cover/.test(mapBody),
    mapBody ? (mapBody.match(/cover:[^\n]*/) || [, '(没有 cover 字段)'])[0] : '(映射抠不到)');
  check('link 直接取自榜单 JSON（不是站内路径拼出来的）',
    /link:\s*it\.link/.test(mapBody),
    mapBody ? (mapBody.match(/link:[^\n]*/) || [, '(没有 link 字段)'])[0] : '(映射抠不到)');
  check('榜单数据来自 rank_<日期>.json（构建期抓、运行时零请求）',
    /rank_\$\{date\}\.json/.test(BUILD),
    "build.mjs 里找不到 rank_${date}.json");
  check('榜单 tab 定义里没有拼站内图片路径（封面是外站热链，不能写成 /img/...）',
    !/\/img\//.test(rankBlock),
    rankBlock.match(/.*\/img\/.*/g)?.join(' | ') || '');
  check('manifest 里榜单 tab 真的带上了 type（push 的时候写 type: rt.type，type 才会真的进 manifest）',
    /type:\s*rt\.type/.test(pushBody),
    pushBody ? (pushBody.match(/type:[^\n]*/) || [, '(没有 type)'])[0] : '(push 抠不到)');
  check('榜单 tab 的 chips 是**从条目现推**的（level1Chips），不是写死的一份',
    /chips:\s*level1Chips\(/.test(pushBody),
    (pushBody.match(/chips:[^\n]*/) || [, '(没有 chips 字段)'])[0]);
  check('榜单条目走的是**统一的**字段映射（rankItem）—— 两处各写各的，契约迟早会分叉',
    /items:\s*rt\.list\.map\(rankItem\)/.test(pushBody) &&
      countOf(BUILD, 'function rankItem(') === 1,
    (BUILD.match(/.*items:.*map\(.*/g) || []).slice(0, 6).join(' | '));
}

console.log('\n5) 离线 fixture manifest：榜单 item 的形状');
{
  /* 自己造一份符合 build.mjs 产出形状的 manifest —— 不依赖线上产物、不依赖构建。 */
  const fixture = {
    date: '2026-11-16',
    generatedAt: '2026-11-16T00:00:00.000Z',
    tabs: [
      {
        key: 'music', label: '听乐', accent: '#a78bfa', count: 2, type: 'rank',
        chips: [{ tag: '中文榜', label: '中文榜' }],
        search: { placeholder: '搜歌名或歌手 · 回车全网搜', itunes: true },
        items: [
          { rank: 1, title: '晴天', subtitle: '周杰伦', meta: '叶惠美', cover: 'https://p2.music.126.net/abc.jpg', link: 'https://music.163.com/#/song?id=1', source: '网易云热歌榜', tag: '热歌榜', tags: ['@1:中文榜', '@2:热歌榜'] },
          { rank: 2, title: 'Love Story', subtitle: 'Taylor Swift', meta: 'Lover', cover: 'https://is1-ssl.mzstatic.com/image/thumb/x/200x200bb.jpg', link: 'https://music.163.com/#/song?id=2', source: '网易云热歌榜', tag: '热歌榜', tags: ['@1:中文榜', '@2:热歌榜'] },
        ],
      },
      {
        /* v3：看片 tab 现在是五段合并，chip（大目录）有五个，
           顺序跟 build.mjs 的拼接顺序一致。 */
        key: 'movie', label: '看片', accent: '#fb923c', count: 5, type: 'rank',
        chips: [
          { tag: '频道更新', label: '频道更新' },
          { tag: '电影', label: '电影' },
          { tag: 'B站热门', label: 'B站热门' },
          { tag: '抖音热门', label: '抖音热门' },
          { tag: '本地演出', label: '本地演出' },
        ],
        search: { placeholder: '搜剧名/片名/演出名 · 回车去豆瓣搜', douban: true },
        items: [
          { rank: 1, title: '三体 · 第二季', subtitle: '', meta: '腾讯视频', cover: '', link: 'https://www.douban.com/subject/26647087/', source: '追更', tag: '三体', tags: ['@1:频道更新', '@2:腾讯视频'] },
          { rank: 2, title: '肖申克的救赎', subtitle: 'The Shawshank Redemption', meta: '9.7 分', cover: '', link: 'https://movie.douban.com/subject/1292052/', source: '豆瓣Top250', tag: '正在放映', tags: ['@1:电影', '@2:正在放映'] },
          { rank: 3, title: '热门视频', subtitle: '', meta: '播放 100 万', cover: 'https://i0.hdslb.com/bfs/archive/x.jpg', link: 'https://www.bilibili.com/video/BV1xx', source: '哔哩哔哩', tag: 'B站热门', tags: ['@1:B站热门'] },
          { rank: 4, title: '抖音热词', subtitle: '', meta: '热度 100 万', cover: '', link: 'https://www.douyin.com/hot/1', source: '抖音', tag: '抖音热门', tags: ['@1:抖音热门'] },
          { rank: 5, title: '上海站 · 演唱会', subtitle: '', meta: '2026-12-01', cover: '', link: 'https://www.douban.com/event/1', source: '大麦', tag: '上海', tags: ['@1:本地演出', '@2:上海'] },
        ],
      },
      {
        key: 'jianxiao', label: '见笑', accent: '#f472b6', count: 1,
        items: [{ id: 'jianxiao_001', thumb: '/img/2026-11-16/jianxiao/aaaa_001_t.webp', full: '/img/2026-11-16/jianxiao/aaaa_001.webp' }],
      },
    ],
  };
  const rankTabs = fixture.tabs.filter((t) => t.type === 'rank');
  const imgTabs = fixture.tabs.filter((t) => !t.type);
  check('fixture 里有两个榜单 tab、一个图片 tab',
    rankTabs.length === 2 && imgTabs.length === 1,
    `榜单=${rankTabs.length} 图片=${imgTabs.length}`);
  check('榜单 tab 是文本型、图片 tab 是媒体型',
    rankTabs.every((t) => isTextTab(t) && !isMediaTab(t)) &&
      imgTabs.every((t) => isMediaTab(t) && !isTextTab(t)));
  const allItems = rankTabs.flatMap((t) => t.items);
  check('每个榜单 item 的 9 个字段都齐全',
    allItems.every((it) => RANK_ITEM_FIELDS.every((f) => f in it)),
    allItems.map((it) => Object.keys(it).join('/')).join(' | '));
  check('榜单 item 的 rank 是数字（前端要拿它当序号显示）',
    allItems.every((it) => typeof it.rank === 'number' && Number.isFinite(it.rank)),
    allItems.map((it) => `rank=${typeof it.rank}:${it.rank}`).join(' '));
  check('榜单 item 的文字字段都是字符串',
    allItems.every((it) => ['title', 'subtitle', 'meta', 'cover', 'link', 'source', 'tag']
      .every((f) => typeof it[f] === 'string')));
  check('榜单 item 的 tags 是**数组**（多层 chip 要按层取值，不是按字符串切）',
    allItems.every((it) => Array.isArray(it.tags)),
    allItems.map((it) => `tags=${typeof it.tags}`).join(' '));
  check('每个 tags 都形如 @<层号>:<非空文字>（前端按前缀认层）',
    allItems.every((it) => it.tags.every((t) => /^@[1-9]\d*:\S/.test(t))),
    allItems.map((it) => it.tags.join(' ')).join(' | '));
  check('每条恰好一个 @1:（板块是单选，多了就分不清这条属于哪一段）',
    allItems.every((it) => it.tags.filter((t) => t.indexOf('@1:') === 0).length === 1),
    allItems.map((it) => it.tags.join(' ')).join(' | '));
  check('层号从 1 开始连续（中间断一层，前端那一层就没有 chip）',
    allItems.every((it) => {
      const lv = it.tags.map((t) => Number(t.slice(1).split(':')[0])).sort((a, b) => a - b);
      return lv.length > 0 && lv.every((v, i) => v === i + 1);
    }),
    allItems.map((it) => it.tags.join(' ')).join(' | '));
  check('榜单 item **没有** thumb / full（文本型 tab 的产物不在 r2 母本里）',
    allItems.every((it) => !('thumb' in it) && !('full' in it)));
  check('榜单 cover 是远程 URL、站内路径或空串，绝不是别的协议（前端只放行 http(s)）',
    allItems.every((it) => it.cover === '' || /^https?:\/\//i.test(it.cover) || /^\/img\//.test(it.cover)),
    allItems.map((it) => it.cover).join(' | '));
  check('榜单 link 都是 http(s)（前端只放行这两种协议）',
    allItems.every((it) => /^https?:\/\//i.test(it.link)),
    allItems.map((it) => it.link).join(' | '));
  check('fixture 的字段集合跟 build.mjs 映射抠出来的字段集合一致（fixture 不能和生产代码各说各话）',
    JSON.stringify([...new Set(mappedFields)].sort()) === JSON.stringify([...RANK_ITEM_FIELDS].sort()),
    `fixture=${RANK_ITEM_FIELDS.sort().join(',')} 生产=${mappedFields.join(',')}`);
}

console.log('\n6) site/app.js：前端分支');
{
  const rankBranchCount = (APPJS.match(/tab\.type\s*===\s*'rank'/g) || []).length;
  check('app.js 里有 tab.type === \'rank\' 的分支（gridClass 与渲染分叉各一处）',
    rankBranchCount >= 2, `实际出现 ${rankBranchCount} 次`);
  check('gridClass 给榜单 tab 加了 grid-rank 类（不加的话榜单会掉进多列图片网格）',
    hasClass(APPJS, 'grid-rank'), 'app.js 里找不到 grid-rank');
  check('app.js 里有 .rank-no（条目序号）',
    hasClass(APPJS, 'rank-no'), 'app.js 里找不到 rank-no');
  check('app.js 里有 .rank-cover（榜单封面）',
    hasClass(APPJS, 'rank-cover'), 'app.js 里找不到 rank-cover');
  check('app.js 里有 .rank-sep（全网搜结果与本地榜单之间的分隔条）',
    hasClass(APPJS, 'rank-sep'), 'app.js 里找不到 rank-sep');
  check('app.js 里有 renderRank（榜单渲染入口）',
    /function\s+renderRank\s*\(/.test(APPJS), 'app.js 里找不到 function renderRank(');
  check('app.js 里有 rankRow（单条榜单条目）',
    /function\s+rankRow\s*\(/.test(APPJS), 'app.js 里找不到 function rankRow(');
  check('榜单封面走**独立的** IntersectionObserver（不进本站图片加载队列）',
    /function\s+getRankIo\s*\(/.test(APPJS) && /rankIo\s*=\s*new\s+IntersectionObserver/.test(APPJS),
    'app.js 里找不到 getRankIo / rankIo = new IntersectionObserver');
  check('app.css 有 .grid.grid-rank（榜单单列，压过多列规则）',
    hasClass(APPCSS, 'grid-rank'), 'app.css 里找不到 .grid.grid-rank');
  check('app.css 有 .rank-no',
    hasClass(APPCSS, 'rank-no'), 'app.css 里找不到 .rank-no');
  check('app.css 有 .rank-cover',
    hasClass(APPCSS, 'rank-cover'), 'app.css 里找不到 .rank-cover');
  check('app.css 有 .rank-sep',
    hasClass(APPCSS, 'rank-sep'), 'app.css 里找不到 .rank-sep');
}

console.log('\n7) site/app.js：iTunes 全网搜的 URL 与 fallback');
{
  const itunes = region(APPJS, 'function itunesSearch(', 'function itunesToItem(');
  check('iTunes 搜索地址是 itunes.apple.com/search（换域名就是换了个服务）',
    /https:\/\/itunes\.apple\.com\/search\?/.test(itunes), itunes.slice(0, 160));
  check('查询串带 media=music',
    /media=music/.test(itunes), '没有找到 media=music');
  check('查询串带 limit=20',
    /limit=20/.test(itunes), '没有找到 limit=20');
  check('term 被 encodeURIComponent 转义（不转义空格和中文会让整条 URL 失效）',
    /term='\s*\+\s*encodeURIComponent\(term\)/.test(itunes), itunes.slice(0, 200));
  check('先试 country=cn（简体优先）',
    /get\(base\s*\+\s*'&country=cn'\)/.test(itunes), '没找到 get(base + \'&country=cn\')');
  check('cn 搜不到时退回不带 country 的同一个 URL（实测 country=cn 对英文词一条都搜不到）',
    /get\(base\)/.test(itunes), '没找到 get(base) 这条 fallback');
  check('fallback 的 URL 里不含 country=cn（带了就等于没退回）',
    (itunes.match(/country=cn/g) || []).length === 1,
    `country=cn 出现 ${(itunes.match(/country=cn/g) || []).length} 次`);
  check('cn 尝试排在 fallback 前面',
    itunes.indexOf("get(base + '&country=cn')") >= 0 &&
      itunes.indexOf("get(base + '&country=cn')") < itunes.indexOf('get(base)'));
  check('退回与否看 resultCount（resultCount 为 0 才退回，不是看有没有 results 数组）',
    /resultCount/.test(itunes), '没找到 resultCount');
  check('iTunes 结果的封面从 100x100 换成 200x200（高分屏下 100px 会糊）',
    /100x100bb['"]\s*,\s*['"]200x200bb/.test(region(APPJS, 'function itunesToItem(', 'function rankRow(')),
    '没找到 100x100bb -> 200x200bb');
  check('影视 tab 回车跳豆瓣搜索页（搜索发生在豆瓣那边，本站零消耗）',
    /https:\/\/search\.douban\.com\/movie\/subject_search\?search_text='\s*\+\s*encodeURIComponent\(term\)/.test(APPJS),
    '没找到豆瓣搜索跳转');
}

console.log('\n8) 封面不能套见报那套 newsImgSrc');
{
  const rankRegion = region(APPJS, 'function rankRow(', 'function enqueueLoad(');
  const headlinesRegion = region(APPJS, 'function renderHeadlines(', 'function getRankIo(');
  const newsSrcRegion = region(APPJS, 'function newsImgSrc(', 'function renderHeadlines(');
  check('newsImgSrc 只接受站内绝对路径（以 / 开头）—— 拿它处理远程封面会把封面全洗掉',
    newsSrcRegion.includes("s.charAt(0) !== '/'"),
    newsSrcRegion.slice(0, 200));
  check('newsImgSrc 仍然被见报用着（不能为了躲这条断言把见报的图也删了）',
    headlinesRegion.includes('newsImgSrc('), 'renderHeadlines 里没有 newsImgSrc(');
  check('newsImgSrc **没有**被用在榜单渲染里（renderRank / rankRow）',
    !rankRegion.includes('newsImgSrc'),
    rankRegion.match(/.*newsImgSrc.*/g)?.join(' | ') || '');
  check('榜单封面直接用 it.cover（远程 URL 热链）',
    /setAttribute\(\s*'data-src',\s*it\.cover\s*\)/.test(rankRegion),
    rankRegion.match(/.*data-src.*/g)?.join(' | ') || '');
  check('榜单封面懒加载用榜单自己的 observer（getRankIo），不是本站的图片队列',
    /getRankIo\(\)/.test(rankRegion), 'rankRow 里没有 getRankIo()');
}

console.log('\n9) 远程 link 的协议校验');
{
  const rankRegion = region(APPJS, 'function rankRow(', 'function enqueueLoad(');
  const headRegion = region(APPJS, 'function renderHeadlines(', 'function renderRank(');
  const safeRegion = region(APPJS, 'function safeHref(', 'function gridClass(');
  check('app.js 里有 safeHref 这个统一的协议校验函数（挡住 javascript: 这类伪协议）',
    /function\s+safeHref\s*\(/.test(APPJS) && /\/i\.test\(link\)/.test(safeRegion),
    'app.js 里找不到 safeHref / /^https?:\\/\\//i 的校验');
  check('榜单的 it.link 走 safeHref（榜单 link 来自外部，必须校验）',
    /safeHref\(it\.link\)/.test(rankRegion),
    rankRegion.match(/.*it\.link.*/g)?.join(' | ') || '');
  check('见报的 it.link 也走同一个 safeHref（规则只定义一处，别各写各的）',
    /safeHref\(it\.link\)/.test(headRegion),
    headRegion.match(/.*it\.link.*/g)?.join(' | ') || '');
  check('校验不过就不给链接（降级成不可点的纯文本，不把脏 href 塞进 DOM）',
    /return\s+''\s*;/.test(safeRegion),
    safeRegion.replace(/\s+/g, ' ').slice(0, 200));
}

console.log('\n10) board.html 的 TAB_LABELS');
{
  const tm = BOARD.match(/var\s+TAB_LABELS\s*=\s*\{([^}]*)\}/);
  check('board.html 里抠得到 TAB_LABELS', !!tm);
  const labels = boardTabLabels;
  check('TAB_LABELS 里有 music 的中文名「听乐」（留言板上不能显示内部 key）',
    labels.music === '听乐', `实际=${labels.music}`);
  check('TAB_LABELS 里有 movie 的中文名「看片」',
    labels.movie === '看片', `实际=${labels.movie}`);
  const musicDef = defOf('music');
  const movieDef = defOf('movie');
  const buildLabel = (d) => (d ? (d.body.match(/label:\s*'([^']+)'/) || [, ''])[1] : '');
  check('build.mjs 里的 music 中文名跟 board.html 一致',
    labels.music === buildLabel(musicDef) && buildLabel(musicDef) !== '',
    `build.mjs=${buildLabel(musicDef) || '?'} board.html=${labels.music}`);
  check('build.mjs 里的 movie 中文名跟 board.html 一致',
    labels.movie === buildLabel(movieDef) && buildLabel(movieDef) !== '',
    `build.mjs=${buildLabel(movieDef) || '?'} board.html=${labels.movie}`);
  check('board.html 的 TAB_LABELS 里**没有** follow（追更已经不是栏目了，留着会让留言板以为它还在）',
    !('follow' in labels), `实际有：${Object.keys(labels).join(',')}`);
}

console.log('\n11) verify-news.mjs：tab 数不能写死');
{
  check('verify-news.mjs 判的是 tabs.length >= 4（加了榜单那一期是 6 个 tab，写死 4 会把好的一期判成坏的）',
    VERIFY_NEWS.includes('tabs.length >= 4'), "verify-news.mjs 里找不到 tabs.length >= 4");
  check('verify-news.mjs 里没有 tabs.length === 4（写死了就会误判加了榜单的期数）',
    !VERIFY_NEWS.includes('tabs.length === 4'), 'verify-news.mjs 里还有 tabs.length === 4');
  check('verify-news.mjs 逐个检查 music / movie 两个榜单 tab（有就必须有、徽标数 > 0）',
    /\[(?:'music'|"music")\s*,\s*(?:'movie'|"movie")\]/.test(VERIFY_NEWS),
    "verify-news.mjs 里找不到 ['music', 'movie']");
  check('verify-news.mjs 里**没有** follow tab 的断言（v3 起追更不再是独立 tab，留着就是查一个不存在的 tab）',
    !/'follow'/.test(VERIFY_NEWS) && !/key\s*===\s*'follow'/.test(VERIFY_NEWS),
    (VERIFY_NEWS.match(/.*'follow'.*/g) || []).slice(0, 3).join(' | '));
  const chipLoopSection = region(VERIFY_NEWS, '榜单的多层 chip', 'await browser.close()');
  check('verify-news.mjs 的**多层 chip** 那段循环覆盖 movie（不覆盖的话看片的层级筛选坏了没人拦）',
    /for\s*\(\s*const\s+k\s+of\s*\[\s*(?:'music'|"music")\s*,\s*(?:'movie'|"movie")\s*\]\s*\)/.test(chipLoopSection),
    chipLoopSection
      ? (chipLoopSection.match(/for\s*\(const[^)]*\)/g) || ['(找不到循环)']).join(' | ')
      : '(抠不到「榜单的多层 chip」那段)');
}

console.log('\n12) 看片 tab：五段合并（频道更新 / 电影 / B站热门 / 抖音热门 / 本地演出）');
/* v3：「追更」tab **取消了**（站点从 7 个 tab 变成 6 个）。
   追更的两块内容（schedule 频道更新、events 本地演出）整体并进「看片」，
   于是「看片」这一个 tab 现在吃**五段**数据，拼接顺序**就是**用户看到的目录顺序：

     频道更新 → 电影 → B站热门 → 抖音热门 → 本地演出      （共 440 条）

   为什么顺序这么要紧：前端的 chip 是**按条目在列表里的出现顺序现推**的
   （site/app.js 的 renderChips 只去重、**不排序**），
   所以 build.mjs 里的拼接顺序 = 用户看到的目录顺序。
   顺序写错了没有任何报错，只是目录顺序悄悄变了 —— 最该钉死的一条。

   跟着来的几个坑：
     1. 五段各自从 1 开始编号 → 合并后必须**统一重编号**（否则有两个「1」）
     2. 上限必须**分项**、而且**在拼接之前**生效（拼完再截 = 后半段整段没了）
     3. follow_<日期>.json 不存在时要**跳过**不是报错（往期重构建没有这个文件）
     4. 豆瓣演出图 418 → 合并后的列表必须接封面本地化
     5. chip 必须**从条目现推**（level1Chips），不是写死一份 */

/* 三个区间（v3 之后的结构）：
     · 榜单块：读 rank_<日期>.json，分项截断
     · 追更块：读 follow_<日期>.json，分项截断（**只读数据，不 push tab**）
     · 看片合并块 + tab 组装 */
const rankDataBlock = region(BUILD, '/* --- 音乐榜 / 影视榜', '/* --- 追更数据');
const followDataBlock = region(BUILD, '/* --- 追更数据', '/* --- 看片：五段合并');
const watchMergeBlock = region(BUILD, '/* --- 看片：五段合并', '\n  /* --- --keep-manifest');

/* watchList 的定义：数组字面量 + 后面的 map。
   数组字面量里没有嵌套的 []，所以第一个 ']' 就是它的结尾。 */
const wlStart = BUILD.indexOf('const watchList = [');
const wlEnd = wlStart >= 0 ? BUILD.indexOf(']', wlStart) : -1;
const watchArr = wlStart >= 0 && wlEnd > wlStart ? BUILD.slice(wlStart, wlEnd + 1) : '';
const wlSemi = wlEnd >= 0 ? BUILD.indexOf(';', wlEnd) : -1;
const watchDecl = wlStart >= 0 && wlSemi > wlStart ? BUILD.slice(wlStart, wlSemi + 1) : '';
const watchMap = watchArr ? watchDecl.slice(watchArr.length) : '';
/* 拼接顺序：按数组字面量里出现的先后抠出每一段 */
const watchSegs = [...watchArr.matchAll(/\.\.\.\s*([A-Za-z_]\w*)/g)].map((m) => m[1]);
const EXPECT_SEGS = ['followSchedule', 'movieList', 'videoList', 'followEvents'];
const segPos = (name) => watchSegs.indexOf(name);

{
  /* ── 顺序：整个护栏最要紧的一段 ── */
  check('watchList 的拼接顺序**恰好**是 频道更新 → 电影 → B站热门 → 抖音热门 → 本地演出（数据顺序 = chip 顺序）',
    watchSegs.length === EXPECT_SEGS.length && watchSegs.every((s, i) => s === EXPECT_SEGS[i]),
    `实际顺序=${watchSegs.join(' → ') || '(抠不到 watchList)'}`);
  check('频道更新（followSchedule）排在电影（movieList）前面',
    segPos('followSchedule') >= 0 && segPos('movieList') >= 0 && segPos('followSchedule') < segPos('movieList'),
    `schedule=${segPos('followSchedule')} movie=${segPos('movieList')}`);
  check('视频段（B站/抖音）排在本地演出（followEvents）前面',
    segPos('videoList') >= 0 && segPos('followEvents') >= 0 && segPos('videoList') < segPos('followEvents'),
    `video=${segPos('videoList')} events=${segPos('followEvents')}`);
  check('五段一个都不能少（少一段 = 那一整个大目录从站上消失，而且不报任何错）',
    EXPECT_SEGS.every((s) => watchSegs.includes(s)),
    `缺=${EXPECT_SEGS.filter((s) => !watchSegs.includes(s)).join(',') || '无'}`);
  check('拼接里没有多出来的段（多一个 = 目录顺序被插队）',
    watchSegs.length > 0 && watchSegs.every((s) => EXPECT_SEGS.includes(s)),
    `多=${watchSegs.filter((s) => !EXPECT_SEGS.includes(s)).join(',') || '无'}`);
  check('拼接之后**没有**再排序（前端按出现顺序现推 chip，sort 会打乱目录顺序）',
    !/\.sort\s*\(/.test(watchDecl), (watchDecl.match(/.*\.sort.*/g) || []).join(' | '));
  check('合并结果直接进看片 tab（看片的 list 就是本地化后的 watchList，不是别处凑的）',
    /list:\s*locWatch\.items/.test(watchMergeBlock) && /key:\s*'movie'/.test(watchMergeBlock),
    (watchMergeBlock.match(/.*list:.*/g) || []).join(' | '));
}
{
  /* ── 合并：统一重编号 ── */
  check('五段合并后**统一重编号**成 1..K（每段各自从 1 开始，不重排就会出现两个「1」）',
    /\.map\(\s*\(\s*it\s*,\s*i\s*\)\s*=>\s*\(\s*\{\s*\.\.\.it\s*,\s*rank:\s*i\s*\+\s*1\s*\}\s*\)\s*\)/.test(watchMap),
    watchMap.replace(/\s+/g, ' ').slice(0, 160) || '(找不到 watchList 的 map)');
  check('重编号是**覆盖**原来的 rank（保留原 rank 的话每段都从 1 开始，序号会重复）',
    /rank:\s*i\s*\+\s*1/.test(watchMap) && !/rank:\s*it\.rank/.test(watchMap),
    watchMap.replace(/\s+/g, ' ').slice(0, 160));
  /* ── 形态：看片 tab 仍然是文本型 ── */
  const movieTabShape = { key: 'movie', label: '看片', type: 'rank' };
  check('看片 tab 是文本型（isTextTab 返回 true、isMediaTab 返回 false）',
    isTextTab(movieTabShape) === true && isMediaTab(movieTabShape) === false,
    `isTextTab=${isTextTab(movieTabShape)} isMediaTab=${isMediaTab(movieTabShape)}`);
  check('看片 tab 的 type 是 \'rank\'（写成别的值就会被当成图片 tab，构建自检去母本里找它的图）',
    !!defOf('movie') && /type:\s*'rank'/.test(defOf('movie').body),
    defOf('movie')
      ? ((defOf('movie').body.match(/type:\s*'([^']+)'/) || [, '(没有 type 字段)'])[1])
      : '定义抠不到');
  check('verify-build.mjs 跳过文本型 tab 的 full/thumb 核对（榜单条目是远程链接，不跳过就会被判成缺 full/thumb）',
    /if\s*\(\s*isTextTab\(\s*tab\s*\)\s*\)\s*\{/.test(VERIFY_BUILD),
    'verify-build.mjs 里找不到 if (isTextTab(tab)) {');
  check('verify-build.mjs **但没跳过本地化的封面**（豆瓣封面在母本里；引用了却不存在 = 线上空格子，构建日志照样报成功）',
    /it\.cover/.test(region(VERIFY_BUILD, 'if (isTextTab(tab)) {', '\n    }\n')) &&
      /r2Date/.test(region(VERIFY_BUILD, 'if (isTextTab(tab)) {', '\n    }\n')),
    (VERIFY_BUILD.match(/.*封面.*/g) || []).slice(0, 3).join(' | '));
}
{
  /* ── 芯片：从条目的 @1: 标签现推（level1Chips）──
     城市会变（换城市组）、平台会变，写死一份就有一排点不动的死 chip。 */
  const chipsExpr = (pushBody.match(/chips:[^\n]*/) || [''])[0];
  check('看片 tab 的 chips 是**从条目现推**的（level1Chips(rt.list)），不是写死一份',
    /chips:\s*level1Chips\(\s*rt\.list\s*\)/.test(pushBody), chipsExpr);
  check('chips 表达式里没有写死的中文城市名 / 平台名（城市组、平台会变，写死就过期了）',
    !/'[^']*[\u4e00-\u9fa5][^']*'/.test(chipsExpr), chipsExpr);
  const level1ChipsBody = region(BUILD, 'function level1Chips(items) {', '\n}\n');
  check('level1Chips 产出的 chip 是 tag / label 同名（前端按 data-tag 过滤，两者必须一致）',
    /\{\s*tag:\s*v\s*,\s*label:\s*v\s*\}/.test(level1ChipsBody),
    level1ChipsBody.replace(/\s+/g, ' ').slice(0, 200));
  check('level1Chips 取的是 @1: 层（板块层），不是别的层',
    /@1:/.test(level1ChipsBody) && !/@2:/.test(level1ChipsBody),
    level1ChipsBody.replace(/\s+/g, ' ').slice(0, 200));
  check('level1Chips 按条目出现顺序去重、**不排序**（chip 顺序 = 数据顺序）',
    /seen\.has\(v\)/.test(level1ChipsBody) && !/\.sort\s*\(/.test(level1ChipsBody),
    level1ChipsBody.replace(/\s+/g, ' ').slice(0, 200));
}
{
  const movieDef = defOf('movie');
  check('看片开着豆瓣搜索（回车去豆瓣搜剧名/片名/演出名，本站零消耗）',
    !!movieDef && /douban:\s*true/.test(movieDef.body),
    movieDef ? ((movieDef.body.match(/search:[^\n]*/) || [, '(没有 search)'])[0]) : '定义抠不到');
  check('看片的 search 有 placeholder（输入框提示语）',
    !!movieDef && /placeholder:\s*'[^']+'\s*,/.test(movieDef.body));
  check('看片的 items 走的是**同一个** rankItem 映射（五个大目录共用一套字段契约）',
    /items:\s*rt\.list\.map\(rankItem\)/.test(pushBody),
    (pushBody.match(/items:[^\n]*/) || [, '(没有 items)'])[0]);
  const fFields = mappedFields;
  check('看片 item 的 9 个字段跟榜单契约一致（少一个字段前端就渲染不出对应信息）',
    fFields.length === RANK_ITEM_FIELDS.length && RANK_ITEM_FIELDS.every((f) => fFields.includes(f)),
    `实际=${fFields.join(',') || '(空)'}；应该是=${RANK_ITEM_FIELDS.join(',')}`);
  check('条目的 tag 是**透传** it.tag（演出条目的 tag 是城市名，写死成「剧集更新」就分不出城市了）',
    /tag:\s*it\.tag/.test(mapBody) && !/tag:\s*'剧集更新'/.test(mapBody),
    (mapBody.match(/tag:[^\n]*/) || [, '(没有 tag 字段)'])[0]);
  check('条目的 cover / link 直接取自 JSON（不是站内路径拼出来的）',
    /cover:\s*it\.cover/.test(mapBody) && /link:\s*it\.link/.test(mapBody));
  check('看片 tab 定义里没有拼站内图片路径（封面要么外站热链、要么走本地化链路）',
    !/\/img\//.test(rankBlock), (rankBlock.match(/.*\/img\/.*/g) || []).join(' | '));
}
{
  /* ── 上限：分项，而且两个数**故意不一样** ── */
  const capM = BUILD.match(/const\s+MAX_FOLLOW_ITEMS\s*=\s*\{([\s\S]*?)\}\s*;/);
  const caps = {};
  if (capM) for (const m of capM[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) caps[m[1]] = Number(m[2]);
  check('MAX_FOLLOW_ITEMS 常量存在（追更条目没有上限的话 manifest 会肉眼可见地变大）',
    !!capM, 'build.mjs 里找不到 const MAX_FOLLOW_ITEMS = { ... };');
  check('上限按板块分项定义（schedule / events 都有）',
    caps.schedule > 0 && caps.events > 0, JSON.stringify(caps));
  check('两个上限都是有限正数且 ≤600',
    caps.schedule > 0 && caps.schedule <= 600 && caps.events > 0 && caps.events <= 600,
    JSON.stringify(caps));
  check('**两个板块的上限不是同一个数**（统一成一个数 = 把「哪一块被砍掉了」这件事藏起来）',
    caps.schedule > 0 && caps.events > 0 && caps.schedule !== caps.events,
    JSON.stringify(caps));
  const iSched = BUILD.indexOf('payload.schedule.slice(0, MAX_FOLLOW_ITEMS.schedule)');
  const iEvents = BUILD.indexOf('payload.events.slice(0, MAX_FOLLOW_ITEMS.events)');
  check('schedule 用自己的上限截断',
    iSched >= 0, 'build.mjs 里找不到 payload.schedule.slice(0, MAX_FOLLOW_ITEMS.schedule)');
  check('events 用自己的上限截断',
    iEvents >= 0, 'build.mjs 里找不到 payload.events.slice(0, MAX_FOLLOW_ITEMS.events)');
  const iMusicCap = BUILD.indexOf('rank.music.slice(0, MAX_RANK_ITEMS.music)');
  const iMovieCap = BUILD.indexOf('rank.movie.slice(0, MAX_RANK_ITEMS.movie)');
  const iVideoCap = BUILD.indexOf('rank.video.slice(0, MAX_RANK_ITEMS.video)');
  check('榜单三段也各自截断，而且**都在拼接之前**（movie / video 段直接进 watchList）',
    iMusicCap >= 0 && iMovieCap >= 0 && iVideoCap >= 0 && wlStart > iVideoCap,
    `music=${iMusicCap} movie=${iMovieCap} video=${iVideoCap} 拼接=${wlStart}`);
  check('是**先分项截断再拼接**（拼完统一截的话后半段会被整段砍掉 —— 影视榜 2026-11-16 实踩过）',
    iSched >= 0 && iEvents > iSched && wlStart > iEvents,
    `schedule 截断=${iSched} events 截断=${iEvents} 拼接=${wlStart}`);
  check('拼接之后**没有**再截一刀（watchList 上不能出现 .slice(0, ...)）',
    !/\.slice\s*\(/.test(watchArr) && !/\.slice\s*\(/.test(watchMap),
    watchDecl.replace(/\s+/g, ' ').slice(0, 200));
}
{
  /* ── 降级：缺数据的那一期要能正常构建，不能报错 ── */
  check('追更的源文件是 follow_<日期>.json（构建期抓、运行时零请求）',
    /follow_\$\{date\}\.json/.test(followDataBlock), '追更块里找不到 follow_${date}.json');
  check('追更的源是逐个源根试读的（源图挪过盘也能找到）',
    /srcSearchRoots\(\)/.test(followDataBlock));
  const followCatches = catchBodies(followDataBlock);
  check('追更块里有 catch（源文件不存在 / 解析失败要能吞掉）',
    followCatches.length >= 1, `catch 数量=${followCatches.length}`);
  check('追更的 catch 里**没有 throw**（源文件缺失 → 跳过，不是报错）',
    followCatches.length >= 1 && followCatches.every((b) => !/\bthrow\b/.test(b)),
    followCatches.map((b) => b.replace(/\s+/g, ' ').slice(0, 90)).join(' | '));
  check('追更走的是 if (payload) 守卫（payload 为空时不往下走）',
    /if\s*\(payload\)/.test(followDataBlock));
  const rankCatches = catchBodies(rankDataBlock);
  check('榜单块里有 catch（rank_<日期>.json 不存在 / 解析失败要能吞掉）',
    rankCatches.length >= 1, `catch 数量=${rankCatches.length}`);
  check('榜单的 catch 里**没有 throw**（缺榜单数据不该让整期构建失败）',
    rankCatches.length >= 1 && rankCatches.every((b) => !/\bthrow\b/.test(b)),
    rankCatches.map((b) => b.replace(/\s+/g, ' ').slice(0, 90)).join(' | '));
  check('榜单走的是 if (rank) 守卫（没抓到榜单就不加这两个 tab）',
    /if\s*\(rank\)/.test(rankDataBlock));
  check('**追更块只读数据、不 push tab**（v3：追更不再是独立 tab，push 一次就多一个栏目）',
    !/manifest\.tabs\.push/.test(followDataBlock) && !/rankTabs\.push/.test(followDataBlock),
    (followDataBlock.match(/.*push.*/g) || []).join(' | '));
}
{
  /* ── 结构：追更这个 tab 彻底没了 ── */
  check('build.mjs 里**没有** key: \'follow\'（追更已整体并入「看片」）',
    !/key:\s*'follow'/.test(BUILD),
    (BUILD.match(/.*key:\s*'follow'.*/g) || []).join(' | '));
  check('build.mjs 里**没有** label: \'追更\'（这个栏目已经不存在了）',
    !/label:\s*'追更'/.test(BUILD),
    (BUILD.match(/.*label:\s*'追更'.*/g) || []).join(' | '));
  check('看板契约抠得到 movie → 「看片」（key / label 必须是字符串字面量）',
    !!contractOf('movie') && contractOf('movie').label === '看片',
    contractOf('movie')
      ? `实际「${contractOf('movie').label}」`
      : `抠到的栏目：${contractPairs.map((p) => p.key).join(',') || '(一个都没有)'}`);
  const mi = BUILD.indexOf("key: 'movie',");
  const ml = BUILD.indexOf("label: '看片',");
  check('movie 的 key 和 label 在源码里挨着（契约正则最多跨 60 字符，隔远了就抠不到 → 栏目脱离契约保护）',
    mi >= 0 && ml > mi && ml - mi <= 60, `key 位置=${mi} label 位置=${ml} 距离=${ml - mi}`);
  check("build.mjs 里 key: 'movie' 只出现一次（出现多次的话契约会抠到错的那个）",
    countOf(BUILD, "key: 'movie',") === 1, `出现 ${countOf(BUILD, "key: 'movie',")} 次`);
  check("build.mjs 里 label: '看片' 只出现一次",
    countOf(BUILD, "label: '看片',") === 1, `出现 ${countOf(BUILD, "label: '看片',")} 次`);
  check('看片 tab 是**列表非空才 push** 的（没数据就不加这个 tab）',
    /if\s*\(locWatch\.items\.length\)/.test(rankBlock),
    (rankBlock.match(/.*if\s*\(loc.*length\).*/g) || []).join(' | '));
  check('听乐 tab 也是**列表非空才 push** 的',
    /if\s*\(locMusic\.items\.length\)/.test(rankBlock),
    (rankBlock.match(/.*if\s*\(loc.*length\).*/g) || []).join(' | '));
}
{
  /* ── 封面：合并后的列表要接本地化（豆瓣演出图 418）── */
  const iLocMusic = BUILD.indexOf('localizeCovers(musicList');
  const iLocWatch = BUILD.indexOf('localizeCovers(watchList');
  check('合并后的 watchList 接了封面本地化（豆瓣演出图 418，必须自己存）',
    iLocWatch >= 0, 'build.mjs 里找不到 localizeCovers(watchList, ...)');
  check('musicList 也接了封面本地化',
    iLocMusic >= 0, 'build.mjs 里找不到 localizeCovers(musicList, ...)');
  check('本地化在**合并之后**做（合并前做的话后面拼进来的段全是没有本地封面的）',
    iLocWatch >= 0 && iLocMusic >= 0 && iLocWatch > wlStart && iLocMusic > wlStart,
    `music=${iLocMusic} watch=${iLocWatch} 拼接=${wlStart}`);
  check('本地化的是**合并后的 watchList**（不是某一段 —— 漏一段，那一段的豆瓣图就全是 418）',
    /localizeCovers\(\s*watchList\s*,/.test(BUILD) &&
      !/localizeCovers\(\s*(followSchedule|movieList|videoList|followEvents)\s*,/.test(BUILD),
    (BUILD.match(/.*localizeCovers\(.*/g) || []).join(' | '));
}
{
  /* ── 抓取端：五个大目录的字面量 ──
     大目录（@1）就是用户看到的 chip。这几个字面量对不上，
     站上的目录名就跟设计对不上，而且没有任何报错。 */
  check('fetch-follow.mjs 的频道更新大目录字面量是「频道更新」（v3 改过字面，别改回去）',
    /export\s+const\s+L1_SCHEDULE\s*=\s*'频道更新'/.test(FETCH_FOLLOW),
    (FETCH_FOLLOW.match(/.*L1_SCHEDULE\s*=.*/g) || []).join(' | '));
  check('fetch-follow.mjs 的本地演出大目录字面量是「本地演出」',
    /export\s+const\s+L1_EVENTS\s*=\s*'本地演出'/.test(FETCH_FOLLOW),
    (FETCH_FOLLOW.match(/.*L1_EVENTS\s*=.*/g) || []).join(' | '));
  check('fetch-rank.mjs 的 B站热门 是 @1 大目录（v3 把「视频」这个壳去掉了）',
    /tags:\s*\['@1:B站热门'\]/.test(FETCH_RANK),
    (FETCH_RANK.match(/.*tags:\s*\['@1:B站热门'\].*/g) || []).join(' | '));
  check('fetch-rank.mjs 的 抖音热门 是 @1 大目录',
    /tags:\s*\['@1:抖音热门'\]/.test(FETCH_RANK),
    (FETCH_RANK.match(/.*tags:\s*\['@1:抖音热门'\].*/g) || []).join(' | '));
  const rankTagLits = [...FETCH_RANK.matchAll(/tags:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  check('fetch-rank.mjs 的 tags 里**没有** @1:视频（那个壳去掉了，留着会多出一档没人点的目录）',
    !rankTagLits.some((t) => t.includes('@1:视频')),
    rankTagLits.filter((t) => t.includes('@1:视频')).join(' | '));
  check('fetch-rank.mjs 的视频段是**B站在前、抖音在后**（两段都在 videoList 里，顺序就是目录顺序）',
    /const\s+video\s*=\s*\[\.\.\.bili\.items\s*,\s*\.\.\.douyin\.items\]/.test(FETCH_RANK),
    (FETCH_RANK.match(/.*const video = .*/g) || []).join(' | '));
  check('fetch-rank.mjs 的 tag 字段没变（仍是 B站热门 / 抖音热门 —— tag 不是层级标签，别一起改）',
    /tag:\s*'B站热门'/.test(FETCH_RANK) && /tag:\s*'抖音热门'/.test(FETCH_RANK),
    (FETCH_RANK.match(/.*tag:\s*'(B站热门|抖音热门)'.*/g) || []).join(' | '));
}
{
  /* 计数单位：文本型 tab 的条目不是图片，单位该是「条」不是「张」。 */
  check('app.js 的计数单位对**所有文本型 tab** 用「条」（榜单条不是图片，「200 张」是错的）',
    /countPill\.textContent\s*=\s*s\.tab\.count\s*\+\s*\(\s*s\.tab\.type\s*\?\s*' 条'\s*:\s*' 张'\s*\)/.test(APPJS),
    (APPJS.match(/countPill\.textContent[^\n]*/) || [, '(找不到 countPill.textContent)'])[0]);
  check('app.js 没有把计数单位写死成只对 headlines 用「条」（rank 型 tab 会退回「张」）',
    !/countPill\.textContent[^\n]*'headlines'\s*\?/.test(APPJS),
    (APPJS.match(/countPill\.textContent[^\n]*/) || [, ''])[0]);
}

console.log('\n13) 前端：多层 chip 的数据契约');
{
  /* 顺序类断言的前提就在这里：前端的 chip 是**按条目在列表里的出现顺序**
     现推的（renderChips 只去重、**不排序**）。
     有人在这儿加一个 sort()，build.mjs 里的拼接顺序就白钉了 ——
     数据顺序还是对的，目录顺序却变了。所以这条也得钉。 */
  const renderChipsBody = region(APPJS, 'function renderChips() {', '\n    }\n');
  check('app.js 的 renderChips 按**候选出现顺序**去重、**不排序**（目录顺序 = 数据顺序；排序了就跟 build.mjs 的拼接顺序对不上）',
    !!renderChipsBody && !/\.sort\s*\(/.test(renderChipsBody),
    (renderChipsBody.match(/.*\.sort.*/g) || []).join(' | '));
  check('renderChips 的选项就是按遇到顺序 push 的（opts.push，不重排）',
    /opts\.push\(lv\[m\]\)/.test(renderChipsBody),
    renderChipsBody.replace(/\s+/g, ' ').slice(0, 200));
  check('app.js 里有 levelTags（取某一层的**全部**标签值）',
    /function\s+levelTags\s*\(/.test(APPJS), 'app.js 里找不到 function levelTags(');
  check('app.js 里**没有**单值的 levelTag —— 只取第一个标签的话，「既在中文榜又在国际榜」的歌就只会出现在一个榜里',
    !/function\s+levelTag\s*\(/.test(APPJS), 'app.js 里还有 function levelTag(');
  check('levelTags 遍历的是**全部**标签（一条内容可以同属多个值，比如既在中文榜又在国际榜）',
    /for\s*\(var\s+i\s*=\s*0;\s*i\s*<\s*arr\.length;\s*i\+\+\)/.test(APPJS),
    (APPJS.match(/for\s*\(var\s+i[^\n]*/g) || []).slice(0, 3).join(' | '));
  check('多层标签写进 data-lv，用 JSON 编码（平台名 Prime Video 带空格，空格分隔会被拆坏）',
    /setAttribute\(\s*'data-lv'\s*,\s*JSON\.stringify/.test(APPJS),
    (APPJS.match(/.*data-lv.*/g) || []).join(' | '));
  check('app.js 读的是 data-lv',
    /getAttribute\('data-lv'\)/.test(APPJS), 'app.js 里找不到 getAttribute(\'data-lv\')');
  check('层级上限是 4 层（板块 / 分类 / 细分 / 类型）',
    /MAX_LEVEL\s*=\s*4/.test(APPJS), 'app.js 里找不到 MAX_LEVEL = 4');
  check('层标题有四个（板块/分类/细分/类型）',
    /LEVEL_CAPS\s*=\s*\[[^\]]*'板块'[^\]]*'分类'[^\]]*'细分'[^\]]*'类型'/.test(APPJS),
    (APPJS.match(/LEVEL_CAPS[^\n]*/) || [, '(找不到 LEVEL_CAPS)'])[0]);
  check('改了上层会清空下层选择（选了深圳却按上海的区筛，是看不懂的组合）',
    /for\s*\(var\s+i\s*=\s*L\s*;\s*i\s*<\s*MAX_LEVEL\s*;\s*i\+\+\)\s*sel\[i\]\s*=\s*''/.test(APPJS),
    'app.js 里找不到 setSel 里清空下层的那句');
  check('app.css 有 .chip-lines（多层 chip 的容器）',
    hasClass(APPCSS, 'chip-lines'), 'app.css 里找不到 .chip-lines');
  check('app.css 有 .chip-line（一层 chip 的一行）',
    hasClass(APPCSS, 'chip-line'), 'app.css 里找不到 .chip-line');
  check('app.css 有 .chips-cap（层标题，放滚动区外面，否则滑走就分不清层级）',
    hasClass(APPCSS, 'chips-cap'), 'app.css 里找不到 .chips-cap');
  check('app.css 有 .chips-lv3 / .chips-lv4（第三、四层的 chip 样式）',
    hasClass(APPCSS, 'chips-lv3') && hasClass(APPCSS, 'chips-lv4'),
    'app.css 里找不到 .chips-lv3 / .chips-lv4');
  check('旧 manifest 的兼容路径还在（条目没有 tags 时走 tab.chips 单层，否则 --keep-manifest 只换前端会让分类 chip 整排消失）',
    /useLegacy/.test(APPJS), 'app.js 里找不到 useLegacy');
}

console.log('\n14) 豆瓣封面本地化：豆瓣对不带 Referer 的请求一律 418，必须自己存');
{
  check('build.mjs 里有 localizeCovers（把 local: 封面换成站内可访问的路径）',
    /function\s+localizeCovers\s*\(/.test(BUILD), 'build.mjs 里找不到 function localizeCovers(');
  check('封面产物用的是**现有的产物命名** <10位随机段>_<3位序号>.webp（upload-r2 / 代理 / r2-prune / orphan-clean 只认这一种）',
    /\$\{nonce\}_\$\{String\(seq\)\.padStart\(3,\s*'0'\)\}\.webp/.test(BUILD),
    (BUILD.match(/.*padStart\(3.*/g) || []).join(' | '));
  check('封面的类别目录名是 covers（代理的路径规则要求分类段是 [a-z0-9]+）',
    /const\s+COVER_CATEGORY\s*=\s*'covers'/.test(BUILD),
    (BUILD.match(/.*COVER_CATEGORY.*/g) || []).join(' | '));
  check('封面转换是**等比缩放**（force_original_aspect_ratio=decrease），不是拉成正方形把人拉胖',
    /force_original_aspect_ratio=decrease/.test(BUILD),
    (BUILD.match(/.*scale=.*COVER_MAX_EDGE.*/g) || []).join(' | '));
  check('听乐和看片都接了 localizeCovers（豆瓣的封面在两个 tab 里都有）',
    /localizeCovers\(\s*musicList\s*,/.test(BUILD) && /localizeCovers\(\s*watchList\s*,/.test(BUILD),
    (BUILD.match(/.*localizeCovers\(.*/g) || []).join(' | '));
  check('远程封面 URL 原样保留（猫眼/B站/网易云不查 Referer，热链没问题）',
    /raw\.indexOf\('local:'\)\s*!==\s*0/.test(BUILD),
    (BUILD.match(/.*local:'.*/g) || []).join(' | '));
  check('本地封面路径做了越界检查（rel 里带 .. 就不能让它去读任意文件）',
    /rel\.includes\('\.\.'\)/.test(BUILD),
    (BUILD.match(/.*rel\.includes.*/g) || []).join(' | '));
  check('封面本地化失败只降级（这条没封面），不让整期构建失败',
    /console\.warn\(`\s*!\s*封面本地化失败/.test(BUILD),
    (BUILD.match(/.*封面本地化失败.*/g) || []).join(' | '));
  /* 豆瓣封面本地化后是**站内路径**（/img/<日期>/covers/...），
     它挂在条目的 cover 字段上，不在 full/thumb 里。
     只收 full/thumb 的工具会把它当孤儿删掉 → 线上直接裂图。 */
  const pruneKeep = region(R2PRUNE, 'async function referencedKeys(', '\n}\n');
  check('r2-prune.mjs 的引用键集也收 it.cover（豆瓣封面本地化后是站内路径，不收就会被当孤儿删掉）',
    /for\s*\(const\s+u\s+of\s*\[\s*it\.full\s*,\s*it\.thumb\s*,\s*it\.cover\s*\]\s*\)/.test(pruneKeep),
    pruneKeep.replace(/\s+/g, ' ').slice(0, 240));
  check('r2-prune.mjs 只把**站内绝对路径**算进引用（远程热链封面切出来是垃圾字符串）',
    /indexOf\('\/img\/'\)\s*!==\s*0/.test(pruneKeep),
    pruneKeep.replace(/\s+/g, ' ').slice(0, 240));
  check('orphan-clean.mjs 的引用是从 manifest **原文**里正则抓的（任何字段里的站内路径都算，封面自动被保住）',
    /extractObjectKeys/.test(ORPHAN_CLEAN) && ORPHAN_CLEAN.includes('/img/'),
    'orphan-clean.mjs 里找不到从 manifest 原文抓 /img/ 路径的逻辑');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
