#!/usr/bin/env node
/**
 * 护栏：构建产物的「有效性」——三道闸门，每道都得有牙齿。
 *
 * 背景（2026-11-15 的**真实线上事故**，不是假想）：
 *   一次发布把一个 **0 字节** 的 WebP 传到了生产 R2 桶，
 *   线上代理以 HTTP 200 / Content-Length: 0 / Content-Type: image/webp 吐出来
 *   → 2026-11-14 归档页那一格是裂图（状态码 200，监控看不出来）。
 *
 *   根因链 —— 三道闸门各漏一处：
 *     1) build.mjs 的 --no-convert 复用路径只查「文件存不存在」
 *        → 0 字节也算「存在」→ 被当成合法产物一路传下去
 *     2) verify-build.mjs（发布闸门，publish.ps1 里「产物自检不通过，已中止」）
 *        查引用产物也只查存不存在 → 自检放行
 *     3) upload-r2.mjs 只按文件名正则过滤（PRODUCT_RE）→ 0 字节文件照传不误
 *
 * 本测试怎么验：**真跑**，不靠 grep 断言。
 *   在临时工程（tools\.tmp-product-validity）里造 0 字节 / 坏文件头的产物，
 *   然后跑三份脚本，看它们拦不拦得住。
 *   产物、manifest、源图全在临时目录里 ——
 *   ~/image-root 和工程里的 published/ 一概不碰（本文件只写 tools\.tmp-*）。
 *
 * 跑法：node tools/test-product-validity.mjs
 *   PRODUCT_VALIDITY_SECTION=build|verify|upload   只跑某一段（变异测试用，省时间）
 *   PRODUCT_VALIDITY_IMPL_DIR=<目录>                被测实现放哪（变异测试用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { webpSize } from './webp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const IMPL_DIR = process.env.PRODUCT_VALIDITY_IMPL_DIR || __dirname;
const TMP = path.join(__dirname, '.tmp-product-validity');
const SECTION = process.env.PRODUCT_VALIDITY_SECTION || 'all';

const BUILD_DATE = '2026-11-17';
const VERIFY_DATE = '2026-11-01';
const UPLOAD_DATE = '2026-11-02';

/* --------------------------------------------------------------- 断言 */

let pass = 0;
let fail = 0;
const failed = [];

function ok(cond, msg, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failed.push(msg);
    console.log(`  ✗ ${msg}${detail ? '  —— ' + detail : ''}`);
  }
}
function section(t) {
  console.log(`\n── ${t}`);
}

/* --------------------------------------------------------------- 小工具 */

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 被测实现文件：变异测试把改坏的副本放在 IMPL_DIR 里 */
function implFile(name) {
  const p = path.join(IMPL_DIR, name);
  return fs.existsSync(p) ? p : path.join(__dirname, name);
}

/** 子进程环境：绝不把真实凭据带进去（IMAGE_ROOT 等由调用方指定） */
function childEnv(extra = {}) {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.R2_BUCKET;
  return { ...env, ...extra };
}

function runNode(args, opts = {}) {
  const res = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: opts.cwd || TMP,
    env: opts.env || childEnv(),
    timeout: opts.timeout || 300000,
  });
  return {
    code: res.status,
    out: (res.stdout || '') + (res.stderr || ''),
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

function haveFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 造一张真 WebP（ffmpeg 的 libwebp 编码器） */
function makeWebp(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x3366cc:s=32x32', '-frames:v', '1', '-c:v', 'libwebp', file],
    { stdio: 'pipe' },
  );
}

/** 造一张源图（PNG） */
function makePng(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xff8800:s=64x64', '-frames:v', '1', file],
    { stdio: 'pipe' },
  );
}

/** 产物是不是「有效 WebP」（存在 + 非 0 字节 + 读得出尺寸） */
async function productOk(file) {
  try {
    const st = fs.statSync(file);
    if (st.size === 0) return false;
    const d = await webpSize(file);
    return !!(d && d.w > 0 && d.h > 0);
  } catch {
    return false;
  }
}

/**
 * 找到**含 needle 的那一行**，看这一行里有没有 also。
 *
 * 为什么不能直接 out.includes(also)：
 *   脚本的提示语里也可能有这几个字（比如「多半是转码被中断留下的 0 字节母本」），
 *   直接 includes 会被提示语蒙过去 —— 那就是名不误实的断言（假绿）。
 *   必须盯住**报出问题的那一行**。
 */
function lineWith(out, needle, also) {
  const line = String(out)
    .split(/\r?\n/)
    .find((l) => l.includes(needle));
  return !!line && line.includes(also);
}

/**
 * **任意一行**同时含 needle 和 also。
 *
 * 什么时候必须用它（而不是上面的 lineWith）：
 *   「回退日志指名道姓说了是哪个文件」这条断言，盯的是**回退那一行**
 *   同时说出文件名和「自动回退为重新转码」。
 *   只用 `out.includes(文件名)` 会被**别的日志蒙过去** ——
 *   2026-11-17 实测：LQIP 阶段处理同一个坏文件时也会打印它的名字
 *   （「LQIP 失败：xxx.webp」），于是「文件名出现过」这条断言
 *   在**根本没有回退**的情况下也是绿的 → 变异 M1 判成 FALSE_RED。
 *   所以这里必须要求「同一行」里既有文件名、又有回退标记。
 */
function anyLineWith(out, needle, also) {
  return String(out)
    .split(/\r?\n/)
    .some((l) => l.includes(needle) && l.includes(also));
}

/** 把一个文件改成「坏 WebP」：文件头前面 12 字节写成垃圾（体积不变） */
function corruptHeader(file) {
  if (!fs.existsSync(file)) makeWebp(file); // 夹具被并发清理掉了就补一个
  const buf = fs.readFileSync(file);
  buf.write('NOTWEBP!!!', 0, 'ascii');
  fs.writeFileSync(file, buf);
}

/* --------------------------------------------------------------- 临时工程 */

/**
 * 临时工程要拷哪些模块：**从三份实现的 import 语句递归扫出来**。
 * 手写清单每次给实现加模块都会漏，扫 import 就不会漏。
 */
function moduleList() {
  const mods = new Set();
  const queue = ['build.mjs', 'verify-build.mjs', 'upload-r2.mjs'];
  while (queue.length) {
    const f = queue.pop();
    if (mods.has(f)) continue;
    mods.add(f);
    const src = fs.readFileSync(implFile(f), 'utf8');
    for (const m of src.matchAll(/from\s+['"]\.\/([\w.-]+)['"]/g)) {
      if (!mods.has(m[1])) queue.push(m[1]);
    }
  }
  return [...mods];
}

/** 搭临时工程：tools/ + site/ + .img-salt —— 三份脚本共用这一份 */
function setupProject() {
  rmrf(TMP);
  fs.mkdirSync(path.join(TMP, 'tools'), { recursive: true });

  for (const f of moduleList()) {
    fs.copyFileSync(implFile(f), path.join(TMP, 'tools', f));
  }
  // 数据文件（不是 import 的，是运行时读的）
  for (const f of ['news-taxonomy.json', 'rss.config.json', 'rss-images.json']) {
    const src = path.join(__dirname, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP, 'tools', f));
  }
  copyDir(path.join(SITE, 'site'), path.join(TMP, 'site'));
  const salt = path.join(SITE, '.img-salt');
  if (fs.existsSync(salt)) fs.copyFileSync(salt, path.join(TMP, '.img-salt'));

  // 拦住网络的夹具：真的上传时把 fetch 换掉（顺便记录「有没有发过请求」）
  fs.writeFileSync(
    path.join(TMP, 'block-net.cjs'),
    [
      "const fs = require('node:fs');",
      'globalThis.fetch = async (url) => {',
      "  const log = process.env.NET_BLOCK_LOG;",
      "  if (log) { try { fs.appendFileSync(log, String(url) + '\\n'); } catch (e) {} }",
      "  throw new Error('网络被测试夹具挡住了（本测试不允许真的上传）');",
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
}

/* --------------------------------------------------------------- 闸门 1：build.mjs */

function buildProductDir(key) {
  return path.join(TMP, 'imageroot', 'r2', BUILD_DATE, key);
}
function buildProducts(key) {
  const dir = buildProductDir(key);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^[0-9a-f]{10}_\d{3}(_t)?\.webp$/.test(f))
    .map((f) => path.join(dir, f));
}
function buildFullProduct(key) {
  const f = buildProducts(key).find((p) => /_\d{3}\.webp$/.test(p));
  return f || null;
}

function runBuild(extra = []) {
  /* 构建也用夹具把 fetch 换掉 —— 本测试**一行外网都不该碰**，
     一旦 build.mjs 想联网，这里会当场炸开（而不是悄悄发出去）。 */
  const netLog = path.join(TMP, 'net.log');
  fs.rmSync(netLog, { force: true });
  return runNode(
    [
      '--require', path.join(TMP, 'block-net.cjs'),
      path.join(TMP, 'tools', 'build.mjs'), '--date', BUILD_DATE, '--no-rss', ...extra,
    ],
    {
      env: childEnv({ IMAGE_ROOT: path.join(TMP, 'imageroot'), NET_BLOCK_LOG: netLog }),
    },
  );
}

/** 构建期间有没有发过网络请求 */
function buildNetCalls() {
  const netLog = path.join(TMP, 'net.log');
  if (!fs.existsSync(netLog)) return [];
  return fs.readFileSync(netLog, 'utf8').split('\n').filter(Boolean);
}

async function sectionBuild() {
  section('闸门 1 / build.mjs：--no-convert 复用路径（产物在，但是坏的 → 回退真转码）');

  // 源图：三个分类各 2 张
  const srcDir = path.join(TMP, 'imageroot', 'src', BUILD_DATE);
  for (const tab of ['见闻', '见她', '见笑']) {
    for (let i = 1; i <= 2; i++) {
      makePng(path.join(srcDir, tab, `${String(i).padStart(3, '0')}.png`));
    }
  }

  const r1 = runBuild([]);
  ok(r1.code === 0, 'build.mjs：第一次构建（真转码）成功', `exit=${r1.code}\n${r1.out.slice(-600)}`);
  if (r1.code !== 0) return;

  const jianxiao = buildProductDir('jianxiao');
  const made = fs.existsSync(jianxiao) ? fs.readdirSync(jianxiao).filter((f) => f.endsWith('.webp')) : [];
  ok(made.length === 4, `build.mjs：产物生成了（见笑 2 张 → 全图+缩略图共 4 个文件，实到 ${made.length} 个）`);

  const full = buildFullProduct('jianxiao');
  ok(!!full, 'build.mjs：找得到产物文件名');
  if (!full) return;

  /* --- 第 1 次复用：产物都有效 → 不该回退，也不该重转 --- */
  const untouched = buildFullProduct('jianwen');
  const untouchedMtime = untouched ? fs.statSync(untouched).mtimeMs : 0;
  const fullMtime0 = fs.statSync(full).mtimeMs;
  const r2 = runBuild(['--no-convert']);
  ok(r2.code === 0, 'build.mjs：--no-convert 复用构建成功', `exit=${r2.code}\n${r2.out.slice(-600)}`);
  ok(
    !r2.out.includes('自动回退为重新转码'),
    'build.mjs：产物都有效时 --no-convert **不**回退成真转码',
    r2.out.slice(-400),
  );
  ok(
    fs.statSync(full).mtimeMs === fullMtime0,
    'build.mjs：产物都有效时 --no-convert **没有重转**（文件没被动过）',
  );

  /* --- 第 2 次复用：一个 0 字节、一个坏文件头 → 必须回退 --- */
  const zero = buildFullProduct('jianxiao');
  const bad = buildFullProduct('jianshe');
  ok(!!zero && !!bad, 'build.mjs：找得到见笑 / 见她的产物用来改坏');
  if (!zero || !bad) return;

  fs.writeFileSync(zero, Buffer.alloc(0)); // 0 字节（线上事故的真凶）
  corruptHeader(bad); // 体积正常、文件头坏掉
  const good = buildFullProduct('jianwen');
  const goodMtime = good ? fs.statSync(good).mtimeMs : 0;

  const r3 = runBuild(['--no-convert']);
  ok(r3.code === 0, 'build.mjs：带坏产物的 --no-convert 构建仍然成功（回退成真转码）', `exit=${r3.code}\n${r3.out.slice(-600)}`);
  ok(
    r3.out.includes('自动回退为重新转码'),
    'build.mjs：0 字节 / 坏文件头的产物**触发了回退**（日志里说明了要重新转码）',
    r3.out.slice(-600),
  );
  ok(
    anyLineWith(r3.out, path.basename(zero), '自动回退为重新转码'),
    'build.mjs：回退日志指名道姓说了是哪个文件（0 字节那个）',
    r3.out.slice(-400),
  );
  ok(
    anyLineWith(r3.out, path.basename(bad), '自动回退为重新转码'),
    'build.mjs：回退日志指名道姓说了是哪个文件（坏文件头那个）',
    r3.out.slice(-400),
  );
  ok(
    lineWith(r3.out, path.basename(zero), '0 字节'),
    'build.mjs：回退日志说清了是什么问题（0 字节）',
    r3.out.slice(-400),
  );

  const zeroOk = fs.statSync(zero).size > 0;
  ok(zeroOk, 'build.mjs：0 字节的产物被重新转码，不再是空文件');
  const zeroValid = await productOk(zero);
  const badValid = await productOk(bad);
  ok(zeroValid, 'build.mjs：回退后的 0 字节产物是**有效 WebP**（读得出尺寸）');
  ok(badValid, 'build.mjs：回退后的坏文件头产物是**有效 WebP**（读得出尺寸）');
  ok(
    good && fs.statSync(good).mtimeMs === goodMtime,
    'build.mjs：只回退坏的那几个，没坏的产物**没有被重转**（不是一刀切）',
  );

  /* --- 第 3 次复用：现在都好了 → 不该再回退 --- */
  const r4 = runBuild(['--no-convert']);
  ok(r4.code === 0, 'build.mjs：修复后的 --no-convert 构建成功', `exit=${r4.code}`);
  ok(
    !r4.out.includes('自动回退为重新转码'),
    'build.mjs：产物都修好之后 --no-convert 不再回退（闸门不是一直拦）',
    r4.out.slice(-400),
  );
  const netCalls = buildNetCalls();
  ok(
    netCalls.length === 0,
    'build.mjs：整个测试里**一个网络请求都没发**（--no-rss 必须是离线的）',
    `发起了 ${netCalls.length} 个：${netCalls.slice(0, 3).join(' | ')}`,
  );
}

/* --------------------------------------------------------------- 闸门 2：verify-build.mjs */

function verifyFixture() {
  const root = path.join(TMP, 'verifyroot');
  const r2 = path.join(root, 'r2', VERIFY_DATE);
  const pubDir = path.join(TMP, 'published', VERIFY_DATE);
  rmrf(root);
  rmrf(pubDir);
  fs.mkdirSync(pubDir, { recursive: true });

  const fFull = 'a1b2c3d4e5_001.webp';
  const fThumb = 'a1b2c3d4e5_001_t.webp';
  const fRss = 'b2c3d4e5f6_001_t.webp';
  const fCover = 'c3d4e5f6a7_001.webp';

  makeWebp(path.join(r2, 'jianxiao', fFull));
  makeWebp(path.join(r2, 'jianxiao', fThumb));
  makeWebp(path.join(r2, 'rss', fRss));
  makeWebp(path.join(r2, 'covers', fCover));

  /* 日期页 + 分享图（og.jpg）——
     verify-build 现在多了一道自检：「日期页 HTML 里 og:image 指的那个文件，
     必须存在且不是 0 字节」（og.jpg 不在 manifest 里，上面那套产物自检查不到它）。
     所以这个夹具必须像一个**真实的构建产物**：有 index.html、有 og.jpg。
     ⚠️ 夹具不合格 ≠ 生产代码有洞 —— 这里补的是夹具。 */
  fs.writeFileSync(
    path.join(pubDir, 'og.jpg'),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  );
  fs.writeFileSync(
    path.join(pubDir, 'index.html'),
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
      `<meta property="og:image" content="https://example.com/${VERIFY_DATE}/og.jpg">\n` +
      '</head>\n<body></body>\n</html>\n',
    'utf8',
  );

  const manifest = {
    date: VERIFY_DATE,
    generatedAt: '2026-11-01T00:00:00.000Z',
    title: '测试',
    siteUrl: 'https://example.com',
    imageBase: '/img',
    defaultTab: 'jianxiao',
    tabs: [
      {
        key: 'jianxiao', label: '见笑', accent: '#ffb020', count: 1,
        items: [{
          id: 'jianxiao_001', w: 32, h: 32, tw: 32, th: 32,
          thumb: `/img/${VERIFY_DATE}/jianxiao/${fThumb}`,
          full: `/img/${VERIFY_DATE}/jianxiao/${fFull}`,
        }],
      },
      /* 见报配图（it.img）的核对在「tab.key === 'news'」那一支里 ——
         所以这个 tab **不能带 type**（带 type 就是文本型 tab，会被 continue 掉）。 */
      {
        key: 'news', label: '见报', accent: '#3ddc97', count: 1,
        items: [{
          title: '一条新闻', link: 'https://example.com/a', source: '示例源',
          tag: 't', tags: [], time: 0, desc: '',
          img: `/img/${VERIFY_DATE}/rss/${fRss}`,
        }],
      },
      /* 本地化封面（it.cover）在文本型 tab 里核对 */
      {
        key: 'headlines', label: '头条', accent: '#3ddc97', type: 'headlines', count: 1,
        items: [{
          title: '一条头条', link: 'https://example.com/b', source: '示例源',
          cover: `/img/${VERIFY_DATE}/covers/${fCover}`,
        }],
      },
    ],
  };
  fs.writeFileSync(
    path.join(pubDir, 'manifest.test01.js'),
    `window.__DAILY_MANIFEST__=${JSON.stringify(manifest)};\n`,
    'utf8',
  );
  return {
    root,
    r2,
    files: {
      fFull: path.join(r2, 'jianxiao', fFull),
      fThumb: path.join(r2, 'jianxiao', fThumb),
      fRss: path.join(r2, 'rss', fRss),
      fCover: path.join(r2, 'covers', fCover),
    },
  };
}

function runVerify(date) {
  return runNode(
    [path.join(TMP, 'tools', 'verify-build.mjs'), '--date', date],
    { env: childEnv({ IMAGE_ROOT: path.join(TMP, 'verifyroot') }) },
  );
}

function sectionVerify() {
  section('闸门 2 / verify-build.mjs：发布闸门（被 manifest 引用的产物必须有效）');

  const fx = verifyFixture();
  const v0 = runVerify(VERIFY_DATE);
  ok(v0.code === 0, 'verify-build.mjs：产物全都有效时自检通过', `exit=${v0.code}\n${v0.out.slice(-600)}`);

  // 0 字节的产物
  fs.writeFileSync(fx.files.fFull, Buffer.alloc(0));
  const v1 = runVerify(VERIFY_DATE);
  ok(v1.code === 1, 'verify-build.mjs：0 字节的产物让自检不通过（exit=1）', `exit=${v1.code}\n${v1.out.slice(-600)}`);
  ok(lineWith(v1.out, 'a1b2c3d4e5_001.webp', '母本里的产物'), 'verify-build.mjs：报错说清了是哪个文件', v1.out.slice(-500));
  ok(lineWith(v1.out, 'a1b2c3d4e5_001.webp', '0 字节'), 'verify-build.mjs：报错说清了是什么问题（0 字节）', v1.out.slice(-500));

  // 坏文件头的产物
  verifyFixture();
  corruptHeader(fx.files.fFull);
  const v2 = runVerify(VERIFY_DATE);
  ok(v2.code === 1, 'verify-build.mjs：坏文件头的产物让自检不通过（exit=1）', `exit=${v2.code}\n${v2.out.slice(-600)}`);
  ok(lineWith(v2.out, 'a1b2c3d4e5_001.webp', '不是有效的 WebP'), 'verify-build.mjs：报错说清了「不是有效的 WebP」', v2.out.slice(-500));

  // 文件不存在（老行为不能丢）
  verifyFixture();
  fs.rmSync(fx.files.fFull);
  const v3 = runVerify(VERIFY_DATE);
  ok(v3.code === 1, 'verify-build.mjs：产物缺失仍然让自检不通过（exit=1，老行为没丢）', `exit=${v3.code}`);
  ok(lineWith(v3.out, 'a1b2c3d4e5_001.webp', '不存在'), 'verify-build.mjs：产物缺失的报错说清了「不存在」', v3.out.slice(-500));

  // 见报配图 0 字节
  verifyFixture();
  fs.writeFileSync(fx.files.fRss, Buffer.alloc(0));
  const v4 = runVerify(VERIFY_DATE);
  ok(v4.code === 1, 'verify-build.mjs：0 字节的见报配图让自检不通过（exit=1）', `exit=${v4.code}\n${v4.out.slice(-500)}`);
  ok(lineWith(v4.out, 'b2c3d4e5f6_001_t.webp', '配图产物'), 'verify-build.mjs：配图的报错点名了是哪个文件', v4.out.slice(-400));

  // 封面 0 字节
  verifyFixture();
  fs.writeFileSync(fx.files.fCover, Buffer.alloc(0));
  const v5 = runVerify(VERIFY_DATE);
  ok(v5.code === 1, 'verify-build.mjs：0 字节的封面让自检不通过（exit=1）', `exit=${v5.code}\n${v5.out.slice(-500)}`);
  ok(lineWith(v5.out, 'c3d4e5f6a7_001.webp', '封面产物'), 'verify-build.mjs：封面的报错点名了是哪个文件', v5.out.slice(-400));
}

/* --------------------------------------------------------------- 闸门 3：upload-r2.mjs */

function uploadFixture() {
  const root = path.join(TMP, 'uploadroot');
  const dir = path.join(root, 'r2', UPLOAD_DATE, 'jianxiao');
  rmrf(root);
  const f1 = 'd4e5f6a7b8_001.webp';
  const f2 = 'e5f6a7b8c9_001.webp';
  makeWebp(path.join(dir, f1));
  makeWebp(path.join(dir, f2));
  // 夹具自检：文件必须真的在。
  // （这个工程里可能有别的会话在并发跑东西、清 tools\.tmp-* ——
  //   夹具被顺手删掉的话，后面的断言会红成「假红」，那比不测还糟。）
  for (const f of [f1, f2]) {
    if (!fs.existsSync(path.join(dir, f))) makeWebp(path.join(dir, f));
  }
  return { root, dir, f1, f2, f1Path: path.join(dir, f1), f2Path: path.join(dir, f2) };
}

function runUpload(root, args = [], { blockNet = false } = {}) {
  const spawnArgs = [];
  const env = childEnv({
    IMAGE_ROOT: root,
    CLOUDFLARE_ACCOUNT_ID: 'dummy-account',
    CLOUDFLARE_API_TOKEN: 'dummy-token',
  });
  if (blockNet) {
    const netLog = path.join(TMP, 'net.log');
    fs.rmSync(netLog, { force: true });
    env.NET_BLOCK_LOG = netLog;
    spawnArgs.push('--require', path.join(TMP, 'block-net.cjs'));
  }
  spawnArgs.push(path.join(TMP, 'tools', 'upload-r2.mjs'), ...args);
  const res = runNode(spawnArgs, { env });
  const netLog = blockNet ? path.join(TMP, 'net.log') : null;
  const netCalls = netLog && fs.existsSync(netLog)
    ? fs.readFileSync(netLog, 'utf8').split('\n').filter(Boolean)
    : [];
  return { ...res, netCalls };
}

function sectionUpload() {
  section('闸门 3 / upload-r2.mjs：坏产物不许上传');

  /* 每一组都**重新铺一遍夹具** —— 各组互不依赖，
     免得上一组留下的坏状态把下一组的结果搅浑（也扛得住夹具被并发清掉）。 */

  // 全部有效：--dry 正常
  let fx = uploadFixture();
  const u0 = runUpload(fx.root, ['--dry']);
  ok(u0.code === 0, 'upload-r2.mjs：产物全都有效时 --dry 正常（exit=0）', `exit=${u0.code}\n${u0.out.slice(-500)}`);
  ok(u0.out.includes('[dry]'), 'upload-r2.mjs：--dry 打印了上传计划', u0.out.slice(-300));
  ok(!u0.out.includes('无效'), 'upload-r2.mjs：产物都有效时不报「无效」', u0.out.slice(-300));

  // 0 字节：--dry 也要报出来
  fx = uploadFixture();
  fs.writeFileSync(fx.f1Path, Buffer.alloc(0));
  const u1 = runUpload(fx.root, ['--dry']);
  ok(u1.code !== 0, 'upload-r2.mjs：0 字节的产物让 --dry 以非 0 退出', `exit=${u1.code}\n${u1.out.slice(-500)}`);
  ok(u1.out.includes(fx.f1), 'upload-r2.mjs：--dry 的报错点名了是哪个文件', u1.out.slice(-400));
  ok(lineWith(u1.out, fx.f1, '0 字节'), 'upload-r2.mjs：--dry 的报错说清了「0 字节」', u1.out.slice(-400));

  // 坏文件头：--dry 也要报出来
  fx = uploadFixture();
  corruptHeader(fx.f1Path);
  const u2 = runUpload(fx.root, ['--dry']);
  ok(u2.code !== 0, 'upload-r2.mjs：坏文件头的产物让 --dry 以非 0 退出', `exit=${u2.code}`);
  ok(lineWith(u2.out, fx.f1, '不是有效的 WebP'), 'upload-r2.mjs：--dry 的报错说清了「不是有效的 WebP」', u2.out.slice(-400));

  /* --- 真上传路径：有坏产物时一个字节都不许发出去 --- */
  fx = uploadFixture();
  fs.writeFileSync(fx.f1Path, Buffer.alloc(0));
  const u3 = runUpload(fx.root, [], { blockNet: true });
  ok(u3.code !== 0, 'upload-r2.mjs：0 字节的产物让真上传以非 0 退出（发布停住）', `exit=${u3.code}\n${u3.out.slice(-500)}`);
  ok(
    !u3.out.includes('缺少环境变量'),
    'upload-r2.mjs：真上传的失败不是「缺少环境变量」顶替的（确实走到了有效性闸门）',
    u3.out.slice(-300),
  );
  ok(u3.out.includes(fx.f1), 'upload-r2.mjs：真上传的报错点名了是哪个文件', u3.out.slice(-400));
  ok(
    u3.netCalls.length === 0,
    'upload-r2.mjs：有坏产物时**一个网络请求都没发**（坏产物没被上传）',
    `发起了 ${u3.netCalls.length} 个请求：${u3.netCalls.slice(0, 3).join(' | ')}`,
  );
}

/* --------------------------------------------------------------- 主流程 */

async function main() {
  console.log('护栏：构建产物的有效性（三道闸门）');
  console.log(`被测实现：${IMPL_DIR}`);
  console.log(`临时工程：${TMP}`);

  if (!haveFfmpeg()) {
    console.error('\n✗ 找不到 ffmpeg —— 造不出测试用的 WebP/PNG，这个测试没法跑。');
    process.exit(1);
  }

  setupProject();

  if (SECTION === 'all' || SECTION === 'build') await sectionBuild();
  if (SECTION === 'all' || SECTION === 'verify') sectionVerify();
  if (SECTION === 'all' || SECTION === 'upload') sectionUpload();

  rmrf(TMP);

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  if (fail) {
    console.log('\n有断言没通过 —— 产物有效性闸门有缺口。');
    for (const f of failed) console.log(`   · ${f}`);
    process.exit(1);
  }
  console.log('\n产物有效性三道闸门都有牙齿。');
}

main();
