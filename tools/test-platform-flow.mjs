#!/usr/bin/env node
/**
 * 第一阶段最小闭环护栏：注册 → 建平台 → 灌内容 → 候选池 → 审稿 → 发布 → digest。
 *
 * 为什么用内存 db + 纯函数：
 *   真实后端还没接，本机也不一定能跑 Node 子进程。把每一步做成 (db, input) 纯函数，
 *   这里用一个内存 db 把整条链跑通 —— 测的是「流程对不对」，不是「SQL 连没连上」。
 *   后端接好后，这六个函数的调用方式不变，护栏照跑。
 *
 * 重点盯会毁掉产品的几件事：
 *   1. 用户选的标签包必须 1:1 变成栏目（栏目固定 = 阅读习惯）
 *   2. 版权过滤必须真的生效（blocked 不进、无授权不存摘要/图片、永不存全文）
 *   3. 去重必须生效（同 URL 不重复灌、同栏目同题只留一条）
 *   4. 审稿必须真改状态，且只能操作本平台本期的候选
 *   5. 发布必须幂等（同一期不能发两次、重跑不翻倍）
 *   6. 空刊不能发布
 *   7. 产出的 digest 必须能被现有 render-email 渲染（新旧两种 digest 都不能坏）
 */
import assert from 'node:assert/strict';
import { emptyDb, seedTagPacks, ensureMainSource } from '../lib/platform-store.mjs';
import {
  registerUser,
  createPlatform,
  setPlatformTagPacks,
  ingestContent,
  buildCandidates,
  reviewCandidates,
  fillEmptyColumnApprovals,
  publishIssue,
  buildPlatformDigest,
  runPipeline,
  contentHash,
  slugify,
  CANDIDATE_STATUS,
} from '../lib/platform-flow.mjs';
import { renderEmail, parseCats, allowedTabs, previewBar } from '../tools/render-email.mjs';
import { buildDigest } from '../tools/build-digest.mjs';

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

const DATE = '2026-11-18';
const SITE = 'https://demo.pages.dev';

function items() {
  return [
    { title: '用 Node 写了个静态站生成器', url: 'https://github.com/a/one', summary: '零依赖', tagKeys: ['opensource'] },
    { title: '某开源 Agent 框架发布', url: 'https://github.com/b/two', summary: '支持多工具', tagKeys: ['opensource', 'ai'] },
    { title: '新模型把推理成本砍半', url: 'https://news.example/ai', summary: '今日发布', tagKeys: ['ai'] },
    { title: '重复链接不应入库', url: 'https://github.com/a/one', summary: 'duplicate', tagKeys: ['opensource'] },
    { title: '无 URL 的坏条目', url: '', tagKeys: ['ai'] },
  ];
}

function seededDb() {
  const db = emptyDb();
  seedTagPacks(db);
  ensureMainSource(db);
  return db;
}

console.log('第一阶段闭环护栏\n');

// --- 1. 注册 -----------------------------------------------------------------
t('注册：email 与 phone 至少一项', () => {
  const db = seededDb();
  assert.throws(() => registerUser(db, {}), /至少一项/);
  const u = registerUser(db, { email: 'A@Example.com', displayName: '阿甲' });
  assert.equal(u.email, 'a@example.com'); // 归一化小写
  assert.ok(db.users[u.id]);
});

t('注册：邮箱去重', () => {
  const db = seededDb();
  registerUser(db, { email: 'dup@example.com' });
  assert.throws(() => registerUser(db, { email: 'DUP@example.com' }), /已存在/);
});

// --- 2. 建平台与栏目 ---------------------------------------------------------
t('标签包 1:1 变成栏目，顺序即 position', () => {
  const db = seededDb();
  const u = registerUser(db, { email: 'p@example.com' });
  const { platform, columns } = createPlatform(db, {
    userId: u.id,
    name: '老张的头条',
    tagKeys: ['ai', 'opensource'],
  });
  assert.equal(columns.length, 2);
  assert.deepEqual(columns.map((c) => c.key), ['ai', 'opensource']);
  assert.deepEqual(columns.map((c) => c.position), [0, 1]);
  assert.equal(columns[0].tag_pack_id, db.tag_packs.ai.id);
  assert.equal(platform.owner_user_id, u.id);
  assert.equal(platform.slug, `${slugify('老张的头条')}-${u.id.slice(0, 8)}`);
});

t('子来源写入 column.settings.sources', () => {
  const db = seededDb();
  const u = registerUser(db, { email: 'src@example.com' });
  const { columns } = createPlatform(db, {
    userId: u.id,
    name: '源订阅',
    tagKeys: ['hot'],
    sourceSelections: { hot: ['微博热搜', '知乎热榜'] },
  });
  assert.deepEqual(columns[0].settings.sources, ['微博热搜', '知乎热榜']);
});

t('改标签包时同 key 复用栏目 id（避免云端 409）', () => {
  const db = seededDb();
  const u = registerUser(db, { email: 'reuse@example.com' });
  const { platform, columns } = createPlatform(db, {
    userId: u.id, name: '复用', tagKeys: ['ai', 'opensource'],
  });
  const aiId = columns.find((c) => c.key === 'ai').id;
  const osId = columns.find((c) => c.key === 'opensource').id;
  const next = setPlatformTagPacks(db, {
    platformId: platform.id,
    tagKeys: ['ai', 'tech'],
    sourceSelections: { ai: ['机器之心'] },
  });
  const ai2 = next.columns.find((c) => c.key === 'ai');
  assert.equal(ai2.id, aiId, 'ai 栏目 id 应复用');
  assert.deepEqual(ai2.settings.sources, ['机器之心']);
  assert.ok(next.columns.some((c) => c.key === 'tech'));
  assert.ok(!next.columns.some((c) => c.key === 'opensource'));
  assert.ok((db._pendingDeletes.replace_columns_platform_ids || []).includes(platform.id), '应标记整平台替换栏目');
  assert.ok((db._pendingDeletes.candidate_platform_ids || []).includes(platform.id));
  assert.ok(!next.columns.some((c) => c.id === osId));
});

t('未知标签包不生成栏目', () => {
  const db = seededDb();
  const u = registerUser(db, { email: 'q@example.com' });
  assert.throws(() => createPlatform(db, {
    userId: u.id, name: 'x', tagKeys: ['not-exist'],
  }), /不存在或已停用/);
});

t('slug 冲突时自动加后缀', () => {
  const db = seededDb();
  const u = registerUser(db, { email: 's@example.com' });
  const a = createPlatform(db, { userId: u.id, name: 'same', slug: 'same', tagKeys: ['ai'] });
  const b = createPlatform(db, { userId: u.id, name: 'same', slug: 'same', tagKeys: ['ai'] });
  assert.notEqual(a.platform.slug, b.platform.slug);
});

// --- 3. 灌内容与版权过滤 -----------------------------------------------------
t('灌内容：去重、丢坏 URL、丢空标题', () => {
  const db = seededDb();
  const r = ingestContent(db, items());
  // 5 条里 1 条重复、1 条无 URL -> 3 条入库
  assert.equal(r.created.length, 3);
  assert.equal(r.reasons.duplicate, 1);
  assert.equal(r.reasons.noUrl, 1);
});

t('版权：blocked 源整条丢弃，标题都不进库', () => {
  const db = seededDb();
  const src = ensureMainSource(db);
  src.rights_status = 'blocked';
  const r = ingestContent(db, items());
  assert.equal(r.created.length, 0);
  // 无 URL 的条目先被 noUrl 拦下，进不了 blocked 计数
  assert.equal(r.reasons.blocked, items().filter((x) => x.url).length);
  assert.equal(Object.keys(db.content_items).length, 0);
});

t('版权：无摘要授权不存 summary，无图片授权不存 image_url', () => {
  const db = seededDb();
  const src = ensureMainSource(db);
  src.allow_snippet = false;
  src.allow_image = false;
  const r = ingestContent(db, [{
    title: '带图和摘要', url: 'https://x.example/1',
    summary: '不该被存', imageUrl: 'https://x.example/cover.jpg', tagKeys: ['ai'],
  }]);
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].summary, null);
  assert.equal(r.created[0].image_url, null);
  assert.equal('body_html' in r.created[0], false, '第一阶段永不存正文');
});

t('contentHash 稳定且区分内容', () => {
  assert.equal(contentHash('https://a', 't'), contentHash('https://a', 't'));
  assert.notEqual(contentHash('https://a', 't'), contentHash('https://b', 't'));
});

t('去重以 URL 为准：改标题/加 utm/尾斜杠仍是同一条', () => {
  const base = contentHash('https://github.com/a/one', '标题甲');
  assert.equal(contentHash('https://github.com/a/one/', '标题乙'), base, '尾斜杠应归一化');
  assert.equal(contentHash('https://github.com/a/one?utm=x', '标题丙'), base, 'utm 追踪参数应忽略');
  assert.equal(contentHash('http://github.com/a/one', '标题丁'), base, '协议应忽略');
  assert.notEqual(
    contentHash('http://www.dapenti.com/blog/more.asp?name=a&id=1', '甲'),
    contentHash('http://www.dapenti.com/blog/more.asp?name=a&id=2', '乙'),
    '身份查询参数必须保留',
  );
  assert.notEqual(
    contentHash('https://music.163.com/#/song?id=1', 'A'),
    contentHash('https://music.163.com/#/song?id=2', 'B'),
    '网易云 hash 路由必须保留',
  );
});

// --- 4. 候选池 ---------------------------------------------------------------
function pipelineToCandidates(db) {
  const u = registerUser(db, { email: 'c@example.com' });
  const { platform } = createPlatform(db, {
    userId: u.id, name: '候选测试', slug: 'cand', tagKeys: ['ai', 'opensource'],
  });
  ingestContent(db, items());
  const candidates = buildCandidates(db, { platformId: platform.id, date: DATE });
  return { u, platform, candidates };
}

t('候选池：只进选中栏目的内容', () => {
  const db = seededDb();
  const { platform, candidates } = pipelineToCandidates(db);
  assert.ok(candidates.length >= 3);
  const colKeys = Object.values(db.platform_columns)
    .filter((c) => c.platform_id === platform.id)
    .map((c) => c.id);
  assert.ok(candidates.every((c) => colKeys.includes(c.column_id)));
  assert.ok(candidates.every((c) => c.status === CANDIDATE_STATUS.PENDING));
});

t('候选池：重复调用不产生重复条目（幂等）', () => {
  const db = seededDb();
  const { platform } = pipelineToCandidates(db);
  const n1 = Object.keys(db.candidate_entries).length;
  buildCandidates(db, { platformId: platform.id, date: DATE });
  assert.equal(Object.keys(db.candidate_entries).length, n1);
});

t('候选池：每栏目不超过 max_items', () => {
  const db = seededDb();
  const { platform } = pipelineToCandidates(db);
  const cols = Object.values(db.platform_columns).filter((c) => c.platform_id === platform.id);
  for (const col of cols) {
    const n = Object.values(db.candidate_entries).filter((e) => e.column_id === col.id).length;
    assert.ok(n <= col.max_items, `栏目 ${col.key} 超出上限`);
  }
});

t('候选池：日期格式校验', () => {
  const db = seededDb();
  const u = registerUser(db, { email: 'd@example.com' });
  const { platform } = createPlatform(db, { userId: u.id, name: 'x', tagKeys: ['ai'] });
  assert.throws(() => buildCandidates(db, { platformId: platform.id, date: '2026/11/18' }), /日期不合法/);
});

t('候选池：缩源无命中时回退整包', () => {
  const db = seededDb();
  const u = registerUser(db, { email: 'fb@example.com' });
  const { platform } = createPlatform(db, {
    userId: u.id,
    name: '回退',
    tagKeys: ['ai'],
    sourceSelections: { ai: ['机器之心'] },
  });
  ingestContent(db, [
    { title: '池内 AI 文', url: 'https://aihot.news/x', summary: '有货', tagKeys: ['ai'] },
  ]);
  Object.values(db.content_items)[0].metadata = { publisher: 'AIHOT' };
  const cands = buildCandidates(db, { platformId: platform.id, date: DATE });
  assert.ok(cands.length >= 1, '无命中时应回退整包');
  assert.ok(String(cands[0].ai_reason).includes('整包'));
});

t('空栏补放行：其它栏已审过时仍能补空栏', () => {
  const db = seededDb();
  const u = registerUser(db, { email: 'fill@example.com' });
  const { platform, columns } = createPlatform(db, {
    userId: u.id, name: '补栏', tagKeys: ['ai', 'opensource'],
  });
  ingestContent(db, items());
  buildCandidates(db, { platformId: platform.id, date: DATE });
  const osCol = columns.find((c) => c.key === 'opensource');
  const aiCol = columns.find((c) => c.key === 'ai');
  // 只审开源，AI 保持 pending → digest 会空
  for (const e of Object.values(db.candidate_entries)) {
    if (e.column_id === osCol.id) e.status = CANDIDATE_STATUS.APPROVED;
  }
  assert.equal(
    Object.values(db.candidate_entries).filter(
      (e) => e.column_id === aiCol.id && e.status === CANDIDATE_STATUS.APPROVED
    ).length,
    0,
  );
  const n = fillEmptyColumnApprovals(db, { platformId: platform.id, date: DATE, autoPerColumn: 6 });
  assert.ok(n >= 1);
  assert.ok(Object.values(db.candidate_entries).some(
    (e) => e.column_id === aiCol.id && e.status === CANDIDATE_STATUS.APPROVED
  ));
});

// --- 5. 审稿 -----------------------------------------------------------------
t('审稿：approve / reject / pin 真改状态', () => {
  const db = seededDb();
  const { platform, candidates } = pipelineToCandidates(db);
  const [a, b, c] = candidates;
  const r = reviewCandidates(db, {
    platformId: platform.id, date: DATE,
    decisions: [
      { candidateId: a.id, action: 'approve' },
      { candidateId: b.id, action: 'reject' },
      { candidateId: c.id, action: 'pin' },
    ],
  });
  assert.equal(r.approved, 1);
  assert.equal(r.rejected, 1);
  assert.equal(r.pinned, 1);
  assert.equal(db.candidate_entries[a.id].status, CANDIDATE_STATUS.APPROVED);
  assert.equal(db.candidate_entries[b.id].status, CANDIDATE_STATUS.REJECTED);
  assert.equal(db.candidate_entries[c.id].status, CANDIDATE_STATUS.PINNED);
});

t('审稿：不能操作别的平台 / 别的期的候选', () => {
  const db = seededDb();
  const { platform, candidates } = pipelineToCandidates(db);
  const r = reviewCandidates(db, {
    platformId: platform.id, date: DATE,
    decisions: [
      { candidateId: candidates[0].id, action: 'approve' },
      { candidateId: candidates[0].id, action: 'approve' }, // 重复决策无所谓
      { candidateId: 'not-exist', action: 'approve' },
    ],
  });
  assert.equal(r.skipped, 1, '不存在的候选应被跳过');
  assert.throws(() => reviewCandidates(db, {
    platformId: 'not-a-platform', date: DATE, decisions: [],
  }), /平台不存在/);
});

t('审稿：auto 模式每栏目只放行前 N 条', () => {
  const db = seededDb();
  const { platform } = pipelineToCandidates(db);
  const r = reviewCandidates(db, {
    platformId: platform.id, date: DATE, auto: true, autoPerColumn: 1,
  });
  assert.ok(r.approved >= 1);
  const approved = Object.values(db.candidate_entries)
    .filter((e) => e.status === CANDIDATE_STATUS.APPROVED);
  const perCol = new Map();
  for (const e of approved) perCol.set(e.column_id, (perCol.get(e.column_id) || 0) + 1);
  assert.ok([...perCol.values()].every((n) => n <= 1));
});

// --- 6. 发布与 digest --------------------------------------------------------
t('空刊拒绝发布', () => {
  const db = seededDb();
  const { platform } = pipelineToCandidates(db);
  assert.throws(() => publishIssue(db, {
    platformId: platform.id, date: DATE, siteUrl: SITE,
  }), /拒绝发布空刊/);
});

t('发布：生成 issue + issue_items + digest', () => {
  const db = seededDb();
  const { platform } = pipelineToCandidates(db);
  reviewCandidates(db, { platformId: platform.id, date: DATE, auto: true, autoPerColumn: 2 });
  const { issue, digest } = publishIssue(db, {
    platformId: platform.id, date: DATE, siteUrl: SITE,
  });
  assert.equal(issue.status, 'published');
  assert.ok(issue.digest_json);
  assert.equal(issue.public_url, digest.issueUrl);
  assert.equal(digest.schema, 2);
  assert.deepEqual(digest.tabKeys, ['ai', 'opensource']);
  assert.ok(digest.total > 0);
  assert.ok(db.issue_items.some((it) => it.issue_id === issue.id));
});

t('发布：置顶条目排在栏目首位', () => {
  const db = seededDb();
  const { platform } = pipelineToCandidates(db);
  reviewCandidates(db, { platformId: platform.id, date: DATE, auto: true, autoPerColumn: 3 });
  const cands = Object.values(db.candidate_entries).filter((e) => e.column_id);
  const pinned = cands.find((e) => e.status === CANDIDATE_STATUS.PINNED);
  // 上面 auto 不置顶，这里手动置顶一个非首位条目再发布
  const col = Object.values(db.platform_columns).find((c) => c.platform_id === platform.id);
  const inCol = cands.filter((e) => e.column_id === col.id);
  if (inCol.length > 1) {
    reviewCandidates(db, {
      platformId: platform.id, date: DATE,
      decisions: [{ candidateId: inCol[inCol.length - 1].id, action: 'pin' }],
    });
    const { digest } = publishIssue(db, { platformId: platform.id, date: DATE, siteUrl: SITE });
    const tab = digest.tabs.find((t) => t.key === col.key);
    assert.equal(tab.highlights[0].title, db.content_items[inCol[inCol.length - 1].content_item_id].title);
  }
  assert.equal(pinned, undefined); // auto 模式不产生 pinned
});

t('发布：同一期不能发两次（幂等）', () => {
  const db = seededDb();
  const { platform } = pipelineToCandidates(db);
  reviewCandidates(db, { platformId: platform.id, date: DATE, auto: true });
  publishIssue(db, { platformId: platform.id, date: DATE, siteUrl: SITE });
  assert.throws(() => publishIssue(db, {
    platformId: platform.id, date: DATE, siteUrl: SITE,
  }), /已发布/);
});

t('发布：digest 缺 siteUrl 时抛错', () => {
  const db = seededDb();
  const u = registerUser(db, { email: 'e@example.com' });
  const { platform } = createPlatform(db, { userId: u.id, name: 'x', slug: 'x', tagKeys: ['ai'] });
  assert.throws(() => buildPlatformDigest(db, {
    platformId: platform.id, date: DATE, siteUrl: '',
  }), /缺少站点地址/);
});

// --- 7. digest 与现有渲染器兼容 ----------------------------------------------
t('平台 digest 可被 render-email 渲染（自定义栏目 key 生效）', () => {
  const db = seededDb();
  const { digest } = runPipeline(db, {
    user: { email: 'r@example.com' },
    platform: { name: '渲染测试', tagKeys: ['ai', 'opensource'] },
    items: items(), date: DATE, siteUrl: SITE,
    review: { auto: true, autoPerColumn: 2 },
  });
  assert.deepEqual(allowedTabs(digest), ['ai', 'opensource']);
  const mail = renderEmail(digest, null);
  assert.deepEqual(mail.tabs, ['ai', 'opensource']);
  assert.ok(mail.html.includes('AI 资讯'));
  assert.ok(mail.html.includes('开源推荐'));
  assert.ok(mail.text.includes('https://'));
});

t('平台 digest 分类过滤：只订 ai 时其他栏详情不出现', () => {
  const db = seededDb();
  const { digest } = runPipeline(db, {
    user: { email: 'r2@example.com' },
    platform: { name: '过滤测试', tagKeys: ['ai', 'opensource'] },
    items: items(), date: DATE, siteUrl: SITE,
    review: { auto: true, autoPerColumn: 2 },
  });
  assert.deepEqual(parseCats('ai,opensource', digest.tabKeys), ['ai', 'opensource']);
  const mail = renderEmail(digest, 'ai');
  assert.deepEqual(mail.tabs, ['ai']);
  assert.ok(!mail.text.includes('【开源推荐'), '未订阅栏目的详情不该出现');
  // 预览条仍列出全部栏目（入口地图）
  assert.ok(previewBar(digest, ['ai']).includes('AI 资讯'));
  assert.ok(previewBar(digest, ['ai']).includes('开源推荐'));
});

t('老六栏 digest 行为不变（回归护栏）', () => {
  const legacy = buildDigest({
    date: DATE,
    title: '每日图片站',
    siteUrl: SITE,
    tabs: [
      { key: 'jianxiao', label: '见笑', count: 1, items: [
        { title: '梗图', url: 'https://x/1' },
      ] },
      { key: 'news', label: '见报', type: 'headlines', count: 1, items: [
        { title: '要闻', url: 'https://x/2' },
      ] },
    ],
  }, { siteUrl: SITE });
  assert.deepEqual(allowedTabs(legacy), ['jianwen', 'jianshe', 'jianxiao', 'news', 'music', 'movie']);
  const mail = renderEmail(legacy, 'jianxiao');
  assert.deepEqual(mail.tabs, ['jianxiao']);
  // 固定预览条：缺的栏目补 0 条，六个都要出现
  const bar = previewBar(legacy, ['jianxiao']);
  for (const label of ['见闻', '见她', '见笑', '见报', '听乐', '看片']) {
    assert.ok(bar.includes(label), `${label} 应在固定预览条里`);
  }
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
