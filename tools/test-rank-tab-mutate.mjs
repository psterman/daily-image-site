#!/usr/bin/env node
/**
 * 变异验证：证明护栏真的有牙齿。
 *
 * 护栏自己「全绿」说明不了它能抓住坏版本 —— 只会说明它没坏。
 * 所以这里把被保护的文件**故意改坏**，再跑护栏，要求它**必须变红**。
 *
 * 变异体不碰真文件：复制到 tools/.mutate-tmp/ 下，跑完删掉。
 * （不用系统 temp 目录 —— 出问题时得能在工程里翻到它。）
 *
 * 每个变异体写三件事：
 *   · from → to     —— 改哪一行（锚点必须在目标文件里**唯一命中一次**）
 *   · expectFail    —— 期望变红的那条断言（子串匹配）
 *   · expectGreen   —— 期望仍然绿的那几条断言（子串匹配；它们变红就是**误伤**，
 *                       说明护栏的判据太粗，改坏一处把不相干的东西也判成坏的）
 *
 * ⚠️ **必须「干净地红」**：护栏变红是因为**断言不成立**，
 *    不是护栏自己抛异常。所以这里同时检查：
 *      ① 护栏跑出了「结果：N 通过 / M 失败」的统计行（崩了就没有这行）
 *      ② stderr 里没有调用栈
 *    崩出来的红会把真缺口盖住 —— 那不算抓到。
 *
 * 覆盖的坏版本（2026-11-16 v3 之后）：
 *   · 榜单 tab 的 type 改成 'images'      → 被当成图片 tab，构建直接拒绝出 manifest
 *   · key 改成变量                         → test-contract.mjs 抠不到，新栏目脱离契约保护
 *   · 中文名跟 board.html 不一致           → 留言板上「听乐」对不上
 *   · iTunes 的 country=cn fallback 被删   → 英文词一条都搜不到
 *   · link 的协议校验被去掉                → javascript: 伪协议能进 DOM
 *   · MAX_RANK_ITEMS 的截断被去掉          → manifest 无限膨胀
 *   · verify-news 的 tab 数写死回 === 4    → 加了榜单的那一期被判成坏的
 *   · 榜单封面走了见报的 newsImgSrc        → 只认站内路径，远程封面全被洗掉
 *   · **五段拼接顺序被改**                 → 用户看到的目录顺序变了（不报错）
 *   · **拼接里少一段**                     → 一整个大目录消失（不报错）
 *   · **统一重编号被去掉**                 → 序号重复
 *   · **追更块的 catch 改成 throw**        → 缺追更数据的那一期构建直接失败
 *   · **分项上限被去掉**                   → manifest 无限膨胀
 *   · **合并后不接封面本地化**             → 豆瓣演出图 418，线上全是空格子
 *   · **chips 被写死成一份**               → 换城市组就有一排点不动的死 chip
 *   · board.html 少了看片的中文名          → 留言板上显示内部 key
 *   · verify-news 少了看片的多层 chip 检查  → 层级筛选坏了没人拦
 *
 * 用法：node tools/test-rank-tab-mutate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, '.mutate-tmp');
const GUARD = path.join(__dirname, 'test-rank-tab.mjs');

let pass = 0;
let fail = 0;

function check(label, cond, detail, okDetail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${okDetail ? '  —— ' + okDetail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? '  —— ' + detail : ''}`);
  }
}

/** 某个片段在源码里出现了几次 */
function countOf(src, needle) {
  let n = 0;
  let i = src.indexOf(needle);
  while (i >= 0) { n++; i = src.indexOf(needle, i + needle.length); }
  return n;
}

/** 从护栏输出里抠出所有失败的断言标签（去掉「✗」前缀和「—— 详情」尾巴） */
function failedLabels(out) {
  const labels = [];
  for (const line of (out || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('✗')) continue;
    labels.push(t.replace(/^✗\s*/, '').split(/\s+——\s+/)[0].trim());
  }
  return labels;
}

/** 从护栏输出里抠出「结果：N 通过 / M 失败」那一行的统计 */
function guardStats(out) {
  const m = (out || '').match(/结果：(\d+) 通过 \/ (\d+) 失败/);
  return m ? { pass: Number(m[1]), fail: Number(m[2]) } : null;
}

const BUILD = fs.readFileSync(path.join(ROOT, 'tools/build.mjs'), 'utf8');
const APPJS = fs.readFileSync(path.join(ROOT, 'site/app.js'), 'utf8');
const APPCSS = fs.readFileSync(path.join(ROOT, 'site/app.css'), 'utf8');
const BOARD = fs.readFileSync(path.join(ROOT, 'site/board.html'), 'utf8');
const VERIFY_NEWS = fs.readFileSync(path.join(ROOT, 'tools/verify-news.mjs'), 'utf8');
const VERIFY_BUILD = fs.readFileSync(path.join(ROOT, 'tools/verify-build.mjs'), 'utf8');
const TAB_KINDS = fs.readFileSync(path.join(ROOT, 'tools/tab-kinds.mjs'), 'utf8');
const R2PRUNE = fs.readFileSync(path.join(ROOT, 'tools/r2-prune.mjs'), 'utf8');

/**
 * 每个变异体：把某个文件里的一段 from 换成 to，然后要求主护栏变红。
 * env = 用哪个环境变量把变异体喂给护栏（护栏按这个变量决定读哪个文件）。
 */
const MUTANTS = [
  /* ── 榜单 tab（听乐 / 看片）── */
  {
    label: 'build.mjs：听乐 tab 的 type 改成 \'images\'（被当成图片 tab → 构建自检去母本里找图，直接拒绝出 manifest）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    /* 锚点带 accent：单靠 `type: 'rank',` 在两个 tab 里都出现，锚不住 */
    from: "      accent: '#a78bfa',\n      type: 'rank',",
    to: "      accent: '#a78bfa',\n      type: 'images',",
    expectFail: ["music 的 type 是 'rank'"],
    expectGreen: ["看片 tab 的 type 是 'rank'", 'TAB_LABELS 里有 music 的中文名'],
  },
  {
    label: 'build.mjs：听乐的 key 改成变量（test-contract.mjs 的正则抠不到 → 新栏目脱离契约保护）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: "      key: 'music',",
    to: '      key: RANK_MUSIC_KEY,',
    expectFail: ['music 的 key/label 必须是字符串字面量', 'music 的中文名是「听乐」'],
    expectGreen: ['TAB_LABELS 里有 music 的中文名', 'musicList 也接了封面本地化'],
  },
  {
    label: 'build.mjs：听乐的中文名跟 board.html 不一致（留言板上的「听乐」对不上）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: "      label: '听乐',",
    to: "      label: '音乐榜',",
    expectFail: ['music 的中文名是「听乐」', 'build.mjs 里的 music 中文名跟 board.html 一致'],
    expectGreen: ['TAB_LABELS 里有 music 的中文名', 'movie 的中文名是「看片」'],
  },
  {
    label: 'build.mjs：MAX_RANK_ITEMS 的截断被去掉（manifest 无限膨胀）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: 'const musicRaw = Array.isArray(rank.music) ? rank.music.slice(0, MAX_RANK_ITEMS.music) : [];',
    to: 'const musicRaw = Array.isArray(rank.music) ? rank.music : [];',
    expectFail: ['music 的 list 用它自己的上限截断'],
    expectGreen: ['movie 的 list 用它自己的上限截断', 'video 的 list 用它自己的上限截断'],
  },
  {
    label: 'build.mjs：MAX_RANK_ITEMS 上限被放大到 2000（单 tab 条目上限失效）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: 'const MAX_RANK_ITEMS = { music: 600, movie: 400, video: 200 };',
    to: 'const MAX_RANK_ITEMS = { music: 2000, movie: 3000, video: 2000 };',
    expectFail: ['上限都是有限正数'],
    expectGreen: ['上限按 tab 分别定义', 'MAX_RANK_ITEMS 常量存在'],
  },
  {
    /* 今天真踩过的坑：影视榜是「豆瓣 250 条在前、B站 50 条在后」，
       两个 tab 的上限统一成 200 的话，B站那 50 条视频会被整段砍掉，
       影视 tab 就只剩电影、没有视频了。 */
    label: 'build.mjs：两个 tab 的上限被统一成 200（B站那 50 条视频会被整段砍掉）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: 'const MAX_RANK_ITEMS = { music: 600, movie: 400, video: 200 };',
    to: 'const MAX_RANK_ITEMS = { music: 200, movie: 200, video: 200 };',
    expectFail: ['听乐的上限够放下'],
    expectGreen: ['上限都是有限正数', '上限按 tab 分别定义'],
  },
  {
    label: 'build.mjs：item 映射里的 cover 字段被掏空（榜单封面渲染不出来）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: "    cover: it.cover || '',",
    to: "    cover: '',",
    expectFail: ['cover 直接取自榜单 JSON'],
    expectGreen: ['link 直接取自榜单 JSON', 'tags 必须透传'],
  },
  {
    /* v2：tags 是第 9 个字段，丢了多层 chip 就只剩一排点不动的板块。 */
    label: 'build.mjs：tags 字段被掏空（多层 chip 拿不到层级数据）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: '    tags: flattenTags(it.tags),',
    to: '    tags: [],',
    expectFail: ['tags 必须透传'],
    expectGreen: ['cover 直接取自榜单 JSON', 'link 直接取自榜单 JSON'],
  },
  {
    label: 'build.mjs：chips 被写死成一份（换平台/换榜单就有一排点不动的死 chip）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: '      chips: level1Chips(rt.list),',
    to: "      chips: [{ tag: '热歌榜', label: '热歌榜' }],",
    expectFail: ['chips 是**从条目现推**的', 'chips 表达式里没有写死的中文城市名'],
    expectGreen: ['level1Chips 产出的 chip 是 tag / label 同名', 'level1Chips 取的是 @1: 层'],
  },
  {
    label: 'site/app.js：iTunes 的 country=cn fallback 被删（英文词一条都搜不到）',
    env: 'RANK_APP_JS',
    file: 'app.js',
    src: APPJS,
    from: '      return get(base).then(function (j2) { return (j2 && j2.results) || []; });',
    to: '      return [];',
    expectFail: ['cn 搜不到时退回不带 country 的同一个 URL'],
    expectGreen: ['先试 country=cn', '查询串带 media=music'],
  },
  {
    label: 'site/app.js：iTunes 的 fallback 也带上 country=cn（等于没退回）',
    env: 'RANK_APP_JS',
    file: 'app.js',
    src: APPJS,
    from: '      return get(base).then(function (j2) { return (j2 && j2.results) || []; });',
    to: '      return get(base + \'&country=cn\').then(function (j2) { return (j2 && j2.results) || []; });',
    expectFail: ['fallback 的 URL 里不含 country=cn'],
    expectGreen: ['先试 country=cn', '查询串带 media=music'],
  },
  {
    /* 锚点定在 safeHref 函数体里（规则只定义这一处）——
       改坏它，见报和榜单两个渲染路径会同时失去协议校验。 */
    label: 'site/app.js：safeHref 的协议校验被去掉（javascript: 伪协议能进 DOM）',
    env: 'RANK_APP_JS',
    file: 'app.js',
    src: APPJS,
    from: "    if (!link || typeof link !== 'string') return '';\n    return /^https?:\\/\\//i.test(link) ? link : '';",
    to: "    if (!link || typeof link !== 'string') return '';\n    return link;",
    expectFail: ['app.js 里有 safeHref 这个统一的协议校验函数'],
    expectGreen: ['榜单的 it.link 走 safeHref', '见报的 it.link 也走同一个 safeHref'],
  },
  {
    label: 'site/app.js：榜单封面改走见报的 newsImgSrc（只认站内路径 → 远程封面全被洗掉）',
    env: 'RANK_APP_JS',
    file: 'app.js',
    src: APPJS,
    from: "      cimg.setAttribute('data-src', it.cover);",
    to: "      cimg.setAttribute('data-src', newsImgSrc(it));",
    expectFail: ['newsImgSrc **没有**被用在榜单渲染里', '榜单封面直接用 it.cover'],
    expectGreen: ['newsImgSrc 仍然被见报用着', '榜单封面懒加载用榜单自己的 observer'],
  },
  {
    label: 'site/app.js：grid-rank 类被去掉（榜单掉进多列图片网格）',
    env: 'RANK_APP_JS',
    file: 'app.js',
    src: APPJS,
    from: "    if (tab.type === 'rank') c += ' grid-rank';",
    to: "    if (tab.type === 'rank') c += ' grid-list';",
    expectFail: ['gridClass 给榜单 tab 加了 grid-rank 类'],
    expectGreen: ['app.css 有 .grid.grid-rank'],
  },
  {
    label: 'site/app.js：渲染分叉里的 rank 分支被改成别的类型（榜单 tab 掉进图片渲染路径）',
    env: 'RANK_APP_JS',
    file: 'app.js',
    src: APPJS,
    from: "    } else if (tab.type === 'rank') {",
    to: "    } else if (tab.type === 'images') {",
    expectFail: ["app.js 里有 tab.type === 'rank' 的分支"],
    expectGreen: ['app.js 里有 renderRank', 'app.js 里有 rankRow'],
  },
  {
    label: 'site/app.css：.rank-cover 样式被改名（榜单封面没尺寸，塌成一个小方块）',
    env: 'RANK_APP_CSS',
    file: 'app.css',
    src: APPCSS,
    from: '.rank-cover {',
    to: '.rank-cover-off {',
    expectFail: ['app.css 有 .rank-cover'],
    expectGreen: ['app.css 有 .rank-no', 'app.css 有 .rank-sep'],
  },
  {
    label: 'site/board.html：TAB_LABELS 里的 music 中文名跟 build.mjs 不一致',
    env: 'RANK_BOARD_HTML',
    file: 'board.html',
    src: BOARD,
    from: "    music: '听乐', movie: '看片'",
    to: "    music: '音乐', movie: '看片'",
    expectFail: ['TAB_LABELS 里有 music 的中文名', 'build.mjs 里的 music 中文名跟 board.html 一致'],
    expectGreen: ['TAB_LABELS 里有 movie 的中文名'],
  },
  {
    label: 'tools/verify-news.mjs：tab 数又写死成 === 4（加了榜单的那一期会被判成坏的）',
    env: 'RANK_VERIFY_NEWS',
    file: 'verify-news.mjs',
    src: VERIFY_NEWS,
    from: "chk('至少 4 个 tab（见闻/见她/见笑/见报）', tabs.length >= 4, String(tabs.length));",
    to: "chk('至少 4 个 tab（见闻/见她/见笑/见报）', tabs.length === 4, String(tabs.length));",
    expectFail: ['verify-news.mjs 里没有 tabs.length === 4', 'verify-news.mjs 判的是 tabs.length >= 4'],
    expectGreen: ['verify-news.mjs 逐个检查 music / movie 两个榜单 tab'],
  },
  {
    label: 'tools/tab-kinds.mjs：isTextTab 写成永远 false（榜单被当成图片 tab）',
    env: 'RANK_TAB_KINDS',
    file: 'tab-kinds.mjs',
    src: TAB_KINDS,
    from: 'export function isTextTab(tab) {\n  return !!tab && !!tab.type;\n}',
    to: 'export function isTextTab(tab) {\n  return false;\n}',
    expectFail: ['isTextTab 对 type', '看片 tab 是文本型'],
    expectGreen: ['TEXT_TAB_TYPES 里登记了'],
  },

  /* ── v3：看片 tab 的五段合并（顺序 / 重编号 / 上限 / 降级 / 封面 / 芯片）── */
  {
    /* 目录顺序 = 数据顺序（前端 renderChips 按出现顺序现推 chip，不排序）。
       顺序错了不报任何错，只是用户看到的目录顺序变了。 */
    label: 'build.mjs：五段拼接顺序被改（频道更新挪到电影后面 → 用户的目录顺序变了）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: '  const watchList = [...followSchedule, ...movieList, ...videoList, ...followEvents]\n    .map((it, i) => ({ ...it, rank: i + 1 }));',
    to: '  const watchList = [...movieList, ...videoList, ...followSchedule, ...followEvents]\n    .map((it, i) => ({ ...it, rank: i + 1 }));',
    expectFail: ['watchList 的拼接顺序**恰好**是', '频道更新（followSchedule）排在电影'],
    expectGreen: ['五段一个都不能少', '五段合并后**统一重编号**'],
  },
  {
    label: 'build.mjs：五段拼接里少一段（删掉追更 → 频道更新这整个大目录消失）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: '  const watchList = [...followSchedule, ...movieList, ...videoList, ...followEvents]\n    .map((it, i) => ({ ...it, rank: i + 1 }));',
    to: '  const watchList = [...movieList, ...videoList, ...followEvents]\n    .map((it, i) => ({ ...it, rank: i + 1 }));',
    expectFail: ['watchList 的拼接顺序**恰好**是', '五段一个都不能少', '频道更新（followSchedule）排在电影'],
    expectGreen: ['视频段（B站/抖音）排在本地演出'],
  },
  {
    label: 'build.mjs：五段拼接里少一段（删掉视频段 → B站热门/抖音热门这整个大目录消失）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: '  const watchList = [...followSchedule, ...movieList, ...videoList, ...followEvents]\n    .map((it, i) => ({ ...it, rank: i + 1 }));',
    to: '  const watchList = [...followSchedule, ...movieList, ...followEvents]\n    .map((it, i) => ({ ...it, rank: i + 1 }));',
    expectFail: ['watchList 的拼接顺序**恰好**是', '五段一个都不能少', '视频段（B站/抖音）排在本地演出'],
    expectGreen: ['频道更新（followSchedule）排在电影'],
  },
  {
    label: 'build.mjs：合并后不统一重编号（每段各自从 1 开始 → 列表里序号重复）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: '  const watchList = [...followSchedule, ...movieList, ...videoList, ...followEvents]\n    .map((it, i) => ({ ...it, rank: i + 1 }));',
    to: '  const watchList = [...followSchedule, ...movieList, ...videoList, ...followEvents];',
    expectFail: ['五段合并后**统一重编号**', '重编号是**覆盖**'],
    expectGreen: ['watchList 的拼接顺序**恰好**是', '五段一个都不能少'],
  },
  {
    label: 'build.mjs：看片的 key 改成变量（test-contract.mjs 抠不到 → 看片脱离契约保护）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: "      key: 'movie',",
    to: '      key: MOVIE_KEY,',
    expectFail: ['movie 的 key/label 必须是字符串字面量', 'movie 的中文名是「看片」', '看板契约抠得到 movie'],
    expectGreen: ['TAB_LABELS 里有 movie 的中文名', 'watchList 的拼接顺序**恰好**是'],
  },
  {
    label: 'build.mjs：看片的中文名改成别的（留言板上的「看片」对不上）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: "      label: '看片',",
    to: "      label: '影视',",
    expectFail: ['movie 的中文名是「看片」', 'build.mjs 里的 movie 中文名跟 board.html 一致'],
    expectGreen: ['TAB_LABELS 里有 movie 的中文名', 'music 的中文名是「听乐」'],
  },
  {
    label: 'build.mjs：看片 tab 的 type 改成 \'headlines\'（掉进见报的渲染路径）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: "      accent: '#fb923c',\n      type: 'rank',",
    to: "      accent: '#fb923c',\n      type: 'headlines',",
    expectFail: ["看片 tab 的 type 是 'rank'"],
    expectGreen: ["music 的 type 是 'rank'", '看片 tab 是文本型'],
  },
  {
    label: 'build.mjs：追更块的 catch 改成 throw（缺追更数据的那一期直接构建失败）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    /* 锚点带上 follow_${date}.json —— 两个块的 catch 长得一样，只靠 catch 锚不住 */
    from: '      const p = path.join(root, date, `follow_${date}.json`);\n      try {\n        payload = JSON.parse(await fs.readFile(p, \'utf8\'));\n        payloadFrom = p;\n        break;\n      } catch {',
    to: '      const p = path.join(root, date, `follow_${date}.json`);\n      try {\n        payload = JSON.parse(await fs.readFile(p, \'utf8\'));\n        payloadFrom = p;\n        break;\n      } catch (err) {\n        throw err;',
    expectFail: ['追更的 catch 里**没有 throw**'],
    expectGreen: ['榜单的 catch 里**没有 throw**', '追更走的是 if (payload) 守卫', '追更块里有 catch'],
  },
  {
    label: 'build.mjs：追更的分项上限被去掉（schedule 那一块无限膨胀）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: '        ? payload.schedule.slice(0, MAX_FOLLOW_ITEMS.schedule)',
    to: '        ? payload.schedule',
    expectFail: ['schedule 用自己的上限截断', '是**先分项截断再拼接**'],
    expectGreen: ['events 用自己的上限截断', '上限按板块分项定义'],
  },
  {
    label: 'build.mjs：追更两个板块的上限被统一成 300（哪一块被砍了看不出来）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: 'const MAX_FOLLOW_ITEMS = { schedule: 500, events: 300 };',
    to: 'const MAX_FOLLOW_ITEMS = { schedule: 300, events: 300 };',
    expectFail: ['**两个板块的上限不是同一个数**'],
    expectGreen: ['上限按板块分项定义', '两个上限都是有限正数'],
  },
  {
    label: 'build.mjs：追更的上限被放大到 2000（单板块条目上限失效）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: 'const MAX_FOLLOW_ITEMS = { schedule: 500, events: 300 };',
    to: 'const MAX_FOLLOW_ITEMS = { schedule: 1500, events: 2000 };',
    expectFail: ['两个上限都是有限正数'],
    expectGreen: ['**两个板块的上限不是同一个数**', '上限按板块分项定义'],
  },
  {
    label: 'build.mjs：合并后不接封面本地化（豆瓣演出图 418 → 线上全是空格子）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: '  const locWatch = await localizeCovers(watchList, coverOpts);',
    to: '  const locWatch = { items: watchList, localized: 0, failed: 0 };',
    expectFail: ['合并后的 watchList 接了封面本地化', '本地化的是**合并后的 watchList**'],
    expectGreen: ['musicList 也接了封面本地化', 'watchList 的拼接顺序**恰好**是'],
  },
  {
    label: 'build.mjs：追更 item 的 tag 被写死成「剧集更新」（演出条目分不出城市）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: "    tag: it.tag || '',",
    to: "    tag: '剧集更新',",
    expectFail: ['条目的 tag 是**透传** it.tag'],
    expectGreen: ['cover 直接取自榜单 JSON', 'link 直接取自榜单 JSON'],
  },
  {
    label: 'site/board.html：TAB_LABELS 里少了看片的中文名（留言板上显示内部 key）',
    env: 'RANK_BOARD_HTML',
    file: 'board.html',
    src: BOARD,
    from: "    music: '听乐', movie: '看片'",
    to: "    music: '听乐'",
    expectFail: ['TAB_LABELS 里有 movie 的中文名', 'build.mjs 里的 movie 中文名跟 board.html 一致'],
    expectGreen: ['TAB_LABELS 里有 music 的中文名'],
  },
  {
    label: 'tools/verify-news.mjs：多层 chip 那段循环去掉了 movie（看片的层级筛选坏了没人拦）',
    env: 'RANK_VERIFY_NEWS',
    file: 'verify-news.mjs',
    src: VERIFY_NEWS,
    /* 锚点带 `if (!t) continue;` —— 两个 ['music', 'movie'] 循环长得一样，
       只有这一个带「有才查」的 continue */
    from: "for (const k of ['music', 'movie']) {\n  const t = tabs.find((x) => x.key === k);\n  if (!t) continue;",
    to: "for (const k of ['music']) {\n  const t = tabs.find((x) => x.key === k);\n  if (!t) continue;",
    expectFail: ['verify-news.mjs 的**多层 chip** 那段循环覆盖 movie'],
    expectGreen: ['verify-news.mjs 逐个检查 music / movie 两个榜单 tab'],
  },
  {
    label: 'tools/verify-news.mjs：又加回了 follow tab 的断言（追更已经不是 tab 了）',
    env: 'RANK_VERIFY_NEWS',
    file: 'verify-news.mjs',
    src: VERIFY_NEWS,
    from: "for (const k of ['music', 'movie']) {\n  const t = tabs.find((x) => x.key === k);\n  if (!t) continue;",
    to: "for (const k of ['music', 'movie', 'follow']) {\n  const t = tabs.find((x) => x.key === k);\n  if (!t) continue;",
    expectFail: ["verify-news.mjs 里**没有** follow tab 的断言"],
    expectGreen: ['verify-news.mjs 逐个检查 music / movie 两个榜单 tab'],
  },
  {
    label: 'tools/verify-build.mjs：不再跳过文本型 tab（去母本里找榜单的图 → 直接判坏）',
    env: 'RANK_VERIFY_BUILD',
    file: 'verify-build.mjs',
    src: VERIFY_BUILD,
    /* 锚点跟着 verify-build.mjs 的结构走：现在是「跳过文本型 tab 的块」，
       里面多了一段本地化封面校验（豆瓣封面在母本里，引用了却不存在 = 线上空格子）。
       这里只把「跳过」这个守卫改坏 —— 文本型 tab 掉进图片 tab 那条路 → 被判缺 full/thumb。 */
    from: '    if (isTextTab(tab)) {',
    to: '    if (false) {',
    expectFail: ['verify-build.mjs 跳过文本型 tab 的 full/thumb 核对'],
    expectGreen: ['app.js 里有 renderRank', 'watchList 的拼接顺序**恰好**是'],
  },
  {
    label: 'site/app.js：renderChips 给 chip 排了序（目录顺序跟数据顺序对不上）',
    env: 'RANK_APP_JS',
    file: 'app.js',
    src: APPJS,
    /* 锚点定在 renderChips 的「候选 + 去重」那段 —— 选项就是按遇到顺序 push 的，
       加一个 sort() 就把「数据顺序 = 目录顺序」的前提打破了。 */
    from: '        var opts = [];\n        var seen = {};\n        for (var j = 0; j < cands.length; j++) {',
    to: '        var opts = [];\n        var seen = {};\n        cands.sort(function (a, b) { return (a.getAttribute(\'data-lv\') || \'\').localeCompare(b.getAttribute(\'data-lv\') || \'\'); });\n        for (var j = 0; j < cands.length; j++) {',
    expectFail: ['renderChips 按**候选出现顺序**去重'],
    expectGreen: ['app.js 里有 levelTags', 'watchList 的拼接顺序**恰好**是'],
  },
  {
    label: 'site/app.js：计数单位又写死成只对 headlines 用「条」（榜单 tab 显示「200 张」）',
    env: 'RANK_APP_JS',
    file: 'app.js',
    src: APPJS,
    from: "    countPill.textContent = s.tab.count + (s.tab.type ? ' 条' : ' 张');",
    to: "    countPill.textContent = s.tab.count + (s.tab.type === 'headlines' ? ' 条' : ' 张');",
    expectFail: ['app.js 没有把计数单位写死成只对 headlines 用「条」', 'app.js 的计数单位对**所有文本型 tab** 用「条」'],
    expectGreen: ['app.js 里有 levelTags'],
  },

  /* ── v2：多层 chip + 豆瓣封面本地化 ── */
  {
    /* 平台名带空格（Prime Video），空格分隔的 data-tags 会把标签拆成两半，
       筛选直接失效。 */
    label: 'site/app.js：层级标签从 JSON 改成空格分隔（平台名 Prime Video 带空格 → 标签被拆坏）',
    env: 'RANK_APP_JS',
    file: 'app.js',
    src: APPJS,
    from: "    li.setAttribute('data-lv', JSON.stringify(it.tags && it.tags.length ? it.tags : [it.tag || '']));",
    to: "    li.setAttribute('data-tags', (it.tags && it.tags.length ? it.tags : [it.tag || '']).join(' '));",
    expectFail: ['多层标签写进 data-lv', 'app.js 读的是 data-lv'],
    expectGreen: ['app.js 里有 levelTags'],
  },
  {
    /* 一条内容可以同属多个值（既在中文榜又在国际榜）。
       只取第一个的话，它就只会出现在一个榜里。 */
    label: 'site/app.js：levelTags 只取第一个匹配值（多榜共有的歌只剩一个榜能筛到）',
    env: 'RANK_APP_JS',
    file: 'app.js',
    src: APPJS,
    from: '      for (var i = 0; i < arr.length; i++) {',
    to: '      for (var i = 0; i < arr.length && out.length < 1; i++) {',
    expectFail: ['levelTags 遍历的是**全部**标签'],
    expectGreen: ['app.js 里有 levelTags', 'app.js 里**没有**单值的 levelTag'],
  },
  {
    label: 'site/app.js：层级上限从 4 改成 1（细分 / 类型两层 chip 永远不出现）',
    env: 'RANK_APP_JS',
    file: 'app.js',
    src: APPJS,
    from: '    var MAX_LEVEL = 4;',
    to: '    var MAX_LEVEL = 1;',
    expectFail: ['层级上限是 4 层'],
    expectGreen: ['app.js 读的是 data-lv'],
  },
  {
    label: 'site/app.css：.chips-lv3 被改名（第三层的 chip 没有样式）',
    env: 'RANK_APP_CSS',
    file: 'app.css',
    src: APPCSS,
    from: '.chips-lv3 .chip',
    to: '.chips-lv3-off .chip',
    expectFail: ['app.css 有 .chips-lv3 / .chips-lv4'],
    expectGreen: ['app.css 有 .chip-line'],
  },
  {
    /* 封面产物名必须符合 <10位随机段>_<3位序号>.webp ——
       upload-r2 只传这种、代理只放行这种、r2-prune 只认这种。
       换成 .jpg 的话，上传时被跳过、代理 404、prune 当垃圾删 —— 三处一起坏。 */
    label: 'build.mjs：封面产物名换成 <hash>.jpg（upload-r2 跳过 / 代理 404 / r2-prune 当垃圾删）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    /* 两处（初次赋值 + 撞名重试），要一起改 —— 只改一处的话护栏照样绿 */
    all: true,
    from: "${nonce}_${String(seq).padStart(3, '0')}.webp",
    to: '${nonce}.jpg',
    expectFail: ['封面产物用的是**现有的产物命名**'],
    expectGreen: ['封面的类别目录名是 covers'],
  },
  {
    label: 'build.mjs：封面被强制拉成正方形（电影海报 2:3 会被拉胖）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    /* 两处（代码 + 注释），要一起改 —— 只改一处的话护栏照样绿 */
    all: true,
    from: 'force_original_aspect_ratio=decrease',
    to: 'force_original_aspect_ratio=fill',
    expectFail: ['封面转换是**等比缩放**'],
    expectGreen: ['封面的类别目录名是 covers'],
  },
  {
    label: 'build.mjs：远程封面被当成本地封面处理（猫眼/B站/网易云的封面全变空）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: "    if (raw.indexOf('local:') !== 0) { out.push({ ...it, cover: raw }); continue; }",
    to: '    if (false) { out.push({ ...it, cover: raw }); continue; }',
    expectFail: ['远程封面 URL 原样保留'],
    expectGreen: ['封面本地化失败只降级'],
  },
  {
    label: 'build.mjs：本地封面的越界检查被去掉（rel 里带 .. 就能去读任意文件）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: "    if (!rel || rel.includes('..') || path.isAbsolute(rel)) {",
    to: '    if (!rel) {',
    expectFail: ['本地封面路径做了越界检查'],
    expectGreen: ['远程封面 URL 原样保留'],
  },
  {
    label: 'build.mjs：封面本地化失败改成直接抛（一张封面坏了，整期构建失败）',
    env: 'RANK_BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: '      console.warn(`  ! 封面本地化失败（${rel}）：${err.message} —— 这条先没有封面`);',
    to: '      throw err;',
    expectFail: ['封面本地化失败只降级'],
    expectGreen: ['远程封面 URL 原样保留'],
  },
  {
    /* 豆瓣封面本地化后是站内路径，挂在 cover 字段上（不在 full/thumb 里）。
       只收 full/thumb 的话，--orphans 会把这些封面当孤儿删掉 → 线上直接裂图。 */
    label: 'tools/r2-prune.mjs：引用键集不收 it.cover（豆瓣封面会被当孤儿删掉）',
    env: 'RANK_R2_PRUNE',
    file: 'r2-prune.mjs',
    src: R2PRUNE,
    from: 'for (const u of [it.full, it.thumb, it.cover]) {',
    to: 'for (const u of [it.full, it.thumb]) {',
    expectFail: ['r2-prune.mjs 的引用键集也收 it.cover'],
    expectGreen: ['r2-prune.mjs 只把**站内绝对路径**算进引用'],
  },
  {
    label: 'tools/r2-prune.mjs：引用键集不筛站内路径（远程热链封面切出来是垃圾字符串）',
    env: 'RANK_R2_PRUNE',
    file: 'r2-prune.mjs',
    src: R2PRUNE,
    from: "        if (u.indexOf('/img/') !== 0) continue; // 只认站内绝对路径",
    to: '        // 只认站内绝对路径',
    expectFail: ['r2-prune.mjs 只把**站内绝对路径**算进引用'],
    expectGreen: ['r2-prune.mjs 的引用键集也收 it.cover'],
  },
];

/* ── 0) 锚点自检：脚本过期了就直接停 ────────────────────────────── */
console.log('\n0) 锚点自检：每个 from 必须在目标文件里唯一命中');
{
  const stale = [];
  for (const m of MUTANTS) {
    const n = countOf(m.src, m.from);
    const ok = m.all ? n >= 1 : n === 1;
    if (!ok) {
      stale.push(`  · ${m.label}\n      锚点命中 ${n} 次（要求 ${m.all ? '≥ 1' : '恰好 1'}）：${JSON.stringify(m.from.slice(0, 90))}`);
    }
  }
  if (stale.length) {
    console.error('\n✗ 脚本过期了（源码改了？）—— 下面这些变异点的锚点在对不上：');
    for (const s of stale) console.error(s);
    console.error(`\n${stale.length} 处锚点失效。先修锚点（或者生产代码改动后同步这里）再跑。`);
    process.exit(1);
  }
  console.log(`  ✓ ${MUTANTS.length} 个变异点的锚点都唯一命中`);
}

/* ── 1) 基线：没改坏之前，护栏必须全绿 ──────────────────────────── */
console.log('\n1) 基线：没改坏之前，护栏必须全绿');
let baseStats = null;
{
  const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8' });
  baseStats = guardStats(r.stdout);
  check('test-rank-tab.mjs 基线绿', r.status === 0, (r.stdout || '').trim().split('\n').pop());
  check('基线跑出了完整的断言统计（说明护栏自己是跑完的，不是崩的）',
    !!baseStats && baseStats.fail === 0,
    baseStats ? `通过 ${baseStats.pass} / 失败 ${baseStats.fail}` : '没有统计行');
  console.log(`  · 基线断言数：${baseStats ? baseStats.pass + baseStats.fail : '?'} 条`);
}

/* ── 2) 变异：每改坏一处，主护栏必须变红 ────────────────────────── */
console.log('\n2) 变异：每改坏一处，主护栏必须变红');

fs.mkdirSync(TMP, { recursive: true });

let caught = 0;
let dirty = 0;
for (const m of MUTANTS) {
  const mutant = m.all ? m.src.replaceAll(m.from, m.to) : m.src.replace(m.from, m.to);
  if (mutant === m.src) {
    check(m.label, false, '变异体跟原文件一模一样（改坏失败）');
    continue;
  }
  const file = path.join(TMP, m.file);
  fs.writeFileSync(file, mutant, 'utf8');

  const r = spawnSync(process.execPath, [GUARD], {
    encoding: 'utf8',
    env: { ...process.env, [m.env]: file },
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const stats = guardStats(stdout);
  const failed = failedLabels(stdout);
  /* 「干净地红」= 护栏跑完了、有统计行、stderr 里没有调用栈。
     崩出来的红不算抓到 —— 那会把真缺口盖住。 */
  const clean = !!stats && !/\n\s*at\s/.test(stderr) && !/\b(Error|TypeError|ReferenceError|SyntaxError):/.test(stderr);
  const red = r.status !== 0;
  const hitExpect = m.expectFail.filter((p) => failed.some((l) => l.includes(p)));
  const wrongRed = m.expectGreen.filter((p) => failed.some((l) => l.includes(p)));

  if (red && clean && hitExpect.length > 0 && wrongRed.length === 0) caught++;
  if (!clean) dirty++;

  const detail = [
    red ? null : '护栏居然还是绿的',
    clean ? null : '护栏是崩的（不是断言不成立）',
    hitExpect.length ? null : `期望红的断言没红：${m.expectFail.join(' / ')}（实际红了：${failed.slice(0, 3).join(' / ') || '(一条都没有)'}）`,
    wrongRed.length ? null : `误伤（这些本该绿）：${wrongRed.join(' / ')}`,
  ].filter(Boolean).join('；');

  check(m.label, red && clean && hitExpect.length > 0 && wrongRed.length === 0,
    detail || `被抓到：${hitExpect[0]}（这次红了 ${failed.length} 条断言）`,
    `红了「${hitExpect[0]}」（本次共红 ${failed.length} 条）`);
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录留着也不影响 */
}
check('临时目录清掉了', !fs.existsSync(TMP));
check(`${MUTANTS.length} 处变异全部被主护栏抓到`,
  caught === MUTANTS.length, `只抓到 ${caught} 处`);
check('没有一次是「崩出来的红」（每次变红都是断言不成立）', dirty === 0, `有 ${dirty} 次是崩的`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败（${caught}/${MUTANTS.length} 处变异被抓住）`);
if (fail > 0) process.exit(1);
