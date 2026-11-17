#!/usr/bin/env node
/**
 * 清理 R2 桶里的「非产物」对象。
 *
 * 产物命名规则：<10位hex随机段>_<3位序号>.webp / ..._t.webp
 * 不符合这个格式的对象，线上代理本来就会挡成 404 —— 留在桶里
 * 只是白占存储和 Class A 写次数。
 *
 * 另外支持 --orphans 模式：按 manifest 清「本轮孤儿产物」。
 *
 *   孤儿 = 命名完全合规、但 manifest 里已经不引用了的对象。
 *   怎么产生的：清洗掉几张图后，源图序号会前移，
 *   而产物文件名里的随机段是按位置算的（nonceFor(salt, tab, 序号)），
 *   位置一变随机段就变 —— 旧文件全部失去引用，但命名仍然合规，
 *   按 PRODUCT_RE 过滤是清不掉它们的。
 *
 * 例外：非图片数据的前缀（留言板 board/、点赞 likes/）不是图片产物，
 * 但它们也不符合 PRODUCT_RE —— 会被下面那套规则当成垃圾删掉。
 * 所以过滤时显式排除这些前缀。
 *
 * ⚠️ 这里漏一个前缀的后果很直接：**跑一次本脚本，那个前缀下的数据全没了**。
 *   2026-11-04 加点赞功能时就差点踩上 ——
 *   likes/ 是新前缀，忘了加进 NON_IMAGE_PREFIXES，
 *   跑一次 `node tools/r2-prune.mjs` 就会把全部点赞计数删光。
 *   新增任何非图片数据（评论、计数、缓存…）都要同步加进这个列表。
 *   tools/test-contract.mjs 有一条断言在盯这件事。
 *
 * 用法：
 *   node tools/r2-prune.mjs --dry      # 只看会删哪些（非产物）
 *   node tools/r2-prune.mjs            # 真删（非产物）
 *   node tools/r2-prune.mjs --orphans --dry   # 只看会删哪些（孤儿产物）
 *   node tools/r2-prune.mjs --orphans --date 2026-10-26
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnv } from './env.mjs';

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
loadEnv();

const ACCOUNT = env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
const BUCKET = env.R2_BUCKET || process.env.R2_BUCKET || 'your-bucket';
const API = 'https://api.cloudflare.com/client/v4';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const orphans = argv.includes('--orphans');
const onlyDate = argv.find((a) => !a.startsWith('--'));
const PRODUCT_RE = /^[0-9a-f]{10}_\d{3}(_t)?\.webp$/;

/**
 * 非图片数据的前缀 —— 这些对象不是图片产物，也不符合 PRODUCT_RE，
 * 按下面那套「不是产物就是垃圾」的规则会被删掉。
 * 删了就没了：留言板删了留言没了，点赞删了计数没了。
 *
 * 新增任何非图片数据（评论、计数、缓存…）都要同步加进这个列表。
 * （tools/test-contract.mjs 有一条断言在盯：Functions 用到的每个 key 前缀都得在这个列表里。）
 */
const NON_IMAGE_PREFIXES = ['board/', 'likes/'];

/**
 * 读某个日期的 manifest，收集它引用的所有图片文件名。
 *
 * manifest 在 published/<日期>/manifest.<hash>.js 里，
 * 格式是 `window.__DAILY_MANIFEST__={...};`。
 * 图片 URL 形如 /img/<日期>/<分类>/<随机段>_<序号>.webp，
 * 去掉前面的 /img/<日期>/ 就是 R2 里的 key。
 */
async function referencedKeys(date) {
  const dir = path.join(ROOT, 'published', date);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const mf = files.find((f) => /^manifest\..*\.js$/.test(f));
  if (!mf) return null;
  const raw = fs.readFileSync(path.join(dir, mf), 'utf8');
  const m = raw.match(/window\.__DAILY_MANIFEST__=(\{.*\});?\s*$/s);
  if (!m) return null;
  let man;
  try {
    man = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const keep = new Set();
  for (const tab of man.tabs || []) {
    for (const it of tab.items || []) {
      /* ⚠️ 必须把 it.cover 也算进来。
         文本型 tab（听乐 / 看片 / 追更）的豆瓣封面是**站内路径**
         （本地化后 = /img/<日期>/covers/<随机段>_<序号>.webp）——
         只收 full / thumb 的话，这些封面不在 keep 集合里，
         --orphans 会把它们当孤儿**删掉**（线上直接裂图）。
         反过来说，远程封面（猫眼 / B站 / 网易云的热链 URL）不能算 ——
         它们的路径切出来是垃圾字符串。 */
      for (const u of [it.full, it.thumb, it.cover]) {
        if (!u || typeof u !== 'string') continue;
        if (u.indexOf('/img/') !== 0) continue; // 只认站内绝对路径
        // /img/<date>/<key>  ->  <key>
        const parts = u.split('/').filter(Boolean);
        if (parts.length >= 2) keep.add(parts.slice(2).join('/'));
      }
    }
  }
  return keep;
}

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

async function del(key) {
  const res = await fetch(
    `${API}/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects/${key}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  return res.ok;
}

async function main() {
  console.log(`Bucket : ${BUCKET}`);
  console.log(`模式   : ${dry ? 'DRY（不真删）' : '真删'}${orphans ? ' · 孤儿产物' : ' · 非产物'}`);
  if (onlyDate) console.log(`日期   : ${onlyDate}\n`);

  const objects = await listAll();

  let junk;
  if (orphans) {
    // 孤儿模式：以 manifest 为准，删掉「命名合规但不再被引用」的对象
    const dates = onlyDate
      ? [onlyDate]
      : [...new Set(objects.map((o) => o.key.split('/')[0]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))];
    junk = [];
    for (const d of dates) {
      const keep = await referencedKeys(d);
      if (!keep) {
        console.log(`  ! ${d} 找不到 manifest，跳过（不猜）`);
        continue;
      }
      const inDay = objects.filter((o) => o.key.startsWith(`${d}/`));
      const orphansInDay = inDay.filter(
        (o) => PRODUCT_RE.test(path.posix.basename(o.key)) && !keep.has(o.key.slice(d.length + 1)),
      );
      console.log(`  ${d}: 引用 ${keep.size} 个，桶里 ${inDay.length} 个，孤儿 ${orphansInDay.length} 个`);
      junk.push(...orphansInDay);
    }
  } else {
    junk = objects.filter((o) => {
      // 非图片数据（board/messages.json、likes/2026-11-03.json…）不是图片产物，
      // 但它也不符合 PRODUCT_RE —— 按下面那套规则会被当成垃圾删掉，
      // 删了留言/点赞就没了。必须显式排除。
      if (NON_IMAGE_PREFIXES.some((p) => o.key.startsWith(p))) return false;
      if (onlyDate && !o.key.startsWith(`${onlyDate}/`)) return false;
      const base = path.posix.basename(o.key);
      return !PRODUCT_RE.test(base);
    });
  }

  if (!junk.length) {
    console.log('✓ 没有可清的对象。');
    return;
  }

  const byDir = new Map();
  for (const o of junk) {
    const d = o.key.split('/').slice(0, -1).join('/') || '(根)';
    byDir.set(d, (byDir.get(d) || 0) + 1);
  }
  console.log(`待清理 ${junk.length} 个对象：`);
  for (const [d, n] of [...byDir].sort()) {
    console.log(`  ${d}/  ${n} 个`);
  }
  const totalBytes = junk.reduce((s, o) => s + (o.size || 0), 0);
  console.log(`\n合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB\n`);

  if (dry) {
    console.log('（dry-run，没删任何东西）');
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const o of junk) {
    if (await del(o.key)) ok++;
    else fail++;
  }
  console.log(`删除完成：成功 ${ok}，失败 ${fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
