#!/usr/bin/env node
/**
 * 探测 R2 是否可用（是否已在 Dashboard 启用 + bucket 是否存在）
 *
 * 退出码：
 *   0  READY      R2 已启用，bucket 存在
 *   3  DISABLED   账号还没启用 R2（Cloudflare 错误码 10042）
 *   4  NO_BUCKET  R2 已启用，但目标 bucket 不存在
 *   2  其他错误
 *
 * 用法：node tools/check-r2.mjs
 */
import { loadEnv } from './env.mjs';

loadEnv();

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET = process.env.R2_BUCKET || 'your-bucket';

if (!ACCOUNT || !TOKEN) {
  console.log('RESULT=NO_CREDENTIALS');
  console.log('缺少 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN');
  process.exit(2);
}

const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets`;
let res;
let body;
try {
  res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  body = await res.json().catch(() => null);
} catch (err) {
  console.log('RESULT=NETWORK_ERROR');
  console.log(err.message);
  process.exit(2);
}

const code = body?.errors?.[0]?.code;

if (res.ok && body?.success) {
  const names = (body.result?.buckets || []).map((b) => b.name);
  if (names.includes(BUCKET)) {
    console.log('RESULT=READY');
    console.log(`bucket=${BUCKET}`);
    console.log(`buckets=${names.join(',')}`);
    process.exit(0);
  }
  console.log('RESULT=NO_BUCKET');
  console.log(`bucket=${BUCKET} 不存在，现有：${names.join(',') || '(空)'}`);
  process.exit(4);
}

if (code === 10042) {
  console.log('RESULT=DISABLED');
  console.log('Cloudflare 错误码 10042：账号尚未启用 R2。');
  console.log('需要手动操作：https://dash.cloudflare.com -> 左侧 R2 -> 启用 R2');
  process.exit(3);
}

console.log('RESULT=ERROR');
console.log(`HTTP ${res.status} code=${code ?? '-'} ${body?.errors?.[0]?.message || ''}`);
process.exit(2);
