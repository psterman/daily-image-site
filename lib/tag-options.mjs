/**
 * 目录 + 标签选项（浏览器 / Node 共用）。
 * 与 tools/tag-options.json 对齐；改选项先改这里，再同步 JSON（test-tag-options 会锁）。
 *
 * sources[]：精选手写；sourcesForTag() 会再合并 source-catalog-data（完整 RSS 池）。
 */
import { sourcesForPackFromCatalog } from './source-catalog-data.mjs';
import { mergeSources } from './source-catalog.mjs';


export const DIRECTORIES = Object.freeze([
  { key: '资讯', label: '资讯', order: 1, desc: '综合新闻与时政媒体' },
  { key: '社区', label: '社区', order: 2, desc: '社交热榜与开发者社区' },
  { key: '科技', label: '科技', order: 3, desc: 'AI、数码、开发者热帖' },
  { key: '娱乐', label: '娱乐', order: 4, desc: '轻松一刻配图' },
  { key: '财经', label: '财经', order: 5, desc: '商业财经速览' },
  { key: '视觉', label: '视觉', order: 6, desc: '人像与设计灵感' },
  { key: '文化', label: '文化', order: 7, desc: '电影音乐' },
]);

/** @type {ReadonlyArray<{name:string, domain:string}>} */
function src(name, domain) {
  return { name, domain };
}

/** 用户可选内容包（选内容包 / 栏目）—— sources 优先对齐共享池已灌域名/publisher */
export const TAG_OPTIONS = Object.freeze([
  {
    key: 'news',
    label: '新闻速览',
    directory: '资讯',
    risk: 'low',
    desc: '综合新闻与时政媒体：通讯社、党报、国际中文与思想评论',
    channels: ['新闻'],
    sources: [
      src('澎湃新闻', 'thepaper.cn'),
      src('新华网·新华社新闻', 'xinhuanet.com'),
      src('央视新闻', 'cctv.com'),
      src('人民日报', 'people.com.cn'),
      src('参考消息', 'cankaoxiaoxi.com'),
      src('联合早报', 'zaobao.com'),
      src('路透中文', 'reuters.com'),
      src('纽约时报中文', 'nytimes.com'),
      src('凤凰网', 'ifeng.com'),
      src('南方周末', 'infzm.com'),
      src('中国新闻周刊', 'inewsweek.cn'),
      src('侠客岛', 'people.com.cn'),
      src('环球时报', 'huanqiu.com'),
      src('德国之声中文', 'dw.com'),
      src('法广中文', 'rfi.fr'),
    ],
  },
  {
    key: 'hot',
    label: '热议',
    directory: '社区',
    risk: 'medium',
    desc: '微博 / 抖音 / 小红书 / 知乎等社交与社区热榜合集',
    channels: ['社区'],
    sources: [
      src('微博热搜', 'weibo.com'),
      src('抖音热榜', 'douyin.com'),
      src('小红书热榜', 'xiaohongshu.com'),
      src('知乎热榜', 'zhihu.com'),
      src('百度热搜', 'baidu.com'),
      src('今日头条热榜', 'toutiao.com'),
      src('B站热搜', 'bilibili.com'),
      src('虎扑步行街', 'hupu.com'),
      src('百度贴吧热议', 'tieba.baidu.com'),
      src('快手热榜', 'kuaishou.com'),
      src('抽屉热榜', 'dig.ichouti.cn'),
      src('NGA网事杂谈', 'nga.cn'),
    ],
  },
  {
    key: 'ai',
    label: 'AI 资讯',
    directory: '科技',
    risk: 'low',
    desc: '大模型、Agent 与行业动态',
    channels: ['科技'],
    sources: [
      src('AIHOT精选', 'aihot.news'),
      src('AI前线', 'infoq.cn'),
      src('机器之心', 'jiqizhixin.com'),
      src('量子位', 'qbitai.com'),
      src('新智元', 'aiera.cn'),
      src('晚点LatePost', 'latepost.com'),
      src('APPSO', 'appso.com'),
      src('Twitter·宝玉', 'xgo.ing'),
      src('Twitter·小互', 'xgo.ing'),
      src('Twitter·向阳乔木', 'xgo.ing'),
      src('Twitter·orange.ai', 'xgo.ing'),
      src('Twitter·OpenAI', 'xgo.ing'),
      src('Twitter·Anthropic', 'xgo.ing'),
      src('Twitter·DeepSeek', 'xgo.ing'),
      src('Twitter·Cursor', 'xgo.ing'),
      src('Twitter·Karpathy', 'xgo.ing'),
      src('Twitter·Dify', 'xgo.ing'),
      src('听说了吗', 'anymesgs.com'),
    ],
  },
  {
    key: 'tech',
    label: '科技新品',
    directory: '科技',
    risk: 'low',
    desc: '数码新品、效率工具与开发者热帖',
    channels: ['科技'],
    sources: [
      src('GitHub趋势', 'github.com'),
      src('V2EX', 'v2ex.com'),
      src('Readhub早报', 'readhub.cn'),
      src('蓝点网', 'landian.news'),
      src('cnBeta', 'cnbeta.com'),
      src('小众软件', 'appinn.com'),
      src('爱范儿', 'ifanr.com'),
      src('36氪', '36kr.com'),
      src('少数派', 'sspai.com'),
      src('数字尾巴', 'dgtle.com'),
      src('远景论坛', 'pcbeta.com'),
      src('酷安热榜', 'coolapk.com'),
      src('半导体行业观察', 'weixin.qq.com'),
      src('科技美学', 'weixin.qq.com'),
      src('津津乐道', 'daopub.com'),
      src('牛油果烤面包', 'typlog.io'),
    ],
  },
  {
    key: 'funny',
    label: '轻松一刻',
    directory: '娱乐',
    risk: 'low',
    desc: '轻松一刻：站内见笑精选图（大佬请批阅已过滤），不含社交热榜或生活文化稿',
    channels: ['娱乐', '游戏', '其他'],
    sources: [
      src('见笑', 'daily.onetone.app'),
      src('大佬请批阅', 'daily.onetone.app'),
    ],
  },
  {
    key: 'opensource',
    label: '开源推荐',
    directory: '社区',
    risk: 'low',
    desc: '开源项目与独立开发社区',
    channels: ['开发'],
    sources: [
      src('NodeSeek', 'nodeseek.com'),
      src('掘金', 'juejin.cn'),
      src('吾爱破解', '52pojie.cn'),
      src('CSDN', 'csdn.net'),
      src('LINUX DO', 'linux.do'),
      src('小众软件', 'appinn.com'),
      src('w2solo独立开发', 'w2solo.com'),
    ],
  },
  {
    key: 'finance',
    label: '财经早报',
    directory: '财经',
    risk: 'medium',
    desc: '商业与财经速览',
    channels: ['财经'],
    sources: [
      src('虎嗅', 'huxiu.com'),
      src('财联社', 'cls.cn'),
      src('钛媒体', 'tmtpost.com'),
      src('FT中文网', 'ftchinese.com'),
      src('参考消息', 'weixin.sogou.com'),
      src('华尔街见闻', 'wallstreetcn.com'),
      src('雪球', 'xueqiu.com'),
      src('财富中文网', 'fortunechina.com'),
      src('经济观察报', 'weixin.qq.com'),
    ],
  },
  {
    key: 'portrait',
    label: '人像美学',
    directory: '视觉',
    risk: 'medium',
    desc: '人像与摄影配图（站内见她精选），只索引站内图址',
    channels: [],
    sources: [
      src('见她', 'daily.onetone.app'),
      src('大佬请批阅', 'daily.onetone.app'),
    ],
  },
  {
    key: 'sight',
    label: '见闻',
    directory: '视觉',
    risk: 'low',
    desc: '站内见闻精选图（大佬请批阅已过滤）：街拍、旅行与日常视觉',
    channels: [],
    sources: [
      src('见闻', 'daily.onetone.app'),
      src('大佬请批阅', 'daily.onetone.app'),
    ],
  },
  {
    key: 'design',
    label: '设计灵感',
    directory: '视觉',
    risk: 'low',
    desc: '产品设计与独立开发精选（池内实源）',
    channels: ['阅读', '开发'],
    sources: [
      src('掘金', 'juejin.cn'),
      src('人人都是产品经理', 'woshipm.com'),
      src('博海拾贝', 'bohaishibei.com'),
      src('w2solo独立开发', 'w2solo.com'),
      src('小众软件', 'appinn.com'),
      src('V2EX', 'v2ex.com'),
      src('随机波动', 'fireside.fm'),
      src('Steve说', 'steveshuo.com'),
      src('Full of Mind', 'fom.fm'),
      src('UX Coffee 设计咖', 'uxcoffee.com'),
      src('但为君故', 'dreams.plus'),
      src('GeekPlux', 'geekplux.com'),
      src('Reorx', 'reorx.com'),
      src('不吐不快', 'mianao.info'),
      src('水八口', 'shuiba.co'),
      src('洞见', 'weixin.qq.com'),
    ],
  },
  {
    key: 'movie',
    label: '电影音乐',
    directory: '文化',
    risk: 'low',
    desc: '院线/乐榜封面与简介（听乐+看片）',
    channels: ['视频', '音乐', '娱乐'],
    sources: [
      src('网易云音乐', 'music.163.com'),
      src('猫眼', 'maoyan.com'),
      src('豆瓣', 'douban.com'),
      src('爱奇艺', 'iqiyi.com'),
      src('腾讯视频', 'v.qq.com'),
      src('QQ音乐', 'y.qq.com'),
      src('B站', 'bilibili.com'),
      src('B站每周必看', 'bilibili.com'),
    ],
  },
]);

/** 见报阅读 chip（与 news-taxonomy categories 对齐，只读展示；两字词组） */
export const NEWS_CHIPS = Object.freeze([
  { key: 'hot', label: '热议' },
  { key: 'current', label: '新闻' },
  { key: 'biz', label: '财经' },
  { key: 'tech', label: '科技' },
  { key: 'ai', label: '智能' },
  { key: 'tools', label: '工具' },
  { key: 'dev', label: '开发' },
  { key: 'deep', label: '深度' },
  { key: 'ent', label: '文娱' },
  // fun ≠ 内容包「轻松一刻」（梗图）；见报侧是生活
  { key: 'fun', label: '生活' },
]);

export function tagsInDirectory(dirKey) {
  if (!dirKey || dirKey === '全部') return [...TAG_OPTIONS];
  return TAG_OPTIONS.filter((t) => t.directory === dirKey);
}

export function sourcesForTag(tagKey) {
  const t = TAG_OPTIONS.find((x) => x.key === tagKey);
  const curated = t && Array.isArray(t.sources) ? t.sources : [];
  // 视觉图包仍以站内精选为准；其余包合并完整 RSS 目录
  if (tagKey === 'funny' || tagKey === 'portrait' || tagKey === 'sight') return curated.slice();
  return mergeSources(curated, sourcesForPackFromCatalog(tagKey));
}

/** 仅精选（手风琴默认先露这些；完整列表见「全部源」） */
export function curatedSourcesForTag(tagKey) {
  const t = TAG_OPTIONS.find((x) => x.key === tagKey);
  return t && Array.isArray(t.sources) ? t.sources.slice() : [];
}

/** 某包下全部来源显示名（默认全选） */
export function defaultSourceNames(tagKey) {
  return sourcesForTag(tagKey).map((s) => s.name);
}

/**
 * 规范化用户勾选的子来源。
 * - 空/非法 → 回落为该包全部来源（rebang 式：进了分类默认全节点，可再减）
 * - 只保留仍在目录里的名字（以后目录扩源时旧选项自动剔除）
 */
export function normalizeSourceSelection(tagKey, selected) {
  const allowed = defaultSourceNames(tagKey);
  if (!allowed.length) return [];
  if (!Array.isArray(selected) || !selected.length) return allowed.slice();
  const picked = [...new Set(selected.map((x) => String(x || '').trim()).filter((n) => allowed.includes(n)))];
  return picked.length ? picked : allowed.slice();
}

/**
 * 目录扩源后回填：旧「全选」自动吃进新源；用户缩减过的保持原样。
 * - 有 sources_catalog_n：勾选数 ≥ 旧目录数 → 升为新全选
 * - 无该字段的老数据：仅当存档只缺 1 个新源时升级（避免把「只勾了 2 个」抬成全选）
 */
export function hydrateSourceSelection(tagKey, selected, catalogN) {
  const allowed = defaultSourceNames(tagKey);
  if (!allowed.length) return [];
  const picked = normalizeSourceSelection(tagKey, selected);
  const n = Number(catalogN);
  if (Number.isFinite(n) && n > 0 && n < allowed.length && picked.length >= n) {
    return allowed.slice();
  }
  if (!(Number.isFinite(n) && n > 0)
      && picked.length === allowed.length - 1
      && picked.length > 0) {
    return allowed.slice();
  }
  return picked;
}

function hostOf(url) {
  try { return new URL(String(url || '')).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return ''; }
}

/** 解析目录 domain：可带 path（t.me/woshadiao） */
function splitDomainSpec(domain) {
  const raw = String(domain || '').toLowerCase().replace(/^www\./, '').replace(/^https?:\/\//, '');
  const i = raw.indexOf('/');
  if (i < 0) return { host: raw, path: '' };
  return { host: raw.slice(0, i), path: raw.slice(i) };
}

/** host 命中 domain：相等、子域、核心标签；带 path 时还要 URL 含该 path */
export function domainMatches(url, domain) {
  const host = hostOf(url);
  const { host: d, path } = splitDomainSpec(domain);
  if (!host || !d) return false;
  const hostOk = host === d || host.endsWith('.' + d)
    || (() => {
      const core = d.split('.')[0];
      return core.length >= 4 && host.split('.').includes(core);
    })();
  if (!hostOk) return false;
  if (!path) return true;
  const u = String(url || '').toLowerCase();
  return u.includes(d + path) || u.includes('telegram.me' + path);
}

function sameDomain(a, b) {
  const x = splitDomainSpec(a).host;
  const y = splitDomainSpec(b).host;
  // 带 path 的源彼此不算「同域共用」（否则 TG 三频道会串台）
  const ap = splitDomainSpec(a).path;
  const bp = splitDomainSpec(b).path;
  if (ap || bp) return ap && bp ? ap === bp && x === y : false;
  return !!x && x === y;
}

/** 条目是否命中用户勾选的来源（publisher / URL domain / 简称） */
export function itemMatchesSources(item, sourceNames, tagKey) {
  if (!Array.isArray(sourceNames) || !sourceNames.length) return true;
  const catalog = sourcesForTag(tagKey);
  const picked = catalog.filter((s) => sourceNames.includes(s.name));
  if (!picked.length) return true;
  const pub = String((item && item.metadata && item.metadata.publisher) || item && item.source || '').trim();
  const url = String((item && (item.canonical_url || item.link || item.url)) || '');
  const genericPub = !pub || pub === 'main-source' || pub === 'visual-packs' || pub === 'RSS';

  return picked.some((s) => {
    if (pub && (pub === s.name || pub.includes(s.name) || s.name.includes(pub))) return true;
    // AIHOT精选 ↔ AIHOT
    if (pub && s.name.replace(/精选$/g, '') === pub.replace(/精选$/g, '') && pub.length >= 2) return true;
    const short = s.name.replace(/热搜|热榜|热议|趋势|日报|早报|精选/g, '');
    if (short && pub && pub.includes(short)) return true;

    const dom = String(s.domain || '').toLowerCase().replace(/^www\./, '');
    if (!dom || !domainMatches(url, dom)) return false;
    // 同包多个源共用域名（如 t.me）时：非通配 publisher 必须对上名字，避免串台
    const siblings = catalog.filter((x) => sameDomain(x.domain, dom));
    if (siblings.length > 1 && !genericPub) {
      return pub === s.name || pub.includes(s.name) || s.name.includes(pub);
    }
    return true;
  });
}

/** favicon 热链（不转存）；domain 可带 path，只取 host */
export function sourceIconUrl(domain) {
  const d = splitDomainSpec(domain).host;
  if (!d) return '';
  return 'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(d);
}

/** 给 platform-model / seed 用的包形状 */
export function toCoreTagPacks() {
  return TAG_OPTIONS.map((t) => ({
    key: t.key,
    name: t.label,
    group_name: t.directory,
    risk_level: t.risk,
    description: t.desc,
  }));
}
