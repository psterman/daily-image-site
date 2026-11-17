#!/usr/bin/env node
/**
 * R2 孤儿对象清理器
 *
 * 背景
 * ----
 * 构建产物的文件名 = 「内容 + 序号」算出来的随机段（nonce）。
 * 审稿里删掉一张图 → 后面所有图的序号平移 → nonce 全变 → 整期换名。
 * 新名字上传后，**上一代对象就成了 R2 里的孤儿**：没人引用，但一直占着
 * GB-月 和 Class A 次数。代码里没有任何地方删过它们 —— 只会越攒越多。
 *
 * 判据
 * ----
 * 孤儿 = 「旧 manifest 引用过、且新 manifest 不再引用」的对象。
 * 不用列举 R2（REST 没有 list 接口），只需要在**构建前**把旧 manifest
 * 引用到的键存下来 —— 构建会删掉旧 manifest，之后就拿不到了。
 *
 * 用法
 * ----
 *   node tools/orphan-clean.mjs --date 2026-11-15 --capture   # 构建前：记下旧键集
 *   node tools/orphan-clean.mjs --date 2026-11-15 --sweep     # 上传后：删掉差集里的孤儿
 *   node tools/orphan-clean.mjs --date 2026-11-15 --plan      # 干跑：只报不删
 *
 * 安全约束（护栏 tools/test-orphan-clean.mjs 盯着）
 * ----------------------------------------------
 *   1. 只认同一期（--date）的键 —— 别期的对象绝不能碰
 *   2. 只删「旧有、新无」；「旧无、新有」的是**要上传的**，不能删
 *   3. 删除的成功判据看**响应体**，不看 HTTP 码
 *      （实测：删一个不存在的键 → HTTP 200 + success:false + code 10007）
 *   4. 干跑模式绝不真删
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from './env.mjs';
import { ROOT } from './paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 产物命名规则 —— 必须和 upload-r2.mjs 的 PRODUCT_RE 一致（只有这种才真传过） */
const PRODUCT_RE = /^[0-9a-f]{10}_\d{3}(_t)?\.webp$/;

/**
 * 从 manifest 文本里抽出这一期引用到的 R2 对象键。
 * manifest 里的路径形如 /img/2026-11-15/jianxiao/abc1234567_001.webp
 * R2 里的存储键形如 2026-11-15/jianxiao/abc1234567_001.webp
 *
 * @param {string} manifestText
 * @param {string} date  YYYY-MM-DD
 * @returns {Set<string>} R2 存储键
 */
export function extractObjectKeys(manifestText, date) {
  const out = new Set();
  if (typeof manifestText !== 'string' || !manifestText) return out;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return out;

  const re = new RegExp(
    `/img/${date}/([A-Za-z0-9_-]+)/([0-9a-f]{10}_\\d{3}(_t)?\\.webp)`,
    'g',
  );
  let m;
  while ((m = re.exec(manifestText)) !== null) {
    const tab = m[1];
    const name = m[2];
    if (!PRODUCT_RE.test(name)) continue; // 只认真传过的那种命名
    out.add(`${date}/${tab}/${name}`);
  }
  return out;
}

/**
 * 两个键集的差集。
 * @returns {{orphans:string[], missing:string[]}}
 *   orphans = 旧有新无 → 该删
 *   missing = 旧无新有 → 该传（绝不能删）
 */
export function diffKeys(oldKeys, newKeys) {
  const o = oldKeys instanceof Set ? oldKeys : new Set(oldKeys || []);
  const n = newKeys instanceof Set ? newKeys : new Set(newKeys || []);
  const orphans = [...o].filter((k) => !n.has(k)).sort();
  const missing = [...n].filter((k) => !o.has(k)).sort();
  return { orphans, missing };
}

/** 有没有新对象需要上传（没有 → 上传那一步可以跳过） */
export function shouldUpload(newKeys, oldKeys) {
  return diffKeys(oldKeys, newKeys).missing.length > 0;
}

/**
 * 删除的成功判据。
 *
 * 为什么不能只看 HTTP 码：实测删一个**不存在的**键，Cloudflare 返回
 * HTTP 200 + `{success:false, errors:[{code:10007}]}` —— 码是 200，
 * 但对象没被删（因为它本来就不存在，这算幂等成功）。
 * 反过来，token 过期时也会给 200 + success:false + code 10000。
 *
 * @param {number} httpStatus
 * @param {object|null} body 解析后的响应体
 */
export function isDeleteSuccess(httpStatus, body) {
  if (!(typeof httpStatus === 'number' && httpStatus >= 200 && httpStatus < 300)) return false;
  if (!body || typeof body !== 'object') return false;
  if (body.success === true) return true;
  const errs = Array.isArray(body.errors) ? body.errors : [];
  // 10007 = 键本来就不存在 → 幂等，算清理干净了
  if (errs.some((e) => e && Number(e.code) === 10007)) return true;
  return false;
}

/**
 * 真删（或干跑）。
 *
 * @param {object} opts
 * @param {Set<string>} opts.oldKeys
 * @param {Set<string>} opts.newKeys
 * @param {(key:string)=>Promise<boolean>} opts.deleteObject
 * @param {boolean} [opts.dryRun]
 */
export async function sweepOrphans({ oldKeys, newKeys, deleteObject, dryRun = false } = {}) {
  const { orphans, missing } = diffKeys(oldKeys, newKeys);
  const deleted = [];
  const failed = [];

  if (!dryRun) {
    for (const key of orphans) {
      try {
        const ok = await deleteObject(key);
        if (ok) deleted.push(key);
        else failed.push({ key, error: '删除没有成功' });
      } catch (err) {
        failed.push({ key, error: String((err && err.message) || err) });
      }
    }
  }

  return { orphans, missing, deleted, failed, dryRun: !!dryRun };
}

/* ────────────────────── 文件与网络层 ────────────────────── */

/** 状态文件：capture 写、sweep 读 */
function stateFileFor(date) {
  return path.join(ROOT, `.orphan-${date}.json`);
}

/**
 * 找这一期最新的 manifest 文件（构建会删旧的，所以按 mtime 取最新的那个）。
 *
 * ⚠️ hash 是 **base-36**，不是 hex！实测：manifest.glbf83.js / manifest.2kxqkw.js
 *    —— 里面带 g / l / k / x / q / w，用 [0-9a-f] 写就一个都匹配不上
 *    （2026-11-15 踩过：读出来是 null → 键集 0 个 → 孤儿清理静默不干活）。
 *
 * @param {string} date
 * @param {string} [baseDir]  默认 ROOT/published；测试用临时目录
 */
export function findManifestFile(date, baseDir) {
  const dir = path.join(baseDir || path.join(ROOT, 'published'), date);
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /^manifest\.[0-9a-z]+\.js$/i.test(f))
      .map((f) => {
        const p = path.join(dir, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch {
          mtime = 0;
        }
        return { path: p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }
  return files.length ? files[0].path : null;
}

/** 读这一期 manifest 的键集（没有 manifest → 空集） */
export function readManifestKeys(date, baseDir) {
  const file = findManifestFile(date, baseDir);
  if (!file) return new Set();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return new Set();
  }
  return extractObjectKeys(text, date);
}

/** 真正的 R2 删除（走 REST API） */
export function makeDeleteObject() {
  loadEnv();
  return async function deleteObject(key) {
    // ⚠️ 凭据是**懒检查**（在真要删的时候才读），不是构造时就抛。
    //
    // 以前是构造时检查 → 「这期一个孤儿都没有」也会因为没配云凭据而 exit 1。
    // 那是纯噪音：没东西要删，本来就不需要碰云端。
    // （顺带：0 孤儿时这个函数一次都不会被调用。）
    const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
    const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
    const BUCKET = process.env.R2_BUCKET || 'your-bucket';
    if (!ACCOUNT || !TOKEN) {
      throw new Error('缺少环境变量：CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN');
    }
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}` +
      `/r2/buckets/${BUCKET}/objects/${key}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!isDeleteSuccess(res.status, body)) {
      const msg = body && Array.isArray(body.errors) && body.errors[0]
        ? `${body.errors[0].code} ${body.errors[0].message || ''}`
        : `HTTP ${res.status}`;
      throw new Error(`删除失败 ${key}：${msg}`);
    }
    return true;
  };
}

/* ────────────────────── CLI ────────────────────── */

function parseArgs(argv) {
  const out = { date: '', mode: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--date=')) out.date = a.slice(7);
    // 两种写法都认：--date 2026-11-15 和 --date=2026-11-15
    // （2026-11-15 实测：只认等号那种时，publish.ps1 里传的是空格写法 → 日期被读成空
    //   → 脚本直接报「用法」→ 孤儿清理静默不干活）
    else if (a === '--date') out.date = argv[++i] || '';
    else if (a === '--capture') out.mode = 'capture';
    else if (a === '--sweep') out.mode = 'sweep';
    else if (a === '--plan') out.mode = 'plan';
    else if (a === '--probe-delete') out.mode = 'probe-delete';
    else if (a === '--debug') out.mode = 'debug';
  }
  return out;
}

async function main() {
  const { date, mode } = parseArgs(process.argv.slice(2));

  // 自检模式：删一个**不存在的**键，验证 REST 删除链路 + 成功判据。
  // 不会碰到任何真对象。
  if (mode === 'probe-delete') {
    const del = makeDeleteObject();
    const key = `${date || 'probe'}/__probe_delete_selftest__/x.webp`;
    try {
      await del(key);
      console.log('  ✓ 删除链路通（键本来就不存在 → code 10007 → 幂等成功）');
      return;
    } catch (err) {
      console.error('  ✗ 删除链路异常：' + (err && err.message ? err.message : err));
      process.exit(1);
    }
  }

  // 调试模式：把内部状态摊开看（抓「读不到 manifest / 读到 0 个键」这类问题）
  if (mode === 'debug') {
    const dir = path.join(ROOT, 'published', date);
    console.log('  ROOT      =', ROOT);
    console.log('  dir       =', dir, 'exists =', fs.existsSync(dir));
    try {
      console.log('  readdir   =', JSON.stringify(fs.readdirSync(dir)));
    } catch (err) {
      console.log('  readdir 抛错 =', err && err.message);
    }
    const file = findManifestFile(date);
    console.log('  manifest  =', file);
    if (file) {
      const text = fs.readFileSync(file, 'utf8');
      console.log('  文件字节  =', text.length);
      const i = text.indexOf('/img/');
      console.log('  首个 /img/ 位置 =', i);
      if (i >= 0) console.log('  片段 =', text.slice(Math.max(0, i - 40), i + 80));
      const keys = extractObjectKeys(text, date);
      console.log('  抽出键数 =', keys.size);
      console.log('  前 3 个 =', [...keys].slice(0, 3).join(' | '));
    }
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    console.error('用法：node tools/orphan-clean.mjs --date YYYY-MM-DD --capture|--sweep|--plan');
    process.exit(1);
  }
  if (!mode) {
    console.error('必须指定 --capture / --sweep / --plan');
    process.exit(1);
  }

  const stateFile = stateFileFor(date);

  if (mode === 'capture') {
    const keys = readManifestKeys(date);
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ date, capturedAt: Date.now(), keys: [...keys].sort() }, null, 2),
      'utf8',
    );
    console.log(`  已记下旧键集：${keys.size} 个 → ${path.basename(stateFile)}`);
    return;
  }

  // sweep / plan 都要读状态文件
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    state = null;
  }
  if (!state) {
    console.log('  没有 capture 记录（首次发布？）→ 没什么可清的');
    return;
  }
  if (state.date !== date) {
    console.error(`状态文件的日期是 ${state.date}，跟 --date ${date} 对不上 → 中止`);
    process.exit(1);
  }

  const oldKeys = new Set(state.keys || []);
  const newKeys = readManifestKeys(date);
  const { orphans, missing } = diffKeys(oldKeys, newKeys);

  if (mode === 'plan') {
    console.log(`  孤儿（该删）${orphans.length} 个：`);
    for (const k of orphans.slice(0, 20)) console.log(`    - ${k}`);
    if (orphans.length > 20) console.log(`    … 还有 ${orphans.length - 20} 个`);
    console.log(`  待上传（新有）${missing.length} 个`);
    return;
  }

  const r = await sweepOrphans({
    oldKeys,
    newKeys,
    deleteObject: makeDeleteObject(),
  });

  console.log(
    `  孤儿 ${r.orphans.length} 个 → 删掉 ${r.deleted.length} 个，失败 ${r.failed.length} 个` +
    `（待上传 ${r.missing.length} 个）`,
  );
  for (const f of r.failed.slice(0, 10)) console.log(`    ! ${f.key}: ${f.error}`);

  if (r.failed.length === 0) {
    // 清干净了才把状态文件删掉；留着的目的是失败后还能重试
    try {
      fs.rmSync(stateFile, { force: true });
    } catch {
      /* 留着也无害 */
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('孤儿清理失败：', err && err.message ? err.message : err);
    process.exit(1);
  });
}
