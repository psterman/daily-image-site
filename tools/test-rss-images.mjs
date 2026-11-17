#!/usr/bin/env node
/**
 * 见报配图的护栏。
 *
 * 测两块：
 *   1) extractImages —— 从 feed 里抠候选图的规则（形态优先级、相对路径、去重、丢弃非 http）
 *   2) fetchRssImages —— 真下载 + 真转码 + 真筛选（本地起 http 服务喂假源）
 *
 * 为什么第 2 块要用真 ffmpeg：
 *   这套逻辑的判定全在「下载下来的字节」上 —— 太小、比例太极端、转码失败，
 *   用假实现测等于没测（断言会变成永远绿的空壳）。
 *
 * 跑法：node tools/test-rss-images.mjs
 */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractImages } from './fetch-rss.mjs';
import { fetchRssImages } from './rss-images.mjs';
import { HEADLINE_SOURCES } from './headlines.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * 从线上代理源码里抠出图片路径正则 —— **不许手抄**。
 *
 * 手抄的那份会自己漂移：改了代理忘了改测试，测试照样绿，
 * 而线上 404。这正是这次踩到的坑（配图目录多排了一层 rss/，
 * 代理的正则认不出来，全裂且不报错）。
 */
function grabProxyPathRe() {
  const src = readFileSync(path.join(ROOT, 'functions', 'img', '[[path]].js'), 'utf8');
  const m = src.match(/key\.match\(\/(.+?)\/\)/);
  if (!m) throw new Error('抠不到 /img/[[path]].js 的路径正则');
  return new RegExp(m[1]);
}

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}\n      期望 ${b}\n      实际 ${a}`);
  }
}
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}

/* ────────────────── 1. extractImages ────────────────── */

section('extractImages —— 候选图的收集规则');

const BASE = 'https://feed.example.com/rss';

eq(
  'enclosure 优先于内联 img',
  extractImages(
    '<item><enclosure url="https://cdn.example.com/a.jpg" type="image/jpeg"/>' +
      '<description>&lt;img src="https://cdn.example.com/inline.jpg"/&gt;</description></item>',
    BASE,
  ).map((x) => x.kind),
  ['enclosure', 'inline'],
);

eq(
  '非图片类型的 enclosure 不收',
  extractImages(
    '<item><enclosure url="https://cdn.example.com/a.mp3" type="audio/mpeg"/></item>',
    BASE,
  ),
  [],
);

eq(
  'media:thumbnail 收、media:content 按 medium 判',
  extractImages(
    '<item>' +
      '<media:thumbnail url="https://cdn.example.com/t.jpg"/>' +
      '<media:content url="https://cdn.example.com/v.mp4" medium="video"/>' +
      '<media:content url="https://cdn.example.com/c.jpg" medium="image"/>' +
      '</item>',
    BASE,
  ).map((x) => x.kind),
  ['media-thumb', 'media-content'],
);

eq(
  'RSS 1.0 的 <image><url> 收',
  extractImages(
    '<item><image><url>https://cdn.example.com/rss1.jpg</url></image></item>',
    BASE,
  ).map((x) => x.url),
  ['https://cdn.example.com/rss1.jpg'],
);

eq(
  '相对路径按 feed 地址补全',
  extractImages('<item><enclosure url="/uploads/a.jpg" type="image/jpeg"/></item>', BASE).map((x) => x.url),
  ['https://feed.example.com/uploads/a.jpg'],
);

eq(
  '协议相对地址补成 https',
  extractImages('<item><enclosure url="//cdn.example.com/a.jpg" type="image/jpeg"/></item>', BASE).map((x) => x.url),
  ['https://cdn.example.com/a.jpg'],
);

eq(
  'data: 地址丢掉',
  extractImages('<item><enclosure url="data:image/gif;base64,R0lGOD" type="image/gif"/></item>', BASE),
  [],
);

eq(
  '同一个地址只留一次',
  extractImages(
    '<item><enclosure url="https://cdn.example.com/a.jpg" type="image/jpeg"/>' +
      '<media:content url="https://cdn.example.com/a.jpg" medium="image"/></item>',
    BASE,
  ).length,
  1,
);

eq(
  'data-src 比 src 更优先',
  extractImages(
    '<item><description>&lt;img src="https://cdn.example.com/low.jpg" data-src="https://cdn.example.com/high.jpg"/&gt;</description></item>',
    BASE,
  ).map((x) => x.url),
  ['https://cdn.example.com/high.jpg'],
);

eq(
  '候选最多留 8 个',
  extractImages(
    '<item><description>' +
      Array.from({ length: 20 }, (_, i) => `&lt;img src="https://cdn.example.com/${i}.jpg"/&gt;`).join('') +
      '</description></item>',
    BASE,
  ).length,
  8,
);

/* ────────────────── 2. fetchRssImages（真下载 + 真转码） ────────────────── */

section('fetchRssImages —— 下载 / 转码 / 筛选');

/* 找 ffmpeg —— 跟 build.mjs 一样从 PATH 和常见位置找。
 * Windows 用 `where`（cmd.exe 内建命令），macOS/Linux 用 `which`（那边没有 `where`）；
 * 可执行文件名也跟着平台走：Windows 是 ffmpeg.exe，macOS/Linux 是 ffmpeg。 */
async function findFfmpeg() {
  const isWin = process.platform === 'win32';
  const candidates = [];
  try {
    const { stdout } = isWin
      ? await execFileAsync('where', ['ffmpeg'], { shell: 'cmd.exe' })
      : await execFileAsync('which', ['ffmpeg']);
    candidates.push(...stdout.split(/\r?\n/).filter(Boolean));
  } catch { /* 不在 PATH */ }
  if (isWin) {
    candidates.push(
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages'),
      'C:\\Program Files\\ffmpeg\\bin',
      'C:\\ffmpeg\\bin',
    );
  } else {
    candidates.push(
      '/opt/homebrew/bin',        // Apple Silicon 上的 Homebrew
      '/usr/local/bin',           // Intel 上的 Homebrew
      '/opt/local/bin',           // MacPorts
      '/usr/bin',                 // 系统自带目录
    );
  }
  const exeName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  for (const c of candidates) {
    /* c 要么已经是可执行文件的完整路径（where / which 给的就是这种），
     * 要么是个目录 —— 目录得再拼一个文件名。 */
    let exe;
    try {
      exe = (await fs.stat(c)).isFile() ? c : path.join(c, exeName);
    } catch {
      exe = path.join(c, exeName);
    }
    try {
      await fs.access(exe);
      /* Windows 上原来只在「c 本身就是 .exe 文件」时才认
       * （目录候选项要另走下面 winget 那条线），非 Windows 上 c 是文件就认。 */
      if (isWin ? c.toLowerCase().endsWith('.exe') : true) return exe;
    } catch { /* 继续找 */ }
  }
  // WinGet 的包目录名带版本号，单独扫一遍（只有 Windows 有这回事）
  if (isWin) {
    const wingetRoot = candidates[1];
    try {
      for (const pkg of await fs.readdir(wingetRoot)) {
        if (!pkg.toLowerCase().includes('ffmpeg')) continue;
        const exe = path.join(wingetRoot, pkg, 'ffmpeg-9.0.2-full_build', 'bin', 'ffmpeg.exe');
        try {
          await fs.access(exe);
          return exe;
        } catch { /* 继续找 */ }
      }
    } catch { /* 没有 winget 目录 */ }
  }
  return null;
}

const ffmpeg = await findFfmpeg();
if (!ffmpeg) {
  console.log('\n  ! 找不到 ffmpeg，跳过下载/转码那部分（其余断言照跑）');
} else {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rssimg-test-'));

  // 造几张测试图：正常图 / 极小图 / 极宽的横幅 / 大图
  // 「大图」必须用**随机噪声** —— 纯色图压得极小（800x600 的纯红 JPEG 才几 KB），
  // 拿纯色图测「体积上限」这条断言会变成永远绿的空壳。
  const big = path.join(tmp, 'big.jpg');
  const small = path.join(tmp, 'small.jpg');
  const banner = path.join(tmp, 'banner.jpg');
  const huge = path.join(tmp, 'huge.png');
  await execFileAsync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=800x600', '-frames:v', '1', big]);
  await execFileAsync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=40x30', '-frames:v', '1', small]);
  await execFileAsync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=2000x100', '-frames:v', '1', banner]);
  await execFileAsync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=600x400,geq=random(1)*255:128:128', '-frames:v', '1', huge]);

  // 本地 http 服务：按路径给不同的回答
  const seenReferer = [];
  const server = http.createServer(async (req, res) => {
    const u = req.url.split('?')[0];
    seenReferer.push({ url: u, referer: req.headers.referer || '' });
    if (u === '/ok.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(await fs.readFile(big));
    } else if (u === '/tiny.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(await fs.readFile(small));
    } else if (u === '/banner.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(await fs.readFile(banner));
    } else if (u === '/huge.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(await fs.readFile(huge));
    } else if (u === '/403.jpg') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
    } else if (u === '/notimage.txt') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>anti-bot</html>');
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const outDir = path.join(tmp, 'out');
  const items = [
    // 0: 第一张候选是 403，应自动退到第二张（正常图）
    { source: '源A', link: `${base}/article/1`, imgs: [{ url: `${base}/403.jpg`, kind: 'enclosure' }, { url: `${base}/ok.jpg`, kind: 'enclosure' }] },
    // 1: 图太小，应被尺寸筛掉
    { source: '源A', link: `${base}/article/2`, imgs: [{ url: `${base}/tiny.jpg`, kind: 'enclosure' }] },
    // 2: 横幅（比例 20:1），应被比例筛掉
    { source: '源A', link: `${base}/article/3`, imgs: [{ url: `${base}/banner.jpg`, kind: 'enclosure' }] },
    // 3: 不是图片，应被跳过
    { source: '源A', link: `${base}/article/4`, imgs: [{ url: `${base}/notimage.txt`, kind: 'inline' }] },
    // 4: 原图太大（1600x1200 但配置 maxBytes 小），应被体积筛掉
    { source: '源A', link: `${base}/article/5`, imgs: [{ url: `${base}/huge.jpg`, kind: 'enclosure' }] },
    // 5: 源不在白名单里，应被跳过
    { source: '源B', link: `${base}/article/6`, imgs: [{ url: `${base}/ok.jpg`, kind: 'enclosure' }] },
    // 6: 正常图
    { source: '源A', link: `${base}/article/7`, imgs: [{ url: `${base}/ok.jpg`, kind: 'enclosure' }] },
    // 7: **头条来源**的条目（虎扑步行街不在 rss.config.json 里，是 daily_headlines.py 抓的，
    //    候选图由 Python 侧逐条抓条目页抠出来）。它必须跟 RSS 源走**同一条**流水线配到图 ——
    //    形状对不上（cand.url / cand.kind）就会静默下不到图。
    { source: '虎扑步行街', link: `${base}/article/8`, imgs: [{ url: `${base}/ok.jpg`, kind: 'inline' }] },
  ];

  const res = await fetchRssImages({
    items,
    date: '2026-11-11',
    outDir,
    ffmpeg,
    salt: 'test-salt-fixed-0123456789',
    imageBase: '/img',
    config: {
      sources: ['源A', '虎扑步行街'],
      maxWidth: 400,
      quality: 78,
      timeoutMs: 8000,
      maxBytes: 40000,     // 故意压小，让 huge.jpg（远大于）被体积筛掉
      minWidth: 120,
      minHeight: 80,
      maxHeight: 900,
      maxTries: 3,
      concurrency: 3,
    },
  });

  eq('选中的条目数（0、6、7 命中）', res.map.size, 3);
  ok('403 的条目退到第二张候选并成功', res.map.has(0), `map=${JSON.stringify([...res.map])}`);
  ok('太小的那条没被选中', !res.map.has(1));
  ok('横幅没被选中', !res.map.has(2));
  ok('非图片没被选中', !res.map.has(3));
  ok('超出体积上限的没被选中', !res.map.has(4));
  ok('白名单外的源被跳过', !res.map.has(5));
  ok('正常条目被选中', res.map.has(6));
  ok('头条来源的条目也配到了图', res.map.has(7), `map=${JSON.stringify([...res.map])}`);

  const picked = res.map.get(6);
  ok('URL 前缀正确（/img/<日期>/rss/）', typeof picked === 'string' && picked.startsWith('/img/2026-11-11/rss/'), picked);
  ok('URL 以 _t.webp 结尾', typeof picked === 'string' && picked.endsWith('_t.webp'), picked);

  /* ── 落盘文件名与 URL 必须跟**线上代理的路径规则**严丝合缝 ──
     配图目录一旦多排一层或少一层，代理会静默 404 —— 页面裂图、不报错、
     也没人知道是为什么。这条断言就是那道闸门。 */
  const proxyPathRe = grabProxyPathRe();
  const pickedKey = typeof picked === 'string' ? picked.replace(/^\/img\//, '') : '';
  ok('URL 的路径部分能被线上代理的正则认出来', proxyPathRe.test(pickedKey), `${pickedKey} vs ${proxyPathRe}`);
  ok('文件名符合 <10位hex>_001_t.webp', /^[0-9a-f]{10}_001_t\.webp$/.test(path.basename(pickedKey)), pickedKey);
  ok('随机段用的是 10 位小写 hex', /^[0-9a-f]{10}$/.test(path.basename(pickedKey).slice(0, 10)), pickedKey);

  /* ── 随机段必须由**盐**决定，而不是由图片地址裸哈希 ──
     站点的一条硬约定：图片路径不可枚举。
     配图如果用裸哈希，同一张图换一天抓就换名字（勉强可接受），
     但更重要的是「跟照片共用一份盐」—— 两套随机段等于留一半口子。 */
  {
    const one = [{ source: '源A', link: `${base}/article/9`, imgs: [{ url: `${base}/ok.jpg`, kind: 'enclosure' }] }];
    const cfg = { sources: ['源A'], maxWidth: 400, quality: 78, timeoutMs: 8000, maxBytes: 40000, minWidth: 120, minHeight: 80, maxHeight: 900, maxTries: 3, concurrency: 1 };
    const a = await fetchRssImages({ items: one, date: '2026-11-11', outDir: path.join(tmp, 'saltA'), ffmpeg, salt: 'salt-A', imageBase: '/img', config: cfg });
    const b = await fetchRssImages({ items: one, date: '2026-11-11', outDir: path.join(tmp, 'saltB'), ffmpeg, salt: 'salt-A', imageBase: '/img', config: cfg });
    const c = await fetchRssImages({ items: one, date: '2026-11-11', outDir: path.join(tmp, 'saltC'), ffmpeg, salt: 'salt-B', imageBase: '/img', config: cfg });
    ok('同一个盐 + 同一张图 = 同一个 URL（链接不会因为重抓就变）', a.map.get(0) === b.map.get(0), `${a.map.get(0)} vs ${b.map.get(0)}`);
    ok('换盐 = 换随机段（路径不可枚举）', a.map.get(0) !== c.map.get(0), `${a.map.get(0)} vs ${c.map.get(0)}`);
  }

  const files = await fs.readdir(outDir);
  ok('落盘的文件都是 .webp', files.every((f) => f.endsWith('.webp')), files.join(','));
  ok('没有残留临时文件', files.every((f) => !f.startsWith('.tmp-')), files.join(','));

  // 产物真的是 webp 且宽度 = 400
  const one = path.join(outDir, files[0]);
  const head = await fs.readFile(one);
  ok('产物是 WebP（RIFF....WEBP 头）', head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP');
  const { stdout } = await execFileAsync(ffmpeg.replace(/ffmpeg\.exe$/, 'ffprobe.exe'), [
    '-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', one,
  ]);
  eq('宽度缩到 400', stdout.trim().split(',')[0], '400');

  ok('请求带上了 Referer（防盗链要靠它）', seenReferer.some((r) => r.referer.startsWith(base)), JSON.stringify(seenReferer.slice(0, 3)));

  server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

/* ────────────────── 3. 白名单 ↔ 源列表必须对得上 ────────────────── */

section('配图白名单 —— 源名拼错不会报错，只会静默不出图');

{
  const rssCfg = JSON.parse(readFileSync(path.join(ROOT, 'tools', 'rss.config.json'), 'utf8'));
  const imgCfg = JSON.parse(readFileSync(path.join(ROOT, 'tools', 'rss-images.json'), 'utf8'));
  const feedNames = new Set(rssCfg.feeds.map((f) => f.name));

  /* 源名重名 = 两个 feed 抢同一个名字。
     归属靠源名算（news-taxonomy.json 的 sourceCategory），
     重名会让「这个源到底算哪个分类」变成随抓取顺序定的 —— 每天飘。 */
  const all = rssCfg.feeds.map((f) => f.name);
  const dup = [...new Set(all.filter((n, i) => all.indexOf(n) !== i))];
  eq('rss.config.json 里没有重名源', dup, []);

  /* 白名单里的每个源名都必须真实存在。
     拼错一个字母 → `allow.has(it.source)` 永远不匹配 → 那个源一张图都不出，
     而构建日志只写「非白名单源 N 条」，**看不出是拼错了还是它真的没图**。
     这是典型的「静默失败」，必须由配置对账来挡。

     源名有两个来源，都得认：
       · rss.config.json 的 feeds[]   —— RSS 源（构建期实时抓）
       · headlines.mjs 的 HEADLINE_SOURCES —— 头条源（daily_headlines.py 抓的，
         候选图由 Python 侧逐条抓条目页抠出来，写进 headlines JSON 的 imgs）
     只认 RSS 源的话，「虎扑步行街」这种头条源就配不了图。 */
  const headlineNames = new Set(HEADLINE_SOURCES);
  const missing = (imgCfg.sources || []).filter(
    (s) => !feedNames.has(s) && !headlineNames.has(s),
  );
  eq('白名单里的源名都存在（RSS 源或头条源）', missing, []);

  /* 头条源名拼错同样要被抓 —— 单独再对一次，
     免得「RSS 源里有同名」这种巧合把错误掩盖过去。 */
  const headlineOnly = (imgCfg.sources || []).filter((s) => !feedNames.has(s));
  const badHeadline = headlineOnly.filter((s) => !headlineNames.has(s));
  eq('白名单里的「非 RSS 源」必须是真头条源', badHeadline, []);

  /* 白名单非空，且不能把全部源都放进来 ——
     名单越大，每期下载的候选图越多（实测 59 源全放 = 候选 1034 张），
     构建时间会成倍涨。全放等于没筛。 */
  ok('白名单非空', (imgCfg.sources || []).length > 0, (imgCfg.sources || []).length);
  ok(
    '白名单没有大到等于「全放」',
    (imgCfg.sources || []).length < rssCfg.feeds.length,
    { 白名单: (imgCfg.sources || []).length, 全部源: rssCfg.feeds.length },
  );

  /* 白名单里的源必须是真能出图的 —— 但这一条只能靠实测（出图率），
     配置本身证明不了。所以这里只守住「名字对得上」，出图率靠专项探针。 */
  console.log(`  · 白名单 ${(imgCfg.sources || []).length} 个源 / 全部 ${rssCfg.feeds.length} 个源`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
