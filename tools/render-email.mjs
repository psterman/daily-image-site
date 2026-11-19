#!/usr/bin/env node
/**
 * 把 digest.json 渲染成 HTML 邮件正文，按订阅者勾选的分类过滤。
 *
 * 为什么要按分类过滤后再渲染，而不是发全量让人自己找：
 *   "精准推送"的全部意义就在这一层 —— 只订了「见笑」的人不该收到写真 tab。
 *   过滤发生在渲染之前，没订的分类连标题都不出现（不是隐藏，是不生成）。
 *
 * 邮件 HTML 的几条硬规矩（都是踩过坑的）：
 *   1. 只用内联样式 —— Gmail/Outlook 会剥掉 <style>，类选择器全失效。
 *   2. 图片一律绝对 URL —— 邮件客户端没有站点根。
 *   3. 图片带 width/height 属性 —— 客户端加载前要先知道占位，不然布局跳。
 *   4. 不用 flex/grid —— 大量邮件客户端不支持，退回 table 布局最稳。
 *   5. 纯文本兜底同时生成 —— 有些客户端/agent 只认 text/plain。
 *
 * 用法：
 *   node tools/render-email.mjs --digest published/2026-11-17/digest.json
 *   node tools/render-email.mjs --digest ... --cats jianxiao,news
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUBSCRIBABLE_TABS, TAB_CN_NAMES } from './build-digest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--digest') out.digest = argv[++i];
    else if (a === '--cats') out.cats = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/** HTML 文本转义（& 最先，否则会把后面替换出来的实体再转一次）。 */
function esc(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * 这一期允许的栏目 key。
 * - 老 digest（schema 1，单站六栏）：用固定 SUBSCRIBABLE_TABS，行为与从前一致。
 * - 平台 digest（schema 2）：用 digest.tabKeys —— 用户自建平台的栏目是任意标签包，
 *   不再是写死的六个。没有 tabKeys 时回退六栏，兼容手工构造的夹具。
 */
export function allowedTabs(digest) {
  if (digest && Array.isArray(digest.tabKeys) && digest.tabKeys.length) {
    return digest.tabKeys.map((k) => String(k));
  }
  return SUBSCRIBABLE_TABS;
}

/** 解析分类勾选：逗号分隔；空/非法 -> 全选（兼容老订阅者没写偏好字段）。 */
export function parseCats(raw, allowed = SUBSCRIBABLE_TABS) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const set = raw.filter((c) => allowed.includes(c));
    return set.length ? set : null;
  }
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((c) => allowed.includes(c));
  return parts.length ? parts : null;
}

/** 日期中文显示：2026-11-17 -> 11月17日 */
function dateCn(date) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(date || ''));
  return m ? `${Number(m[1])}月${Number(m[2])}日` : String(date || '');
}

function mediaBlock(tab) {
  if (!tab.highlights.length) return '';
  // 三列一行：table 布局，每 3 个包一行（邮件客户端不支持 flex/grid）
  const cells = tab.highlights.map((h) =>
    `<td width="31%" valign="top" style="padding:3px;">` +
    `<a href="${esc(h.full)}"><img src="${esc(h.thumb || h.full)}" width="120" ` +
    `style="width:100%;max-width:120px;height:auto;border-radius:6px;display:block;" ` +
    `alt="" border="0"></a></td>`);
  let rows = '';
  for (let i = 0; i < cells.length; i += 3) {
    rows += '<tr>' + cells.slice(i, i + 3).join('') + '</tr>';
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`;
}

function textBlock(tab) {
  const lis = tab.highlights
    .map((h) => {
      const title = h.url
        ? `<a href="${esc(h.url)}" style="color:#1a1a1e;text-decoration:none;">${esc(h.title)}</a>`
        : esc(h.title);
      return `<li style="margin:6px 0;line-height:1.5;">${title}</li>`;
    })
    .join('');
  return lis
    ? `<ul style="margin:6px 0;padding-left:20px;color:#1a1a1e;font-size:14px;">${lis}</ul>`
    : '';
}

/**
 * 固定栏目预览条：六个栏目**永远全列出**，不受订阅过滤影响。
 *
 * 为什么要全列出（哪怕读者只订了一个分类）：
 *   这是读者每天打开邮件的「入口地图」—— 一眼看到今天有哪些栏目、各多少条，
 *   想临时跳去看没订的栏目，点一下就直达。如果只列订阅的，读者想探索别的栏目
 *   就得先去改订阅设置，门槛太高。预览是轻量目录，详情才是订阅内容。
 *
 * 每格都链到 issueUrl#<key>：app.js 读 location.hash 切 tab，
 * 所以点开落在指定栏目，前端不用改一行。
 */
export function previewBar(digest, selected) {
  const present = new Map(
    (Array.isArray(digest.tabs) ? digest.tabs : []).map((t) => [String(t.key || ''), t])
  );
  // 全量栏目 = 本期所有栏目（平台 digest 用 tabKeys；老 digest 用固定六栏）。
  // 之前这里只遍历 digest.tabs —— digest 缺栏目时预览条会少格，跟「固定入口地图」
  // 的设计意图相悖，也让「六栏永远全列出」的护栏断言必挂。这里按 key 补齐。
  const all = allowedTabs(digest).map((key) => present.get(key) || {
    key,
    label: TAB_CN_NAMES[key] || key,
    count: 0,
    highlights: [],
  });
  const cells = all.map((tab) => {
    const key = String(tab.key || '');
    const label = esc(tab.label || TAB_CN_NAMES[key] || key);
    const count = Number(tab.count) || 0;
    const isSub = selected.includes(key);
    const href = esc(`${digest.siteUrl}/${digest.date}/#${key}`);
    // 订阅的栏目用实心标记，没订的空心 —— 不靠颜色也能区分
    const mark = isSub ? '●' : '○';
    const cover = tab.highlights && tab.highlights[0] && tab.highlights[0].thumb
      ? `<img src="${esc(tab.highlights[0].thumb)}" width="150" style="width:100%;max-width:150px;height:auto;display:block;border-radius:4px;" alt="" border="0">`
      : `<div style="height:48px;background:#eef0f3;border-radius:4px;"></div>`;
    return (
      `<td width="33%" valign="top" style="padding:4px;">` +
      `<a href="${href}" style="text-decoration:none;color:#1a1a1e;">` +
      cover +
      `<div style="font-size:13px;font-weight:600;margin-top:5px;">${mark} ${label} <span style="font-size:11px;color:#888;font-weight:400;">${count}</span></div>` +
      `<div style="font-size:11px;color:#4a8cff;margin-top:2px;">直达查看 →</div>` +
      `</a></td>`
    );
  });
  let rows = '';
  for (let i = 0; i < cells.length; i += 3) {
    rows += '<tr>' + cells.slice(i, i + 3).join('') + '</tr>';
  }
  return rows
    ? `<tr><td style="padding:6px 0 4px;font-size:12px;color:#888;">今日栏目（● 已订阅 · ○ 未订阅，点任意栏目直达网页）</td></tr>` +
      `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>`
    : '';
}

/**
 * 渲染邮件（纯函数，供护栏测试）。
 * @param {object} digest
 * @param {string[]|string|null} cats  null/空 = 全量
 * @returns {{ subject: string, html: string, text: string, tabs: string[] }}
 */
export function renderEmail(digest, cats) {
  if (!digest || typeof digest !== 'object') throw new Error('renderEmail 需要 digest 对象');
  const allowed = allowedTabs(digest);
  const selected = parseCats(cats, allowed) || allowed;
  const tabs = (Array.isArray(digest.tabs) ? digest.tabs : []).filter((t) =>
    selected.includes(String(t.key))
  );

  const subject = `${digest.title} · ${dateCn(digest.date)}`;
  // 概览行展示全部六栏，跟下面的固定预览条一致 —— 不能这行只列订阅的、
  // 预览条又列全部的，读者会以为数据对不上。
  const allTabsForSummary = Array.isArray(digest.tabs) ? digest.tabs : [];
  const shownSummary = allTabsForSummary.map((t) => `${t.label} ${t.count}`).join(' · ');

  const sections = tabs
    .map((tab) => {
      const media = tab.type === 'media' || !tab.type;
      const body = media ? mediaBlock(tab) : textBlock(tab);
      if (!body) return '';
      const deepLink = esc(`${digest.siteUrl}/${digest.date}/#${tab.key}`);
      return (
        `<tr><td style="padding:22px 0 6px;">` +
        `<div style="font-size:16px;font-weight:600;color:#1a1a1e;">${esc(tab.label)}` +
        `<span style="font-size:12px;color:#888;font-weight:400;"> · ${Number(tab.count) || 0} 条 · ` +
        `<a href="${deepLink}" style="color:#4a8cff;font-weight:400;text-decoration:none;">在网页看这一栏 →</a></span></div></td></tr>` +
        `<tr><td>${body}</td></tr>`
      );
    })
    .filter(Boolean)
    .join('');

  const preview = previewBar(digest, selected);

  const html =
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:#f5f5f7;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    `<tr><td align="center" style="padding:20px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">` +
    `<tr><td style="padding:8px 0 14px;">` +
    `<div style="font-size:20px;font-weight:600;color:#1a1a1e;">${esc(subject)}</div>` +
    `<div style="font-size:13px;color:#888;margin-top:6px;">${esc(shownSummary)}</div></td></tr>` +
    preview +
    sections +
    `<tr><td style="padding:24px 0 8px;border-top:1px solid #e5e5ea;margin-top:20px;">` +
    `<a href="${esc(digest.issueUrl)}" style="color:#4a8cff;font-size:14px;text-decoration:none;">在网页里看完整一期 →</a>` +
    `</td></tr>` +
    `<tr><td style="padding:6px 0 20px;color:#aaa;font-size:12px;line-height:1.6;">` +
    `你收到这封邮件是因为订阅了本站。不想再收？` +
    `<a href="{{unsubscribe_url}}" style="color:#888;">点这里退订</a>。</td></tr>` +
    `</table></td></tr></table></body></html>`;

  // 纯文本兜底：agent / 纯文本客户端读这份。绝对路径直接给，agent 可自行取图。
  const textLines = [subject, shownSummary, ''];
  // 六个栏目直达索引永远在（即使没订阅），agent 也能拿到完整栏目地图
  const allTabs = Array.isArray(digest.tabs) ? digest.tabs : [];
  if (allTabs.length) {
    textLines.push('今日栏目（点链接直达）：');
    for (const tab of allTabs) {
      const mark = selected.includes(String(tab.key)) ? '[已订阅]' : '';
      textLines.push(`  ${tab.label} ${Number(tab.count) || 0} 条 ${mark} ${digest.siteUrl}/${digest.date}/#${tab.key}`);
    }
    textLines.push('');
  }
  for (const tab of tabs) {
    textLines.push(`【${tab.label} · ${tab.count} 条】`);
    for (const h of tab.highlights) {
      if (h.title) textLines.push(`- ${h.title}${h.url ? ` ${h.url}` : ''}`);
      else if (h.full) textLines.push(`- ${h.full}`);
    }
    textLines.push('');
  }
  textLines.push(`完整一期：${digest.issueUrl}`, `退订：{{unsubscribe_url}}`);

  return {
    subject,
    html,
    text: textLines.join('\n'),
    tabs: tabs.map((t) => String(t.key)),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.digest) {
    console.log(`用法：node tools/render-email.mjs --digest <digest.json> [--cats a,b,c] [--out <文件>]
  --cats 省略或非法 = 全量分类`);
    process.exit(args.help ? 0 : 1);
  }
  const digest = JSON.parse(await fs.readFile(path.resolve(process.cwd(), args.digest), 'utf8'));
  const rendered = renderEmail(digest, args.cats);
  const out = rendered.html;
  if (args.out) {
    await fs.writeFile(path.resolve(process.cwd(), args.out), out, 'utf8');
    console.log(`邮件正文已写入：${args.out}`);
  } else {
    process.stdout.write(out);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (e) {
    console.error(`✗ ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  }
}
