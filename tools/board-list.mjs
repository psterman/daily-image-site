#!/usr/bin/env node
/**
 * 留言板本地管理 —— 看留言 / 删留言。
 *
 * 留言存在 R2 的 board/messages.json 里（Pages Functions 写入），
 * 这个脚本用 R2 REST API 读同一个对象，所以看到的就是线上看到的那份。
 *
 * 用法：
 *   node tools/board-list.mjs              # 列出所有留言（新的在前）
 *   node tools/board-list.mjs --json       # 原始 JSON
 *   node tools/board-list.mjs --id <id>    # 只看某一条
 *   node tools/board-list.mjs --delete <id>  # 删掉某一条（不可撤销）
 *   node tools/board-list.mjs --clear       # 清空全部留言
 *
 * 令牌过期（401 / 400-9106）会自动续期后重试。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const env = {};
function loadEnvAll() {
  for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
loadEnvAll();

const ACCOUNT = env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
const BUCKET = env.R2_BUCKET || process.env.R2_BUCKET || 'your-bucket';
const API = 'https://api.cloudflare.com/client/v4';
const KEY = 'board/messages.json';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const onlyId = argv.includes('--id') ? argv[argv.indexOf('--id') + 1] : null;
const delId = argv.includes('--delete') ? argv[argv.indexOf('--delete') + 1] : null;
const clearAll = argv.includes('--clear') || argv.includes('--wipe');

let TOKEN = env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;

function refreshToken() {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'refresh-token.mjs')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`token 续期失败：${(r.stderr || '').slice(0, 200)}`);
  loadEnvAll();
  TOKEN = env.CLOUDFLARE_API_TOKEN;
}

async function call(method, key, body) {
  const url = `${API}/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects/${key}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { Authorization: `Bearer ${TOKEN}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    const res = await fetch(url, { method, headers, body });
    if (res.status === 401 || res.status === 403) {
      if (attempt === 0) {
        console.log('  token 失效，自动续期后重试…');
        refreshToken();
        continue;
      }
      throw new Error(`HTTP ${res.status} 鉴权失败`);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    if (method === 'GET') {
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.toString('utf8');
    }
    return await res.text().catch(() => '');
  }
  throw new Error('请求失败');
}

async function readMessages() {
  try {
    const raw = await call('GET', KEY);
    const data = JSON.parse(raw);
    return Array.isArray(data.items) ? data.items : [];
  } catch (err) {
    if (/HTTP 404/.test(err.message)) return [];
    throw err;
  }
}

async function writeMessages(items) {
  await call('PUT', KEY, JSON.stringify({ items }));
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function main() {
  if (!ACCOUNT) throw new Error('缺少 CLOUDFLARE_ACCOUNT_ID');

  const items = await readMessages();

  if (clearAll) {
    if (!items.length) {
      console.log('本来就没有留言。');
      return;
    }
    await writeMessages([]);
    console.log(`✓ 已清空 ${items.length} 条留言。`);
    return;
  }

  if (delId) {
    const before = items.length;
    const next = items.filter((it) => it && it.id !== delId);
    if (next.length === before) {
      console.log(`✗ 没找到 id = ${delId}`);
      process.exit(1);
    }
    await writeMessages(next);
    console.log(`✓ 已删除 ${before - next.length} 条留言。`);
    return;
  }

  const list = onlyId ? items.filter((it) => it && it.id === onlyId) : items.slice().reverse();

  if (asJson) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }

  if (!list.length) {
    console.log('（还没有留言）');
    return;
  }

  console.log(`共 ${items.length} 条留言\n`);
  for (const it of list) {
    const cat = it.cat ? `[${it.cat}] ` : '';
    console.log(`${fmtTime(it.ts)}  ${cat}${it.name || '匿名'}`);
    console.log(`  ${String(it.body).replace(/\n/g, '\n  ')}`);
    if (it.link) console.log(`  ${it.link}`);
    console.log(`  id: ${it.id}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error('失败:', err.message);
  process.exit(1);
});
