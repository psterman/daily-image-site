#!/usr/bin/env node
/**
 * Cloudflare API 权限自检
 *
 * 用途：token 的权限范围经常和「脚本想调用的端点」对不上，
 * 导致 wrangler 报一堆看不懂的错（Invalid access token / 403）。
 * 这个脚本把关键端点挨个点一遍，直接告诉你哪个能用、哪个不能。
 *
 * 用法：node tools/check-api.mjs
 * 退出码：0 = 关键端点全部可用；1 = 有端点不可用（详情看输出）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* 读 .env.local */
const env = {};
const envFile = path.join(ROOT, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const token = process.env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
const acc = process.env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
const proj = process.env.PAGES_PROJECT || env.PAGES_PROJECT || 'your-project';
const bucket = process.env.R2_BUCKET || env.R2_BUCKET || 'your-bucket';

if (!token || !acc) {
  console.error('缺少 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（检查 .env.local）');
  process.exit(2);
}

const H = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

const base = 'https://api.cloudflare.com/client/v4';
const checks = [
  ['token 自检', `${base}/user/tokens/verify`, 'GET'],
  ['账号信息', `${base}/accounts/${acc}`, 'GET'],
  ['Pages 项目', `${base}/accounts/${acc}/pages/projects/${proj}`, 'GET'],
  ['Pages 项目列表', `${base}/accounts/${acc}/pages/projects`, 'GET'],
  ['Pages 密钥列表', `${base}/accounts/${acc}/pages/projects/${proj}/secrets`, 'GET'],
  ['Pages 自定义域名', `${base}/accounts/${acc}/pages/projects/${proj}/domains`, 'GET'],
  ['Pages 部署列表', `${base}/accounts/${acc}/pages/projects/${proj}/deployments`, 'GET'],
  ['R2 bucket 列表', `${base}/accounts/${acc}/r2/buckets`, 'GET'],
  ['Zone DNS', `${base}/zones?name=example.com`, 'GET'],
];

const REDACT = new RegExp(acc, 'g');
let failed = 0;

console.log(`token  : ${token.slice(0, 6)}…${token.slice(-4)} (len=${token.length})`);
console.log(`account: ${acc}`);
console.log(`project: ${proj}\n`);

for (const [label, url, method] of checks) {
  try {
    const res = await fetch(url, { method, headers: H });
    const body = await res.json().catch(() => ({}));
    const errs = (body.errors || []).map((e) => `${e.code}:${e.message}`).join('; ');
    const ok = res.ok && body.success !== false;
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'}  ${label.padEnd(18)} HTTP ${String(res.status).padEnd(4)} ${errs || ''}`,
    );

    if (ok && label === 'Pages 密钥列表' && Array.isArray(body.result)) {
      console.log('        已配置密钥:', body.result.map((s) => s.name).join(', ') || '(无)');
    }
    if (ok && label === 'Pages 自定义域名' && Array.isArray(body.result)) {
      console.log('        已绑域名:', body.result.map((d) => d.name).join(', ') || '(无)');
    }
    if (ok && label === 'R2 bucket 列表' && Array.isArray(body.result)) {
      console.log('        bucket:', body.result.map((b) => b.name).join(', ') || '(无)');
    }
  } catch (e) {
    failed++;
    console.log(`FAIL  ${label.padEnd(18)} ${e.message}`);
  }
}

console.log(`\n结论：${failed === 0 ? '全部可用' : `${failed} 个端点不可用`}`);
process.exit(failed === 0 ? 0 : 1);
