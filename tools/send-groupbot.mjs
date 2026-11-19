#!/usr/bin/env node
/**
 * 把某一期 digest.json 发到企业微信 / 钉钉 / 飞书群机器人。
 *
 * 这是「群钩子」，不是 newsletter：
 *   - 一条日报广播，不按成员分类；
 *   - 六个栏目固定全列出，每栏带 #栏目 直达；
 *   - 不存订阅者、不写退订、不做个性化。
 *
 * 为什么不自动重试：
 *   超时可能"其实已送达"，重试会造成群里两条重复日报。群机器人一天一条，
 *   真失败了手动重跑比自动双发更可控。
 *
 * 成功判定不能只看 HTTP 200：
 *   三家都是 200 + 业务码，errcode/code 非 0 时消息根本没进群。
 *
 * 用法：
 *   node tools/send-groupbot.mjs --date 2026-11-17 --provider wecom [--dry-run]
 *
 * 环境变量（任选其一，推荐写 .env.local，不要提交）：
 *   WECOM_WEBHOOK / DINGTALK_WEBHOOK / FEISHU_WEBHOOK / GROUPBOT_WEBHOOK
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT } from './paths.mjs';
import { GROUPBOT_PROVIDERS, renderGroupbotMessage } from './render-groupbot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROVIDER_LABELS = { wecom: '企业微信', dingtalk: '钉钉', feishu: '飞书' };
const ENV_NAMES = {
  wecom: ['WECOM_WEBHOOK', 'WECOM_WEBHOOK_URL'],
  dingtalk: ['DINGTALK_WEBHOOK', 'DINGTALK_WEBHOOK_URL'],
  feishu: ['FEISHU_WEBHOOK', 'FEISHU_WEBHOOK_URL'],
};

function parseArgs(argv) {
  const out = { provider: 'wecom' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i];
    else if (a.startsWith('--date=')) out.date = a.slice(7);
    else if (a === '--provider') out.provider = argv[++i];
    else if (a.startsWith('--provider=')) out.provider = a.slice(11);
    else if (a === '--webhook') out.webhook = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function resolveWebhook(provider, cliValue) {
  if (cliValue) return cliValue;
  for (const name of [...ENV_NAMES[provider], 'GROUPBOT_WEBHOOK']) {
    const value = process.env[name];
    if (value) return value;
  }
  return '';
}

/** 三家的成功码不一样，统一在这里判，调用方只看布尔。 */
function isBizOk(provider, body) {
  if (!body || typeof body !== 'object') return false;
  if (body.success === true) return true;
  if (provider === 'feishu') {
    const code = body.code != null ? body.code : body.StatusCode != null ? body.StatusCode : body.status;
    return Number(code) === 0;
  }
  const code = body.errcode != null ? body.errcode : body.code;
  return Number(code) === 0;
}

function bizMessage(body, httpStatus) {
  if (!body || typeof body !== 'object') return `HTTP ${httpStatus}`;
  const text = body.errmsg || body.msg || body.StatusMessage || body.message || body.statusMessage;
  if (text) return String(text);
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return `HTTP ${httpStatus}`;
  }
}

async function postWebhook(url, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`请求超时（${timeoutMs}ms），不自动重试以免群里双发`);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应也是失败，下面统一处理 */
  }
  if (res.status === 429) {
    throw new Error('被群机器人限流（429）。一天一条不该撞限，请检查是否被别的脚本重复调用。');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} · ${bizMessage(body, res.status)}`);
  return body;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.date) {
    console.log(`把 digest.json 发到群机器人（企业微信 / 钉钉 / 飞书）

用法：
  node tools/send-groupbot.mjs --date <YYYY-MM-DD> [--provider wecom|dingtalk|feishu] [--dry-run]

  --dry-run   只渲染不发送，打印文本与请求体
  --webhook   直接传地址（不推荐，容易进 shell 历史；优先用环境变量）
  --timeout   请求超时毫秒，默认 10000

环境变量：WECOM_WEBHOOK / DINGTALK_WEBHOOK / FEISHU_WEBHOOK / GROUPBOT_WEBHOOK
`);
    process.exit(args.help ? 0 : 1);
  }

  if (!GROUPBOT_PROVIDERS.includes(args.provider)) {
    throw new Error(`未知平台：${args.provider}（可选 ${GROUPBOT_PROVIDERS.join(' / ')}）`);
  }

  const digestPath = path.join(ROOT, 'published', args.date, 'digest.json');
  let digest;
  try {
    digest = JSON.parse(await fs.readFile(digestPath, 'utf8'));
  } catch {
    throw new Error(`读不到 ${digestPath} —— 先跑 node tools/build-digest.mjs --date ${args.date}`);
  }
  if (digest.date !== args.date) {
    throw new Error(`digest 日期对不上：文件里是 ${digest.date}，命令要的是 ${args.date}`);
  }
  if (!Array.isArray(digest.tabs) || !digest.tabs.length) {
    throw new Error('digest 里没有任何分类，拒绝发送空日报');
  }

  const rendered = renderGroupbotMessage(digest, args.provider);

  if (args.dryRun) {
    console.log(`干跑：不会发送 · 平台 ${PROVIDER_LABELS[args.provider]}`);
    console.log(`标题：${rendered.title}`);
    console.log('');
    console.log(rendered.text);
    console.log('\n请求体：');
    console.log(JSON.stringify(rendered.payload, null, 2));
    return;
  }

  const webhook = resolveWebhook(args.provider, args.webhook);
  if (!webhook) {
    const names = [...ENV_NAMES[args.provider], 'GROUPBOT_WEBHOOK'].join(' / ');
    throw new Error(`缺少 webhook：请设置 ${names}（写 .env.local，别提交仓库）`);
  }

  const timeoutMs = Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : 10000;
  const body = await postWebhook(webhook, rendered.payload, timeoutMs);
  if (!isBizOk(args.provider, body)) {
    throw new Error(`${PROVIDER_LABELS[args.provider]} 拒绝消息：${bizMessage(body, 200)}`);
  }

  const total = digest.tabs.reduce((n, t) => n + (Number(t.count) || 0), 0);
  console.log(
    `已发送到${PROVIDER_LABELS[args.provider]}群：${args.date} · ` +
      `${digest.tabs.length} 个有内容的栏目 · 共 ${total} 条`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (e) {
    console.error(`✗ ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  }
}
