#!/usr/bin/env node
/**
 * 读订阅者 + digest，按每人的分类偏好渲染邮件，经 Resend 发送。
 *
 * 为什么用 Resend：
 *   免费档 3000 封/月，但**每天硬顶 100 封**（各家的免费档都有日限）。
 *   本脚本把「一次发超过 100 人」当作硬错误挡住，而不是傻发然后被拒一半 ——
 *   被拒的那部分人不会收到，也不会重试，静默漏发比直接报错更糟。
 *
 * 为什么退订链接用 email_hash + token：
 *   发信脚本能同时读到 hash 和 token（它是服务端，握有 Cloudflare 凭据），
 *   但邮件正文里只有这条一次性链接，泄漏了也只能退订这一个人。
 *
 * 幂等：
 *   同一期重复跑不该重复发。用 R2 里的 newsletter/sent-<日期>.json 记已发名单，
 *   重跑时跳过已发的人（--force 可强制重发，用于补发失败的人）。
 *
 * 用法：
 *   node tools/send-newsletter.mjs --date 2026-11-17 [--dry-run] [--force] [--limit 20]
 *
 * 环境变量（.env.local）：
 *   RESEND_API_KEY    必填
 *   NEWSLETTER_FROM   发件人，形如 "每日图片站 <daily@你的域名>"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT } from './paths.mjs';
import { renderEmail } from './render-email.mjs';
import { SUBSCRIBABLE_TABS } from './build-digest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RESEND_API = 'https://api.resend.com/emails';
const FREE_DAILY_CAP = 100;

const LIST_KEY = 'subscribers/list.json';
const SENT_PREFIX = 'newsletter/sent-';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i];
    else if (a.startsWith('--date=')) out.date = a.slice(7);
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/** Cloudflare R2 的 S3 兼容 REST 读（本项目的 Token 走 API Token + Account ID） */
async function r2Get(account, token, bucket, key) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`读 R2 ${key} 失败：HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** R2 REST 写对象（PUT 到 objects/<key>） */
async function r2Put(account, token, bucket, key, data) {
  const body = JSON.stringify(data);
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    }
  );
  if (!res.ok) throw new Error(`写 R2 ${key} 失败：HTTP ${res.status}`);
}

function unsubscribeUrl(digest, emailHash, token) {
  // 编码进查询串：token 是十六进制，hash 也是，不含需要转义的字符
  return `${digest.siteUrl}/subscribe/api?action=unsubscribe&email=${encodeURIComponent(emailHash)}&token=${encodeURIComponent(token)}`;
}

/** 把 {{unsubscribe_url}} 占位替换成这封邮件专属的退订链接 */
function personalize(rendered, url) {
  return {
    subject: rendered.subject,
    html: rendered.html.replaceAll('{{unsubscribe_url}}', url),
    text: rendered.text.replaceAll('{{unsubscribe_url}}', url),
  };
}

/** 纯函数：挑出该发的人（排除已发、按 limit 截断）。供护栏测试。 */
export function selectRecipients(list, sent, opts = {}) {
  const entries = Object.entries(list || {});
  const force = !!opts.force;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : Infinity;
  const out = [];
  for (const [hash, rec] of entries) {
    if (!rec || typeof rec !== 'object') continue;
    if (!rec.email || typeof rec.token !== 'string') continue;
    if (!force && sent && sent[hash]) continue;
    out.push({ hash, rec });
    if (out.length >= limit) break;
  }
  return out;
}

async function sendOne(apiKey, from, mail) {
  const res = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const msg = body && body.message ? body.message : `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body && body.id;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.date) {
    console.log(`按订阅偏好发送每日邮件（Resend）

用法：
  node tools/send-newsletter.mjs --date <YYYY-MM-DD> [--dry-run] [--force] [--limit N]

  --dry-run  只渲染不发送，打印前 3 封的主题与收件人
  --force    忽略"已发送"标记（用于补发）
  --limit    最多发几人（默认全发，受 Resend 免费档 100 封/天限制）

环境变量：RESEND_API_KEY / NEWSLETTER_FROM / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN / R2_BUCKET
`);
    process.exit(args.help ? 0 : 1);
  }

  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const bucket = process.env.R2_BUCKET;
  if (!account || !token || !bucket) {
    throw new Error('缺少 Cloudflare 凭据：CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN / R2_BUCKET');
  }

  const digestPath = path.join(ROOT, 'published', args.date, 'digest.json');
  const digest = JSON.parse(await fs.readFile(digestPath, 'utf8'));
  if (digest.date !== args.date) {
    throw new Error(`digest 日期对不上：文件里是 ${digest.date}，命令要的是 ${args.date}`);
  }
  if (!digest.tabs || !digest.tabs.length) {
    throw new Error('digest 里没有任何分类，拒绝发送空邮件');
  }

  const [list, sent] = await Promise.all([
    r2Get(account, token, bucket, LIST_KEY),
    r2Get(account, token, bucket, SENT_PREFIX + args.date + '.json'),
  ]);

  const recipients = selectRecipients(list, sent, { force: args.force, limit: args.limit });
  if (!recipients.length) {
    console.log('没有需要发送的订阅者（都已发过，或列表为空）。');
    return;
  }
  if (recipients.length > FREE_DAILY_CAP) {
    throw new Error(
      `本次要发 ${recipients.length} 封，超过 Resend 免费档 ${FREE_DAILY_CAP} 封/天。` +
        `请升级套餐或用 --limit 分批（已发的会自动跳过）。`
    );
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NEWSLETTER_FROM;
  if (!args.dryRun && (!apiKey || !from)) {
    throw new Error('缺少 RESEND_API_KEY 或 NEWSLETTER_FROM');
  }

  console.log(`期号 ${args.date} · 待发 ${recipients.length} 人${args.dryRun ? ' · DRY RUN' : ''}`);

  const sentNow = {};
  let okCount = 0;
  let failCount = 0;

  for (const { hash, rec } of recipients) {
    const cats = Array.isArray(rec.cats) && rec.cats.length ? rec.cats : SUBSCRIBABLE_TABS;
    const rendered = renderEmail(digest, cats);
    const url = unsubscribeUrl(digest, hash, rec.token);
    const mail = { ...personalize(rendered, url), to: rec.email };

    if (args.dryRun) {
      if (okCount < 3) console.log(`  [预览] ${mail.to} · ${mail.subject} · 分类 ${cats.join('/')}`);
      okCount++;
      continue;
    }

    try {
      const id = await sendOne(apiKey, from, mail);
      sentNow[hash] = { id, at: new Date().toISOString() };
      okCount++;
      console.log(`  [OK] ${mail.to}`);
    } catch (err) {
      failCount++;
      console.log(`  [失败] ${mail.to} · ${err.message}（status ${err.status || '-'}）`);
      // 429 是日限撞顶：后面的别再发了，剩下的留到明天（没写 sent 标记，会重发）
      if (err.status === 429) {
        console.log('  ⚠ 撞到发送上限，停止本次发送。未发的没有打标记，明天会自动续发。');
        break;
      }
    }
  }

  // 合并已发名单写回（保留历史，不清空）
  if (!args.dryRun && Object.keys(sentNow).length) {
    const merged = { ...(sent || {}), ...sentNow };
    await r2Put(account, token, bucket, SENT_PREFIX + args.date + '.json', merged);
    console.log(`已发送记录写回 R2：${Object.keys(sentNow).length} 人`);
  }

  console.log(`完成：成功 ${okCount} · 失败 ${failCount}${args.dryRun ? '（dry-run）' : ''}`);
  if (failCount && !args.dryRun) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (e) {
    console.error(`✗ ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  }
}
