#!/usr/bin/env node
/**
 * 护栏：R2 孤儿对象清理器（tools/orphan-clean.mjs）
 *
 * 为什么需要它
 * ------------
 * 构建产物的文件名是「内容 + 序号」算出来的随机段（nonce）。
 * 审稿里删掉一张图 → 后面所有图的序号平移 → nonce 全变 → 整期换名。
 * 新名字上传后，**上一代对象就成了 R2 里的孤儿**（没人引用，但一直占着
 * GB-月 和 Class A 次数）。代码里没有任何地方删过它们 —— 只会越攒越多。
 *
 * 这个工具的判定是「**旧 manifest 引用过、且新 manifest 不再引用**」=
 * 孤儿。不用列举 R2（REST 没有 list 接口），只需要在构建前把旧 manifest
 * 的键集存下来。
 *
 * 判据要写死在这里，任何一条改了都必须让本文件变红：
 *   1. 只认同一期（date）的键 —— 别期的对象绝不能碰
 *   2. 只删「旧有、新无」的；「旧无、新有」的是**要上传的**，不能删
 *   3. 删除的成功判据看**响应体**，不看 HTTP 码
 *      （实测：删一个不存在的键 → HTTP 200 + success:false + code 10007）
 *   4. 干跑模式绝不真删
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 变异测试入口：ORPHAN_CLEAN 指向别的文件时，本护栏就对着那个文件跑
// （这样验「护栏能抓住坏版本」不用碰真文件）。
const orphanMod = process.env.ORPHAN_CLEAN
  ? path.resolve(ROOT, process.env.ORPHAN_CLEAN)
  : './orphan-clean.mjs';
const {
  extractObjectKeys,
  diffKeys,
  shouldUpload,
  isDeleteSuccess,
  sweepOrphans,
} = await import(orphanMod);

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? '  —— ' + detail : ''}`);
  }
}

console.log('\n1) 从 manifest 抽出 R2 对象键');
{
  const manifest = JSON.stringify({
    tabs: [
      {
        items: [
          { img: '/img/2026-11-15/jianwen/aaaaaaaaaa_001.webp', thumb: '/img/2026-11-15/jianwen/aaaaaaaaaa_001_t.webp' },
          { img: '/img/2026-11-15/jianwen/bbbbbbbbbb_002.webp' },
        ],
      },
      { items: [{ img: '/img/2026-11-15/rss/cccccccccc_001_t.webp' }] },
    ],
    news: { items: [{ img: '/img/2026-11-15/rss/dddddddddd_002_t.webp' }] },
  });
  const keys = extractObjectKeys(manifest, '2026-11-15');
  check('抽出 5 个键', keys.size === 5, `实际=${keys.size}`);
  check('键是 R2 的存储形态（日期/分类/文件）',
    keys.has('2026-11-15/jianwen/aaaaaaaaaa_001.webp') &&
    keys.has('2026-11-15/jianwen/aaaaaaaaaa_001_t.webp') &&
    keys.has('2026-11-15/rss/cccccccccc_001_t.webp'),
    [...keys].join(' '));
  check('去重（同一张图被引用两次只算一次）',
    extractObjectKeys(manifest + manifest, '2026-11-15').size === 5);
}
{
  const manifest = JSON.stringify({
    a: { img: '/img/2026-11-14/jianwen/aaaaaaaaaa_001.webp' },
    b: { img: '/img/2026-11-15/jianwen/bbbbbbbbbb_001.webp' },
    c: { img: '/img/2026-11-16/jianwen/cccccccccc_001.webp' },
    d: { img: '/assets/logo.png' },
    e: { img: '/img/2026-11-15/jianwen/not_an_image.txt' },
    f: { img: '/img/2026-11-15/jianwen/wrongname_001.webp' },
  });
  const keys = extractObjectKeys(manifest, '2026-11-15');
  check('别期的键不进来（2026-11-14 / 2026-11-16 都不算）',
    keys.size === 1 && keys.has('2026-11-15/jianwen/bbbbbbbbbb_001.webp'), [...keys].join(' '));
  check('非 webp 的路径不算对象', ![...keys].some((k) => k.endsWith('.txt')));
  check('不符合产物命名规则的也不算（那种对象从来没真传过）',
    ![...keys].some((k) => k.includes('wrongname')), [...keys].join(' '));
}
{
  check('manifest 是空/坏的不炸', extractObjectKeys('', '2026-11-15').size === 0);
  check('manifest 不是字符串时返回空集',
    extractObjectKeys(null, '2026-11-15').size === 0);
}

console.log('\n2) 差集：谁该删、谁该传');
{
  const oldKeys = new Set([
    '2026-11-15/jianxiao/aaaaaaaaaa_001.webp',
    '2026-11-15/jianxiao/bbbbbbbbbb_002.webp',
    '2026-11-15/jianxiao/cccccccccc_003.webp',
    '2026-11-15/jianxiao/dddddddddd_004.webp',
  ]);
  const newKeys = new Set([
    '2026-11-15/jianxiao/aaaaaaaaaa_001.webp',   // 没动 → 保留
    '2026-11-15/jianxiao/eeeeeeeeee_002.webp',   // 序号平移 → 换名
    '2026-11-15/jianxiao/ffffffffff_003.webp',   // 序号平移 → 换名
  ]);
  const { orphans, missing } = diffKeys(oldKeys, newKeys);
  check('孤儿 = 3 个（换名的 2 个 + 被删的 1 个）', orphans.length === 3, `实际=${orphans.length}`);
  check('孤儿里没有保留下来的那个',
    !orphans.includes('2026-11-15/jianxiao/aaaaaaaaaa_001.webp'), orphans.join(' '));
  check('待上传 = 2 个新名字', missing.length === 2, `实际=${missing.length}`);
  check('待上传里没有旧名字',
    !missing.includes('2026-11-15/jianxiao/bbbbbbbbbb_002.webp'), missing.join(' '));
  check('两集合不相交', !orphans.some((k) => missing.includes(k)));
}
{
  const same = new Set(['2026-11-15/jianxiao/aaaaaaaaaa_001.webp']);
  const { orphans, missing } = diffKeys(same, same);
  check('内容没变 → 既没孤儿也没待上传',
    orphans.length === 0 && missing.length === 0);
  check('该传：只要有新名字就要传', shouldUpload(new Set(['a']), new Set()) === true);
  check('不该传：键集完全一致时跳过上传', shouldUpload(same, same) === false);
}

console.log('\n3) 删除的成功判据（看响应体，不看 HTTP 码）');
{
  check('HTTP 200 + success:true → 成功', isDeleteSuccess(200, { success: true }) === true);
  check('HTTP 200 + success:false（且不是 10007）→ 失败（不能只看 HTTP 码）',
    isDeleteSuccess(200, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }) === false);
  check('code 10007（键本来就不存在）→ 幂等，算成功',
    isDeleteSuccess(200, { success: false, errors: [{ code: 10007 }] }) === true);
  check('HTTP 403 → 失败', isDeleteSuccess(403, { success: false }) === false);
  check('HTTP 500 → 失败', isDeleteSuccess(500, null) === false);
  check('body 解析不出来 → 失败（不猜）', isDeleteSuccess(200, null) === false);
}

console.log('\n4) 清理动作本身（行为层：注入假的删除函数）');
{
  const oldKeys = new Set([
    '2026-11-15/jianxiao/aaaaaaaaaa_001.webp',
    '2026-11-15/jianxiao/bbbbbbbbbb_002.webp',
    '2026-11-15/jianxiao/cccccccccc_003.webp',
  ]);
  const newKeys = new Set(['2026-11-15/jianxiao/aaaaaaaaaa_001.webp']);
  const deleted = [];
  const r = await sweepOrphans({
    oldKeys,
    newKeys,
    deleteObject: async (k) => {
      deleted.push(k);
      return true;
    },
  });
  check('删了 2 个（换名 1 个 + 被删 1 个）', r.deleted.length === 2, `实际=${r.deleted.length}`);
  check('删的正好是那两个', deleted.length === 2 &&
    deleted.includes('2026-11-15/jianxiao/bbbbbbbbbb_002.webp') &&
    deleted.includes('2026-11-15/jianxiao/cccccccccc_003.webp'), deleted.join(' '));
  check('保留下来的那个没被删',
    !deleted.includes('2026-11-15/jianxiao/aaaaaaaaaa_001.webp'), deleted.join(' '));
  check('报告里写清了删了几个', r.deleted.length === 2 && r.failed.length === 0);
}
{
  const deleted = [];
  const r = await sweepOrphans({
    oldKeys: new Set(['2026-11-15/jianxiao/old_001.webp']),
    newKeys: new Set(),
    deleteObject: async (k) => {
      deleted.push(k);
      return true;
    },
    dryRun: true,
  });
  check('干跑：一个都不真删', deleted.length === 0, deleted.join(' '));
  check('干跑：仍然报告有 1 个孤儿', r.orphans.length === 1, JSON.stringify(r.orphans));
  check('干跑：标记自己没删', r.dryRun === true);
}
{
  const deleted = [];
  const r = await sweepOrphans({
    oldKeys: new Set(['2026-11-15/jianxiao/old_001.webp']),
    newKeys: new Set(),
    deleteObject: async (k) => {
      deleted.push(k);
      return false; // 假装删不掉
    },
  });
  check('删失败要如实报出来', r.failed.length === 1 && r.deleted.length === 0,
    `failed=${r.failed.length} deleted=${r.deleted.length}`);
  check('失败时仍然尝试过（不是悄悄跳过）', deleted.length === 1);
}
{
  const r = await sweepOrphans({
    oldKeys: new Set(),
    newKeys: new Set(['2026-11-15/jianxiao/new_001.webp']),
    deleteObject: async () => {
      throw new Error('不该被调用');
    },
  });
  check('没有孤儿时一次都不删', r.deleted.length === 0 && r.failed.length === 0);
  check('待上传数量照样报出来', r.missing.length === 1, JSON.stringify(r.missing));
}

console.log('\n5) 状态文件：capture 存、sweep 读、sweep 后清掉');
{
  const tmpDir = path.join(__dirname, '.test-orphan-tmp');
  const stateFile = path.join(tmpDir, 'state.json');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    date: '2026-11-15',
    capturedAt: 123,
    keys: ['2026-11-15/jianxiao/aaaaaaaaaa_001.webp'],
  }), 'utf8');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('状态文件读得回来', Array.isArray(st.keys) && st.keys.length === 1);
  check('状态文件带着日期', st.date === '2026-11-15');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  check('临时目录清掉了', !fs.existsSync(tmpDir));
}

console.log('\n6) 找 manifest 文件（hash 是 base-36，不是 hex）');
{
  // 2026-11-15 踩过：manifest.glbf83.js / manifest.2kxqkw.js 里带 g / l / k / x / q / w
  // —— 原来的正则写成 [0-9a-f] → 一个都匹配不上 → 键集 0 个 → 孤儿清理静默不干活。
  // 上一版护栏只测了「键怎么抽」，没测「文件怎么找」→ 全绿，但功能是坏的。
  const { findManifestFile, readManifestKeys } = await import(orphanMod);
  const tmpPub = path.join(__dirname, '.test-manifest-tmp', '2026-11-15');
  fs.mkdirSync(tmpPub, { recursive: true });
  fs.writeFileSync(
    path.join(tmpPub, 'manifest.glbf83.js'),
    JSON.stringify({ tabs: [{ items: [{ img: '/img/2026-11-15/jianxiao/aaaaaaaaaa_001.webp' }] }] }),
    'utf8',
  );
  fs.writeFileSync(path.join(tmpPub, 'index.html'), 'x', 'utf8');
  const found = findManifestFile('2026-11-15', path.join(__dirname, '.test-manifest-tmp'));
  check('找到 base-36 hash 的 manifest', !!found && found.endsWith('manifest.glbf83.js'),
    String(found));
  const keys = readManifestKeys('2026-11-15', path.join(__dirname, '.test-manifest-tmp'));
  check('并从它抽出键', keys.size === 1 &&
    keys.has('2026-11-15/jianxiao/aaaaaaaaaa_001.webp'), [...keys].join(' '));
  fs.rmSync(path.join(__dirname, '.test-manifest-tmp'), { recursive: true, force: true });
  check('临时目录清掉了', !fs.existsSync(path.join(__dirname, '.test-manifest-tmp')));
}

console.log('\n7) CLI 入口本身（这条曾经是假绿）');
{
  // 为什么要有这条：2026-11-15 踩过 —— CLI 的入口判断写成了
  // `file://${argv[1]}`，而 Windows 上 import.meta.url 是 `file:///E:/...`
  // （三个斜杠）→ 永远不相等 → **main() 根本不跑**，进程 exit 0、一行输出都没有。
  // 上一版的护栏只测导出的函数，没测 CLI → 全绿，但脚本是死的。
  const { spawnSync } = await import('node:child_process');
  const cli = path.join(__dirname, 'orphan-clean.mjs');
  const bad = spawnSync(process.execPath, [cli, '--date', '2026-1-1', '--capture'], {
    encoding: 'utf8',
  });
  check('日期格式不合法 → exit 1', bad.status === 1, `exit=${bad.status}`);
  check('并且真的打印了用法（说明 CLI 入口活着）',
    /用法/.test((bad.stdout || '') + (bad.stderr || '')),
    ((bad.stdout || '') + (bad.stderr || '')).trim().slice(0, 120));
  const noMode = spawnSync(process.execPath, [cli, '--date', '2026-11-15'], { encoding: 'utf8' });
  check('没给模式 → exit 1', noMode.status === 1, `exit=${noMode.status}`);

  // 空格写法的 --date 必须认（publish.ps1 里传的就是这种）。
  // 用 --debug 的输出来判断：认出来了，目录里才会带上那个日期。
  const spaceDate = spawnSync(process.execPath, [cli, '--date', '1999-01-01', '--debug'], {
    encoding: 'utf8',
  });
  check('--date 空格写法被认出来（否则日期读成空 → 目录名就不对）',
    /1999-01-01/.test((spaceDate.stdout || '') + (spaceDate.stderr || '')),
    ((spaceDate.stdout || '') + (spaceDate.stderr || '')).trim().slice(0, 160));

  // 整条 CLI 走一遍：capture → sweep（用一个不存在的日期 → 0 孤儿 → 不碰 R2 任何对象，
  // 也不会留下状态文件）
  const fake = '1999-01-01';
  const cap = spawnSync(process.execPath, [cli, '--date', fake, '--capture'], { encoding: 'utf8' });
  check('capture 走通', cap.status === 0, `exit=${cap.status}`);
  const sw = spawnSync(process.execPath, [cli, '--date', fake, '--sweep'], { encoding: 'utf8' });
  check('sweep 走通', sw.status === 0, `exit=${sw.status}`);
  check('sweep 之后状态文件自己清掉了',
    !fs.existsSync(path.join(ROOT, `.orphan-${fake}.json`)));

  // 「0 孤儿也要云凭据」是设计缺陷：没东西要删，本来就不该碰云端。
  // 以前凭据是**构造时**检查的 → 没配凭据就 exit 1（纯噪音）。
  // 现在改成**调用时**懒检查 → 构造不抛，真要删才抛。
  //
  // ⚠️ 顺序很重要：先构造（loadEnv 可能把 .env.local 里的真凭据灌进 env），
  //    **再**把 env 里的凭据抹掉，最后才调 —— 这样断言在有没有 .env.local 的
  //    机器上都成立，而且绝不会真的发出去一个删除请求（抛错发生在 fetch 之前）。
  {
    const { makeDeleteObject } = await import(orphanMod);
    const savedA = process.env.CLOUDFLARE_ACCOUNT_ID;
    const savedT = process.env.CLOUDFLARE_API_TOKEN;
    let built = null;
    try {
      built = makeDeleteObject();
    } catch (err) {
      built = new Error(String((err && err.message) || err));
    }
    check('makeDeleteObject() 构造时不抛（凭据是懒检查）',
      !(built instanceof Error), built instanceof Error ? built.message : '');
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    let msg = '';
    try {
      await built('__guardrail_never_deleted__/x.webp');
    } catch (err) {
      msg = String((err && err.message) || err);
    }
    check('真要删的时候才要凭据（且报错说清缺哪两个）',
      /CLOUDFLARE_ACCOUNT_ID/.test(msg) && /CLOUDFLARE_API_TOKEN/.test(msg), msg);
    if (savedA === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = savedA;
    if (savedT === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = savedT;
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
