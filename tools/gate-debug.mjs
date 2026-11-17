#!/usr/bin/env node
/**
 * 口令模式诊断：
 *   1. 密钥到底在不在项目里、类型对不对
 *   2. 带 cache-buster 的请求能不能绕过边缘缓存打到 Function
 *
 * 用法：node tools/gate-debug.mjs [口令]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const token = process.argv[2] || '';
const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${env.PAGES_PROJECT}/secrets`;

console.log('=== 1. 项目密钥列表 ===');
{
  const res = await fetch(base, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
  });
  const body = await res.json().catch(() => ({}));
  console.log(`HTTP ${res.status} success=${body.success}`);
  if (Array.isArray(body.result)) {
    for (const s of body.result) console.log(`   ${s.name}  type=${s.type}`);
    if (!body.result.length) console.log('   (空)');
  } else {
    console.log('   ', JSON.stringify(body.errors || body).slice(0, 200));
  }
}

const cb = Date.now();
const site = env.SITE_URL || 'https://example.com';
const img = `${site}/img/2026-10-25/jianwen/001.webp?cb=${cb}`;

console.log('\n=== 2. 带 cache-buster 访问图片（应 401）===');
{
  const res = await fetch(img, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) MicroMessenger/8.0.32' } });
  console.log(`HTTP ${res.status}  cf-cache-status=${res.headers.get('cf-cache-status')}  age=${res.headers.get('age')}`);
  console.log(`   cache-control: ${res.headers.get('cache-control')}`);
  const body = await res.text();
  console.log(`   body: ${body.slice(0, 80)}`);
}

console.log('\n=== 3. 带 ?k= 访问站点根（应 302 + Set-Cookie）===');
if (token) {
  const res = await fetch(`${site}/?k=${token}&cb=${cb}`, { redirect: 'manual' });
  console.log(`HTTP ${res.status}`);
  console.log(`   location: ${res.headers.get('location')}`);
  console.log(`   set-cookie: ${res.headers.get('set-cookie')}`);
  console.log(`   cache-control: ${res.headers.get('cache-control')}`);
} else {
  console.log('（未提供口令，跳过）');
}

console.log('\n=== 4. 不带任何凭证访问站点根（页面 HTML 应公开）===');
{
  const res = await fetch(`${site}/?cb=${cb}`, { redirect: 'manual' });
  console.log(`HTTP ${res.status}  cf-cache-status=${res.headers.get('cf-cache-status')}`);
}
