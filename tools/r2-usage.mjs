#!/usr/bin/env node
/**
 * R2 用量体检：存储量 + 免费额度对照 + 还能撑多久。
 *
 * 数据来自**桶里的真实对象列表**（不是本地推算）——
 * 本地母本可能和线上不一致（上传失败、孤儿对象没清），只有桶里的数是真的。
 *
 * 用法：
 *   node tools/r2-usage.mjs              # 总览
 *   node tools/r2-usage.mjs --by-date    # 再按日期拆开列
 *
 * token 过期（401 / 400-9106）会自动续期后重试 —— 监控工具自己挂掉等于没监控。
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
const byDate = process.argv.slice(2).includes('--by-date');

/** R2 免费额度：10 GB-月存储，1M 次 Class A 操作/月，10M 次 Class B 操作/月。 */
const FREE_STORAGE_GB = 10;

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

async function api(p, retried = false) {
  const res = await fetch(API + p, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = await res.json().catch(() => ({}));
  const codes = (body.errors || []).map((e) => e.code);
  const authFail =
    res.status === 401 || (res.status === 400 && (codes.includes(9106) || codes.includes(10000)));
  if (authFail && !retried) {
    console.log('  token 已过期，自动续期后重试…');
    refreshToken();
    return api(p, true);
  }
  if (!res.ok || body.success === false) {
    const errs = (body.errors || []).map((e) => `${e.code}:${e.message}`).join('; ');
    throw new Error(`HTTP ${res.status} ${errs}`);
  }
  return { items: body.result || [], info: body.result_info || {} };
}

async function listAll() {
  const out = [];
  let cursor = null;
  let pages = 0;
  do {
    const q = new URLSearchParams({ per_page: '1000' });
    if (cursor) q.set('cursor', cursor);
    const { items, info } = await api(`/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects?${q}`);
    out.push(...items);
    pages++;
    cursor = info.is_truncated === true && info.cursor ? info.cursor : null;
    if (pages > 500) break;
  } while (cursor);
  return out;
}

async function main() {
  console.log(`Bucket : ${BUCKET}`);
  console.log(`查询中…`);
  const objects = await listAll();

  const totalBytes = objects.reduce((s, o) => s + (o.size || 0), 0);
  const GB = totalBytes / 1073741824;
  const usedPct = (GB / FREE_STORAGE_GB) * 100;
  const leftGB = FREE_STORAGE_GB - GB;

  // 按天分布
  const perDate = new Map();
  for (const o of objects) {
    const d = o.key.split('/')[0] || '(根)';
    const cur = perDate.get(d) || { n: 0, bytes: 0 };
    cur.n++;
    cur.bytes += o.size || 0;
    perDate.set(d, cur);
  }

  console.log(`\n──── 对象总量 ────`);
  console.log(`  对象数   : ${objects.length}`);
  console.log(`  存储量   : ${(totalBytes / 1048576).toFixed(2)} MB  (${GB.toFixed(4)} GB)`);
  console.log(`  平均对象 : ${objects.length ? Math.round(totalBytes / objects.length / 1024) : 0} KB`);

  if (byDate) {
    console.log(`\n──── 按日期 ────`);
    for (const [d, v] of [...perDate.entries()].sort()) {
      console.log(
        `  ${d}  ${String(v.n).padStart(5)} 个   ${(v.bytes / 1048576).toFixed(2).padStart(8)} MB`,
      );
    }
  }

  console.log(`\n──── 免费额度 ────`);
  console.log(`  R2 免费存储 : ${FREE_STORAGE_GB} GB-月`);
  console.log(`  已用        : ${GB.toFixed(4)} GB  (${usedPct.toFixed(2)}%)`);
  console.log(`  剩余        : ${leftGB.toFixed(3)} GB`);
  if (objects.length) {
    const avg = totalBytes / objects.length;
    console.log(`  按当前均值  : 还能再放约 ${Math.floor(leftGB * 1073741824 / avg)} 个对象`);
  }
  console.log(`  Class A 操作 : 每次上传算 1 次（免费额度 100 万次/月）`);
  console.log(`  出网流量     : 免费（不计费）`);
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
