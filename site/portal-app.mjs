/**
 * portal-app.mjs —— 自建平台工作台（浏览器 ES 模块，零框架）
 *
 * 架构纪律参考 psterman/daily-image-site 线上原版：
 *   - 单一真源：所有视图只读一个 state（db / platform / digest / selectedKeys）
 *   - 一个 refresh() 按真源重绘全部视图，不在 UI 里伪造数据
 *   - hash 路由交给 portal-render.mjs 的 bindHashRouting 统一处理
 *   - 每一步都调 lib/platform-flow.mjs 的真函数
 *
 * 双数据模式：
 *   - demo：内存 db + DEMO_ITEMS，零后端，离线可跑完整条闭环
 *   - cloud：Supabase publishable key + 登录 token，loadDb/saveDb 读写 platform schema
 *     共享池（tag_packs / sources / content_items）只读；私有表按 auth.uid() RLS 隔离
 *
 * 安全边界：本文件只接触 publishable key；secret / PAT 绝不进前端。
 */
import {
  emptyDb,
  seedTagPacks,
  ensureMainSource,
  CORE_TAG_PACKS,
  DIRECTORIES,
} from '../lib/platform-model.mjs';
import {
  sourcesForTag,
  curatedSourcesForTag,
  sourceIconUrl,
  defaultSourceNames,
  normalizeSourceSelection,
  hydrateSourceSelection,
  itemMatchesSources,
  NEWS_CHIPS,
  TAG_OPTIONS,
} from '../lib/tag-options.mjs';
import {
  FORMAT_OPTIONS,
  itemMatchesFormats,
} from '../lib/format-catalog.mjs';
import { SOURCE_CATALOG } from '../lib/source-catalog-data.mjs';
import { groupEntriesByTaxonomy, TAX_BLURB } from '../lib/source-catalog.mjs';
import { isGarbledText } from '../lib/ingest-map.mjs';
import {
  SRC_MEDIA_CHIPS,
  SRC_PLATFORM_CHIPS,
  PLATFORM_MARK,
  TOPIC_CHIP_ICON,
  VISUAL_SOURCE_EXTRAS,
  sourceMediaKey,
  sourcePlatformKey,
  sourceTopicKey,
  sourceDimLabels,
  displaySourceName,
  isWeixinSource,
  isWeiboSource,
  isTwitterSource,
  dimHost as sourceHost,
} from '../lib/source-dims.mjs';
import {
  registerUser,
  createPlatform,
  setPlatformTagPacks,
  reorderColumns,
  ingestContent,
  buildCandidates,
  reviewCandidates,
  fillEmptyColumnApprovals,
  buildPlatformDigest,
  buildReadingDigest,
  publishIssue,
  CANDIDATE_STATUS,
} from '../lib/platform-flow.mjs';
import {
  renderInoReader,
  bindHashRouting,
  safeHref,
} from './portal-render.mjs';
import { createClient } from '../lib/sb-client.mjs';
import { loadDb, saveDb, loadSharedPool, mergeSharedPool } from '../lib/sb-repo.mjs';
import { SB_CONFIG, FULLTEXT_ENDPOINT } from './config.js';
import {
  loadSession,
  saveSession,
  clearSession,
  renderAuth,
  authError,
  normalizeSession,
  sessionNeedsRefresh,
  parseAuthHash,
} from './auth-ui.mjs';

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
const DATE = todayStr();
const SITE = SB_CONFIG.siteUrl;

/* 离线兜底：后端不可达时才灌入。有共享池时一律用真实目录与内容。 */
const DEMO_ITEMS = [
  { title: '零依赖静态站生成器发布 2.0', url: 'https://github.com/demo/staticgen', summary: '配置驱动的静态站工具：写好配置即可生成页面，适合个人日报与作品集。不绑定特定框架。', tagKeys: ['opensource'] },
  { title: '一个把 RSS 变成每日简报的 Agent', url: 'https://github.com/demo/rss-agent', summary: '从订阅源聚合条目，支持邮件与 Telegram 分发；可接人工审稿后再发。', tagKeys: ['opensource', 'ai'] },
  { title: '开源多用户聚合平台参考架构', url: 'https://github.com/demo/aggregate', summary: 'Supabase 控制面 + 静态站发布面的双模式示意，适合「用户自建栏目」类产品。', tagKeys: ['opensource'] },
  { title: '新模型发布：推理成本砍半', url: 'https://news.example.com/model', summary: '厂商公布新一代推理模型，标称同等质量下成本约降一半，并开放有限评测名额。', tagKeys: ['ai'] },
  { title: 'Agent 实践：审稿台的人机协作', url: 'https://news.example.com/agent', summary: '用 Agent 做抓取与打分，最终放行仍由人确认；审计日志可回放每一次决策。', tagKeys: ['ai'] },
  { title: '本周片单：五部值得重看的电影', url: 'https://movie.example.com/week', summary: '五部风格不同的片单速览：从古典叙事到当代影像，附一句话推荐理由。', tagKeys: ['movie'] },
  { title: '独立音乐人新专辑速递', url: 'https://music.example.com/album', summary: '本周值得一听的独立发行：偏民谣与电子，附试听入口（外链）。', tagKeys: ['movie'] },
  { title: '街头光影：城市人像合集', url: 'https://photo.example.com/street', summary: '城市人像作品索引：只给标题与出处链接，不转存图片。', tagKeys: ['portrait'] },
  { title: '极简配色方案十二例', url: 'https://design.example.com/palette', summary: '十二组可直接套用的界面配色，含主色、中性色与强调色建议。', tagKeys: ['design'] },
  { title: '早报：市场在交易什么预期', url: 'https://finance.example.com/am', summary: '用三条线索概括当日市场关注点：利率、财报季与风险偏好。', tagKeys: ['finance'] },
  { title: '一款真正省时间的效率工具', url: 'https://tech.example.com/tool', summary: '把重复操作收成一键流程；适合编辑与运营日常。', tagKeys: ['tech'] },
  { title: '办公室冷知识三则', url: 'https://funny.example.com/office', summary: '三则短讯：工位、会议与摸鱼的轻量段子，适合栏目开头。', tagKeys: ['funny'] },
];

/** 启动时预取的共享池缓存（匿名可读） */
let sharedPoolCache = null;
/** boot 后台预热；进演示前可 await，避免抢跑成离线 DEMO → 小红书等假「未入库」 */
let sharedPoolWarm = null;

/* ── 单一真源 ── */
let mode = 'demo';          // 'demo' | 'cloud'
let client = null;          // 复用同一个 client，靠 currentToken 切换身份
let currentToken = null;
let db = null;
let platform = null;
let user = null;
let digest = null;
let selectedKeys = [];
let draftKeys = [];          // 搭站向导里的临时多选（尚未 createPlatform）
/** 每个内容包勾选的子来源名 { [tagKey]: string[] }，对齐 rebang 节点订阅 */
let draftSources = {};
/** 格式第二轴多选（空=不限）；localStorage 持久化 */
let selectedFormats = [];
try {
  selectedFormats = JSON.parse(localStorage.getItem('portal.formats') || '[]');
  if (!Array.isArray(selectedFormats)) selectedFormats = [];
} catch {
  selectedFormats = [];
}
/** 内容包内展开的来源手风琴 { [tagKey]: Set<sourceName> } */
const srcAccordionOpen = new Map();
/** 包内源搜索 / 是否展开完整目录 */
const packSrcQuery = new Map();
const packSrcShowAll = new Set();
/** B 布局：当前展开的内容包 key */
let openPackKey = null;
/** 方案选用：single=只留一个包 · multi=可同时入库多个 */
let packSelectMode = 'multi';
/**
 * 全部源三维度（同时生效、互相独立）：
 *   分类 = 媒体形式 · 平台 = 载体 · 来源 = 题材（逻辑见 lib/source-dims.mjs）
 */
let srcCatMedia = '';
let srcCatPlatform = '';
let srcCatTopic = ''; // taxonomy key
let srcCatTab = 'media'; // media | platform | topic — subtab 并列切换
let srcCatQ = '';
let srcCatSelected = '';

/** 共享池 metadata.publisher_avatar → 源名 */
function indexPublisherAvatars(byPub) {
  const map = new Map();
  if (!byPub) return map;
  for (const [pub, items] of byPub) {
    for (const it of items || []) {
      const av = String((it.metadata && it.metadata.publisher_avatar) || '').trim();
      if (/^https?:\/\//i.test(av)) {
        map.set(pub, av);
        break;
      }
    }
  }
  return map;
}

function letterAvatar(ch, bg, fg) {
  return '<span class="chip-av" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;font-size:10px;font-weight:600;background:'
    + bg + ';color:' + fg + '">' + ch + '</span>';
}

function platformMarkHtml(key) {
  const m = PLATFORM_MARK[key];
  if (!m) return '';
  return letterAvatar(m.ch, m.bg, m.fg);
}

/** 头像失败时亮出色块；勿把带引号的 HTML 塞进 onerror（会炸出 X'">） */
function imgAvWithFallback(src, fallbackHtml) {
  return '<span class="av-wrap">'
    + '<img class="chip-av" src="' + esc(src) + '" alt="" loading="lazy" referrerpolicy="no-referrer"'
    + ' onerror="this.style.display=\'none\';var n=this.nextElementSibling;if(n)n.hidden=false">'
    + '<span class="av-fb" hidden>' + fallbackHtml + '</span>'
    + '</span>';
}

/** 微信/微博用品牌色块；推特优先池内头像，否则 𝕏（不用展示名猜 handle） */
function platformAvatarHtml(r, avatarByPub) {
  const name = String((r && r.name) || '?');
  const pooled = avatarByPub && (avatarByPub.get(name) || '');

  if (isWeixinSource(r)) {
    const fb = platformMarkHtml('weixin');
    return pooled ? imgAvWithFallback(pooled, fb) : fb;
  }
  if (isWeiboSource(r)) {
    const fb = platformMarkHtml('weibo');
    return pooled ? imgAvWithFallback(pooled, fb) : fb;
  }
  if (isTwitterSource(r)) {
    const fb = platformMarkHtml('twitter');
    return pooled ? imgAvWithFallback(pooled, fb) : fb;
  }
  return '';
}
let onboarding = false;      // 新用户：先预览/选包，再一键建平台
let contentSource = 'demo';    // 'real' | 'empty'（云端池空） | 'demo'（离线 initDemo）
/** 共享池空或缺标签时的样例文案（只作预览，不入库） */
const FALLBACK_SAMPLES = {
  news: ['早报：三则值得跟进的要闻', '国际简讯合集', '地方与政策动态速览'],
  funny: ['办公室冷知识三则', '今日沙雕新闻速览', '一个让人会心一笑的小实验'],
  portrait: ['街头光影：城市人像合集', '自然光人像构图五式', '黑白肖像里的情绪'],
  sight: ['见闻精选：街头与旅途一瞥', '城市角落里的日常视觉', '旅行见闻图墙'],
  opensource: ['零依赖静态站生成器发布 2.0', '把 RSS 变成每日简报的 Agent', '开源多用户聚合平台参考架构'],
  ai: ['新模型发布：推理成本砍半', 'Agent 实践：审稿台的人机协作', '多模态评测周报'],
  design: ['极简配色方案十二例', '字体配对不会翻车的方法', '作品集首页怎么排'],
  finance: ['早报：市场在交易什么预期', '一家公司的定价实验', '财报季阅读清单'],
  tech: ['一款真正省时间的效率工具', '折叠屏交互观察', '硬件开箱不必看完的三点'],
  movie: ['本周片单：五部值得重看的电影', '独立音乐人新专辑速递', '纪录片推荐：幕后制作'],
};
let authState = {
  status: 'checking',       // checking | signedOut | signedIn
  mode: 'login',            // login | signup | recover | reset
  busy: false,
  error: '',
  notice: '',
  pendingEmail: '',         // 待确认邮箱（可重发）
  user: null,
  backendOk: null,          // null=检查中 true=可达 false=不可达
};

/* ── DOM 工具 ── */
function $(sel) { return document.querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function urlHost(u) {
  const m = /^https?:\/\/([^\/]+)/i.exec(String(u || ''));
  return m ? m[1] : String(u || '');
}
function statusCn(s) {
  return { pending: '待选', approved: '已选用', rejected: '已跳过', pinned: '已置顶' }[s] || s;
}
function hostOf(url) {
  const href = safeHref(url);
  const m = href && /^https?:\/\/([^\/]+)/i.exec(href);
  return m ? m[1].replace(/^www\./, '') : '';
}
function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 1900);
}

/* ── client 工厂：token 存在模块级，getToken 闭包实时读取 ── */
function ensureClient(token) {
  if (token) currentToken = token;
  if (!client) {
    client = createClient({
      url: SB_CONFIG.url,
      key: SB_CONFIG.key,
      schema: SB_CONFIG.schema,
      getToken: () => currentToken,
    });
  }
  // 关键：sb-client 的 auth.user() / auth.signOut() 读的是内部 sessionToken，
  // getToken 只用于数据请求的 Bearer。恢复会话必须同时 setToken，
  // 否则刷新后 auth.user() 直接返回 null，会话被误判为失效。
  if (token) client.auth.setToken(token);
  return client;
}

function syncSelectedKeys() {
  selectedKeys = CORE_TAG_PACKS.filter((p) =>
    Object.values(db.platform_columns).some(
      (c) => c.platform_id === platform.id && c.key === p.key
    )
  ).map((p) => p.key);
}

/** 从已建栏目 settings.sources 回填勾选（缺省=该包全源；目录扩源时旧全选自动并入新源） */
function hydrateDraftSourcesFromColumns() {
  draftSources = {};
  if (!db || !platform) return;
  for (const col of Object.values(db.platform_columns)) {
    if (col.platform_id !== platform.id) continue;
    const settings = col.settings || {};
    draftSources[col.key] = hydrateSourceSelection(
      col.key,
      settings.sources,
      settings.sources_catalog_n,
    );
  }
}

function selectedSourcesFor(key) {
  if (draftSources[key]) return draftSources[key];
  return defaultSourceNames(key);
}

function togglePackKey(keys, key, on) {
  return on ? keys.filter((k) => k !== key) : keys.concat([key]);
}

function toggleSourceName(tagKey, sourceName) {
  const all = defaultSourceNames(tagKey);
  if (!all.includes(sourceName)) return;
  let cur = selectedSourcesFor(tagKey).slice();
  const i = cur.indexOf(sourceName);
  if (i >= 0) {
    cur.splice(i, 1);
    // 子源全灭 → 取消该内容包
    if (!cur.length) {
      delete draftSources[tagKey];
      return { dropPack: true };
    }
  } else {
    cur.push(sourceName);
  }
  draftSources[tagKey] = normalizeSourceSelection(tagKey, cur);
  return { dropPack: false };
}

/** 优先用预取的共享池；失败才灌离线 DEMO_ITEMS。 */
function fillContentPool(targetDb) {
  const pool = sharedPoolCache;
  if (pool && pool.items && pool.items.length) {
    mergeSharedPool(targetDb, pool);
    seedTagPacks(targetDb);
    ensureMainSource(targetDb);
    normalizePackNames(targetDb);
    contentSource = 'real';
    return 'real';
  }
  seedTagPacks(targetDb);
  ensureMainSource(targetDb);
  ingestContent(targetDb, DEMO_ITEMS);
  contentSource = 'demo';
  return 'demo';
}

/* ── 演示模式：有后台则用真实目录，否则离线 DEMO；再进搭站向导 ── */
function initDemo() {
  mode = 'demo';
  db = emptyDb();
  fillContentPool(db);
  user = registerUser(db, { email: 'demo@example.com', displayName: '演示用户' });
  platform = null;
  digest = null;
  selectedKeys = [];
  draftKeys = ['opensource', 'ai', 'movie']; // 预勾推荐，仍可改
  draftSources = Object.fromEntries(draftKeys.map((k) => [k, defaultSourceNames(k)]));
  onboarding = true;
  selectedCandId = null;
  candColumn = 'all';
  candFilter = 'all';
}

/* ── 云模式初始化：loadDb → 找/建用户与平台 → 跑业务函数 → saveDb ── */
async function initCloud(authResp) {
  mode = 'cloud';
  const c = ensureClient(authResp.access_token);
  db = await loadDb(c);
  db.schema = 2;
  // 只规范云端已有包的中文名/目录；缺包（如 hot）不能前端假插 uuid——
  // 否则建栏目会 FK 失败，目录看起来有、源池却对不上。缺包靠管理端 repair-shared-pool。
  const cloudKeys = new Set(Object.keys(db.tag_packs || {}));
  const missingPacks = CORE_TAG_PACKS.filter((p) => !cloudKeys.has(p.key)).map((p) => p.key);
  normalizePackNames(db);
  ensureMainSource(db);

  // 云端只读共享池；池空也不假灌（前端写不进 content_items，假候选会 FK 炸）。
  contentSource = Object.keys(db.content_items).length ? 'real' : 'empty';
  if (missingPacks.length) {
    console.warn('[portal] 云端缺标签包，需跑 node tools/repair-shared-pool.mjs:', missingPacks.join(','));
    setTimeout(() => {
      toast('内容目录未同步到云端（缺 ' + missingPacks.join('、') + '）。请管理员跑 repair-shared-pool 后重新登录。');
    }, 400);
  }

  const authUid = authResp.user && authResp.user.id;
  const email = String((authResp.user && authResp.user.email) || '').toLowerCase();
  user = Object.values(db.users).find(
    (u) => u.id === authUid || (email && u.email === email)
  );
  if (!user) {
    user = registerUser(db, {
      id: authUid,
      email,
      displayName: email.split('@')[0] || '用户',
    });
    await saveDb(c, db);
  }

  platform = Object.values(db.platforms).find((p) => p.owner_user_id === user.id);
  if (!platform) {
    // 新用户：不代建平台，进向导自己预览/多选/确认
    onboarding = true;
    draftKeys = ['opensource', 'ai', 'movie'];
    draftSources = Object.fromEntries(draftKeys.map((k) => [k, defaultSourceNames(k)]));
    selectedKeys = [];
    digest = null;
    return;
  }

  onboarding = false;
  hydrateDraftSourcesFromColumns();
  if (contentSource === 'real') {
    buildCandidates(db, { platformId: platform.id, date: DATE });
    const reviewed = Object.values(db.candidate_entries).some(
      (e) => e.platform_id === platform.id && e.issue_date === DATE
        && e.status !== CANDIDATE_STATUS.PENDING
    );
    if (!reviewed) {
      reviewCandidates(db, { platformId: platform.id, date: DATE, auto: true, autoPerColumn: 6 });
    } else {
      // 已审过的期：只给仍空的栏目补放行（避免 AI 等栏一直 0）
      fillEmptyColumnApprovals(db, { platformId: platform.id, date: DATE, autoPerColumn: 6 });
    }
    await saveDb(c, db);
  }

  digest = buildReadingDigest(db, { platformId: platform.id, date: DATE, siteUrl: SITE });
  syncSelectedKeys();
}

/* ── 认证：渲染 + 提交 + 会话恢复 + 退出 ── */
function paintAuth() {
  // reset 模式虽已持有 recovery token，仍停在遮罩改密，不进工作台
  const loggedIn = authState.status === 'signedIn' && authState.mode !== 'reset';
  const overlay = $('#authOverlay');
  const app = $('#appRoot');
  if (overlay) overlay.hidden = loggedIn;
  if (app) app.hidden = !loggedIn;

  renderAuth($('#authRoot'), authState, {
    onSubmit: handleAuthSubmit,
    onSwitch: (m) => {
      authState.mode = m;
      authState.error = '';
      authState.notice = '';
      if (m !== 'login' && m !== 'signup') authState.pendingEmail = '';
      paintAuth();
    },
    onLogout: handleLogout,
    onRecover: handleRecover,
    onResend: handleResend,
    onReset: handleResetPassword,
  });

  const backend = $('#authBackend');
  if (!backend) return;
  if (authState.backendOk === null) {
    backend.className = 'auth-backend';
    backend.textContent = '正在检查后端连接…';
    // 探测未结束也允许进演示，避免 loadSharedPool 分页拖死整屏
    const b = document.createElement('button');
    b.className = 'demo-enter';
    b.textContent = '进入演示模式';
    b.addEventListener('click', enterDemo);
    backend.appendChild(b);
  } else if (authState.backendOk === false) {
    backend.className = 'auth-backend off';
    backend.textContent = '云端未连接（可离线体验）';
    const b = document.createElement('button');
    b.className = 'demo-enter';
    b.textContent = '进入演示模式';
    b.addEventListener('click', enterDemo);
    backend.appendChild(b);
  } else {
    backend.className = 'auth-backend';
    backend.textContent = '已连接 ' + urlHost(SB_CONFIG.url);
    const b = document.createElement('button');
    b.className = 'demo-enter';
    b.textContent = '先体验演示';
    b.addEventListener('click', enterDemo);
    backend.appendChild(b);
  }
}

async function handleAuthSubmit(email, pw) {
  if (!email || !pw) {
    authState.error = '请填写邮箱和密码';
    paintAuth();
    return;
  }
  if (pw.length < 6) {
    authState.error = '密码至少需要 6 位';
    paintAuth();
    return;
  }
  authState.busy = true;
  authState.error = '';
  authState.notice = '';
  authState.pendingEmail = '';
  paintAuth();
  try {
    const c = ensureClient(null);
    const resp = authState.mode === 'signup'
      ? await c.auth.signUp(email, pw, { display_name: email.split('@')[0] })
      : await c.auth.signIn(email, pw);

    // 开启邮箱确认时，signUp 只返回 user、没有 session
    if (!resp || !resp.access_token) {
      authState.busy = false;
      authState.mode = 'login';
      authState.pendingEmail = email;
      authState.notice = '账号已创建。请先到邮箱点确认链接，然后回来登录。';
      paintAuth();
      return;
    }
    const sess = normalizeSession(resp) || resp;
    saveSession(sess);
    await enterCloud(sess);
  } catch (e) {
    authState.busy = false;
    authState.error = authError(e);
    if (/email not confirmed/i.test(String(e && e.message || e || ''))) {
      authState.pendingEmail = email;
      authState.notice = '还没验证邮箱？';
    }
    paintAuth();
  }
}

async function handleRecover(email) {
  if (!email) {
    authState.error = '请填写邮箱';
    paintAuth();
    return;
  }
  authState.busy = true;
  authState.error = '';
  authState.notice = '';
  paintAuth();
  try {
    const c = ensureClient(null);
    await c.auth.recover(email);
    authState.busy = false;
    authState.mode = 'login';
    authState.notice = '重置邮件已发送（若该邮箱已注册）。请按邮件链接设置新密码。';
    paintAuth();
  } catch (e) {
    authState.busy = false;
    authState.error = authError(e);
    paintAuth();
  }
}

async function handleResend(email) {
  if (!email) return;
  authState.busy = true;
  authState.error = '';
  paintAuth();
  try {
    const c = ensureClient(null);
    await c.auth.resend(email, 'signup');
    authState.busy = false;
    authState.notice = '确认邮件已重发，请查收邮箱（含垃圾箱）。';
    paintAuth();
  } catch (e) {
    authState.busy = false;
    authState.error = authError(e);
    paintAuth();
  }
}

async function handleResetPassword(password) {
  if (!password || password.length < 6) {
    authState.error = '密码至少需要 6 位';
    paintAuth();
    return;
  }
  authState.busy = true;
  authState.error = '';
  paintAuth();
  try {
    const c = ensureClient(currentToken);
    await c.auth.updatePassword(password);
    let u = null;
    try { u = await c.auth.user(); } catch { /* ignore */ }
    authState.mode = 'login';
    authState.busy = false;
    authState.notice = '';
    authState.user = u;
    // 改密成功后直接进云端（已持有有效 session）
    const sess = loadSession() || { access_token: currentToken, user: u };
    if (u) sess.user = u;
    saveSession(sess);
    await enterCloud(sess);
  } catch (e) {
    authState.busy = false;
    authState.error = authError(e);
    paintAuth();
  }
}

/**
 * 用本地会话进云端：过期则 refresh；refresh 失败清会话。
 * @returns {Promise<boolean>} 是否成功进入
 */
async function restoreFromSession(session) {
  if (!session || !session.access_token) return false;
  let sess = session;
  const c = ensureClient(sess.access_token);
  try {
    if (sessionNeedsRefresh(sess) && sess.refresh_token) {
      const fresh = await c.auth.refreshSession(sess.refresh_token);
      sess = normalizeSession(fresh) || fresh;
      if (fresh && fresh.user) sess.user = fresh.user;
      saveSession(sess);
      ensureClient(sess.access_token);
    }
    const u = await c.auth.user();
    if (!u) throw new Error('session invalid');
    sess.user = { id: u.id, email: u.email };
    saveSession(sess);
    await enterCloud({ access_token: sess.access_token, user: u, refresh_token: sess.refresh_token, expires_at: sess.expires_at });
    return true;
  } catch (first) {
    // access_token 可能已死但 refresh 还活着（needsRefresh 因缺 expires_at 没触发）
    if (sess.refresh_token) {
      try {
        const fresh = await c.auth.refreshSession(sess.refresh_token);
        sess = normalizeSession(fresh) || fresh;
        if (fresh && fresh.user) sess.user = fresh.user;
        saveSession(sess);
        ensureClient(sess.access_token);
        const u = await c.auth.user();
        if (!u) throw new Error('session invalid');
        await enterCloud({ access_token: sess.access_token, user: u, refresh_token: sess.refresh_token, expires_at: sess.expires_at });
        return true;
      } catch { /* fall through */ }
    }
    clearSession();
    currentToken = null;
    return false;
  }
}

async function enterCloud(resp) {
  try {
    await initCloud(resp);
    let u = resp.user;
    if (!u && client) {
      try { u = await client.auth.user(); } catch { /* ignore */ }
    }
    authState.status = 'signedIn';
    authState.mode = 'login';
    authState.busy = false;
    authState.error = '';
    authState.notice = '';
    authState.user = u || { email: resp.user && resp.user.email };
    updateTopbar();
    paintAuth();
    refresh();
    if (!onboarding) showView('digest');
    toast(onboarding ? '先选内容包，搭好你的平台' : '已连接 · 打开今日阅读');
  } catch (e) {
    authState.busy = false;
    authState.error = '云端数据加载失败：' + authError(e);
    clearSession();
    currentToken = null;
    paintAuth();
  }
}

async function enterDemo() {
  mode = 'demo';
  currentToken = null;
  // 等共享池预热一小会儿：池里已有小红书等，别先灌离线 DEMO 显示「未入库」
  if (!sharedPoolCache && authState.backendOk && sharedPoolWarm) {
    try { await withDeadline(sharedPoolWarm, 8000, 'pool warm timeout'); } catch { /* 仍可离线 */ }
  }
  if (!sharedPoolCache && authState.backendOk) {
    try {
      const c = createClient({
        url: SB_CONFIG.url,
        key: SB_CONFIG.key,
        schema: SB_CONFIG.schema,
        timeout: 8000,
      });
      sharedPoolCache = await withDeadline(loadSharedPool(c), 12000, 'pool load timeout');
    } catch { /* 离线 DEMO */ }
  }
  initDemo();
  authState.status = 'signedIn';
  authState.mode = 'login';
  authState.busy = false;
  authState.error = '';
  authState.notice = '';
  authState.user = { email: '演示用户', id: 'demo' };
  updateTopbar();
  paintAuth();
  refresh();
  toast(contentSource === 'real'
    ? '演示：已载入主源目录，先选内容包'
    : '演示：离线样例，先选内容包');
}

async function handleLogout() {
  try { if (client && currentToken) await client.auth.signOut(); } catch { /* ignore */ }
  clearSession();
  currentToken = null;
  initDemo();
  authState.status = 'signedOut';
  authState.mode = 'login';
  authState.user = null;
  authState.pendingEmail = '';
  authState.notice = '已退出登录，当前为演示模式';
  authState.error = '';
  updateTopbar();
  paintAuth();
  refresh();
  toast('已退出登录');
}

function updateTopbar() {
  const badge = $('#backendBadge');
  const avatar = $('#topAvatar');
  const side = $('#sideAuth');
  const welcome = $('#topWelcome');
  const topDate = $('#topDate');
  if (topDate) topDate.textContent = DATE;
  if (!badge || !avatar || !side) return;
  if (mode === 'cloud' && authState.user) {
    const email = String(authState.user.email || '');
    const name = email.split('@')[0] || '创作者';
    badge.textContent = '● 已连接云端';
    badge.className = 'pill on';
    avatar.textContent = (email.charAt(0) || '我').toUpperCase();
    if (welcome) welcome.textContent = '欢迎回来，' + name;
    side.innerHTML = '<div class="side-user">' + esc(email) + '</div>' +
      '<button class="side-logout" id="sideLogout">退出登录</button>';
    const b = $('#sideLogout');
    if (b) b.addEventListener('click', handleLogout);
  } else {
    badge.textContent = '● 演示模式';
    badge.className = 'pill';
    avatar.textContent = '我';
    if (welcome) welcome.textContent = '欢迎来到你的创作中心';
    side.innerHTML = '<div class="side-user">演示模式 · 数据仅存本机</div>' +
      '<button class="side-logout" id="sideLogin">登录云端</button>';
    const b = $('#sideLogin');
    if (b) b.addEventListener('click', () => {
      authState.status = 'signedOut';
      authState.user = null;
      paintAuth();
    });
  }
}

/* ── 视图切换 ── */
const VIEW_TITLES = {
  onboard: '搭建平台',
  platform: '概览',
  tags: '选内容包',
  sources: '全部源',
  review: '今日转发',
  digest: '今日阅读',
};
function showView(name) {
  if (onboarding && name !== 'onboard') name = 'onboard';
  // 栏目管理已并入今日转发
  if (name === 'columns') name = 'review';
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  const title = $('#topTitle');
  if (title) title.textContent = VIEW_TITLES[name] || '';
  // 切页时按需重绘：避免只依赖启动时 refresh，导致空网格一直留着
  if (name === 'onboard') drawOnboard();
  else if (name === 'tags') drawTags();
  else if (name === 'sources') drawSourceCatalog();
  else if (name === 'review') drawCands();
  else if (name === 'digest') drawDigest();
  else if (name === 'platform') drawHome();
}

/* ── 重算真 digest + 重绘全部视图 ── */
function refresh() {
  if (!db) return;
  const app = $('#appRoot');
  if (app) app.classList.toggle('onboarding', !!onboarding);
  if (onboarding) {
    showView('onboard');
    drawOnboard();
    return;
  }
  if (!platform) return;
  // 今日阅读 = 已选源汇总；发布页仍走 buildPlatformDigest（仅已选用）
  digest = buildReadingDigest(db, { platformId: platform.id, date: DATE, siteUrl: SITE });
  drawHome();
  drawFormatChips();
  drawTags();
  drawSourceCatalog();
  drawCands();
  drawSide();
  drawDigest();
}

/* ── 数据变更后：先本地重绘，再按需写回云端（串行，避免连点 audit upsert 403） ── */
let commitTail = Promise.resolve();
function commit(msg) {
  refresh();
  if (mode === 'cloud' && client) {
    commitTail = commitTail.catch(() => {}).then(async () => {
      try {
        await saveDb(client, db);
        toast(msg ? msg + ' · 已同步云端' : '已同步云端');
      } catch (e) {
        console.error('[portal] saveDb failed', e);
        const detail = (e && (e.body || e.details || e.hint)) ? JSON.stringify(e.body || e.details || e.hint).slice(0, 180) : '';
        toast('云端同步失败：' + ((e && e.message) || e) + (detail ? ' · ' + detail : ''));
      }
    });
    return commitTail;
  }
  if (msg) toast(msg);
  return Promise.resolve();
}

function todayStats() {
  const cols = Object.values(db.platform_columns).filter((c) => c.platform_id === platform.id);
  const cands = Object.values(db.candidate_entries).filter(
    (e) => e.platform_id === platform.id && e.issue_date === DATE
  );
  const pending = cands.filter((e) => e.status === CANDIDATE_STATUS.PENDING).length;
  const approved = cands.filter(
    (e) => e.status === CANDIDATE_STATUS.APPROVED || e.status === CANDIDATE_STATUS.PINNED
      || e.status === 'approved' || e.status === 'pinned'
  ).length;
  return { cols: cols.length, cands: cands.length, pending, approved };
}

/* ── 首页：状态卡 + 待办 + 三入口宫格 ── */
function drawHome() {
  const s = todayStats();
  const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v); };
  const readingN = digest && Number.isFinite(digest.total) ? digest.total : 0;
  set('#statCols', s.cols);
  set('#statCands', s.cands);
  set('#statPending', s.pending);
  set('#statApproved', readingN);

  const todo = $('#homeTodo');
  if (todo) {
    if (contentSource === 'empty' && readingN === 0) {
      todo.textContent = '主源暂无内容，可先调整内容包；有供给后会出现在今日阅读。';
    } else if (readingN > 0) {
      todo.textContent = '今日阅读已汇总已选源 ' + readingN + ' 条 · 按栏目标签切换。';
    } else if (s.pending > 0) {
      todo.textContent = '阅读池暂空；转发区有 ' + s.pending + ' 条待选。可等日更或改内容包。';
    } else {
      todo.textContent = '打开「今日阅读」看已选源；要发出去时再进「今日转发」。';
    }
  }

  const reviewBtn = $('#homeActionReview');
  const homeBadge = $('#homeReviewBadge');
  if (reviewBtn) reviewBtn.classList.toggle('emphasis', s.pending > 0);
  if (homeBadge) {
    if (s.pending > 0) {
      homeBadge.hidden = false;
      homeBadge.textContent = String(s.pending);
    } else {
      homeBadge.hidden = true;
    }
  }
}

function markClass(key) {
  if (key === 'news') return 'o';
  if (key === 'portrait' || key === 'movie') return 'p';
  if (key === 'ai') return 'o';
  if (key === 'finance') return 'y';
  if (key === 'design' || key === 'sight') return 'b';
  if (key === 'funny') return 'g';
  return '';
}

/** 云端 tag_packs 名若乱码/空，仍用 CORE 中文展示名；id 必须用库里的 uuid。 */
function normalizePackNames(targetDb) {
  if (!targetDb || !targetDb.tag_packs) return;
  for (const p of CORE_TAG_PACKS) {
    const row = targetDb.tag_packs[p.key];
    if (!row) continue;
    row.name = p.name;
    row.group_name = p.group_name;
    row.description = p.description || '';
  }
  // 已建栏目名跟着修，避免审稿目录也是 ????
  for (const col of Object.values(targetDb.platform_columns || {})) {
    const core = CORE_TAG_PACKS.find((p) => p.key === col.key);
    if (core) col.name = core.name;
  }
}

/** 目录顺序：CORE 顺序；id 取库内行（打标签 / 建栏目外键要用）。 */
function listPacks() {
  return CORE_TAG_PACKS.map((p) => {
    const row = db && db.tag_packs && db.tag_packs[p.key];
    if (!row) return p;
    return {
      key: p.key,
      name: p.name,
      group_name: p.group_name,
      description: p.description || row.description || '',
      risk_level: row.risk_level || p.risk_level,
      id: row.id,
    };
  });
}

function countForTag(key) {
  const pack = db && db.tag_packs && db.tag_packs[key];
  if (!pack || !Array.isArray(db.content_tags)) return 0;
  let n = 0;
  for (const t of db.content_tags) {
    if (t.tag_pack_id === pack.id) n++;
  }
  return n;
}

function displayTitle(item) {
  const t = String((item && item.title) || '');
  if (t && !isGarbledText(t)) return t;
  const sum = String((item && item.summary) || '').trim();
  if (sum && !isGarbledText(sum)) return sum.length > 48 ? sum.slice(0, 48) + '…' : sum;
  return hostOf(item && item.canonical_url) || '未命名条目';
}

function thumbUrl(item) {
  const u = item && item.image_url;
  if (u && /^https?:\/\//i.test(u) && safeHref(u)) return safeHref(u);
  const host = hostOf(item && item.canonical_url);
  return host ? 'https://www.google.com/s2/favicons?sz=128&domain=' + encodeURIComponent(host) : '';
}

/** 用户地区：电影音乐按 locale 优先匹配 metadata.region（zh-CN / intl）。 */
function userRegion() {
  const loc = String((user && user.locale) || 'zh-CN').toLowerCase();
  if (loc.startsWith('zh')) return 'zh-CN';
  return 'intl';
}

function regionScore(item, prefer) {
  const r = item && item.metadata && item.metadata.region;
  if (!r) return 1;
  if (r === prefer) return 0;
  if (prefer === 'zh-CN' && r === 'intl') return 2;
  if (prefer === 'intl' && r === 'zh-CN') return 2;
  return 1;
}

const VISUAL_PACKS = { funny: 1, portrait: 1, sight: 1, movie: 1 };

/** 与 loadSharedPool 的 content_items limit 对齐；手风琴必须扫够整包，否则尾部 publisher 会假「未入库」 */
const CATALOG_POOL_LIMIT = 5000;

/**
 * 共享池样例颗粒（完整条目）；离线 demo 才退回标题字符串。
 * @param {{ forCatalog?: boolean }} [opts]
 *   forCatalog=true：内容包手风琴用整包池（每源各自再滤），不被「已勾选来源」裁空；
 *   默认 false：今日阅读相关预览仍按勾选来源过滤。
 */
function granulesForTag(key, limit = 5, opts = {}) {
  const pack = db && db.tag_packs && db.tag_packs[key];
  const out = [];
  const want = selectedSourcesFor(key);
  const allSrc = defaultSourceNames(key);
  const narrowed = !opts.forCatalog
    && !!(want.length && allSrc.length && want.length < allSrc.length);
  // forCatalog 忽略调用方的小数 limit（旧代码传 48 会把微博/机器之心等挤出样例池）
  const cap = opts.forCatalog ? Math.max(limit, CATALOG_POOL_LIMIT) : limit;
  if (pack && Array.isArray(db.content_tags)) {
    for (const t of db.content_tags) {
      if (t.tag_pack_id !== pack.id) continue;
      const item = db.content_items[t.content_item_id];
      if (!item || !item.title) continue;
      if (isGarbledText(item.title) && isGarbledText(item.summary || '')) continue;
      if (narrowed && !itemMatchesSources(item, want, key)) continue;
      if (!itemMatchesFormats(item, selectedFormats)) continue;
      // 视觉包必须有配图，否则不配进预览（对齐见笑/见她/听乐看片）
      if (VISUAL_PACKS[key] && !(item.image_url && /^https?:\/\//i.test(item.image_url))) continue;
      out.push(item);
      if (out.length >= cap) break;
    }
  }
  if (key === 'movie' && out.length) {
    const prefer = userRegion();
    out.sort((a, b) => regionScore(a, prefer) - regionScore(b, prefer));
  }
  if (out.length) return out.slice(0, cap);
  if (contentSource === 'demo') {
    return (FALLBACK_SAMPLES[key] || []).slice(0, limit).map((title, i) => ({
      id: 'fallback-' + key + '-' + i,
      title,
      summary: '离线样例，连接主源后可看真实摘要与配图。',
      canonical_url: '',
      image_url: null,
    }));
  }
  return [];
}

function poolHintText() {
  const n = db ? Object.keys(db.content_items).length : 0;
  if (contentSource === 'real') return '主源目录 · ' + n + ' 条可索引';
  if (contentSource === 'empty') return '主源暂无内容';
  return '离线样例（未连上主源）';
}

function setPoolHints() {
  const text = poolHintText();
  ['#onboardPoolHint', '#tagPoolHint'].forEach((sel) => {
    const el = $(sel);
    if (el) el.textContent = text;
  });
}

function summaryLead(item, max = 96) {
  const sum = String((item && item.summary) || '').trim();
  if (!sum || isGarbledText(sum)) return '';
  // 摘要首段：按换行切开，否则整段截断
  const lead = sum.split(/\n+/)[0].trim();
  return lead.length > max ? lead.slice(0, max) + '…' : lead;
}

function makeGranuleButton(item, packKey, packName) {
  const g = document.createElement('button');
  g.type = 'button';
  g.className = 'granule rich';
  const thumb = thumbUrl(item);
  const hasRemoteImg = !!(item.image_url && /^https?:\/\//i.test(item.image_url));
  const title = displayTitle(item);
  const leadRaw = summaryLead(item);
  const lead = leadRaw && leadRaw.replace(/\s+/g, '') !== String(title || '').replace(/\s+/g, '')
    ? leadRaw
    : '';
  const mediaHtml = hasRemoteImg
    ? `<img class="granule-thumb" src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : (thumb
      ? `<img class="granule-thumb ico-fav" src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="granule-thumb ico ${markClass(packKey)}">${esc(String(packName || '?').slice(0, 1))}</span>`);
  g.innerHTML =
    mediaHtml +
    `<span class="granule-body">` +
    `<span class="granule-title">${esc(title)}</span>` +
    (lead ? `<span class="granule-sum">${esc(lead)}</span>` : '') +
    `</span>`;
  g.addEventListener('click', (e) => {
    e.stopPropagation();
    openGranule(item);
  });
  return g;
}

function renderTagCard(p, opts) {
  const on = opts.selected;
  const key = p && p.key;
  const name = String((p && p.name) || key || '内容包');
  const pickedSources = on ? selectedSourcesFor(key) : defaultSourceNames(key);
  // 手风琴要展示「每个源自己有没有货」：整包池 + 每源再滤（勿截前 N，稀有源会被挤成「未入库」）
  const pool = granulesForTag(key, CATALOG_POOL_LIMIT, { forCatalog: true });
  const count = countForTag(key);
  const card = document.createElement('div');
  card.className = 'tag-card rich' + (on ? ' selected' : '');
  card.dataset.tagKey = key;
  const desc = (p && p.description) || '';
  const group = (p && p.group_name) || '';
  const srcN = on && pickedSources.length ? pickedSources.length + ' 个源 · ' : '';
  const countLabel = count > 0 ? count + ' 条可看' : (contentSource === 'demo' ? '离线样例' : '暂无供给');

  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'badge' + (on ? '' : ' soft');
  pick.textContent = on ? '✓ 已选' : '+ 选择';
  pick.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onToggle(key, on);
  });

  const head = document.createElement('div');
  head.className = 'tag-card-head';
  head.innerHTML =
    `<div class="tag-mark ${markClass(key)}">${esc(name.slice(0, 1))}</div>` +
    `<div class="tag-head-text">` +
    `<div class="tag-name">${esc(name)}</div>` +
    `<div class="tag-meta">${esc(group)}${group ? ' · ' : ''}${esc(srcN)}${esc(countLabel)}</div>` +
    (desc ? `<div class="tag-desc">${esc(desc)}</div>` : '') +
    `</div>`;
  head.addEventListener('click', () => opts.onToggle(key, on));

  const allSources = sourcesForTag(key);
  const curated = curatedSourcesForTag(key);
  const curatedNames = new Set(curated.map((s) => s.name));
  const q = String(packSrcQuery.get(key) || '').trim().toLowerCase();
  const showAll = packSrcShowAll.has(key) || !!q;
  let sources = showAll ? allSources : curated;
  if (q) {
    sources = allSources.filter(
      (s) => s.name.toLowerCase().includes(q) || String(s.domain || '').toLowerCase().includes(q),
    );
  }
  const ACC_CAP = 40;
  const truncated = sources.length > ACC_CAP;
  if (truncated) sources = sources.slice(0, ACC_CAP);

  const acc = document.createElement('div');
  acc.className = 'src-acc-list';
  acc.setAttribute('aria-label', name + ' 来源手风琴');
  const hint = document.createElement('div');
  hint.className = 'tag-sources-hint';
  hint.textContent = on
    ? `共 ${allSources.length} 个源（精选 ${curated.length}）；点行预览，右侧勾选`
    : `共 ${allSources.length} 个源；先选内容包，或打开「全部源」`;
  acc.appendChild(hint);

  if (allSources.length > curated.length || allSources.length > 12) {
    const tools = document.createElement('div');
    tools.className = 'src-acc-tools';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'src-acc-search';
    search.placeholder = '搜本包源名';
    search.value = packSrcQuery.get(key) || '';
    search.addEventListener('click', (e) => e.stopPropagation());
    search.addEventListener('input', () => {
      packSrcQuery.set(key, search.value);
      // 局部重绘该卡：走整页 drawTags 最省事
      drawTags();
      const again = document.querySelector(`.tag-card[data-tag-key="${CSS.escape(key)}"] .src-acc-search`);
      if (again) {
        again.focus();
        const v = again.value;
        again.setSelectionRange(v.length, v.length);
      }
    });
    tools.appendChild(search);
    if (!showAll && allSources.length > curated.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn soft src-acc-more';
      more.textContent = '展开全部 ' + allSources.length;
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        packSrcShowAll.add(key);
        drawTags();
      });
      tools.appendChild(more);
    } else if (showAll && !q) {
      const less = document.createElement('button');
      less.type = 'button';
      less.className = 'btn soft src-acc-more';
      less.textContent = '只看精选';
      less.addEventListener('click', (e) => {
        e.stopPropagation();
        packSrcShowAll.delete(key);
        drawTags();
      });
      tools.appendChild(less);
    }
    acc.appendChild(tools);
  }

  if (!sources.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-s';
    empty.textContent = q ? '无匹配源' : '暂无具名源';
    acc.appendChild(empty);
  } else {
    if (!srcAccordionOpen.has(key)) srcAccordionOpen.set(key, new Set());
    const openSet = srcAccordionOpen.get(key);

    sources.forEach((s) => {
      // 演示展示区每源只露 3 条；池内日更可远多于此
      const items = pool.filter((it) => itemMatchesSources(it, [s.name], key)).slice(0, 3);
      const active = on && pickedSources.indexOf(s.name) >= 0;
      const expanded = openSet.has(s.name);
      const row = document.createElement('div');
      row.className = 'src-acc' + (expanded ? ' open' : '') + (active ? ' on' : '') + (on ? '' : ' dim');

      const bar = document.createElement('div');
      bar.className = 'src-acc-h';

      const body = document.createElement('div');
      body.className = 'src-acc-body';
      body.hidden = !expanded;
      if (!items.length) {
        body.innerHTML = '<div class="empty-s">共享池尚未入库该源（榜单/RSS 未接或未日更）</div>';
      } else {
        items.forEach((item) => body.appendChild(makeGranuleButton(item, key, name)));
      }

      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'src-acc-expand' + (items.length ? '' : ' empty');
      expandBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      expandBtn.title = expanded ? '收起' : '展开';
      const ico = sourceIconUrl(s.domain);
      const peek = items[0] ? displayTitle(items[0]) : '未入库';
      const badge = curatedNames.has(s.name) ? '' : '<span class="src-badge">扩</span>';
      expandBtn.innerHTML =
        `<span class="src-acc-caret" aria-hidden="true"></span>` +
        (ico ? `<img class="src-ico" src="${esc(ico)}" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer">` : '') +
        `<span class="src-acc-main">` +
        `<span class="src-name">${esc(s.name)}${badge}</span>` +
        `<span class="src-acc-peek">${esc(peek)}</span>` +
        `</span>` +
        `<span class="src-acc-n">${items.length ? (items.length + (items.length >= 4 ? '+' : '')) : '—'}</span>`;
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (openSet.has(s.name)) openSet.delete(s.name);
        else openSet.add(s.name);
        const nowOpen = openSet.has(s.name);
        row.classList.toggle('open', nowOpen);
        expandBtn.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
        expandBtn.title = nowOpen ? '收起' : '展开';
        body.hidden = !nowOpen;
      });

      const pickSrc = document.createElement('button');
      pickSrc.type = 'button';
      pickSrc.className = 'src-acc-pick' + (active ? ' on' : '');
      pickSrc.setAttribute('aria-pressed', active ? 'true' : 'false');
      pickSrc.title = active ? '移出栏目' : '加入栏目';
      pickSrc.textContent = active ? '✓' : '+';
      pickSrc.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof opts.onToggleSource === 'function') opts.onToggleSource(key, s.name, on);
      });

      bar.appendChild(expandBtn);
      bar.appendChild(pickSrc);
      row.appendChild(bar);
      row.appendChild(body);
      acc.appendChild(row);
    });
    if (truncated) {
      const more = document.createElement('div');
      more.className = 'empty-s';
      more.textContent = `仅显示前 ${ACC_CAP} 个，打开「全部源」查看完整目录`;
      acc.appendChild(more);
    }
  }

  card.appendChild(pick);
  card.appendChild(head);
  card.appendChild(acc);
  return card;
}

function openGranule(item) {
  let modal = $('#granuleModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'granuleModal';
    modal.className = 'granule-modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="granule-dialog card" role="dialog" aria-modal="true">' +
      '<button type="button" class="granule-close" aria-label="关闭">×</button>' +
      '<div class="granule-cover-wrap"><img class="granule-cover" alt=""></div>' +
      '<h2 class="granule-h"></h2>' +
      '<p class="granule-fullsum"></p>' +
      '<div class="granule-meta"></div>' +
      '<div class="granule-actions btn-row"></div>' +
      '<p class="granule-note">版权：只展示标题、短摘要与原文链接；配图为源站热链，不转存。</p>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.classList.contains('granule-close')) closeGranule();
    });
  }
  const cover = modal.querySelector('.granule-cover');
  const wrap = modal.querySelector('.granule-cover-wrap');
  const thumb = thumbUrl(item);
  if (thumb) {
    wrap.hidden = false;
    cover.src = thumb;
    cover.onerror = () => { wrap.hidden = true; };
  } else {
    wrap.hidden = true;
    cover.removeAttribute('src');
  }
  modal.querySelector('.granule-h').textContent = displayTitle(item);
  const sum = String(item.summary || '').trim();
  modal.querySelector('.granule-fullsum').textContent =
    sum && !isGarbledText(sum) ? sum : '（无摘要，请打开原文查看）';
  const meta = [
    hostOf(item.canonical_url) || (item.metadata && item.metadata.publisher) || '主源',
    item.published_at ? String(item.published_at).slice(0, 10) : '',
  ].filter(Boolean).join(' · ');
  modal.querySelector('.granule-meta').textContent = meta;
  const actions = modal.querySelector('.granule-actions');
  actions.innerHTML = '';
  const href = safeHref(item.canonical_url);
  if (href) {
    const a = document.createElement('a');
    a.className = 'btn primary';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '打开原文';
    actions.appendChild(a);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn';
  close.textContent = '关闭';
  close.addEventListener('click', closeGranule);
  actions.appendChild(close);
  modal.hidden = false;
}

function closeGranule() {
  const modal = $('#granuleModal');
  if (modal) modal.hidden = true;
}

/* ── 目录筛选（社区/科技/…）── */
let dirFilter = '全部';

function drawDirTabs(hostId, onPick) {
  const host = $(hostId);
  if (!host) return;
  const dirs = [{ key: '全部', label: '全部' }, ...DIRECTORIES];
  host.innerHTML = '';
  dirs.forEach((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dir-tab' + (dirFilter === d.key ? ' on' : '');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', dirFilter === d.key ? 'true' : 'false');
    b.textContent = d.label;
    b.addEventListener('click', () => {
      dirFilter = d.key;
      onPick();
    });
    host.appendChild(b);
  });
}

function packsInDir(packs) {
  if (dirFilter === '全部') return packs;
  return packs.filter((p) => (p.group_name || '') === dirFilter);
}

/* ── 搭站向导 ── */
function drawOnboard() {
  const grid = $('#onboardGrid');
  const count = $('#onboardCount');
  const btn = $('#onboardConfirm');
  if (!grid) return;
  setPoolHints();
  const onToggle = (key, on) => {
    draftKeys = togglePackKey(draftKeys, key, on);
    if (on) delete draftSources[key];
    else draftSources[key] = defaultSourceNames(key);
    drawOnboard();
  };
  const onSetKeys = (keys) => {
    const next = [...new Set((keys || []).map((k) => String(k || '').trim()).filter(Boolean))];
    draftKeys = next;
    const keep = new Set(next);
    Object.keys(draftSources).forEach((k) => { if (!keep.has(k)) delete draftSources[k]; });
    next.forEach((k) => {
      if (!draftSources[k]) draftSources[k] = defaultSourceNames(k);
    });
    drawOnboard();
  };
  const onToggleSource = (key, sourceName, packOn) => {
    if (!packOn) {
      draftKeys = togglePackKey(draftKeys, key, false);
      draftSources[key] = [sourceName];
    } else {
      const r = toggleSourceName(key, sourceName);
      if (r && r.dropPack) draftKeys = draftKeys.filter((k) => k !== key);
    }
    drawOnboard();
  };
  const usedB = drawPackPickerB({
    railId: '#onboardRail',
    gridId: '#onboardGrid',
    heroId: '#onboardSelHero',
    ctaId: null,
    selectedPackKeys: draftKeys,
    onToggle,
    onSetKeys,
    onToggleSource,
    redraw: drawOnboard,
  });
  if (!usedB) {
    drawDirTabs('#onboardDirs', drawOnboard);
    grid.innerHTML = '';
    packsInDir(listPacks()).forEach((p) => {
      grid.appendChild(renderTagCard(p, {
        selected: draftKeys.indexOf(p.key) >= 0,
        onToggle,
        onToggleSource,
      }));
    });
  }
  if (count) count.textContent = draftKeys.length;
  if (btn) btn.disabled = draftKeys.length === 0;
}

async function confirmOnboard() {
  if (!user || !draftKeys.length) {
    toast('请至少选择一个内容包');
    return;
  }
  const btn = $('#onboardConfirm');
  if (btn) { btn.disabled = true; btn.textContent = '正在搭建…'; }
  try {
    const sourceSelections = {};
    for (const k of draftKeys) sourceSelections[k] = selectedSourcesFor(k);
    const built = createPlatform(db, {
      userId: user.id,
      name: '我的头条',
      tagKeys: draftKeys,
      sourceSelections,
      siteUrl: SITE,
      reviewPolicy: 'human_confirm',
    });
    platform = built.platform;
    selectedKeys = draftKeys.slice();
    hydrateDraftSourcesFromColumns();
    if (Object.keys(db.content_items).length) {
      buildCandidates(db, { platformId: platform.id, date: DATE });
      // 观看优先：搭站后每栏多放行几条，立刻能切标签看
      reviewCandidates(db, { platformId: platform.id, date: DATE, auto: true, autoPerColumn: 6 });
    }
    onboarding = false;
    if (mode === 'cloud' && client) await saveDb(client, db);
    refresh();
    showView('digest');
    toast('平台已搭好，开始今日阅读：' + selectedKeys.length + ' 个栏目');
  } catch (e) {
    toast('搭建失败：' + (e && e.message ? e.message : e));
    if (btn) { btn.disabled = draftKeys.length === 0; btn.textContent = '搭好我的平台'; }
  }
}

/** 共享池按 publisher 建索引，供「全部源」标题/摘要预览 */
function indexPoolByPublisher() {
  const map = new Map();
  if (!db || !db.content_items) return map;
  for (const item of Object.values(db.content_items)) {
    if (!item) continue;
    const pub = String((item.metadata && item.metadata.publisher) || '').trim();
    if (!pub || pub === 'main-source' || pub === 'RSS') continue;
    if (!map.has(pub)) map.set(pub, []);
    map.get(pub).push(item);
  }
  for (const list of map.values()) {
    list.sort((a, b) => String(b.published_at || b.created_at || '').localeCompare(String(a.published_at || a.created_at || '')));
  }
  return map;
}

/** 源名 → 池内条目（精确优先；去热搜/热榜后缀对齐；禁止「见闻」误吞「华尔街见闻」） */
function poolItemsForSource(sourceName, byPub) {
  if (!byPub || !byPub.size) return [];
  const name = String(sourceName || '').trim();
  if (!name) return [];
  if (byPub.has(name)) return byPub.get(name);
  const strip = (s) => String(s || '').replace(/热搜|热榜|热议|趋势|日报|早报|精选/g, '');
  const soft = strip(name);
  if (soft.length < 2) return [];
  for (const [pub, items] of byPub) {
    if (strip(pub) === soft) return items;
  }
  return [];
}

function shortWhen(iso) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  return (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2)
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 三维度芯片行（带图标）；全部同时展示，筛选 AND */
function paintFoloSubChips(host, items, current, onPick, allLabel) {
  if (!host) return;
  host.innerHTML = '';
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'src-chip cat-chip' + (!current ? ' active' : '');
  all.textContent = allLabel;
  all.addEventListener('click', () => onPick(''));
  host.appendChild(all);
  items.forEach((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'src-chip cat-chip' + (current === it.key ? ' active' : '');
    let ico = '';
    if (it.mark && it.mark.ch) {
      ico = letterAvatar(it.mark.ch, it.mark.bg, it.mark.fg);
    } else if (it.icon) {
      ico = '<img src="' + esc(it.icon) + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
    } else if (it.glyph) {
      ico = '<span class="chip-ico">' + esc(it.glyph) + '</span>';
    }
    b.innerHTML = ico + '<span>' + esc(it.label) + '</span>';
    b.addEventListener('click', () => onPick(current === it.key ? '' : it.key));
    host.appendChild(b);
  });
}

function activeFilterHints() {
  const bits = [];
  if (srcCatMedia) {
    const c = SRC_MEDIA_CHIPS.find((x) => x.key === srcCatMedia);
    bits.push('分类·' + ((c && c.label) || srcCatMedia));
  }
  if (srcCatPlatform) {
    const c = SRC_PLATFORM_CHIPS.find((x) => x.key === srcCatPlatform);
    bits.push('平台·' + ((c && c.label) || srcCatPlatform));
  }
  if (srcCatTopic) {
    const c = NEWS_CHIPS.find((x) => x.key === srcCatTopic);
    bits.push('来源·' + ((c && c.label) || srcCatTopic));
  }
  return bits;
}

function drawSourceFeed(selected, byPub, avatarByPub) {
  const head = $('#srcFeedHead');
  const feed = $('#srcFeedList');
  if (!head || !feed) return;
  if (!selected) {
    head.innerHTML = '<div><h2>选择左侧源</h2><div class="sub">Folo / Inoreader 式：左栏管理源，右栏看条目</div></div>';
    feed.innerHTML = '<div class="folo-empty">从左侧点一个新闻源开始浏览</div>';
    return;
  }
  const items = poolItemsForSource(selected.name, byPub);
  const av = platformAvatarHtml(selected, avatarByPub);
  const shown = displaySourceName(selected) || selected.name;
  const ico = sourceIconUrl(selected.domain);
  const dims = sourceDimLabels(selected);
  head.innerHTML =
    '<div>' +
      '<h2 style="display:flex;align-items:center;gap:8px">' +
        (av || (ico ? '<img src="' + esc(ico) + '" alt="" width="22" height="22" style="border-radius:50%;border:1px solid var(--border)" loading="lazy" referrerpolicy="no-referrer">' : '')) +
        esc(shown) +
      '</h2>' +
      '<div class="sub">' + (items.length ? items.length + ' 条 · ' : '暂无条目 · ') +
      esc(dims.media) + ' · ' + esc(dims.platform) + ' · ' + esc(dims.topic) +
      (selected.domain ? ' · ' + esc(selected.domain) : '') +
      '</div>' +
    '</div>' +
    '<div class="actions">' +
      '<button type="button" class="btn sm" data-view="tags">选内容包</button>' +
      (selected.url
        ? '<a class="btn sm" href="' + esc(safeHref(selected.url) || selected.url) + '" target="_blank" rel="noopener">打开源站</a>'
        : '') +
    '</div>';
  const back = head.querySelector('[data-view="tags"]');
  if (back) back.addEventListener('click', () => showView('tags'));

  feed.innerHTML = '';
  if (!items.length) {
    feed.innerHTML = '<div class="folo-empty">共享池暂无该源条目（未日更进配额，或尚无标题摘要）</div>';
    return;
  }
  const CAP = 80;
  items.slice(0, CAP).forEach((item) => {
    const title = displayTitle(item);
    const lead = summaryLead(item, 100);
    const when = shortWhen(item.published_at || item.created_at);
    const img = String(item.image_url || '').trim();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'folo-item';
    btn.innerHTML =
      (img && /^https?:\/\//i.test(img)
        ? '<img class="folo-thumb" src="' + esc(img) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.className=\'folo-thumb ph\';this.removeAttribute(\'src\');this.textContent=\'图\'">'
        : '<div class="folo-thumb ph">图</div>') +
      '<div class="body">' +
        '<div class="ti">' + esc(title) + '</div>' +
        '<div class="meta">' +
          '<span class="pub">' +
            (av || (ico ? '<img src="' + esc(ico) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '')) +
            esc(selected.name) +
          '</span>' +
          '<span class="tag-mini">' + esc(dims.media) + '</span>' +
          '<span class="tag-mini">' + esc(dims.platform) + '</span>' +
          '<span class="tag-mini">' + esc(dims.topic) + '</span>' +
          (when ? '<span>' + esc(when) + '</span>' : '') +
          (lead ? '<span>' + esc(lead) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="side"><span class="dot" title="池内条目"></span></div>';
    btn.addEventListener('click', () => openGranule(item));
    feed.appendChild(btn);
  });
  if (items.length > CAP) {
    const more = document.createElement('div');
    more.className = 'folo-empty';
    more.textContent = '仅显示前 ' + CAP + ' 条（共 ' + items.length + '）';
    feed.appendChild(more);
  }
}

/* ── 全部源：Folo / Inoreader 双栏（左源管理 · 右条目流）── */
function drawSourceCatalog() {
  const list = $('#srcCatalogList');
  const countEl = $('#srcCatalogCount');
  const hint = $('#srcCatalogHint');
  if (!list) return;

  const byPub = indexPoolByPublisher();
  const search = $('#srcCatalogSearch');
  if (search && !search.__wired) {
    search.__wired = true;
    search.addEventListener('input', () => {
      srcCatQ = search.value || '';
      drawSourceCatalog();
    });
  }
  if (search && search.value !== srcCatQ) search.value = srcCatQ;

  const q = String(srcCatQ || '').trim().toLowerCase();
  let rows = Array.isArray(SOURCE_CATALOG) ? SOURCE_CATALOG.slice() : [];
  // 站内见笑/见她/见闻无 RSS，目录生成时常缺；运行时并入
  for (const v of VISUAL_SOURCE_EXTRAS) {
    if (!rows.some((r) => r.name === v.name)) rows.push(v);
  }
  if (!rows.length) {
    list.innerHTML = '<div class="folo-empty">源目录未生成。跑 npm run format:sources 后刷新。</div>';
    if (countEl) countEl.textContent = '0';
    drawSourceFeed(null, byPub, new Map());
    return;
  }

  // 没有池内条目的源不露出
  rows = rows.filter((r) => poolItemsForSource(r.name, byPub).length > 0);
  const avatarByPub = indexPublisherAvatars(byPub);

  // 芯片选项按「有货全集」算，避免三维互相把对方芯片藏没（整体过滤不收缩维度）
  const liveMedia = new Set(rows.map((r) => sourceMediaKey(r)));
  const livePlatform = new Set(rows.map((r) => sourcePlatformKey(r)));
  const liveTopic = new Set(rows.map((r) => sourceTopicKey(r)).filter(Boolean));
  if (srcCatMedia && !liveMedia.has(srcCatMedia)) srcCatMedia = '';
  if (srcCatPlatform && !livePlatform.has(srcCatPlatform)) srcCatPlatform = '';
  if (srcCatTopic && !liveTopic.has(srcCatTopic)) srcCatTopic = '';
  if (!['media', 'platform', 'topic'].includes(srcCatTab)) srcCatTab = 'media';

  // 分类 / 平台 / 来源：并列 subtab，一次只展开当前维的芯片
  const subtabs = $('#srcCatSubtabs');
  if (subtabs && !subtabs.__wired) {
    subtabs.__wired = true;
    subtabs.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-dim]');
      if (!btn) return;
      const dim = btn.getAttribute('data-dim');
      if (!dim || dim === srcCatTab) return;
      srcCatTab = dim;
      drawSourceCatalog();
    });
  }
  if (subtabs) {
    $$('.folo-subtab', subtabs).forEach((b) => {
      const on = b.getAttribute('data-dim') === srcCatTab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  const chipHost = $('#srcCatActiveChips');
  if (srcCatTab === 'media') {
    // 分类芯片始终全量露出（无货点进去是空列表），避免只剩「短讯」
    paintFoloSubChips(
      chipHost,
      SRC_MEDIA_CHIPS,
      srcCatMedia,
      (k) => { srcCatMedia = k; drawSourceCatalog(); },
      '全部',
    );
  } else if (srcCatTab === 'platform') {
    paintFoloSubChips(
      chipHost,
      SRC_PLATFORM_CHIPS.filter((c) => livePlatform.has(c.key) || ['weixin', 'weibo', 'website'].includes(c.key)),
      srcCatPlatform,
      (k) => { srcCatPlatform = k; drawSourceCatalog(); },
      '全部',
    );
  } else {
    paintFoloSubChips(
      chipHost,
      NEWS_CHIPS.filter((c) => liveTopic.has(c.key)).map((c) => ({
        key: c.key,
        label: c.label,
        glyph: c.key === 'hot' ? '热' : undefined,
        icon: c.key === 'hot' ? '' : sourceIconUrl(TOPIC_CHIP_ICON[c.key] || 'wikipedia.org'),
      })),
      srcCatTopic,
      (k) => { srcCatTopic = k; drawSourceCatalog(); },
      '全部',
    );
  }

  // 已选筛选项（跨 tab 仍 AND）
  const af = $('#srcCatActiveFilters');
  if (af) {
    const pills = [];
    if (srcCatMedia) {
      const c = SRC_MEDIA_CHIPS.find((x) => x.key === srcCatMedia);
      pills.push({ dim: 'media', label: '分类·' + ((c && c.label) || srcCatMedia) });
    }
    if (srcCatPlatform) {
      const c = SRC_PLATFORM_CHIPS.find((x) => x.key === srcCatPlatform);
      pills.push({ dim: 'platform', label: '平台·' + ((c && c.label) || srcCatPlatform) });
    }
    if (srcCatTopic) {
      const c = NEWS_CHIPS.find((x) => x.key === srcCatTopic);
      pills.push({ dim: 'topic', label: '来源·' + ((c && c.label) || srcCatTopic) });
    }
    af.hidden = pills.length === 0;
    af.innerHTML = pills.map((p) =>
      '<span class="af">' + esc(p.label)
      + '<button type="button" data-clear="' + esc(p.dim) + '" aria-label="清除">×</button></span>',
    ).join('');
    if (!af.__wired) {
      af.__wired = true;
      af.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest && e.target.closest('[data-clear]');
        if (!btn) return;
        const d = btn.getAttribute('data-clear');
        if (d === 'media') srcCatMedia = '';
        if (d === 'platform') srcCatPlatform = '';
        if (d === 'topic') srcCatTopic = '';
        drawSourceCatalog();
      });
    }
  }

  if (srcCatMedia) rows = rows.filter((r) => sourceMediaKey(r) === srcCatMedia);
  if (srcCatPlatform) rows = rows.filter((r) => sourcePlatformKey(r) === srcCatPlatform);
  if (srcCatTopic) rows = rows.filter((r) => sourceTopicKey(r) === srcCatTopic);
  if (q) {
    rows = rows.filter((r) => {
      const dims = sourceDimLabels(r);
      if (String(r.name || '').toLowerCase().includes(q)) return true;
      if (String(r.domain || '').toLowerCase().includes(q)) return true;
      if (Object.values(dims).some((x) => String(x).toLowerCase().includes(q))) return true;
      return poolItemsForSource(r.name, byPub).slice(0, 3).some((it) => {
        const t = displayTitle(it).toLowerCase();
        const s = String(it.summary || '').toLowerCase();
        return t.includes(q) || s.includes(q);
      });
    });
  }

  if (countEl) countEl.textContent = String(rows.length);
  if (hint) {
    const bits = activeFilterHints();
    hint.innerHTML = bits.length
      ? '筛选 <b>' + bits.map((x) => esc(x)).join(' · ') + '</b> · ' + rows.length + ' 个源'
      : '有消息 ' + rows.length + ' 个源';
  }

  if (!rows.some((r) => r.name === srcCatSelected)) {
    srcCatSelected = rows[0] ? rows[0].name : '';
  }
  const selected = rows.find((r) => r.name === srcCatSelected) || null;

  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = '<div class="folo-empty">当前筛选下没有新消息</div>';
    drawSourceFeed(null, byPub, avatarByPub);
    return;
  }

  const CAP = 500;
  const groups = groupEntriesByTaxonomy(rows, NEWS_CHIPS);
  let rendered = 0;
  for (const g of groups) {
    if (rendered >= CAP) break;
    const sec = document.createElement('div');
    sec.className = 'folo-sec';
    sec.innerHTML = esc(g.label) + '<span>' + g.entries.length + '</span>';
    list.appendChild(sec);
    for (const r of g.entries) {
      if (rendered >= CAP) break;
      rendered++;
      const n = poolItemsForSource(r.name, byPub).length;
      const dims = sourceDimLabels(r);
      const av = platformAvatarHtml(r, avatarByPub);
      const shown = displaySourceName(r) || r.name;
      const ico = sourceIconUrl(r.domain);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'folo-src' + (r.name === srcCatSelected ? ' on' : '');
      b.title = [r.name, r.domain, dims.media, dims.platform, dims.topic].filter(Boolean).join(' · ');
      const lead = av
        || (ico
          ? '<img src="' + esc(ico) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML=\'<span class=letter>' + esc(String(shown || '?').slice(0, 1)) + '</span>\'">'
          : '<span class="letter">' + esc(String(shown || '?').slice(0, 1)) + '</span>');
      b.innerHTML =
        lead +
        '<span class="nm-wrap">' +
          '<span class="nm">' + esc(shown) + '</span>' +
          '<span class="tags">' +
            '<span class="tag-mini">' + esc(dims.media) + '</span>' +
            '<span class="tag-mini">' + esc(dims.platform) + '</span>' +
            '<span class="tag-mini">' + esc(dims.topic) + '</span>' +
          '</span>' +
        '</span>' +
        '<span class="n">' + (n > 999 ? '999+' : String(n)) + '</span>';
      b.addEventListener('click', () => {
        srcCatSelected = r.name;
        drawSourceCatalog();
      });
      list.appendChild(b);
    }
  }
  drawSourceFeed(selected, byPub, avatarByPub);
}

function faviconForDomain(domain, name) {
  const d = String(domain || '').replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  if (/weixin|mp\.weixin/.test(d)) return platformMarkHtml('weixin');
  if (/weibo/.test(d)) return platformMarkHtml('weibo');
  if (/^(x\.com|twitter\.com)/.test(d)) return platformMarkHtml('twitter');
  if (d) return `<img class="favicon" src="https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(d)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  const ch = String(name || '?').slice(0, 1);
  return `<span class="letter">${esc(ch)}</span>`;
}

function renderSelHeroB(host, selectedPackKeys, { onRemove, onJump, redraw }) {
  if (!host) return;
  const keys = selectedPackKeys.slice();
  if (!keys.length) {
    host.className = 'sel-hero empty';
    host.innerHTML = '方案还是空的 · 在下方点「选用」入库（可切单选/多选）';
    return;
  }
  const byKey = Object.fromEntries(listPacks().map((p) => [p.key, p]));
  host.className = 'sel-hero';
  host.innerHTML =
    '<div class="hero-top">' +
      '<h2>已选方案 ' + keys.length + ' 个包</h2>' +
      '<div class="hero-sub">点卡片预览 · 「选用」入库 · 单选只留一个，多选可叠加</div>' +
    '</div><div class="sel-grid"></div>';
  const grid = host.querySelector('.sel-grid');
  keys.forEach((key) => {
    const p = byKey[key];
    if (!p) return;
    const name = String(p.name || key);
    const picked = selectedSourcesFor(key);
    const curated = curatedSourcesForTag(key);
    const showSrc = (picked.length ? curated.filter((s) => picked.includes(s.name)) : curated).slice(0, 6);
    const chip = document.createElement('div');
    chip.className = 'sel-chip';
    chip.innerHTML =
      `<div class="tag-mark mark ${markClass(key)}">${esc(name.slice(0, 1))}</div>` +
      `<div class="who"><b>${esc(name)}</b><span class="dir">${esc(p.group_name || '')}</span></div>` +
      `<div class="icos">${showSrc.map((s) => faviconForDomain(s.domain, s.name)).join('')}` +
      (picked.length > showSrc.length ? `<span class="more">+${picked.length - showSrc.length}</span>` : '') +
      `</div><button type="button" class="x" title="移出" aria-label="移出 ${esc(name)}">×</button>`;
    chip.querySelector('.x').addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove(key);
      redraw();
    });
    chip.addEventListener('click', (e) => {
      if (e.target.closest('.x')) return;
      onJump(p);
      redraw();
    });
    grid.appendChild(chip);
  });
}

function drawPackRailB(rail, packsAll, redraw) {
  if (!rail) return;
  rail.innerHTML = '<div class="rail-label">栏目</div>';
  DIRECTORIES.forEach((d) => {
    const inDir = packsAll.filter((p) => (p.group_name || '') === d.key);
    const onN = inDir.filter((p) => {
      const keys = onboarding ? draftKeys : selectedKeys;
      return keys.indexOf(p.key) >= 0;
    }).length;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'title-btn' + (dirFilter === d.key ? ' on' : '');
    b.innerHTML = `<span class="big">${esc(d.key)}</span><span class="small">${onN ? onN + ' 已加入 · ' : ''}${inDir.length} 个包</span>`;
    b.addEventListener('click', () => {
      dirFilter = d.key;
      const first = inDir[0];
      openPackKey = first ? first.key : null;
      redraw();
    });
    rail.appendChild(b);
  });
}

/** 包内某源的预览条：优先包标签，否则按 publisher 扫整池（新包未打标也能出标题） */
function previewItemsForSource(sourceName, tagKey, taggedPool, byPub, limit = 4) {
  const fromTag = (taggedPool || [])
    .filter((it) => itemMatchesSources(it, [sourceName], tagKey))
    .slice(0, limit);
  if (fromTag.length) return fromTag;
  return poolItemsForSource(sourceName, byPub).slice(0, limit);
}

function packPoolCount(key, byPub) {
  let n = 0;
  for (const s of curatedSourcesForTag(key)) {
    n += poolItemsForSource(s.name, byPub).length;
  }
  return n;
}

function renderPackExpandB(p, opts) {
  const key = p.key;
  const name = String(p.name || key);
  const on = opts.selected;
  const showAll = packSrcShowAll.has(key);
  const curated = curatedSourcesForTag(key);
  const curatedNames = new Set(curated.map((s) => s.name));
  const allSources = sourcesForTag(key);
  const rows = (showAll ? allSources : curated).slice(0, 64);
  const picked = on ? selectedSourcesFor(key) : [];
  const taggedPool = granulesForTag(key, CATALOG_POOL_LIMIT, { forCatalog: true });
  const byPub = opts.byPub || indexPoolByPublisher();
  if (!srcAccordionOpen.has(key)) srcAccordionOpen.set(key, new Set());
  const openSet = srcAccordionOpen.get(key);

  const box = document.createElement('div');
  box.className = 'pack-expand';
  box.innerHTML =
    `<div class="expand-head">` +
      `<div><h4>${esc(name)}</h4>` +
      `<p>${esc(p.description || '')} · 点行看标题预览；右侧勾选子源</p></div>` +
      `<div class="btn-row">` +
        `<button type="button" class="btn sm" data-all>${showAll ? '只看精选' : '全部 ' + allSources.length + ' 源'}</button>` +
        packPickBtnHtml(on, packSelectMode) +
      `</div>` +
    `</div><div class="expand-body src-acc-list dense"></div>`;
  box.querySelector('[data-all]').addEventListener('click', () => {
    if (showAll) packSrcShowAll.delete(key);
    else packSrcShowAll.add(key);
    opts.redraw();
  });
  box.querySelector('[data-join]').addEventListener('click', () => {
    applyPackPick(key, on, opts);
  });

  const body = box.querySelector('.expand-body');
  rows.forEach((s) => {
    const items = previewItemsForSource(s.name, key, taggedPool, byPub, 4);
    const active = on && picked.indexOf(s.name) >= 0;
    const expanded = openSet.has(s.name);
    const row = document.createElement('div');
    row.className = 'src-acc' + (expanded ? ' open' : '') + (active ? ' on' : '') + (on ? '' : ' dim');

    const bar = document.createElement('div');
    bar.className = 'src-acc-h';

    const detail = document.createElement('div');
    detail.className = 'src-acc-body';
    detail.hidden = !expanded;
    if (!items.length) {
      detail.innerHTML = '<div class="empty-s">共享池暂无该源标题</div>';
    } else {
      items.forEach((it) => detail.appendChild(makeGranuleButton(it, key, name)));
    }

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'src-acc-expand' + (items.length ? '' : ' empty');
    expandBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    expandBtn.title = expanded ? '收起预览' : '展开预览标题';
    const peek = items[0] ? displayTitle(items[0]) : '暂无预览';
    const badge = curatedNames.has(s.name) ? '' : '<span class="src-badge">扩</span>';
    expandBtn.innerHTML =
      `<span class="src-acc-caret" aria-hidden="true"></span>` +
      faviconForDomain(s.domain, s.name) +
      `<span class="src-acc-main">` +
        `<span class="src-name">${esc(s.name)}${badge}</span>` +
        `<span class="src-acc-peek">${esc(peek)}</span>` +
      `</span>` +
      `<span class="src-acc-n">${items.length}</span>`;
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openSet.has(s.name)) openSet.delete(s.name);
      else openSet.add(s.name);
      const nowOpen = openSet.has(s.name);
      row.classList.toggle('open', nowOpen);
      expandBtn.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      expandBtn.title = nowOpen ? '收起预览' : '展开预览标题';
      detail.hidden = !nowOpen;
    });

    const pickSrc = document.createElement('button');
    pickSrc.type = 'button';
    pickSrc.className = 'src-acc-pick' + (active ? ' on' : '');
    pickSrc.setAttribute('aria-pressed', active ? 'true' : 'false');
    pickSrc.title = active ? '取消勾选此源' : '勾选此源';
    pickSrc.textContent = active ? '✓' : '+';
    pickSrc.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onToggleSource(key, s.name, on);
    });

    bar.appendChild(expandBtn);
    bar.appendChild(pickSrc);
    row.appendChild(bar);
    row.appendChild(detail);
    body.appendChild(row);
  });
  return box;
}

function packPickBtnHtml(on, mode) {
  const single = mode === 'single';
  const lab = on ? (single ? '选用中' : '已选') : (single ? '选用' : '多选+');
  const title = on
    ? (single ? '取消选用' : '移出方案')
    : (single ? '单选选用（替换当前方案）' : '加入方案');
  return (
    `<button type="button" class="pack-pick ${single ? 'single' : 'multi'}${on ? ' on' : ''}" data-join` +
      ` aria-pressed="${on ? 'true' : 'false'}" title="${title}">` +
      `<span class="pack-pick-ico" aria-hidden="true"></span>` +
      `<span class="pack-pick-lab">${lab}</span>` +
    `</button>`
  );
}

/** 单选：整案替换为该包；多选：加减 toggling */
function applyPackPick(key, currentlyOn, { selectedPackKeys, onToggle, onSetKeys }) {
  if (packSelectMode === 'single' && !currentlyOn) {
    if (typeof onSetKeys === 'function') {
      onSetKeys([key]);
      return;
    }
  }
  onToggle(key, currentlyOn);
}

function drawPackPickerB({ railId, gridId, heroId, ctaId, selectedPackKeys, onToggle, onToggleSource, onSetKeys, redraw }) {
  const grid = $(gridId);
  const rail = $(railId);
  const hero = $(heroId);
  // 无 B 壳（自测页只有 grid）→ 回落旧卡片
  if (!grid || !rail) return false;
  const packsAll = listPacks();
  if (dirFilter === '全部' || !DIRECTORIES.some((d) => d.key === dirFilter)) {
    dirFilter = (DIRECTORIES[0] && DIRECTORIES[0].key) || '社区';
  }
  drawPackRailB(rail, packsAll, redraw);
  renderSelHeroB(hero, selectedPackKeys, {
    redraw,
    onRemove: (key) => onToggle(key, true),
    onJump: (p) => {
      dirFilter = p.group_name || dirFilter;
      openPackKey = p.key;
    },
  });

  grid.innerHTML = '';
  const packs = packsInDir(packsAll);
  if (!packs.length) {
    grid.innerHTML = '<div class="empty card">该栏目下暂无内容包。</div>';
  } else {
    if (!openPackKey || !packs.some((p) => p.key === openPackKey)) {
      openPackKey = packs.length === 1 ? packs[0].key : openPackKey;
    }
    const group = document.createElement('section');
    group.className = 'group';
    group.innerHTML =
      `<div class="subhead">` +
        `<div class="subhead-l"><h3>${esc(dirFilter)}</h3><span>${packs.length} 个内容包</span></div>` +
        `<div class="pack-mode" role="group" aria-label="方案选择方式">` +
          `<button type="button" class="pack-mode-btn${packSelectMode === 'single' ? ' on' : ''}" data-mode="single">单选</button>` +
          `<button type="button" class="pack-mode-btn${packSelectMode === 'multi' ? ' on' : ''}" data-mode="multi">多选</button>` +
        `</div>` +
      `</div>` +
      `<div class="pack-grid"></div>`;
    group.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = btn.getAttribute('data-mode');
        if (!m || m === packSelectMode) return;
        packSelectMode = m;
        redraw();
      });
    });
    const pg = group.querySelector('.pack-grid');
    const byPub = indexPoolByPublisher();
    const pickOpts = { selectedPackKeys, onToggle, onSetKeys, onToggleSource, redraw, byPub };
    let openedPack = null;
    packs.forEach((p) => {
      try {
        const name = String(p.name || p.key);
        const on = selectedPackKeys.indexOf(p.key) >= 0;
        const opened = openPackKey === p.key;
        const curated = curatedSourcesForTag(p.key);
        const taggedN = countForTag(p.key);
        const poolN = packPoolCount(p.key, byPub);
        const showN = taggedN || poolN;
        const card = document.createElement('div');
        card.className = 'tag-card rich pack-b-card' + (on ? ' selected' : '') + (opened ? ' open' : '');
        card.dataset.tagKey = p.key;
        card.innerHTML =
          `<div class="pack-b-body">` +
            `<div class="pack-b-top">` +
              `<div class="tag-mark ${markClass(p.key)}">${esc(name.slice(0, 1))}</div>` +
              `<div class="pack-b-acts">` +
                `<span class="pack-b-peek${opened ? ' on' : ''}" title="${opened ? '正在预览' : '点卡片预览'}" aria-hidden="true"></span>` +
                packPickBtnHtml(on, packSelectMode) +
              `</div>` +
            `</div>` +
            `<div class="pack-b-name">${esc(name)}</div>` +
            `<div class="tag-meta">${showN} 条 · ${curated.length} 源` +
              `<span class="pack-b-hint">${opened ? '预览中' : '点卡预览'}</span></div>` +
            `<div class="src-strip">${curated.slice(0, 5).map((s) => faviconForDomain(s.domain, s.name)).join('')}` +
              (curated.length > 5 ? `<span class="more">+${curated.length - 5}</span>` : '') +
            `</div>` +
          `</div>`;
        const joinBtn = card.querySelector('[data-join]');
        joinBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          applyPackPick(p.key, on, pickOpts);
        });
        card.addEventListener('click', () => {
          openPackKey = opened ? null : p.key;
          redraw();
        });
        pg.appendChild(card);
        if (opened) openedPack = { ...p, name, selected: on };
      } catch (err) {
        const el = document.createElement('div');
        el.className = 'empty card';
        el.textContent = '内容包加载失败：' + ((err && err.message) || err);
        pg.appendChild(el);
      }
    });
    // 小卡片横排保留；手风琴铺满下一行
    if (openedPack) {
      const expand = renderPackExpandB(openedPack, pickOpts);
      expand.classList.add('pack-expand-wide');
      group.appendChild(expand);
    }
    grid.appendChild(group);
  }

  const cta = ctaId ? $(ctaId) : null;
  if (cta) {
    const p = openPackKey ? packsAll.find((x) => x.key === openPackKey) : null;
    if (!p) {
      cta.innerHTML =
        `<div>点卡片预览；用「选用」入库。当前 <b>${packSelectMode === 'single' ? '单选' : '多选'}</b> · 已选 <b>${selectedPackKeys.length}</b></div>`;
    } else {
      const on = selectedPackKeys.indexOf(p.key) >= 0;
      cta.innerHTML =
        `<div>预览 <b>${esc(p.name || p.key)}</b> · 子源 <b>${selectedSourcesFor(p.key).length}</b> / ${sourcesForTag(p.key).length}</div>` +
        packPickBtnHtml(on, packSelectMode).replace('data-join', 'data-cta-join');
      const bj = cta.querySelector('[data-cta-join]');
      if (bj) bj.addEventListener('click', () => applyPackPick(p.key, on, { selectedPackKeys, onToggle, onSetKeys }));
    }
  }
  return true;
}

/* ── 内容包（已有平台时调整；无平台也先画出目录，避免空白页） ── */
function drawTags() {
  drawFormatChips();
  const grid = $('#tagGrid');
  if (!grid || !db) return;
  if (db.tag_packs) seedTagPacks(db);
  if (platform) hydrateDraftSourcesFromColumns();
  setPoolHints();

  const onToggle = (key, on) => {
    if (!platform) {
      toast('请先完成搭站');
      showView('onboard');
      return;
    }
    // on=true 表示当前已加入、即将移出；即将加入时必须有云端 uuid
    if (!on) {
      const cloud = db.tag_packs && db.tag_packs[key];
      if (!cloud || !cloud.id) {
        const label = (listPacks().find((p) => p.key === key) || {}).name || key;
        toast('「' + label + '」尚未同步到云端，请刷新后重试；仍没有则跑 repair-shared-pool');
        return;
      }
    }
    const next = togglePackKey(selectedKeys, key, on);
    if (!next.length) { toast('至少保留一个栏目'); return; }
    if (on) delete draftSources[key];
    else draftSources[key] = defaultSourceNames(key);
    selectedKeys = next;
    const sourceSelections = {};
    for (const k of selectedKeys) sourceSelections[k] = selectedSourcesFor(k);
    setPlatformTagPacks(db, { platformId: platform.id, tagKeys: selectedKeys, sourceSelections });
    buildCandidates(db, { platformId: platform.id, date: DATE });
    // 转发候选仍自动打底；今日阅读已改走共享池汇总，不依赖放行条数
    reviewCandidates(db, { platformId: platform.id, date: DATE, auto: true, autoPerColumn: 12 });
    const pack = listPacks().find((p) => p.key === key);
    commit('已更新栏目：' + ((pack && pack.name) || key));
  };
  const onSetKeys = (keys) => {
    if (!platform) {
      toast('请先完成搭站');
      showView('onboard');
      return;
    }
    const next = [...new Set((keys || []).map((k) => String(k || '').trim()).filter(Boolean))];
    if (!next.length) { toast('至少保留一个栏目'); return; }
    for (const k of next) {
      if (selectedKeys.includes(k)) continue;
      const cloud = db.tag_packs && db.tag_packs[k];
      if (!cloud || !cloud.id) {
        const label = (listPacks().find((p) => p.key === k) || {}).name || k;
        toast('「' + label + '」尚未同步到云端，请刷新后重试；仍没有则跑 repair-shared-pool');
        return;
      }
    }
    const keep = new Set(next);
    Object.keys(draftSources).forEach((k) => { if (!keep.has(k)) delete draftSources[k]; });
    next.forEach((k) => {
      if (!draftSources[k]) draftSources[k] = defaultSourceNames(k);
    });
    selectedKeys = next;
    const sourceSelections = {};
    for (const k of selectedKeys) sourceSelections[k] = selectedSourcesFor(k);
    setPlatformTagPacks(db, { platformId: platform.id, tagKeys: selectedKeys, sourceSelections });
    buildCandidates(db, { platformId: platform.id, date: DATE });
    reviewCandidates(db, { platformId: platform.id, date: DATE, auto: true, autoPerColumn: 12 });
    commit('已更新方案：' + selectedKeys.length + ' 个栏目');
  };
  const onToggleSource = (key, sourceName, packOn) => {
    if (!platform) {
      toast('请先完成搭站');
      showView('onboard');
      return;
    }
    let keys = selectedKeys.slice();
    if (!packOn) {
      keys = togglePackKey(keys, key, false);
      draftSources[key] = [sourceName];
    } else {
      const r = toggleSourceName(key, sourceName);
      if (r && r.dropPack) keys = keys.filter((k) => k !== key);
    }
    if (!keys.length) { toast('至少保留一个栏目'); return; }
    selectedKeys = keys;
    const sourceSelections = {};
    for (const k of selectedKeys) sourceSelections[k] = selectedSourcesFor(k);
    setPlatformTagPacks(db, { platformId: platform.id, tagKeys: selectedKeys, sourceSelections });
    buildCandidates(db, { platformId: platform.id, date: DATE });
    reviewCandidates(db, { platformId: platform.id, date: DATE, auto: true, autoPerColumn: 12 });
    commit('已更新来源：' + sourceName);
  };

  const usedB = drawPackPickerB({
    railId: '#tagRail',
    gridId: '#tagGrid',
    heroId: '#tagSelHero',
    ctaId: '#tagCta',
    selectedPackKeys: selectedKeys,
    onToggle,
    onSetKeys,
    onToggleSource,
    redraw: drawTags,
  });
  if (!usedB) {
    // 自测页等无 B 壳：回落旧卡片栅格
    drawDirTabs('#tagDirs', drawTags);
    grid.innerHTML = '';
    packsInDir(listPacks()).forEach((p) => {
      grid.appendChild(renderTagCard({ ...p, name: String(p.name || p.key) }, {
        selected: selectedKeys.indexOf(p.key) >= 0,
        onToggle,
        onToggleSource,
      }));
    });
  }
  const chosen = $('#tagChosen');
  if (chosen) chosen.textContent = String(selectedKeys.length);
}

/* ── 栏目顺序（并入今日转发左侧）── */
function moveColumn(i, d, cols) {
  const j = i + d;
  if (j < 0 || j >= cols.length) return;
  const keys = cols.map((c) => c.key);
  const x = keys[i]; keys[i] = keys[j]; keys[j] = x;
  reorderColumns(db, { platformId: platform.id, keys });
  commit('栏目顺序已更新');
}

/* ── 审稿台 ── */
let candFilter = 'all';
let candColumn = 'all';
let selectedCandId = null;

function todayCands() {
  if (!platform) return [];
  return Object.values(db.candidate_entries)
    .filter((e) => e.platform_id === platform.id && e.issue_date === DATE);
}

function decideCand(id, action) {
  reviewCandidates(db, {
    platformId: platform.id,
    date: DATE,
    decisions: [{ candidateId: id, action }],
  });
  selectedCandId = id;
  commit('已' + ({ approve: '选用', pin: '置顶', reject: '跳过' }[action] || action));
}

function drawReviewDirs() {
  const box = $('#reviewDirs');
  if (!box || !platform) return;
  const cols = Object.values(db.platform_columns)
    .filter((c) => c.platform_id === platform.id)
    .sort((a, b) => a.position - b.position);
  const all = todayCands();
  const countOf = (colId) => all.filter((e) => e.column_id === colId).length;
  box.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = '栏目';
  box.appendChild(h);
  const hint = document.createElement('div');
  hint.className = 'review-col-hint';
  hint.textContent = '↑↓ 调顺序 · 点名称筛选';
  box.appendChild(hint);

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'dir-item' + (candColumn === 'all' ? ' active' : '');
  allBtn.innerHTML = `<span>全部栏目</span><span class="dir-n">${all.length}</span>`;
  allBtn.addEventListener('click', () => {
    candColumn = 'all';
    drawReviewDirs();
    drawCands();
  });
  box.appendChild(allBtn);

  cols.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'dir-row' + (candColumn === c.id ? ' active' : '');
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'dir-item grow';
    pick.innerHTML = `<span>${esc(c.name)}</span><span class="dir-n">${countOf(c.id)}</span>`;
    pick.addEventListener('click', () => {
      candColumn = c.id;
      drawReviewDirs();
      drawCands();
    });
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'dir-mv';
    up.textContent = '↑';
    up.disabled = i === 0;
    up.title = '上移';
    up.addEventListener('click', (e) => { e.stopPropagation(); moveColumn(i, -1, cols); });
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'dir-mv';
    down.textContent = '↓';
    down.disabled = i === cols.length - 1;
    down.title = '下移';
    down.addEventListener('click', (e) => { e.stopPropagation(); moveColumn(i, 1, cols); });
    row.appendChild(pick);
    row.appendChild(up);
    row.appendChild(down);
    box.appendChild(row);
  });
}

function drawCandPreview() {
  const box = $('#candPreview');
  if (!box) return;
  const e = selectedCandId ? db.candidate_entries[selectedCandId] : null;
  const item = e && db.content_items[e.content_item_id];
  if (!e || !item) {
    box.innerHTML = '<div class="empty">点中间一条，查看摘要与原文</div>';
    return;
  }
  const col = db.platform_columns[e.column_id];
  const href = safeHref(item.canonical_url) || '';
  const summary = (item.summary || '').trim();
  const sumText = summary && !isGarbledText(summary) ? summary : '（无摘要，请打开原文查看）';
  const thumb = thumbUrl(item);
  box.innerHTML =
    (thumb ? `<div class="pv-cover"><img src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>` : '') +
    `<div class="pv-title">${esc(displayTitle(item))}</div>` +
    `<div class="pv-meta"><span>${esc(statusCn(e.status))}</span>` +
    `<span>栏目 ${esc(col ? col.name : '—')}</span>` +
    `<span>来源 ${esc(hostOf(item.canonical_url) || '主源')}</span>` +
    `<span class="score">评分 ${e.score}</span></div>` +
    `<p class="pv-summary">${esc(sumText)}</p>` +
    `<div class="pv-ops">` +
    (href ? `<a class="btn sm primary" href="${esc(href)}" target="_blank" rel="noopener noreferrer">打开原文</a>` : '') +
    `<button type="button" class="btn sm" data-open-granule="1">大图预览</button>` +
    `<button type="button" class="btn sm accent" data-op="approve">选用</button>` +
    `<button type="button" class="btn sm" data-op="pin">置顶</button>` +
    `<button type="button" class="btn sm danger" data-op="reject">跳过</button>` +
    `</div>` +
    (e.ai_reason ? `<div class="reason" style="margin-top:10px">AI：${esc(e.ai_reason)}</div>` : '');
  box.querySelectorAll('[data-op]').forEach((b) => {
    b.addEventListener('click', () => decideCand(e.id, b.dataset.op));
  });
  const openG = box.querySelector('[data-open-granule]');
  if (openG) openG.addEventListener('click', () => openGranule(item));
}

function drawCands() {
  const searchEl = $('#candSearch');
  const kw = ((searchEl && searchEl.value) || '').trim().toLowerCase();
  const list = $('#candList');
  if (!list || !platform) return;
  drawReviewDirs();
  list.innerHTML = '';
  const cands = todayCands();
  const shown = cands.filter((e) => {
    if (candColumn !== 'all' && e.column_id !== candColumn) return false;
    if (candFilter !== 'all' && e.status !== candFilter) return false;
    const item = db.content_items[e.content_item_id];
    if (!item) return false;
    if (kw && (item.title + (item.summary || '') + hostOf(item.canonical_url)).toLowerCase().indexOf(kw) < 0) return false;
    return true;
  }).sort((a, b) => b.score - a.score);
  if (!shown.length) {
    list.innerHTML = '<div class="empty card">没有符合条件的候选。</div>';
  }
  if (selectedCandId && !shown.some((e) => e.id === selectedCandId)) {
    selectedCandId = shown.length ? shown[0].id : null;
  } else if (!selectedCandId && shown.length) {
    selectedCandId = shown[0].id;
  }
  shown.forEach((e) => {
    const item = db.content_items[e.content_item_id];
    const col = db.platform_columns[e.column_id];
    const snip = (item.summary || '').trim();
    const thumb = thumbUrl(item);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cand ' + e.status + (e.id === selectedCandId ? ' selected' : '');
    el.innerHTML =
      `<div class="cand-row">` +
      (thumb
        ? `<img class="cand-thumb" src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : '<span class="cand-thumb ph"></span>') +
      `<div class="cand-main"><div class="cand-title">${esc(displayTitle(item))}</div>` +
      `<div class="cand-meta"><span class="score">评分 ${e.score}</span>` +
      `<span>${esc(hostOf(item.canonical_url) || '主源')}</span>` +
      `<span>${esc(col ? col.name : '—')}</span>` +
      `<span>${esc(statusCn(e.status))}</span></div>` +
      (snip && !isGarbledText(snip) ? `<div class="cand-snip">${esc(snip)}</div>` : '') +
      `</div></div>`;
    el.addEventListener('click', () => {
      selectedCandId = e.id;
      drawCands();
    });
    list.appendChild(el);
  });
  drawCandPreview();
  const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v); };
  set('#rvTotal', cands.length);
  set('#rvApproved', cands.filter((e) => e.status === 'approved' || e.status === 'pinned').length);
  set('#rvRejected', cands.filter((e) => e.status === 'rejected').length);
  set('#rvPinned', cands.filter((e) => e.status === 'pinned').length);
}

/* ── 侧栏今日摘要 ── */
function drawSide() {
  const s = todayStats();
  const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v); };
  set('#sideCols', s.cols);
  set('#sideCands', s.cands);
  set('#sidePending', s.pending);
  set('#sideApproved', digest && Number.isFinite(digest.total) ? digest.total : s.approved);
  const navBadge = $('#navReviewBadge');
  if (navBadge) {
    if (s.pending > 0) {
      navBadge.hidden = false;
      navBadge.textContent = String(s.pending);
    } else {
      navBadge.hidden = true;
    }
  }
}

/* ── 日报预览：真 digest → 真渲染内核 ── */
function todayShareUrl() {
  if (digest && digest.issueUrl) return digest.issueUrl;
  if (platform && platform.slug) {
    return String(SITE || '').replace(/\/+$/, '') + '/p/' + platform.slug + '/' + DATE + '/';
  }
  return typeof location !== 'undefined' ? String(location.href).split('#')[0] : '';
}

async function copyTodayShare() {
  const url = todayShareUrl();
  if (!url) {
    toast('暂无今日链接');
    return;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('已复制今日链接 · 发朋友圈/微信群请自行粘贴（微信无法代发）');
  } catch {
    toast('复制失败：' + url);
  }
}

function persistFormats(next) {
  selectedFormats = Array.isArray(next) ? next.slice() : [];
  try {
    localStorage.setItem('portal.formats', JSON.stringify(selectedFormats));
  } catch { /* ignore quota */ }
}

function drawFormatChips() {
  const box = $('#tagFormatChips');
  if (!box) return;
  box.innerHTML = '';
  FORMAT_OPTIONS.forEach((f) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'src-chip cat-chip' + (selectedFormats.indexOf(f.key) >= 0 ? ' active' : '');
    b.textContent = f.label;
    b.dataset.format = f.key;
    b.addEventListener('click', () => {
      const i = selectedFormats.indexOf(f.key);
      if (i >= 0) selectedFormats.splice(i, 1);
      else selectedFormats.push(f.key);
      persistFormats(selectedFormats);
      drawFormatChips();
      drawTags();
    });
    box.appendChild(b);
  });
}

function drawDigest() {
  if (!digest) return;
  $('#readerSummary').textContent = digest.summary || '—';
  renderInoReader($('#readerRoot'), digest, {
    fulltextEndpoint: FULLTEXT_ENDPOINT,
    shareUrl: todayShareUrl(),
    onCopyShare: copyTodayShare,
    onForward: function () { showView('review'); },
    formats: selectedFormats.slice(),
    onFormatsChange: function (next) {
      persistFormats(next);
      drawFormatChips();
    },
  });
}

/* ── 一次性事件绑定 ── */
$$('[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$$('[data-filter]').forEach((b) => b.addEventListener('click', () => {
  candFilter = b.dataset.filter;
  $$('[data-filter]').forEach((x) => x.classList.toggle('active', x === b));
  drawCands();
}));
$('#candSearch').addEventListener('input', drawCands);
const onboardBtn = $('#onboardConfirm');
if (onboardBtn) onboardBtn.addEventListener('click', () => { confirmOnboard(); });
$('#autoReview').addEventListener('click', () => {
  if (!platform) return;
  reviewCandidates(db, { platformId: platform.id, date: DATE, auto: true, autoPerColumn: 12 });
  commit('智能挑选完成：每栏目选用前 12 条（供转发/发布）');
});
$('#publishBtn').addEventListener('click', () => {
  if (!platform) return;
  try {
    const out = publishIssue(db, { platformId: platform.id, date: DATE, siteUrl: SITE });
    toast('已发布今日页：' + out.issue.public_url);
  } catch (e) {
    // 幂等保护：同一期已发布时 digest 仍可实时预览，这里如实提示
    toast(e.message);
  }
  commit();
});
$('#resetReview').addEventListener('click', () => {
  if (!platform) return;
  Object.values(db.candidate_entries)
    .filter((e) => e.platform_id === platform.id)
    .forEach((e) => { e.status = CANDIDATE_STATUS.PENDING; });
  commit('挑选已重置');
});
$('#reRender').addEventListener('click', (e) => { e.preventDefault(); drawDigest(); toast('已刷新'); });

/** 硬超时：fetch abort 偶发不生效时，仍让 boot 前进 */
function withDeadline(promise, ms, label = 'timeout') {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(label)), ms);
    }),
  ]);
}

/* ── 启动：轻探后端可达性，再处理邮件回调 / 恢复会话，否则停在登录页 ── */
async function boot() {
  bindHashRouting();
  paintAuth();

  // 不要在 boot 里 await 整池分页（content_items/tags 可拖到分钟级）。
  // 先用单次轻探判定可达；整池后台预热，登录/演示再按需 load。
  const probe = createClient({
    url: SB_CONFIG.url,
    key: SB_CONFIG.key,
    schema: SB_CONFIG.schema,
    timeout: 4000,
  });
  try {
    await withDeadline(
      probe.select('tag_packs', {
        columns: 'key',
        limit: 1,
        filters: [{ col: 'status', op: 'eq', value: 'active' }],
      }),
      5000,
      'probe timeout',
    );
    authState.backendOk = true;
    paintAuth();
    sharedPoolWarm = loadSharedPool(probe).then((pool) => {
      sharedPoolCache = pool;
      return pool;
    }).catch(() => null);
  } catch {
    sharedPoolCache = null;
    sharedPoolWarm = null;
    authState.backendOk = false;
    paintAuth();
  }

  // 邮件确认 / 重置密码回调：#access_token=…&type=recovery|signup
  const hashSess = parseAuthHash(location.hash);
  if (hashSess && authState.backendOk) {
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch { /* ignore */ }
    saveSession(hashSess);
    ensureClient(hashSess.access_token);
    if (hashSess.type === 'recovery') {
      authState.status = 'signedIn';
      authState.mode = 'reset';
      authState.busy = false;
      authState.notice = '请设置新密码以完成找回。';
      paintAuth();
      return;
    }
    // signup / magiclink / 其它：直接进云端
    if (await restoreFromSession(hashSess)) return;
  }

  const session = loadSession();
  if (session && authState.backendOk) {
    if (await restoreFromSession(session)) return;
  }

  authState.status = 'signedOut';
  authState.busy = false;
  paintAuth();
}

boot();
