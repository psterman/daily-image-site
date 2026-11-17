#!/usr/bin/env node
/**
 * `--keep-manifest` 的功能测试。
 *
 * 为什么要有这个测试：
 *   这个开关的整个意义就是「只改前端、内容一个字都不动」。
 *   而「内容没被动过」这件事，用 grep 断言是验不出来的 ——
 *   只能真跑一遍构建，看产出的 manifest 是不是字节级不变。
 *
 * 跑法：node tools/test-keep-manifest.mjs
 *
 * 测试完全隔离：把构建脚本复制到临时目录，用临时 IMAGE_ROOT，
 * 不碰真实的 ~/image-root 和真实 published/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const TMP = path.join(SITE, 'tools', '.tmp-keep-manifest-test');
const DATE = '2026-11-04';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}
function section(t) {
  console.log(`\n── ${t}`);
}

/* --------------------------------------------------------------- 临时工程 */

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

/**
 * 临时工程要拷哪些模块：**从 build.mjs 的 import 语句递归扫出来**。
 * 手写清单每次给 build.mjs 加模块都会漏（加 news-dedupe.mjs 时就漏了一次，
 * 两个集成测试一起红），扫 import 就不会漏。
 * 必须是递归的 —— paths.mjs 自己还 import 了 env.mjs（只看一层照样漏）。
 */
function buildModuleList() {
  const mods = new Set(['build.mjs']);
  const queue = ['build.mjs'];
  while (queue.length) {
    const f = queue.pop();
    if (!/\.mjs$/.test(f)) continue;
    const src = fs.readFileSync(path.join(SITE, 'tools', f), 'utf8');
    for (const m of src.matchAll(/from\s+['"]\.\/([\w.-]+)['"]/g)) {
      if (!mods.has(m[1])) {
        mods.add(m[1]);
        queue.push(m[1]);
      }
    }
  }
  mods.add('news-taxonomy.json'); // 不是 import 的数据文件（分类真相源）
  return [...mods];
}

function setupProject() {
  rmrf(TMP);
  fs.mkdirSync(path.join(TMP, 'tools'), { recursive: true });

  // 构建脚本 + 它 import 的模块（清单从 import 语句扫出来，不会漏）
  for (const f of buildModuleList()) {
    fs.copyFileSync(path.join(SITE, 'tools', f), path.join(TMP, 'tools', f));
  }
  const cfg = path.join(SITE, 'tools', 'rss.config.json');
  if (fs.existsSync(cfg)) fs.copyFileSync(cfg, path.join(TMP, 'tools', 'rss.config.json'));

  // 前端资源
  copyDir(path.join(SITE, 'site'), path.join(TMP, 'site'));

  // 随机盐：图片 URL 里的不可猜段要用
  const salt = path.join(SITE, '.img-salt');
  if (fs.existsSync(salt)) fs.copyFileSync(salt, path.join(TMP, '.img-salt'));

  // 源图 + 头条数据（放在临时 IMAGE_ROOT 下）
  const imgRoot = path.join(TMP, 'imageroot');
  const srcDir = path.join(imgRoot, 'src', DATE);
  const tabs = { 见闻: '0x4a8cff', 见她: '0xff6b9d', 见笑: '0xffb020' };
  for (const [tab, color] of Object.entries(tabs)) {
    const dir = path.join(srcDir, tab);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 2; i++) {
      const out = path.join(dir, `${String(i).padStart(3, '0')}.png`);
      execFileSync('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=${color}:s=64x64`,
        '-frames:v', '1', out,
      ], { stdio: 'pipe' });
    }
  }
  writeHeadlines(srcDir, ['第一条', '第二条']);
  return imgRoot;
}

function writeHeadlines(srcDir, titles) {
  const dir = path.join(srcDir, 'headlines');
  fs.mkdirSync(dir, { recursive: true });
  const items = titles.map((t, i) => ({
    title: t,
    link: `https://example.com/${i}`,
    source: i % 2 === 0 ? '知乎热榜' : '微博热搜',
    category: i % 2 === 0 ? '知乎' : '微博',
  }));
  fs.writeFileSync(
    path.join(dir, `headlines_${DATE}.json`),
    JSON.stringify({ ts: Date.now(), items }, null, 2),
    'utf8'
  );
}

/* --------------------------------------------------------------- 跑构建 */

function runBuild(extra = []) {
  const args = [
    path.join(TMP, 'tools', 'build.mjs'),
    '--date', DATE,
    '--no-rss',
    ...extra,
  ];
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: TMP,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, IMAGE_ROOT: path.join(TMP, 'imageroot') },
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    return {
      code: e.status ?? -1,
      out: (e.stdout || '') + (e.stderr || ''),
      err: (e.stdout || '') + (e.stderr || ''),
    };
  }
}

const pubDir = () => path.join(TMP, 'published', DATE);
function manifestFile() {
  const f = fs.readdirSync(pubDir()).find((n) => /^manifest\..*\.js$/.test(n));
  return f ? path.join(pubDir(), f) : null;
}
function manifestBytes() {
  const f = manifestFile();
  return f ? fs.readFileSync(f) : null;
}
function dayHtml() {
  return fs.readFileSync(path.join(pubDir(), 'index.html'), 'utf8');
}

/* --------------------------------------------------------------- 测试 */

function main() {
  console.log('--keep-manifest 功能测试');
  console.log(`临时工程：${TMP}`);

  section('准备临时工程（不碰真实目录）');
  setupProject();
  ok(fs.existsSync(path.join(TMP, 'tools', 'build.mjs')), '构建脚本已复制');
  ok(fs.existsSync(path.join(TMP, 'imageroot', 'src', DATE, '见笑')), '测试源图已生成');

  section('第 1 次构建：正常构建，作为基线');
  const r1 = runBuild();
  ok(r1.code === 0, `构建成功（exit=${r1.code}）`);
  const m1 = manifestBytes();
  const m1Name = path.basename(manifestFile() || '');
  ok(!!m1, `产出 manifest（${m1Name}）`);
  ok(r1.out.includes('头条 2 条'), '头条内容进了 manifest');
  const html1 = dayHtml();
  ok(html1.includes(m1Name), '页面引用了这份 manifest');

  section('第 2 次构建：--keep-manifest，内容必须字节级不变');
  const r2 = runBuild(['--keep-manifest']);
  ok(r2.code === 0, `构建成功（exit=${r2.code}）`);
  const m2 = manifestBytes();
  const m2Name = path.basename(manifestFile() || '');
  ok(!!m2 && m1.equals(m2), 'manifest 字节完全一致');
  ok(m1Name === m2Name, `manifest 文件名没变（内容哈希一致 -> ${m1Name}）`);
  ok(r2.out.includes('沿用已发布的 manifest'), '日志说明了沿用旧 manifest');
  ok(r2.out.includes('图片与已发布版本完全一致'), '日志说明了图片比对通过');
  const html2 = dayHtml();
  ok(html2.includes(m2Name), '页面仍然引用同一份 manifest');
  const jsRef = (html2.match(/src="(app\.[a-z0-9]+\.js)"/) || [])[1];
  const cssRef = (html2.match(/href="(app\.[a-z0-9]+\.css)"/) || [])[1];
  ok(!!jsRef && fs.existsSync(path.join(pubDir(), jsRef)), `页面引用的 app.js 真实存在（${jsRef}）`);
  ok(!!cssRef && fs.existsSync(path.join(pubDir(), cssRef)), `页面引用的 app.css 真实存在（${cssRef}）`);
  ok(
    !!jsRef && fs.readFileSync(path.join(pubDir(), jsRef), 'utf8') === fs.readFileSync(path.join(SITE, 'site', 'app.js'), 'utf8'),
    'app.js 内容 = 最新的 site/app.js（前端确实换了）'
  );

  section('第 3 次构建：内容源变了，--keep-manifest 也不能跟着变');
  writeHeadlines(path.join(TMP, 'imageroot', 'src', DATE), ['第一条', '第二条', '第三条（新增）']);
  const r3 = runBuild(['--keep-manifest']);
  ok(r3.code === 0, `构建成功（exit=${r3.code}）`);
  const m3 = manifestBytes();
  ok(!!m3 && m1.equals(m3), 'manifest 仍然字节一致（新增的第三条没有混进来）');
  ok(!m3.toString('utf8').includes('第三条'), '新增内容确实没进 manifest');

  section('第 4 次构建：图片被动过，--keep-manifest 必须拒绝');
  const seeSmile = path.join(TMP, 'imageroot', 'src', DATE, '见笑');
  fs.rmSync(path.join(seeSmile, '002.png'));
  const r4 = runBuild(['--keep-manifest']);
  ok(r4.code !== 0, `构建被拒绝（exit=${r4.code}）`);
  ok(r4.out.includes('图片跟已发布的 manifest 对不上'), '报出了「图片对不上」');
  ok(r4.out.includes('少了一张'), '指名道姓说是哪一张');

  section('第 5 次构建：普通构建（不加 --keep-manifest）仍能正常跑');
  const r5 = runBuild();
  ok(r5.code === 0, `构建成功（exit=${r5.code}）`);
  ok(r5.out.includes('头条 3 条'), '普通构建读到了新增的内容（说明第 3 步的差异是真的）');

  section('publish.ps1 的接线');
  {
    // 少这一步，publish.ps1 里的开关就是个摆设：
    // 参数声明了但没传给 build.mjs，发布时就会走普通构建 —— 内容被换掉，没人知道。
    const ps = fs.readFileSync(path.join(SITE, 'tools', 'publish.ps1'), 'utf8');
    ok(/\[switch\]\$KeepManifest/.test(ps), 'publish.ps1 声明了 -KeepManifest 开关');
    ok(
      /if \(\$KeepManifest\) \{ \$buildArgs \+= @\('--keep-manifest'\) \}/.test(ps),
      'publish.ps1 把 --keep-manifest 传给了 build.mjs'
    );
  }

  section('清理');
  rmrf(TMP);
  ok(!fs.existsSync(TMP), '临时工程已删除');

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  if (fail) {
    console.log('\n有断言没通过 —— --keep-manifest 的行为跟预期不一致。');
    process.exit(1);
  }
  console.log('\n--keep-manifest 行为符合预期。');
}

main();
