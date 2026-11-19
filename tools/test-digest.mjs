#!/usr/bin/env node
/**
 * 推送链路护栏：digest 生成 + 邮件渲染 + 收件人筛选。
 *
 * 为什么用纯函数 + 夹具，不真跑 R2：
 *   R2 在网络那头，护栏必须能离线跑、确定性跑（跟项目其他护栏同一纪律）。
 *   buildDigest / renderEmail / selectRecipients 都抽成了纯函数，这里直接喂对象。
 *
 * 重点盯几件真出过事或极易出错的：
 *   - 图片 URL 必须绝对（相对 URL 在邮件里是坏链）
 *   - 文本型 tab 不能被当图片处理（会去 R2 母本找不存在的图）
 *   - 分类过滤必须真过滤（"精准推送"的全部意义）
 *   - 退订占位符必须被替换（漏了会把 {{unsubscribe_url}} 发给用户）
 *   - 已发的人不能重复发（幂等）
 */
import assert from 'node:assert/strict';
import { buildDigest, SUBSCRIBABLE_TABS } from './build-digest.mjs';
import { renderEmail, parseCats } from './render-email.mjs';
import { renderGroupbotMessage } from './render-groupbot.mjs';
import { selectRecipients } from './send-newsletter.mjs';

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
function manifestFixture() {
  return {
    date: '2026-11-17',
    title: '每日图片站',
    siteUrl: 'https://demo.pages.dev/',
    defaultTab: 'jianxiao',
    tabs: [
      {
        key: 'jianxiao',
        label: '见笑',
        count: 2,
        items: [
          { id: 'jianxiao_001', full: '/img/2026-11-17/jianxiao/a.webp', thumb: '/img/2026-11-17/jianxiao/a_t.webp' },
          { id: 'jianxiao_002', full: '/img/2026-11-17/jianxiao/b.webp', thumb: '/img/2026-11-17/jianxiao/b_t.webp' },
        ],
      },
      {
        key: 'news',
        label: '见报',
        type: 'headlines',
        count: 2,
        items: [
          { title: '第一条 & <热榜>', url: 'https://news.example/1' },
          { title: '第二条', url: '' },
        ],
      },
      { key: 'music', label: '听乐', type: 'rank', count: 0, items: [] },
    ],
  };
}

console.log('推送链路护栏\n');

const digest = buildDigest(manifestFixture(), { siteUrl: 'https://demo.pages.dev' });

t('日期不合法时抛错', () => {
  assert.throws(() => buildDigest(manifestFixture(), { date: 'not-a-date' }), /日期不合法/);
});

t('缺站点地址时抛错', () => {
  const m = manifestFixture();
  m.siteUrl = '';
  delete process.env.SITE_URL;
  assert.throws(() => buildDigest(m, { siteUrl: '' }), /缺少站点地址/);
});

t('图片 URL 拼成绝对地址', () => {
  const img = digest.tabs.find((x) => x.key === 'jianxiao').highlights[0];
  assert.equal(img.full, 'https://demo.pages.dev/img/2026-11-17/jianxiao/a.webp');
  assert.ok(img.thumb.startsWith('https://'));
  assert.ok(!img.full.startsWith('/'), '图片 URL 不能以 / 开头');
});

t('站点地址结尾斜杠被去掉（不出现 //img）', () => {
  const d = buildDigest(manifestFixture(), { siteUrl: 'https://demo.pages.dev///' });
  assert.equal(d.siteUrl, 'https://demo.pages.dev');
  assert.ok(!d.issueUrl.includes('//2026'));
});

t('文本型 tab 不当图片处理', () => {
  const news = digest.tabs.find((x) => x.key === 'news');
  assert.equal(news.type, 'headlines');
  assert.equal(news.highlights[0].title, '第一条 & <热榜>');
  assert.equal(news.highlights[0].url, 'https://news.example/1');
});

t('缺链接的文本条目 url 为 null，不塞坏链', () => {
  const news = digest.tabs.find((x) => x.key === 'news');
  assert.equal(news.highlights[1].url, null);
});

t('未订阅的 tab 不进 digest', () => {
  assert.equal(digest.tabs.some((x) => x.key === 'unknown'), false);
  assert.deepEqual(Object.keys(digest.counts).sort(), ['jianxiao', 'music', 'news']);
});

t('概览字符串含各分类数量', () => {
  assert.match(digest.summary, /见笑 2/);
  assert.match(digest.summary, /见报 2/);
});

t('parseCats 过滤非法分类', () => {
  assert.deepEqual(parseCats('jianxiao,junk,news'), ['jianxiao', 'news']);
  assert.equal(parseCats('junk'), null);
});

t('分类过滤：只订见笑，详情正文不出现见报的完整内容', () => {
  const mail = renderEmail(digest, ['jianxiao']);
  assert.deepEqual(mail.tabs, ['jianxiao']);
  // 详情区不含见报的条目；但预览条里仍可见"见报"两个字（那是栏目地图，不是详情）
  assert.ok(!mail.html.includes('第一条 &amp; &lt;热榜&gt;'), '见报的详情条目不该出现');
  assert.ok(mail.text.includes('见笑'));
});

t('固定栏目预览：未订阅的栏目也出现在预览条', () => {
  const mail = renderEmail(digest, ['jianxiao']);
  assert.ok(mail.html.includes('见报'), '预览条应列出全部六个栏目');
  assert.ok(mail.html.includes('听乐'));
  assert.ok(mail.html.includes('看片'));
});

t('预览条与详情都带 #栏目 直达锚点', () => {
  const mail = renderEmail(digest, ['jianxiao']);
  assert.ok(mail.html.includes('/2026-11-17/#jianxiao'));
  assert.ok(mail.html.includes('/2026-11-17/#news'), '未订阅的栏目也应能直达');
  assert.ok(mail.html.includes('在网页看这一栏'), '详情区应有直达链接');
});

t('纯文本兜底带六栏目直达索引', () => {
  const mail = renderEmail(digest, ['jianxiao']);
  assert.ok(mail.text.includes('今日栏目'));
  assert.ok(mail.text.includes('/2026-11-17/#news'));
  assert.ok(mail.text.includes('[已订阅]'));
});

t('预览条用绝对 URL（不出现相对锚点）', () => {
  const mail = renderEmail(digest, ['jianxiao']);
  assert.ok(mail.html.includes('https://demo.pages.dev/2026-11-17/#jianxiao'));
});

t('分类过滤：纯文本详情同步过滤（栏目索引仍在）', () => {
  const mail = renderEmail(digest, 'news');
  assert.ok(mail.text.includes('第一条'), '见报的详情条目应在');
  assert.ok(!mail.text.includes('【见笑'), '见笑的详情区不该出现');
  assert.ok(mail.text.includes('见笑'), '栏目索引里仍应能看到见笑（只是没详情）');
});

t('空分类 = 全量', () => {
  const mail = renderEmail(digest, null);
  assert.equal(mail.tabs.length, digest.tabs.length);
});

t('HTML 转义 & < >', () => {
  const mail = renderEmail(digest, 'news');
  assert.ok(mail.html.includes('&amp;'), '& 应转义');
  assert.ok(!mail.html.includes('<热榜>'), '原文尖括号不应裸出现');
});

t('退订占位符出现在渲染结果里（等发信脚本替换）', () => {
  const mail = renderEmail(digest, 'jianxiao');
  assert.ok(mail.html.includes('{{unsubscribe_url}}'));
  assert.ok(mail.text.includes('{{unsubscribe_url}}'));
});

t('绝对 URL 出现在邮件正文', () => {
  const mail = renderEmail(digest, 'jianxiao');
  assert.ok(mail.html.includes('https://demo.pages.dev/img/'));
  assert.ok(mail.text.includes('https://demo.pages.dev/img/'));
});

t('已发的人不重复发', () => {
  const list = { a: { email: 'a@x.com', token: 't' }, b: { email: 'b@x.com', token: 't' } };
  const sent = { a: { id: 'x' } };
  const got = selectRecipients(list, sent);
  assert.deepEqual(got.map((x) => x.hash), ['b']);
});

t('--force 可无视已发标记', () => {
  const list = { a: { email: 'a@x.com', token: 't' } };
  assert.equal(selectRecipients(list, { a: {} }, { force: true }).length, 1);
});

t('--limit 截断', () => {
  const list = {
    a: { email: 'a@x.com', token: 't' },
    b: { email: 'b@x.com', token: 't' },
    c: { email: 'c@x.com', token: 't' },
  };
  assert.equal(selectRecipients(list, {}, { limit: 2 }).length, 2);
});

t('缺 email / token 的坏记录被跳过', () => {
  const list = { a: { email: '', token: 't' }, b: { email: 'b@x.com' }, c: { email: 'c@x.com', token: 't' } };
  assert.deepEqual(selectRecipients(list, {}).map((x) => x.hash), ['c']);
});

t('群机器人：企业微信用 markdown 且带六栏目直达', () => {
  const msg = renderGroupbotMessage(digest, 'wecom');
  assert.equal(msg.payload.msgtype, 'markdown');
  assert.match(msg.payload.markdown.content, /每日图片站 · 11月17日/);
  assert.ok(msg.payload.markdown.content.includes('https://demo.pages.dev/2026-11-17/#jianxiao'));
  assert.ok(msg.payload.markdown.content.includes('https://demo.pages.dev/2026-11-17/#news'));
});

t('群机器人：钉钉 markdown 有标题', () => {
  const msg = renderGroupbotMessage(digest, 'dingtalk');
  assert.equal(msg.payload.msgtype, 'markdown');
  assert.equal(msg.payload.markdown.title, '每日图片站 · 11月17日');
  assert.ok(msg.payload.markdown.text.includes('https://demo.pages.dev/2026-11-17/#music'));
});

t('群机器人：飞书 post 的 a 标签带绝对直达链接', () => {
  const msg = renderGroupbotMessage(digest, 'feishu');
  assert.equal(msg.payload.msg_type, 'post');
  const post = msg.payload.content.post.zh_cn;
  assert.equal(post.title, '每日图片站 · 11月17日');
  const hrefs = post.content.flat().filter((x) => x.tag === 'a').map((x) => x.href);
  assert.ok(hrefs.includes('https://demo.pages.dev/2026-11-17/#jianxiao'));
  assert.ok(hrefs.includes('https://demo.pages.dev/2026-11-17/#news'));
  assert.ok(hrefs.every((h) => h.startsWith('https://')));
});

t('群机器人：digest 缺栏目时仍固定列全六栏（缺的记 0 条）', () => {
  const msg = renderGroupbotMessage(digest, 'wecom');
  for (const label of ['见闻', '见她', '见笑', '见报', '听乐', '看片']) {
    assert.ok(msg.payload.markdown.content.includes(label), `${label} 应在固定预览里`);
  }
  assert.ok(msg.payload.markdown.content.includes('见闻 0 条'));
  assert.ok(msg.payload.markdown.content.includes('看片 0 条'));
});

t('群机器人：预览链接不出现相对路径锚点', () => {
  const msg = renderGroupbotMessage(digest, 'wecom');
  assert.ok(!/\]\(\/2026-\d{2}-\d{2}\/#/.test(msg.payload.markdown.content));
  assert.ok(!msg.text.includes(' /2026-11-17/#'));
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
