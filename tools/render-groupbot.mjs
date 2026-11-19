#!/usr/bin/env node
/**
 * 把 digest.json 渲染成群机器人日报（企业微信 / 钉钉 / 飞书）。
 *
 * 这个适配器跟邮件不是一回事：
 *   邮件是 newsletter 主载体，能按读者偏好发不同详情；
 *   群机器人是群里的「一条日报钩子」，不区分群成员，目标是让人一眼看到今天有什么，
 *   并且点一下就落到指定栏目。所以这里只发固定六栏目预览 + 直达链接，
 *   不发图片正文、不发个人退订链接。
 *
 * 为什么固定六个栏目都列出：
 *   群里是广播，没有"我的订阅偏好"这个概念。固定六栏等于每天的入口地图，
 *   缺哪个栏目也保留一个 0 条的位置，读起来结构稳定。
 *
 * 三个平台的承载格式不同：
 *   企业微信 / 钉钉：markdown
 *   飞书：post 富文本（用 a 标签承载链接，比 markdown 更稳）
 * 链接一律来自 digest.siteUrl + date + #<tabKey>，站点 app.js 已支持 hash 切栏目。
 *
 * 用法：
 *   node tools/render-groupbot.mjs --digest published/2026-11-17/digest.json --provider wecom
 *   node tools/render-groupbot.mjs --digest ... --provider dingtalk --out .exp/groupbot.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUBSCRIBABLE_TABS, TAB_CN_NAMES } from './build-digest.mjs';

export const GROUPBOT_PROVIDERS = ['wecom', 'dingtalk', 'feishu'];

function parseArgs(argv) {
  const out = { provider: 'wecom' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--digest') out.digest = argv[++i];
    else if (a.startsWith('--digest=')) out.digest = a.slice(9);
    else if (a === '--provider') out.provider = argv[++i];
    else if (a.startsWith('--provider=')) out.provider = a.slice(11);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/** 群消息里不允许出现换行破坏结构；顺手压掉多余空白。 */
function oneLine(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** markdown 里方括号和圆括号会吃掉链接语法，标题这类自由文本要先压平。 */
function mdText(s) {
  return oneLine(s).replace(/([\[\]\\])/g, '\\$1');
}

/** 日期中文显示：2026-11-17 -> 11月17日 */
function dateCn(date) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(date || ''));
  return m ? `${Number(m[1])}月${Number(m[2])}日` : oneLine(date);
}

/** 固定六栏；digest 里缺的栏目补 0 条，但链接照样给。 */
function fixedTabs(digest) {
  const byKey = new Map((Array.isArray(digest.tabs) ? digest.tabs : []).map((t) => [String(t.key), t]));
  return SUBSCRIBABLE_TABS.map((key) => {
    const t = byKey.get(key);
    return {
      key,
      label: String((t && t.label) || TAB_CN_NAMES[key] || key),
      count: t && t.count != null ? Number(t.count) || 0 : 0,
    };
  });
}

function tabUrl(digest, key) {
  const site = String(digest.siteUrl || '').replace(/\/+$/, '');
  if (!site || !digest.date) throw new Error('digest 缺少 siteUrl 或 date，无法生成栏目直达链接');
  return `${site}/${digest.date}/#${key}`;
}

/**
 * 渲染（纯函数，便于护栏测试）。
 * @param {object} digest
 * @param {'wecom'|'dingtalk'|'feishu'} provider
 * @returns {{provider: string, title: string, text: string, payload: object}}
 */
export function renderGroupbotMessage(digest, provider = 'wecom') {
  if (!digest || typeof digest !== 'object') throw new Error('renderGroupbotMessage 需要 digest 对象');
  const kind = GROUPBOT_PROVIDERS.includes(provider) ? provider : 'wecom';
  const tabs = fixedTabs(digest);
  const title = `${oneLine(digest.title || '每日图片站')} · ${dateCn(digest.date)}`;
  const total = tabs.reduce((n, t) => n + t.count, 0);
  const summary = tabs.map((t) => `${t.label} ${t.count}`).join(' · ');
  const issueUrl = String(digest.issueUrl || tabUrl(digest, tabs[0].key));

  const markdownLines = [
    `**${mdText(title)}**`,
    `今日 ${total} 条 · ${mdText(summary)}`,
    '',
    '今日栏目（点栏目直达）：',
    ...tabs.map((t) => `· ${mdText(t.label)} ${t.count} 条 · [打开](${tabUrl(digest, t.key)})`),
    '',
    `[看完整一期 →](${issueUrl})`,
  ];
  const markdown = markdownLines.join('\n');

  const textLines = [
    title,
    `今日 ${total} 条 · ${summary}`,
    '今日栏目（点栏目直达）：',
    ...tabs.map((t) => `  ${t.label} ${t.count} 条 ${tabUrl(digest, t.key)}`),
    `完整一期：${issueUrl}`,
  ];

  let payload;
  if (kind === 'wecom') {
    payload = { msgtype: 'markdown', markdown: { content: markdown } };
  } else if (kind === 'dingtalk') {
    payload = { msgtype: 'markdown', markdown: { title: oneLine(title), text: markdown } };
  } else {
    // 飞书 post：每个数组是一段，段内可以混排 text 和 a
    const content = [
      [{ tag: 'text', text: title }],
      [{ tag: 'text', text: `今日 ${total} 条 · ${summary}` }],
      [{ tag: 'text', text: '今日栏目（点栏目直达）：' }],
      ...tabs.map((t) => [
        { tag: 'text', text: `· ${t.label} ${t.count} 条 · ` },
        { tag: 'a', text: '打开', href: tabUrl(digest, t.key) },
      ]),
      [
        { tag: 'text', text: '看完整一期：' },
        { tag: 'a', text: issueUrl, href: issueUrl },
      ],
    ];
    payload = { msg_type: 'post', content: { post: { zh_cn: { title: oneLine(title), content } } } };
  }

  return { provider: kind, title, text: textLines.join('\n'), payload };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.digest) {
    console.log(`把 digest.json 渲染成群机器人日报

用法：
  node tools/render-groupbot.mjs --digest <digest.json> [--provider wecom|dingtalk|feishu] [--out <file.json>]

  --out 写 JSON 请求体；不写则打印可读文本 + JSON 到 stdout
`);
    process.exit(args.help ? 0 : 1);
  }

  const file = path.resolve(process.cwd(), args.digest);
  const digest = JSON.parse(await fs.readFile(file, 'utf8'));
  const rendered = renderGroupbotMessage(digest, args.provider);

  if (args.out) {
    const out = path.resolve(process.cwd(), args.out);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(rendered.payload, null, 2) + '\n', 'utf8');
    console.log(`群机器人请求体已写入：${out}`);
    return;
  }

  console.log(`平台：${rendered.provider}`);
  console.log(`标题：${rendered.title}`);
  console.log('');
  console.log(rendered.text);
  console.log('\n请求体：');
  console.log(JSON.stringify(rendered.payload, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (e) {
    console.error(`✗ ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  }
}
