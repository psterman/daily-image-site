#!/usr/bin/env node
/**
 * 追更抓取 v2 —— 构建期抓外部源，写 JSON 给 build.mjs 读。
 *
 * 零依赖：只用 Node 内置 API（global fetch / fs / path / url / crypto）。
 *
 * ── v2 的两块板 ───────────────────────────────────────────────
 *   1. 频道更新（schedule）—— **按平台/频道分组**，再加一层语言维度
 *      主源：TVmaze `https://api.tvmaze.com/schedule/full?date=YYYY-MM-DD`
 *      辅源：B站番剧 timeline、豆瓣「港剧」标签
 *   2. 本地演出（events）—— 豆瓣同城 12 城，每条带**行政区 + 类型**
 *      https://www.douban.com/location/<slug>/events   ← 必须带 Referer
 *
 * ── 为什么从 `/schedule?country=` 换成 `/schedule/full` ────────
 *   旧代码按「国家」分组，用的是 `/schedule?country=US&date=X`。
 *   2026-11-16 实测：
 *     · `/schedule` 是**按剧去重**的（一天 92 条 = 92 部剧），且 country 不给就默认 US；
 *     · 5 国 × 3 天里 **Netflix / HBO Max / Prime Video 全是 0 条** ——
 *       用户点名的平台**根本出不来**，按国家分组这件事本身就跟需求打架；
 *     · `/schedule/full` 是**集级**的：一天 5836 条 / 1247 部剧 / 105 个 webChannel，
 *       **忽略 country**（全球平台一次拿全），Netflix=33 腾讯=18 爱奇艺=18 全都在。
 *   代价是单次 11.7 MB（实测 2.4 s 拉完）—— 旧注释里「禁止用 /schedule/full（11MB 太重）」
 *   是在「按国家分组」这个前提下做的判断，分组维度一换，那个判断就不成立了：
 *   窗口自带 date-1 ~ date+11，**一次请求就够 3 天**（旧口径要 5 国 × 3 天 = 15 次）。
 *   所以默认抓 3 天（今天 + 明天 + 后天）—— 正好是窗口覆盖的范围，也是一次请求的量。
 *
 * ⚠️ `date=` 是**窗口起点**不是「精确一天」：实测返回的 airdates 横跨 date-1 ~ date+11，
 *    所以必须自己按 `e.airdate === 目标日` 过滤，不能直接用返回的条目。
 *
 * ⚠️ 豆瓣封面**不能热链**（2026-11-16 实测）：img*.doubanio.com 对「不带 Referer」的请求
 *    一律返回 **418**（14 字节 "I'm a teapot"），给不给浏览器 UA 都一样；
 *    只有带 `Referer: https://www.douban.com/` 才返回 200。
 *    浏览器里 <img> 带的是**我们自己站点的 referer** → 豆瓣封面热链必然裂图。
 *    所以这里把封面下载到 `<SRC_LOCAL>/<日期>/follow-covers/`，条目 cover 写
 *    `local:follow-covers/<sha1前16位>.jpg`（构建期由 build.mjs 改写成站内路径）。
 *
 * ⚠️ 只做**信息汇总**：不托管、不转码、不代理任何音视频。
 *    link 一律指向官方正版入口（show.officialSite）或豆瓣活动页；
 *    兜底通道的 link 一律指向豆瓣站内搜索 —— 站点上不会出现任何播放地址。
 *
 * 兜底通道（**默认关闭**）：
 *   读 tools/fetch-follow.local.json（文件不存在 = 整条通道关闭，不影响主流程）
 *   格式：{"fallbacks":[{"name":"<显示名>","url":"<列表页 URL>"}]}
 *   规矩：
 *     1) 只在主源对应板块失败时才启用（TVmaze 全挂 → 兜底填 schedule；豆瓣全城失败 → 兜底填 events）
 *     2) 只提取纯文本元数据（剧名 / 集数 / 日期），页面上所有 URL 一律丢弃
 *     3) link 统一填合法入口：https://search.douban.com/movie/subject_search?search_text=<标题>
 *     4) source = 配置里的 name
 *     5) 硬性自检：输出里出现 http:// 或 https://（豆瓣搜索链接除外）→ 直接 throw
 *
 * 用法：
 *   node tools/fetch-follow.mjs --date 2026-11-16              抓取并写文件
 *   node tools/fetch-follow.mjs --date 2026-11-16 --dry-run    只抓取并打印统计
 *   node tools/fetch-follow.mjs --help                         打印用法（exit 0）
 *
 * 退出码：0 正常 · 1 两块都空 · 2 日期格式非法
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SRC_LOCAL, srcSearchRoots } from './paths.mjs';

/** 顺手把路径解析也导出（别处要写/读同一个位置时不用再 import paths.mjs） */
export { SRC_LOCAL, srcSearchRoots };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ───────────────────────────── 常量 ───────────────────────────── */

/** 桌面 Chrome UA —— 豆瓣 / TVmaze 对非浏览器 UA 会挑食 */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 普通请求超时 20s */
export const HTTP_TIMEOUT_MS = 20000;

/**
 * TVmaze `/schedule/full` 的超时 —— 必须够长。
 * 实测单次 11.7 MB / 2.4 s，但跨境链路抖起来 20 s 会不够用。
 */
export const TVMAZE_FULL_TIMEOUT_MS = 90000;

/** 失败重试 2 次，退避 1s / 3s（到境外链路会间歇 ECONNRESET） */
export const RETRY_BACKOFF_MS = [1000, 3000];

/** 总尝试次数 = 首次 + 重试 2 次 */
export const HTTP_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

/** 源名（写进条目的 source 字段） */
export const SCHEDULE_SOURCE = 'TVmaze 播出表';
export const EVENTS_SOURCE = '豆瓣同城';
export const BILI_SOURCE = '哔哩哔哩番剧';
export const HK_SOURCE = '豆瓣港剧';
export const FALLBACK_SOURCE = '兜底';

/** 第一层（板块）标签 */
export const L1_SCHEDULE = '频道更新';
export const L1_EVENTS = '本地演出';

/** 长尾平台合并后的兜底分组名 */
export const OTHER_CHANNEL = '其他平台';

/** 语言缺失时的兜底值（TVmaze 用 '(none)' 表示没登记语言） */
export const OTHER_LANGUAGE = '其他语言';

/** 兜底 item 的唯一合法 link 前缀 */
export const DOUBAN_SEARCH_BASE = 'https://search.douban.com/movie/subject_search?search_text=';

/** 豆瓣封面下载必须带的 Referer —— 不带就是 418 */
export const DOUBAN_IMAGE_REFERER = 'https://www.douban.com/';

/** 豆瓣同城页 / 豆瓣港剧页的 Referer */
export const DOUBAN_MOVIE_BASE = 'https://movie.douban.com/';
export const BILI_REFERER = 'https://www.bilibili.com/';

/** 兜底输出里的 URL 探测器（自检用） */
const URL_RE = /https?:\/\//i;

/**
 * 只收「剧集」类型。
 *
 * 实测 /schedule/full 单日 280 条的类型分布：Scripted 78 · News 63 · Reality 52 ·
 * Talk Show 29 · Documentary 22 · Game Show 15 · Animation 12 · Sports 4 …
 * 不筛的话首页一半是新闻和脱口秀。
 */
export const SERIES_TYPES = ['Scripted', 'Documentary'];

/** 已实测 200 的 12 个同城 slug（每个 11~15 条） */
export const CITIES = [
  { name: '北京', slug: 'beijing' },
  { name: '上海', slug: 'shanghai' },
  { name: '广州', slug: 'guangzhou' },
  { name: '深圳', slug: 'shenzhen' },
  { name: '杭州', slug: 'hangzhou' },
  { name: '成都', slug: 'chengdu' },
  { name: '武汉', slug: 'wuhan' },
  { name: '南京', slug: 'nanjing' },
  { name: '重庆', slug: 'chongqing' },
  { name: '西安', slug: 'xian' },
  { name: '苏州', slug: 'suzhou' },
  { name: '天津', slug: 'tianjin' },
];

/* ── 平台（频道）归并 ──────────────────────────────────────────
 *
 * TVmaze 的原始频道名是英文/缩写，对中文读者没信息量。
 * 下面这张表照抄 tools/proto-v2.mjs 的 CHANNEL_ALIAS / CHANNEL_RENAME（已验证原型）。
 */

/** 别名归并：原始名（含前缀匹配）→ 用户可读的平台名 */
export const CHANNEL_ALIAS = [
  { label: 'Netflix', match: ['Netflix'] },
  { label: 'HBO Max', match: ['HBO Max'] },
  { label: 'HBO', match: ['HBO'] },
  { label: '迪士尼+', match: ['Disney+'] },
  { label: 'Hulu', match: ['Hulu'] },
  { label: 'Peacock', match: ['Peacock'] },
  { label: 'Prime Video', match: ['Prime Video'] },
  { label: 'Paramount+', match: ['Paramount+'] },
  { label: 'Apple TV', match: ['Apple TV'] },
  { label: '腾讯视频', match: ['Tencent QQ', 'Tencent Video', 'Tencent'] },
  { label: '优酷', match: ['Youku'] },
  { label: '爱奇艺', match: ['iQIYI'] },
  { label: '芒果TV', match: ['Mango TV'] },
  { label: '哔哩哔哩', match: ['Bilibili'] },
];

/** 纯改名（原始名本身是个数字或缩写） */
export const CHANNEL_RENAME = { '5': 'Channel 5（英国五台）' };

/**
 * chip 的顺序：**用户点名的那批**排前面（用户点名的顺序就是他们心里的顺序）。
 * 没被点名的长尾平台按条目数从多到少排在后面。
 */
export const CHANNEL_PRIORITY = [
  'Netflix',
  'HBO Max',
  '迪士尼+',
  'Hulu',
  'Peacock',
  'Prime Video',
  'Paramount+',
  'Apple TV',
  '腾讯视频',
  '优酷',
  '爱奇艺',
  '芒果TV',
  '哔哩哔哩',
];

/**
 * 两个独立源（B站番剧 / 豆瓣港剧）—— 排在点名平台之后、长尾之前。
 * 港剧**不单独成板块**，就是平台 chip 里的一个（用户拍板「可以混排」）。
 */
export const CHANNEL_SOURCES = ['B站番剧', '港剧'];

/** 长尾平台里保留独立分组的个数（其余合并进「其他平台」） */
export const LONGTAIL_CHANNELS = 10;

/** 「其他平台」分组：每个平台最多留几条 */
export const OTHER_MAX_PER_CHANNEL = 6;

/** 「其他平台」分组：总共最多几条 */
export const OTHER_MAX_TOTAL = 40;

/* ── 演出类型（豆瓣同城自己的分类法）─────────────────────────
 *
 * 城市页的「类型：」导航里就是这 14 类（实测 12 城一致）：
 * 音乐 / 喜剧 / 戏剧 / 讲座 / 聚会 / 电影 / 展览 / 运动 / 公益 / 旅行 / 赛事 / 课程 / 亲子 / 其他
 */
export const EVENT_TYPES = [
  '音乐',
  '喜剧',
  '戏剧',
  '讲座',
  '聚会',
  '电影',
  '展览',
  '运动',
  '公益',
  '旅行',
  '赛事',
  '课程',
  '亲子',
  '其他',
];

/**
 * 演出类型的判定规则（按顺序命中，先中先算）。
 *
 * ⚠️ **为什么是关键词判定**：豆瓣同城的「最近一周」列表页（events/week-all）
 *    是一张**平铺**的列表 —— 实测整页 `itemprop="eventType"` 出现 **0 次**、
 *    没有 class="tag" 标记、也没有任何按类型分组的标题，
 *    「类型：音乐/喜剧/…」只出现在页头那个**筛选导航**里（它只是跳转链接，不是条目的属性）。
 *    真要拿到精确类型，只能逐个抓类型子页（12 城 × 15 类 = 180 次，会被豆瓣限流），
 *    或者逐条抓活动详情页（140 次）。两者都与「不要逐个抓」冲突。
 *    所以这里用**条目自己的标题**做判定：命中就给类型，**命中不了就不写 @4** ——
 *    宁可少一个 chip，也不要点进去是空的（同一原则见 events 段的说明）。
 */
export const EVENT_TYPE_RULES = [
  { type: '电影', re: /电影|影展|电影节|首映|放映|观影|超前点映|点映|CINITY|IMAX|院线/ },
  { type: '展览', re: /展览|艺术展|特展|个展|群展|画展|摄影展|美术馆|博物馆|画廊|装置艺术/ },
  { type: '赛事', re: /赛事|锦标赛|冠军赛|联赛|杯赛|竞技赛|总决赛|大奖赛|斗技/ },
  { type: '旅行', re: /旅行|出游|郊游|徒步|露营|城市\s?walk|city\s?walk|自驾/ },
  { type: '运动', re: /运动|健身|球赛|篮球|足球|羽毛球|乒乓|排球|瑜伽|游泳|攀岩|滑板|跑步|马拉松|网球|骑行|攀爬/ },
  { type: '公益', re: /公益|义演|慈善|志愿者|公益行/ },
  { type: '课程', re: /课程|培训|工作坊|体验课|教学|手作|烘焙|研习|教你/ },
  { type: '讲座', re: /讲座|分享会|沙龙|对谈|论坛|峰会|公开课|读书会|大师课|直播课/ },
  { type: '聚会', re: /派对|聚会|社交|酒会|茶会|下午茶|见面|联谊|跨行业|局/ },
  { type: '音乐', re: /音乐会|交响|演唱会|音乐节|民谣|摇滚|爵士|钢琴|大提琴|小提琴|民乐|古典乐|电音|乐队/ },
  { type: '戏剧', re: /戏剧|话剧|舞剧|音乐剧|戏曲|昆曲|京剧|越剧|黄梅戏|木偶戏|默剧|歌剧|大戏|舞演/ },
  { type: '喜剧', re: /喜剧|脱口秀|相声|小品|麻花|爆笑|搞笑|滑稽|捧腹/ },
  { type: '亲子', re: /亲子|儿童|少儿|宝宝|童话|乐园|研学|萌娃/ },
];

/**
 * 源站基址。
 * 留 env 覆盖是为了让护栏能指向本机 fixture server（离线跑 CLI 用），
 * 默认值就是线上正式地址。
 */
const TVMAZE_BASE = String(process.env.FETCH_FOLLOW_TVMAZE_BASE || 'https://api.tvmaze.com').replace(/\/+$/, '');
const DOUBAN_BASE = String(process.env.FETCH_FOLLOW_DOUBAN_BASE || 'https://www.douban.com').replace(/\/+$/, '');
const BILI_BASE = String(process.env.FETCH_FOLLOW_BILI_BASE || 'https://api.bilibili.com').replace(/\/+$/, '');
const DOUBAN_MOVIE_BASE_ENV = String(process.env.FETCH_FOLLOW_DOUBAN_MOVIE_BASE || DOUBAN_MOVIE_BASE).replace(/\/+$/, '');

/** 兜底配置文件（不存在 = 通道关闭） */
export const FALLBACK_CONFIG_PATH = path.join(__dirname, 'fetch-follow.local.json');

/**
 * 节流间隔（毫秒）。
 *
 * 豆瓣同城 12 个城 + 140 张封面图 = 150+ 次请求，间隔太密会被限流（403/418）。
 * 这两个值可以用 env 调低 —— 护栏跑本机 fixture server 时设 0 就行，
 * 否则每次变异测试都要多等好几分钟。
 */
export const CITY_DELAY_MS = Number(process.env.FETCH_FOLLOW_CITY_DELAY_MS ?? 250) || 0;
export const COVER_DELAY_MS = Number(process.env.FETCH_FOLLOW_COVER_DELAY_MS ?? 60) || 0;

/* ───────────────────────────── 小工具 ───────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function codePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/** 解 HTML 实体（&amp; 最后解，否则 &amp;lt; 会被解两次） */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&middot;/gi, '·')
    .replace(/&hellip;/gi, '…')
    .replace(/&mdash;/gi, '—')
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&lsquo;|&rsquo;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** 剥标签 + 压空白 */
function stripTags(s) {
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textOf(html) {
  return stripTags(decodeEntities(html));
}

/** 校验 YYYY-MM-DD，且必须是真日子（2026-13-45 不算） */
export function isDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** 北京时区的今天（不能用本机时区 —— 差一天就是差一期） */
export function beijingToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || { value: '' }).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 日期加天数（UTC 算，不受本机时区影响） */
export function addDays(date, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return String(date || '');
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + Number(n || 0) * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function errMsg(e) {
  return e && e.message ? String(e.message) : String(e);
}

/** 时间戳 → 毫秒（解析不了给 Infinity，排序时沉底） */
function tval(s) {
  const t = Date.parse(String(s || ''));
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/** http:// → https://（TVmaze 的 officialSite 有一半是 http，站点是 https → mixed content） */
export function toHttps(url) {
  const s = String(url || '');
  return s.startsWith('http://') ? 'https://' + s.slice('http://'.length) : s;
}

/* ───────────────────────────── 网络层 ───────────────────────────── */

/** 网络层面的失败才值得重试（HTTP 4xx 是站点自己的回答） */
function isRetryable(err) {
  if (!err) return false;
  if (err.retryable) return true;
  if (err.name === 'AbortError') return true;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|terminated|network/i.test(
    String(err.message || err),
  );
}

/** 会重定向的状态码 */
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * 自己实现跳转跟随，**不用** fetch 的 redirect:'follow'。
 *
 * 为什么：豆瓣的 301 是「软跳转」—— 响应体里写着
 * "Your browser should have redirected you to <真实地址>"，
 * 而 Location 头指的地方还会再 301 一次。Node 内置 fetch（undici）在这条链上会
 * 停在 301 不跟完，拿到的是跳转提示页而不是真页面（原型 tools/proto-v2.mjs 实测）。
 * 自己跟还有一个好处：**Referer 不会被 undici 改写成新域名的**，
 * 豆瓣的图床/同城页对 Referer 敏感（418 那条坑就是 Referer 触发的）。
 */
async function followRedirects(doFetch, url, headers, timeoutMs, maxRedirects, read) {
  let current = String(url);
  for (let depth = 0; depth <= maxRedirects; depth++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      });
      const loc = res.headers && res.headers.get ? res.headers.get('location') : null;
      if (REDIRECT_CODES.has(res.status) && loc) {
        try {
          if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
        } catch {
          /* 取消失败无所谓，继续跳 */
        }
        current = new URL(loc, current).href;
        continue;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        // 429 / 5xx 是「限流 / 暂时挂了」，重试有意义；其它 4xx 重试没用
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      return await read(res);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`重定向跳太多次（>${maxRedirects}）：${url}`);
}

/**
 * 带超时 + 重试的 GET（返回文本）。
 *
 * 退避表是 1s / 3s（失败重试 2 次）—— 到境外的链路会间歇 ECONNRESET，
 * 不退避直接重试基本还是撞同一个坑。
 */
export async function httpGet(
  url,
  {
    headers = {},
    timeoutMs = HTTP_TIMEOUT_MS,
    attempts = HTTP_ATTEMPTS,
    backoffMs = RETRY_BACKOFF_MS,
    fetchImpl = null,
    maxRedirects = 6,
  } = {},
) {
  const doFetch = fetchImpl || globalThis.fetch;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await followRedirects(doFetch, url, headers, timeoutMs, maxRedirects, (res) => res.text());
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || i === attempts - 1) throw e;
      await sleep(backoffMs[i] ?? backoffMs[backoffMs.length - 1]);
    }
  }
  throw lastErr;
}

/** 下载二进制（图片）—— 同样自己跟跳转 */
export async function httpBinary(
  url,
  headers = {},
  { timeoutMs = HTTP_TIMEOUT_MS, attempts = HTTP_ATTEMPTS, backoffMs = RETRY_BACKOFF_MS, fetchImpl = null, maxRedirects = 6 } = {},
) {
  const doFetch = fetchImpl || globalThis.fetch;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await followRedirects(doFetch, url, headers, timeoutMs, maxRedirects, async (res) =>
        Buffer.from(await res.arrayBuffer()),
      );
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || i === attempts - 1) throw e;
      await sleep(backoffMs[i] ?? backoffMs[backoffMs.length - 1]);
    }
  }
  throw lastErr;
}

/** GET + JSON 解析 */
export async function httpJson(url, opts = {}) {
  const txt = await httpGet(url, opts);
  try {
    return JSON.parse(txt);
  } catch (e) {
    throw new Error(`${url} → 不是 JSON（前 120 字：${txt.slice(0, 120)}）：${errMsg(e)}`);
  }
}

/** 豆瓣同城页必须带的 Referer */
export function doubanReferer(slug) {
  return `${DOUBAN_BASE}/location/${slug}/`;
}

/* ───────────────────────────── 排序键 ───────────────────────────── */

/**
 * 挂一个排序键，但**不可枚举** —— 这样 JSON.stringify / Object.keys 都看不到它，
 * 契约里的 9 个字段一个不多一个不少，排序信息只在内存里跟着走。
 */
export function withKey(item, key) {
  Object.defineProperty(item, '_key', { value: key, enumerable: false, writable: true, configurable: true });
  return item;
}

/**
 * 合并多个来源后重新排序用的通用比较器（读不可枚举的 _key）。
 *
 * _key 的形状：
 *   剧集更新 → [airdate, airstamp 绝对毫秒, title]
 *   演出     → [开始时间绝对毫秒]
 */
export function compareKeys(a, b) {
  const ka = a._key || [];
  const kb = b._key || [];
  const n = Math.min(ka.length, kb.length);
  for (let i = 0; i < n; i++) {
    const x = ka[i];
    const y = kb[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return ka.length - kb.length;
}

/* ───────────────────────────── 标签（层级） ───────────────────────────── */

/**
 * 归一化 tags：每层最多一个标签、层号严格递增、值非空。
 *
 * 形状是 '@<层号>:<值>'：@1 板块 / @2 平台或城市 / @3 语言或行政区 / @4 演出类型。
 * ⚠️ 层号是**语义层**，不是「第几个标签」——
 *    演出条目没有行政区时就是 @1/@2/@4（跳过 @3），前端要能认得出这个空洞。
 */
export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const picked = [];
  const usedLayer = new Set();
  for (const raw of list) {
    const m = /^@(\d+):\s*(.+)$/.exec(String(raw == null ? '' : raw).trim());
    if (!m) continue;
    const layer = Number(m[1]);
    const value = m[2].trim();
    if (!Number.isFinite(layer) || layer < 1 || !value) continue;
    if (usedLayer.has(layer)) continue;
    usedLayer.add(layer);
    picked.push({ layer, value });
  }
  picked.sort((a, b) => a.layer - b.layer);
  return picked.map((p) => `@${p.layer}:${p.value}`);
}

/** 把某条目的 @2 层换成别的平台（长尾合并进「其他平台」时用） */
function retagChannel(item, channel) {
  const tags = normalizeTags([...(item.tags || []).filter((t) => !/^@2:/.test(t)), `@2:${channel}`]);
  item.tag = channel;
  item.tags = tags;
  return item;
}

/* ───────────────────────────── 解析：TVmaze ───────────────────────────── */

/**
 * 频道归并：TVmaze 的原始频道名是英文/缩写，对中文读者没信息量。
 * 这里把用户点名的平台换成中文名，其余保留原名（能认出是谁就行）。
 */
export function bucketChannel(raw) {
  const name = String(raw || '').trim();
  if (!name) return '';
  for (const b of CHANNEL_ALIAS) {
    if (b.match.some((m) => name === m || name.startsWith(m))) return b.label;
  }
  return CHANNEL_RENAME[name] || name;
}

/** 语言归一：TVmaze 用 '(none)' 表示没登记语言 */
export function normalizeLanguage(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '(none)') return OTHER_LANGUAGE;
  return s;
}

/**
 * 解析 TVmaze `/schedule/full` 的条目。
 *
 * ⚠️ **条目结构是 `e._embedded.show`**（不是 `e.show`）——
 *    `/schedule/full` 的每条 episode 把**完整的 show 对象**内嵌在 `_embedded` 里。
 * ⚠️ **必须按 airdate 精确过滤**：`date=` 是窗口起点，返回的 airdates 横跨 date-1 ~ date+11。
 * ⚠️ **只留「剧集」**：type 缺失的照样保留（判不出来就不丢数据），
 *    真出了结构问题，外层「源返回了 N 条却解析出 0 条」的守卫会响。
 * ⚠️ **同一剧同一天多集只留一条**（按 show.id 去重，留最早播出的一集）。
 *
 * @param {Array} entries  API 返回的 episode 数组
 * @param {string} day     目标日（只留 airdate === day 的）
 * @param {object} opts    { source, types } —— types=null 表示不过滤（结构自检用）
 */
export function parseTvmazeFull(entries, day, opts = {}) {
  const source = String(opts.source || SCHEDULE_SOURCE);
  const types = opts.types === null ? null : Array.isArray(opts.types) && opts.types.length ? opts.types : SERIES_TYPES;
  const arr = Array.isArray(entries) ? entries : [];
  const target = String(day || '');

  /** show.id → 已收下的那条（留最早播出的） */
  const byShow = new Map();

  for (const ep of arr) {
    if (!ep) continue;
    if (target && String(ep.airdate || '') !== target) continue;
    const show = (ep._embedded && ep._embedded.show) || ep.show;
    if (!show || !show.name) continue;

    const showType = String(show.type || '').trim();
    if (types && showType && !types.includes(showType)) continue;

    const id = show.id != null ? show.id : `${show.name}|${String(show.webChannel && show.webChannel.name || '')}`;
    const airstamp = String(ep.airstamp || '').trim();
    const prev = byShow.get(id);
    if (prev) {
      // 同一剧当天多集：留最早播出的一集
      if (tval(airstamp) < tval(prev.airstamp)) byShow.set(id, { ep, show, airstamp });
      continue;
    }
    byShow.set(id, { ep, show, airstamp });
  }

  const rows = [];
  for (const { ep, show, airstamp } of byShow.values()) {
    const rawChannel =
      (show.webChannel && show.webChannel.name) || (show.network && show.network.name) || '';
    const channel = bucketChannel(rawChannel) || OTHER_CHANNEL;
    const language = normalizeLanguage(show.language);

    const season = ep.season != null ? Number(ep.season) : NaN;
    const number = ep.number != null ? Number(ep.number) : NaN;
    const epName = String(ep.name || '').trim();
    const se = Number.isFinite(season) && Number.isFinite(number) ? `S${season}E${number}` : '';
    const subtitle = [se, epName].filter(Boolean).join(' · ');

    const airdate = String(ep.airdate || '').trim();
    const airtime = String(ep.airtime || '').trim();
    const meta = [airdate, airtime, rawChannel].filter(Boolean).join(' · ');

    const img = show.image || {};
    const cover = toHttps(img.medium || img.original || '');

    /* officialSite 原样带过来会是 http://（TVmaze 里实测 280 条里 51 条是 http），
       站点是 https → mixed content，浏览器可能直接拦。统一升成 https。 */
    const link = toHttps(
      (show.officialSite && String(show.officialSite).trim()) ||
        `https://www.tvmaze.com/shows/${show.id}`,
    );

    rows.push(
      withKey(
        {
          rank: 0,
          title: String(show.name).trim(),
          subtitle,
          meta,
          cover,
          link,
          source,
          tag: channel,
          tags: normalizeTags([`@1:${L1_SCHEDULE}`, `@2:${channel}`, `@3:${language}`]),
        },
        [airdate, tval(airstamp), String(show.name).trim()],
      ),
    );
  }
  return rows;
}

/**
 * 拉 `/schedule/full` 并按天分桶。
 *
 * 一次请求就够 3 天 —— 窗口自带 date-1 ~ date+11。
 * 某天一个条目都没有时，单独再拉那一天（保险）。
 */
export async function fetchTvmazeFull(days, { fetchImpl = null } = {}) {
  const byDay = new Map(days.map((d) => [d, []]));
  const loaded = new Set();

  const load = async (d) => {
    if (loaded.has(d)) return;
    loaded.add(d);
    const raw = await httpGet(`${TVMAZE_BASE}/schedule/full?date=${d}`, {
      timeoutMs: TVMAZE_FULL_TIMEOUT_MS,
      fetchImpl,
    });
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      throw new Error(`不是合法 JSON：${errMsg(e)}`);
    }
    if (!Array.isArray(arr)) throw new Error('返回的不是数组（源结构可能变了）');
    for (const e of arr) {
      const d2 = String((e && e.airdate) || '');
      if (d2 && byDay.has(d2)) byDay.get(d2).push(e);
    }
  };

  await load(days[0]);
  for (const d of days) {
    if (!byDay.get(d).length) await load(d);
  }
  return byDay;
}

/* ───────────────────────────── 解析：B站番剧 ───────────────────────────── */

/**
 * B站番剧 timeline。
 *
 * ⚠️ `day` 参数**不生效**（day=1 与 day=3 同结果）—— 实测一次给 7 天 23 集，
 *    所以这里全收，不按天切（切了反而可能一刀切空）。
 * ⚠️ B站番剧**没有语言这一层** —— tags 只有 @1/@2。
 */
export function parseBiliBangumi(result, opts = {}) {
  const source = String(opts.source || BILI_SOURCE);
  const arr = Array.isArray(result) ? result : [];
  const rows = [];
  for (const day of arr) {
    if (!day) continue;
    const date = String(day.date || '').trim();
    for (const ep of day.episodes || []) {
      if (!ep) continue;
      const title = String(ep.title || (ep.ep && ep.ep.title) || '').trim();
      if (!title) continue;
      const pubIndex = String(ep.pub_index || '').trim();
      const indexNum = Number(pubIndex);
      const subtitle = pubIndex ? (Number.isFinite(indexNum) && indexNum > 0 ? `第${pubIndex}话` : pubIndex) : '';
      const cover = toHttps(ep.cover || ep.square || '');
      const link = ep.ep_id
        ? `https://www.bilibili.com/bangumi/play/ep${ep.ep_id}`
        : String(ep.link || '');
      rows.push(
        withKey(
          {
            rank: 0,
            title,
            subtitle,
            meta: [date, String(ep.pub_time || '').trim()].filter(Boolean).join(' · '),
            cover,
            link,
            source,
            tag: 'B站番剧',
            tags: normalizeTags([`@1:${L1_SCHEDULE}`, '@2:B站番剧']),
          },
          [date, 0, title],
        ),
      );
    }
  }
  return rows;
}

/* ───────────────────────────── 解析：豆瓣港剧 ───────────────────────────── */

/**
 * 豆瓣「港剧」标签（中文源，直给封面链接）。
 * ⚠️ 排序是否按「最新」未确认（sort=time 参数没验证生效）→ 当成「港剧片单」用。
 * ⚠️ 港剧**不单独成板块** —— 它就是平台 chip 里的一个（用户拍板「可以混排」）。
 */
export function parseDoubanHK(subjects, opts = {}) {
  const source = String(opts.source || HK_SOURCE);
  const arr = Array.isArray(subjects) ? subjects : [];
  const rows = [];
  for (const s of arr) {
    if (!s) continue;
    const title = String(s.title || '').trim();
    if (!title) continue;
    const rate = String(s.rate || '').trim();
    rows.push(
      withKey(
        {
          rank: 0,
          title,
          subtitle: String(s.subtitle || '').trim(),
          meta: rate ? `${rate} 分` : '',
          /* 港剧封面同样会下载到本地 → URL 只当下载源用，不升 https */
          cover: String(s.cover || '').trim(),
          link: String(s.url || '').trim(),
          source,
          tag: '港剧',
          tags: normalizeTags([`@1:${L1_SCHEDULE}`, '@2:港剧']),
        },
        ['', 0, title],
      ),
    );
  }
  return rows;
}

/* ───────────────────────────── 解析：豆瓣同城 ───────────────────────────── */

/** 行政区（静安区 / 上城区 …） */
export const DISTRICT_RE = /^[一-龥]{1,6}(区|县)$/;

/** 地址关键词（路 / 街 / 号 / 楼 …） */
export const ADDRESS_RE = /(路|街|号|栋|座|层|室|巷|弄|村|镇|园|大厦|广场|胡同|弄堂)/;

/**
 * 把豆瓣同城「地点」那一行拆成 行政区 / 场馆 / 地址。
 *
 * 豆瓣给的原始串是「城市 行政区 场馆 地址」四段拼的（见 <li title="...">），
 * 段与段之间是空格，但**场馆本身也可能带空格**（"中影国际影城天天中影CINITY LED店"），
 * 所以不能简单按空格切 —— 只有当最后一段长得像地址（带路/街/号/楼…）时才当地址。
 *
 * ⚠️ **行政区要留着**（v2 改动）：旧代码用 DISTRICT_RE 匹配后**直接 slice 掉了**，
 *    于是「区」这个维度在数据里根本不存在。现在保留它 → 演出条目能带 @3:行政区。
 */
export function splitVenueAddress(raw, cityName = '') {
  const text = decodeEntities(String(raw || '')).replace(/\s+/g, ' ').trim();
  if (!text) return { district: '', venue: '', address: '' };
  let parts = text.split(' ').filter(Boolean);
  if (cityName && parts[0] === cityName) parts = parts.slice(1);
  let district = '';
  if (parts.length && DISTRICT_RE.test(parts[0])) {
    district = parts[0];
    parts = parts.slice(1);
  }
  if (!parts.length) return { district, venue: '', address: '' };
  if (parts.length >= 2 && ADDRESS_RE.test(parts[parts.length - 1])) {
    return { district, venue: parts.slice(0, -1).join(' '), address: parts[parts.length - 1] };
  }
  return { district, venue: parts.join(' '), address: '' };
}

/**
 * 从演出标题判定类型（豆瓣自己的分类法）。
 * 判不出来就给空串 —— **不写 @4 标签**，宁可少一个 chip。
 */
export function classifyEventType(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  for (const rule of EVENT_TYPE_RULES) {
    if (rule.re.test(t)) return rule.type;
  }
  return '';
}

/**
 * 解析城市页里的「区级链接」和「类型分类」—— 这两张表是 chip 的**候选集合**。
 *
 * ⚠️ **锚文本跨行带缩进**（`>\n   音乐\n  </a>`）→ 正则上限要放宽（例如 {1,60}），
 *    取值时再 trim。上限写 {1,10} 会把「换行 + 16 个空格」一起吃掉 → 整条不匹配。
 */
export function parseCityMeta(html) {
  const src = String(html || '');
  const districts = [];
  const seen = new Set();
  for (const m of src.matchAll(/href="[^"]*\/events\/week-all-(\d+)"[^>]*>\s*([^<]{1,60})/g)) {
    const name = textOf(m[2]);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    districts.push(name);
  }
  const types = [];
  const tseen = new Set();
  for (const m of src.matchAll(/href="[^"]*\/events\/week-([a-z]+)"[^>]*>\s*([^<]{1,60})</g)) {
    const name = textOf(m[2]);
    if (!name || tseen.has(name) || name === '全部') continue;
    tseen.add(name);
    types.push(name);
  }
  return { districts, types };
}

/** ISO 时间戳 → 「2026-11-17 12:30」 */
function fmtStamp(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(s || '').trim());
  if (m) return `${m[1]} ${m[2]}`;
  return String(s || '').trim();
}

/** 事件的时间描述：优先用 <time datetime>（机器可读），没有才退回可见文字 */
function eventMeta(block) {
  const startM = block.match(/<time itemprop="startDate" datetime="([^"]*)"/i);
  const endM = block.match(/<time itemprop="endDate" datetime="([^"]*)"/i);
  const start = startM ? startM[1].trim() : '';
  const end = endM ? endM[1].trim() : '';
  if (start) {
    const s = fmtStamp(start);
    if (!end) return s;
    const e = fmtStamp(end);
    if (!e) return s;
    const sDate = s.split(' ')[0];
    const eDate = e.split(' ')[0];
    const eTime = e.includes(' ') ? e.split(' ')[1] : '';
    // 同一天：结束时间只给时刻，跨天：带完整日期
    return sDate === eDate && eTime ? `${s} - ${eTime}` : `${s} - ${e}`;
  }
  const timeLi = block.match(/<li class="event-time"[^>]*>([\s\S]*?)<\/li>/i);
  if (timeLi) {
    const t = textOf(timeLi[1]).replace(/^时间[：:]\s*/, '').trim();
    if (t) return t;
  }
  return '';
}

/**
 * 解析豆瓣同城活动页。
 *
 * @param {string} html       页面 HTML
 * @param {string} cityName   城市中文名（做 tag，也用来切地点串）
 * @param {object} opts       { allowedTypes } —— 该城页面上认的类型候选集（用于校验推断出的类型）
 * @returns {Array} 契约条目（9 个字段），按开始时间升序
 */
export function parseDoubanEvents(html, cityName, opts = {}) {
  const src = String(html || '');
  const city = String(cityName || '').trim();
  const allowed = Array.isArray(opts.allowedTypes) && opts.allowedTypes.length ? opts.allowedTypes : null;

  const blocks = src.split('<li class="list-entry"').slice(1);
  const rows = [];

  for (const block of blocks) {
    /* 侧栏的推荐位也是 list-entry，但没有 itemprop="summary" → 靠它挡掉 */
    let title = '';
    const sumM = block.match(/<span itemprop="summary"[^>]*>([\s\S]*?)<\/span>/i);
    if (sumM) title = textOf(sumM[1]);
    if (!title) {
      const titleM = block.match(/<a href="[^"]*\/event\/\d+\/"[^>]*title="([^"]*)"/i);
      if (titleM) title = decodeEntities(titleM[1]).trim();
    }
    if (!title) continue;

    const link = (block.match(/href="([^"]*\/event\/\d+\/)"/i) || [])[1] || '';

    // 海报在 data-lazy 里 —— src 是 blank.gif 占位图，不是真海报
    const picM = block.match(/<div class="pic">([\s\S]*?)<\/div>/i);
    const picHtml = picM ? picM[1] : block;
    /* ⚠️ 这里**不**升 https：豆瓣封面一律会被下载到本地（见 localizeCovers），
       cover 最终写的是 local: 标记，这个 URL 只当「下载源」用 ——
       升了反而会跟本机 fixture server 打架（护栏是 http 的）。 */
    const cover = (picHtml.match(/data-lazy="([^"]+)"/i) || [])[1] || '';

    const meta = eventMeta(block);

    const locM = block.match(/<li title="([^"]*)"/i);
    const loc = locM ? locM[1] : '';
    const { district, venue, address } = splitVenueAddress(loc, city);
    const subtitle = [district, venue, address].filter(Boolean).join(' · ');

    /* 类型：标题关键词判定 + 候选集校验；判不出来就不写 @4 */
    let type = classifyEventType(title);
    if (type && allowed && !allowed.includes(type)) type = '';

    const startM = block.match(/<time itemprop="startDate" datetime="([^"]*)"/i);
    const key = startM ? tval(startM[1]) : Number.POSITIVE_INFINITY;

    const tags = [`@1:${L1_EVENTS}`, `@2:${city}`];
    if (district) tags.push(`@3:${district}`);
    if (type) tags.push(`@4:${type}`);

    rows.push(
      withKey(
        {
          rank: 0,
          title,
          subtitle,
          meta,
          cover,
          link,
          source: EVENTS_SOURCE,
          tag: city,
          tags: normalizeTags(tags),
        },
        [key],
      ),
    );
  }

  rows.sort(compareKeys);
  return rows;
}

/* ───────────────────────────── 封面本地化 ───────────────────────────── */

/**
 * 把豆瓣封面下载到本地，改写成 `local:` 标记。
 *
 * ⚠️ 为什么必须存本地：实测 img*.doubanio.com 对「不带 Referer」的请求一律 418
 *    （14 字节 "I'm a teapot"），而浏览器里的 <img> 带的是**我们自己站点的 referer**
 *    → 豆瓣封面热链必然裂图（生产环境也救不了）。
 * ⚠️ 失败的条目 cover 留空字符串 —— **绝不能留一个会裂的远程 URL**。
 *
 * @param {Array} items  条目数组（就地改写 cover）
 * @param {object} opts  { dir, date, root, fetchImpl }
 */
export async function localizeCovers(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const root = opts.root || SRC_LOCAL;
  const dir = opts.dir || path.join(root, String(opts.date || ''), 'follow-covers');
  const delay = opts.delayMs === undefined ? COVER_DELAY_MS : Number(opts.delayMs) || 0;
  const dryRun = !!opts.dryRun;
  /* --dry-run 干跑**不能有副作用** —— 一个文件都不许落盘。 */
  if (!dryRun) fs.mkdirSync(dir, { recursive: true });

  let ok = 0;
  let fail = 0;
  let probed = false;
  for (const it of list) {
    const u = String(it.cover || '');
    if (!u || !/doubanio\.com/i.test(u)) continue;
    const name = crypto.createHash('sha1').update(u).digest('hex').slice(0, 16) + '.jpg';
    const dest = path.join(dir, name);

    if (dryRun) {
      /* 干跑只探一张（下载到内存，不落盘）—— 418 那条坑就是靠它兜住：
         豆瓣哪天改了防盗链，干跑就要能喊出来。 */
      it.cover = 'local:follow-covers/' + name;
      ok++;
      if (!probed) {
        probed = true;
        try {
          const buf = await httpBinary(u, { Referer: DOUBAN_IMAGE_REFERER }, { fetchImpl: opts.fetchImpl });
          if (!buf || buf.length < 500) fail++;
        } catch {
          fail++;
        }
      }
      continue;
    }

    if (!fs.existsSync(dest)) {
      try {
        const buf = await httpBinary(u, { Referer: DOUBAN_IMAGE_REFERER }, { fetchImpl: opts.fetchImpl });
        if (!buf || buf.length < 500) {
          fail++;
          it.cover = '';
          continue;
        }
        fs.writeFileSync(dest, buf);
      } catch {
        fail++;
        it.cover = '';
        continue;
      }
    }
    it.cover = 'local:follow-covers/' + name;
    ok++;
    if (delay > 0) await sleep(delay);
  }
  return { ok, fail, dir, dryRun };
}

/* ───────────────────────────── 解析：兜底通道 ───────────────────────────── */

/** 把页面上所有 URL 拆干净（兜底通道只许留纯文本元数据） */
function stripUrls(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/[^\s"'<>]+/gi, ' ')
    .replace(/ftp:\/\/[^\s"'<>]+/gi, ' ')
    .replace(/(^|[\s(（])\/\/[^\s"'<>]+/g, '$1')
    .replace(/\bwww\.[^\s"'<>]+/gi, ' ')
    .replace(/magnet:\?[^\s"'<>]+/gi, ' ');
}

/** 豆瓣站内搜索（兜底 item 唯一允许出现的链接） */
export function doubanSearchLink(title) {
  return DOUBAN_SEARCH_BASE + encodeURIComponent(String(title || ''));
}

/** 兜底行里「剧名 第N集 [集名] 日期」的认法 */
const FALLBACK_EP_RE =
  /([^\s][^\n]{0,80}?)\s*第\s*(\d+)\s*集\s*([^\n]{0,40}?)(\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?|\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?)/;

/** 兜底行里「剧名 日期」的认法（没有集数时） */
const FALLBACK_DATE_RE =
  /^([^\s][^\n]{1,80}?)\s*(\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?|\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?)/;

/**
 * 兜底输出的硬性自检：**绝不允许出现 URL**（豆瓣搜索链接除外）。
 *
 * 这条是整个兜底通道的命门 —— 兜底源是盗版聚合站，页面上全是播放地址，
 * 一旦漏出去，站点就会变成盗版站的外链跳板。所以宁可 throw 也不能放行。
 */
function assertNoUrls(items) {
  for (const it of items) {
    for (const [k, v] of Object.entries(it)) {
      if (k === 'link') {
        if (typeof v === 'string' && !v.startsWith(DOUBAN_SEARCH_BASE)) {
          throw new Error(`兜底 link 不是豆瓣搜索：${v}`);
        }
        continue;
      }
      if (typeof v === 'string') {
        if (URL_RE.test(v)) throw new Error(`兜底输出含 URL：${k}=${v}`);
        continue;
      }
      if (Array.isArray(v)) {
        for (const one of v) {
          if (typeof one === 'string' && URL_RE.test(one)) throw new Error(`兜底输出含 URL：${k}=${one}`);
        }
      }
    }
  }
}

/** 从一行纯文本里认「剧名 / 集数 / 日期」 */
function parseFallbackLine(line, name, tag, tags) {
  const t = String(line || '').trim();
  if (!t || t.length < 2) return null;

  const epM = FALLBACK_EP_RE.exec(t);
  let title = '';
  let subtitle = '';
  let meta = '';

  if (epM) {
    title = epM[1].replace(/[\s\-–—|:：·]+$/, '').trim();
    const epTitle = epM[3].replace(/[\s\-–—|:：·]+$/, '').trim();
    subtitle = epTitle ? `第${epM[2]}集 ${epTitle}` : `第${epM[2]}集`;
    meta = epM[4].replace(/\s+/g, '');
  } else {
    const dateM = FALLBACK_DATE_RE.exec(t);
    if (!dateM) return null;
    title = dateM[1].replace(/[\s\-–—|:：·]+$/, '').trim();
    meta = dateM[2].replace(/\s+/g, '');
  }

  if (!title) return null;

  return {
    title,
    subtitle,
    meta,
    cover: '',
    link: doubanSearchLink(title),
    source: name,
    tag,
    tags: normalizeTags(tags),
  };
}

/**
 * 解析兜底源页面 → 纯文本元数据。
 *
 * @param {string} text  兜底列表页的原始 HTML / 文本
 * @param {object} cfg   { name, tag, tags } —— 显示名与标签
 * @returns {Array} 契约条目（9 个字段）；输出里含 URL 直接 throw
 */
export function parseFallbackMeta(text, cfg = {}) {
  const name = String(cfg.name || '兜底').trim() || '兜底';
  const tag = String(cfg.tag || FALLBACK_SOURCE).trim() || FALLBACK_SOURCE;
  const tags = Array.isArray(cfg.tags) ? cfg.tags : [`@1:${L1_SCHEDULE}`, `@2:${tag}`];

  const raw = stripUrls(String(text || ''));
  const lines = [];
  for (const one of raw.split(/[\n\r]+/)) {
    const l = one.replace(/\s+/g, ' ').trim();
    if (l) lines.push(l);
  }

  const items = [];
  for (const c of lines) {
    const item = parseFallbackLine(c, name, tag, tags);
    if (item) items.push(item);
  }

  assertNoUrls(items);

  return items.map((it, i) => ({
    rank: i + 1,
    title: it.title,
    subtitle: it.subtitle,
    meta: it.meta,
    cover: it.cover,
    link: it.link,
    source: it.source,
    tag: it.tag,
    tags: it.tags,
  }));
}

/* ───────────────────────────── 兜底配置 ───────────────────────────── */

/**
 * 读兜底配置。
 *
 * 文件不存在 = 整条通道关闭（**不是错误**，主流程照常跑）。
 * 文件坏掉 = 通道关闭 + 记一条错误，不让配置问题把主流程带崩。
 */
export function loadFallbackConfig(configPath = FALLBACK_CONFIG_PATH) {
  const p = configPath || FALLBACK_CONFIG_PATH;
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    // 文件不存在 = 通道关闭（**不是错误**：主流程照常跑）
    return {
      enabled: false,
      fallbacks: [],
      path: p,
      missing: true,
      reason: '没有配置文件（兜底通道关闭）',
    };
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    return {
      enabled: false,
      fallbacks: [],
      path: p,
      missing: false,
      reason: `配置不是合法 JSON：${errMsg(e)}`,
    };
  }
  const list = Array.isArray(cfg && cfg.fallbacks) ? cfg.fallbacks : [];
  const fallbacks = list
    .filter((f) => f && typeof f.url === 'string' && f.url.trim())
    .map((f) => ({
      name: String(f.name || '兜底').trim() || '兜底',
      url: String(f.url).trim(),
    }));
  return {
    enabled: fallbacks.length > 0,
    fallbacks,
    path: p,
    missing: false,
    reason: fallbacks.length ? '' : '配置里没有可用的兜底源',
  };
}

/* ───────────────────────────── 输出契约 ───────────────────────────── */

/** 条目字段（顺序固定，一个都不能多） */
export const ITEM_FIELDS = ['rank', 'title', 'subtitle', 'meta', 'cover', 'link', 'source', 'tag', 'tags'];

/** 顶层字段（顺序固定） */
export const PAYLOAD_FIELDS = ['date', 'generatedAt', 'cities', 'schedule', 'events', 'channels', 'languages', 'errors'];

/** 条目归一化：字段名与顺序固定，rank 连号 */
function normalizeItem(it, i) {
  const o = it || {};
  return {
    rank: i + 1,
    title: String(o.title || '').trim(),
    subtitle: String(o.subtitle || '').trim(),
    meta: String(o.meta || '').trim(),
    cover: String(o.cover || '').trim(),
    link: String(o.link || '').trim(),
    source: String(o.source || '').trim(),
    tag: String(o.tag || '').trim(),
    tags: normalizeTags(o.tags),
  };
}

/** cities 既可能是名字数组，也可能是 {name,slug} 数组 */
function cityNames(cities) {
  const list = Array.isArray(cities) ? cities : [];
  return list
    .map((c) => (typeof c === 'string' ? c : c && c.name ? String(c.name) : ''))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 从条目里取某一层的值（'@2:' → 平台/城市） */
function tagValue(tags, layer) {
  const prefix = `@${layer}:`;
  for (const t of Array.isArray(tags) ? tags : []) {
    const s = String(t || '');
    if (s.startsWith(prefix)) return s.slice(prefix.length);
  }
  return '';
}

/**
 * 平台清单：按条目里出现的先后顺序去重。
 * 条目数组本身已经是「按平台分组」排好的，所以首次出现顺序 = 用户看到的顺序。
 */
function deriveChannels(schedule) {
  const out = [];
  const seen = new Set();
  for (const it of schedule) {
    const ch = tagValue(it.tags, 2);
    if (!ch || seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}

/** 语言清单：按条目数从多到少（并列时按首次出现顺序） */
function deriveLanguages(schedule) {
  const count = new Map();
  const first = new Map();
  let n = 0;
  for (const it of schedule) {
    const lang = tagValue(it.tags, 3);
    if (!lang) continue;
    if (!count.has(lang)) first.set(lang, n++);
    count.set(lang, (count.get(lang) || 0) + 1);
  }
  return [...count.keys()].sort((a, b) => {
    const d = (count.get(b) || 0) - (count.get(a) || 0);
    if (d) return d;
    return first.get(a) - first.get(b);
  });
}

/**
 * 组装最终 JSON（build.mjs 按这个结构读，字段名一个都不能改）。
 *
 * { date, generatedAt, cities[], schedule[], events[], channels[], languages[], errors[] }
 * 条目 9 个字段：rank/title/subtitle/meta/cover/link/source/tag/tags
 */
export function buildFollowPayload({
  date = '',
  schedule = [],
  events = [],
  cities = [],
  channels = null,
  languages = null,
  errors = [],
} = {}) {
  const d = isDate(date) ? String(date).trim() : beijingToday();
  const list = Array.isArray(cities) ? cities : [];
  const names = list.length ? cityNames(list) : CITIES.map((c) => c.name);
  const sched = (Array.isArray(schedule) ? schedule : []).map(normalizeItem);
  const evts = (Array.isArray(events) ? events : []).map(normalizeItem);
  return {
    date: d,
    generatedAt: `${d}T00:00:00.000Z`,
    cities: names,
    schedule: sched,
    events: evts,
    channels: Array.isArray(channels) && channels.length ? channels.map((c) => String(c)) : deriveChannels(sched),
    languages:
      Array.isArray(languages) && languages.length ? languages.map((l) => String(l)) : deriveLanguages(sched),
    errors: (Array.isArray(errors) ? errors : []).map((e) => String(e)),
  };
}

/** 落盘位置：<SRC_LOCAL>/<date>/follow_<date>.json */
export function followFilePath(date, { root = SRC_LOCAL } = {}) {
  return path.join(root, String(date), `follow_${String(date)}.json`);
}

/** 历史位置也认（挪过盘的老目录），写还是写规范位置 */
export function followFileCandidates(date) {
  return srcSearchRoots().map((root) => followFilePath(date, { root }));
}

/** 写文件（dryRun 时只报路径，不落盘） */
export function writeFollowFile(payload, date, { root = SRC_LOCAL, dryRun = false } = {}) {
  const file = followFilePath(date, { root });
  if (dryRun) return { file, written: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { file, written: true };
}

/* ───────────────────────────── 编排 ───────────────────────────── */

/** 单个源失败只记 error，不炸整个命令 */
async function runSource(name, fn, errors, { allowEmpty = false } = {}) {
  const t0 = Date.now();
  try {
    const items = await fn();
    if (!items.length && !allowEmpty) throw new Error('解析出 0 条（源结构可能变了）');
    return { name, items, ms: Date.now() - t0, error: '' };
  } catch (e) {
    const msg = errMsg(e);
    errors.push(`${name}: ${msg}`);
    return { name, items: [], ms: Date.now() - t0, error: msg };
  }
}

/**
 * 把「平台 → 条目」分组排成最终的 schedule 数组。
 *
 * 顺序：**用户点名的平台**（CHANNEL_PRIORITY）→ 两个独立源（B站番剧 / 港剧）
 *      → 长尾平台（按条目数从多到少）→ 剩下的长尾合并进「其他平台」。
 * 组内按 (airdate, airstamp) 升序。
 */
export function groupSchedule(tvmazeItems, biliItems, hkItems) {
  const byChannel = new Map();
  const push = (ch, item) => {
    if (!ch) return;
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch).push(item);
  };

  for (const it of tvmazeItems || []) push(it.tag, it);
  for (const it of biliItems || []) push('B站番剧', it);
  for (const it of hkItems || []) push('港剧', it);

  const used = new Set();
  const ordered = [];

  for (const ch of CHANNEL_PRIORITY) {
    if (!byChannel.has(ch)) continue;
    used.add(ch);
    ordered.push(ch);
  }
  for (const ch of CHANNEL_SOURCES) {
    if (!byChannel.has(ch)) continue;
    used.add(ch);
    ordered.push(ch);
  }

  /* 「其他平台」这个桶有两种来源：排在长尾之外的平台，以及**压根没标频道的剧**
     （TVmaze 里 webChannel 和 network 都是空的）—— 两者都进同一个兜底组。 */
  const rest = [...byChannel.entries()]
    .filter(([k]) => !used.has(k) && k !== OTHER_CHANNEL)
    .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const top = rest.slice(0, LONGTAIL_CHANNELS);
  const tail = rest.slice(LONGTAIL_CHANNELS);
  for (const [k] of top) ordered.push(k);

  const out = [];
  for (const ch of ordered) {
    const items = byChannel.get(ch).sort(compareKeys);
    out.push(...items);
  }

  /* 剩下的长尾：每个平台最多留 6 条，总共最多 40 条，合成一个「其他平台」分组 */
  const merged = [];
  for (const [, items] of tail) {
    const sorted = [...items].sort(compareKeys);
    merged.push(...sorted.slice(0, OTHER_MAX_PER_CHANNEL));
    if (merged.length >= OTHER_MAX_TOTAL) break;
  }
  const noChannel = [...(byChannel.get(OTHER_CHANNEL) || [])].sort(compareKeys);
  merged.push(...noChannel.slice(0, OTHER_MAX_PER_CHANNEL));
  for (const it of merged.slice(0, OTHER_MAX_TOTAL)) out.push(retagChannel(it, OTHER_CHANNEL));
  return out;
}

/**
 * 抓 TVmaze /schedule/full 并解析成条目。
 * 每天单独做「结构自检」：返回了条目却一条都解析不出来 → 源结构变了 → 记错。
 */
async function collectTvmaze(dayList, { fetchImpl, errors }) {
  const byDay = await fetchTvmazeFull(dayList, { fetchImpl });
  const items = [];
  for (const day of dayList) {
    const entries = byDay.get(day) || [];
    const all = parseTvmazeFull(entries, day, { types: null });
    if (entries.length > 0 && !all.length) {
      errors.push(`${SCHEDULE_SOURCE}(${day}): 源结构可能变了（返回 ${entries.length} 条但解析出 0 条）`);
      continue;
    }
    items.push(...parseTvmazeFull(entries, day));
  }
  return items;
}

/**
 * 抓全部源，组装最终 payload。
 *
 * 失败隔离：单个城市失败不影响其它城市；单个源失败不影响其它源；
 * 全挂（schedule 和 events 都空）才算彻底失败。
 */
export async function fetchFollow({
  date = '',
  days = 3,
  cities = CITIES,
  dryRun = false,
  fetchImpl = null,
  fallbackConfig = undefined,
  root = SRC_LOCAL,
  coverDir = '',
  cityDelayMs = CITY_DELAY_MS,
  coverDelayMs = COVER_DELAY_MS,
  log = null,
} = {}) {
  const errors = [];
  const d = isDate(date) ? String(date).trim() : beijingToday();
  const doFetch = fetchImpl || globalThis.fetch;
  const cityList = Array.isArray(cities) && cities.length ? cities : CITIES;
  const nDays = Math.max(1, Number(days) || 3);
  const dayList = Array.from({ length: nDays }, (_, i) => addDays(d, i));
  const say = typeof log === 'function' ? log : () => {};

  /* 1) 频道更新 —— TVmaze /schedule/full（一次请求够 3 天，窗口自带） */
  const tvmaze = await runSource(
    SCHEDULE_SOURCE,
    () => collectTvmaze(dayList, { fetchImpl: doFetch, errors }),
    errors,
    { allowEmpty: true },
  );
  say(`  TVmaze /full：${tvmaze.items.length} 条`);

  /* 2) B站番剧 */
  const bili = await runSource(
    BILI_SOURCE,
    async () => {
      const j = await httpJson(`${BILI_BASE}/pgc/web/timeline?types=1&day=3`, {
        headers: { Referer: BILI_REFERER },
        fetchImpl: doFetch,
      });
      if (j && j.code !== undefined && j.code !== 0) {
        throw new Error(`接口返回 code=${j.code}${j.message ? `（${j.message}）` : ''}`);
      }
      const raw = Array.isArray(j && j.result) ? j.result : [];
      const items = parseBiliBangumi(j && j.result);
      if (raw.length > 0 && !items.length) {
        throw new Error(`源结构可能变了（返回 ${raw.length} 天但解析出 0 条）`);
      }
      return items;
    },
    errors,
    { allowEmpty: true },
  );
  say(`  B站番剧：${bili.items.length} 集`);

  /* 3) 豆瓣「港剧」标签（和别的平台混排，不单独成板块） */
  const hk = await runSource(
    HK_SOURCE,
    async () => {
      const j = await httpJson(
        `${DOUBAN_MOVIE_BASE_ENV}/j/search_subjects?type=tv&tag=${encodeURIComponent('港剧')}&page_limit=20&page_start=0`,
        { headers: { Referer: DOUBAN_MOVIE_BASE }, fetchImpl: doFetch },
      );
      const raw = Array.isArray(j && j.subjects) ? j.subjects : [];
      const items = parseDoubanHK(j && j.subjects);
      if (raw.length > 0 && !items.length) {
        throw new Error(`源结构可能变了（返回 ${raw.length} 条但解析出 0 条）`);
      }
      return items;
    },
    errors,
    { allowEmpty: true },
  );
  say(`  豆瓣港剧：${hk.items.length} 条`);

  const schedule = groupSchedule(tvmaze.items, bili.items, hk.items);

  /* 4) 本地演出：豆瓣同城，一个城市一个页面（某城失败只丢那一城） */
  const events = [];
  for (const city of cityList) {
    const slug = city.slug;
    const url = `${DOUBAN_BASE}/location/${slug}/events`;
    const r = await runSource(
      `${EVENTS_SOURCE}(${city.name})`,
      async () => {
        const html = await httpGet(url, { headers: { Referer: doubanReferer(slug) }, fetchImpl: doFetch });
        const meta = parseCityMeta(html);
        return parseDoubanEvents(html, city.name, { allowedTypes: meta.types });
      },
      errors,
    );
    events.push(...r.items);
    if (cityDelayMs > 0) await sleep(cityDelayMs);
  }
  events.sort(compareKeys);
  say(`  豆瓣同城：${events.length} 条`);

  /* 5) 豆瓣封面本地化（418 → 必须自己存） */
  const doubanItems = [...events, ...hk.items];
  const cov = await localizeCovers(doubanItems, {
    date: d,
    root,
    dir: coverDir,
    fetchImpl: doFetch,
    delayMs: coverDelayMs,
    dryRun,
  });
  say(`  豆瓣封面本地化：${cov.ok} 张就绪 · ${cov.fail} 张失败${cov.dryRun ? '（--dry-run 只落标记，不落盘）' : ''}`);

  /* 6) 兜底通道：只在主源对应板块失败时启用 */
  let cfg;
  if (typeof fallbackConfig === 'string') cfg = loadFallbackConfig(fallbackConfig);
  else if (fallbackConfig && typeof fallbackConfig === 'object') cfg = fallbackConfig;
  else cfg = loadFallbackConfig();
  if (cfg.reason && !cfg.missing) errors.push(`兜底通道: ${cfg.reason}`);

  if (cfg.enabled) {
    if (!schedule.length) {
      const fb = await collectFallback(cfg, {
        tag: FALLBACK_SOURCE,
        tags: [`@1:${L1_SCHEDULE}`, `@2:${FALLBACK_SOURCE}`],
        fetchImpl: doFetch,
        errors,
      });
      if (fb.length) schedule.push(...fb);
    }
    if (!events.length) {
      const fb = await collectFallback(cfg, {
        tag: FALLBACK_SOURCE,
        tags: [`@1:${L1_EVENTS}`, `@2:${FALLBACK_SOURCE}`],
        fetchImpl: doFetch,
        errors,
      });
      if (fb.length) events.push(...fb);
    }
  }

  const payload = buildFollowPayload({
    date: d,
    schedule,
    events,
    cities: cityList.map((c) => (typeof c === 'string' ? c : c.name)),
    errors,
  });

  const allFailed = !payload.schedule.length && !payload.events.length;
  let written = null;
  if (!allFailed) written = writeFollowFile(payload, d, { root, dryRun });

  return payload;
}

/** 把兜底源抓一遍，解析成条目 */
async function collectFallback(cfg, { tag, tags, fetchImpl, errors }) {
  const items = [];
  for (const fb of cfg.fallbacks || []) {
    try {
      const txt = await httpGet(fb.url, { fetchImpl });
      const parsed = parseFallbackMeta(txt, { name: fb.name, tag, tags });
      items.push(...parsed);
    } catch (e) {
      errors.push(`兜底(${fb.name}): ${errMsg(e)}`);
    }
  }
  return items;
}

/* ───────────────────────────── CLI ───────────────────────────── */

function parseArgs(argv) {
  const out = { date: '', dryRun: false, help: false, days: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = String(argv[++i] || '').trim();
    else if (a.startsWith('--date=')) out.date = a.slice('--date='.length).trim();
    else if (a === '--dry-run' || a === '--dry') out.dryRun = true;
    else if (a === '--days') out.days = Number(argv[++i] || 2) || 2;
    else if (a.startsWith('--days=')) out.days = Number(a.slice('--days='.length)) || 2;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  return [
    '用法：',
    '  node tools/fetch-follow.mjs --date 2026-11-16              抓取并写文件',
    '  node tools/fetch-follow.mjs --date 2026-11-16 --dry-run    只抓取并打印统计',
    '  node tools/fetch-follow.mjs --help                         打印本用法',
    '',
    '  --date <YYYY-MM-DD>   期号（缺省 = 北京今天）',
    '  --dry-run             不写文件',
    '  --days <N>            抓几天（默认 3 = 今天 + 明天 + 后天；一次请求就够，窗口自带）',
    '',
    '  退出码：0 正常 · 1 两块都空 · 2 日期格式非法',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const date = args.date || beijingToday();
  if (!isDate(date)) {
    console.error(`日期格式不对：${date}（要 YYYY-MM-DD）`);
    console.error(usage());
    return 2;
  }

  console.log(`\n追更抓取  ${date}\n`);
  const t0 = Date.now();
  const payload = await fetchFollow({
    date,
    days: args.days,
    dryRun: args.dryRun,
    log: (s) => console.log(s),
  });

  console.log(
    `  频道更新 ${payload.schedule.length} 条 / 本地演出 ${payload.events.length} 条 / 耗时 ${Date.now() - t0}ms`,
  );
  console.log(`  平台 ${payload.channels.length} 个：${payload.channels.join('、')}`);
  console.log(`  语言 ${payload.languages.length} 种：${payload.languages.join('、')}`);
  const cities = new Set(payload.events.map((e) => e.tag));
  console.log(`  城市 ${cities.size} 个：${[...cities].join('、')}`);
  if (payload.errors.length) {
    console.log('\n失败摘要：');
    for (const e of payload.errors) console.log(`  - ${e}`);
  }

  if (args.dryRun) {
    console.log('\n--dry-run：不写文件。');
  } else if (!payload.schedule.length && !payload.events.length) {
    console.error('\n两个板块都挂了 —— 没有内容可写。');
    return 1;
  } else {
    console.log(`\n写入  ${followFilePath(date)}`);
  }

  if (!payload.schedule.length && !payload.events.length) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error('追更抓取失败：', err && err.message ? err.message : err);
      process.exit(1);
    });
}
