#!/usr/bin/env node
/**
 * 头条 JSON 新鲜度的单元测试
 *
 * 用法：node tools/test-headlines.mjs
 * 退出码：0 = 全过；1 = 有失败
 *
 * 为什么要有这组用例（2026-11-11 实测）：
 *   线上「见报」有两条内容来源 —— RSS（构建期实时重抓）和头条（构建期**只读快照**）。
 *   头条那份是 `daily_headlines.py` 早上 07:35 抓的 JSON，构建**不重抓**，
 *   于是当天一整天，微博热搜 / V2EX 热榜 / 虎扑 / 驱动之家这 4 个源（139~142 条，
 *   占见报近四成、并且**全部**落在默认第一档「热议」）都带着 07:35 的旧时间戳。
 *   症状：用户打开站说「不是最新」，但构建日志一路「成功」、线上文件与本地字节级一致 ——
 *   部署是对的，**是内容本身就是旧的**。
 *
 *   所以要有一条断言：**当天那份头条过期时，构建必须喊出来**，而不是静默发出去。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadHeadlines, STALE_HEADLINES_MS, HEADLINE_SOURCES } from './headlines.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 本机有没有 python（没有就跳过 Python 侧的断言，不让整套测试挂掉） */
async function hasPython() {
  return new Promise((resolve) => {
    const p = spawn('python', ['--version'], { cwd: ROOT });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

/** 真跑一段 python，把 stdin 喂进去，stdout 收回来 */
function runPython(code, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', ['-c', code], { cwd: ROOT });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`python exit ${code}: ${err}`)),
    );
    child.stdin.end(stdin);
  });
}

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  -> ' + extra : ''}`);
  }
}

/** 抓 console.log 的输出，用来断言「有没有告警」（loadHeadlines 是 async，要 await） */
async function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const r = await fn();
    return { r, lines };
  } finally {
    console.log = orig;
  }
}

/** 造一份 headlines JSON（结构跟 daily_headlines.py 落的��致） */
async function writeJson(dir, date, ageMs) {
  const ts = Date.now() - ageMs;
  const json = {
    generatedAt: new Date(ts).toISOString(),
    ts: Math.floor(ts / 1000), // Python 落的是秒
    date,
    sources: ['微博热搜'],
    items: [
      { title: '热榜条目一', link: 'https://example.com/a', source: '微博热搜', category: '微博' },
      { title: '热榜条目二', link: 'https://example.com/b', source: '微博热搜', category: '微博' },
    ],
  };
  await fs.mkdir(path.join(dir, 'headlines'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'headlines', `headlines_${date}.json`),
    JSON.stringify(json),
    'utf8',
  );
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'headlines-test-'));
const TODAY = '2026-11-11';
const YESTERDAY = '2026-11-10';

try {
  /* ────────────────── 1. 当天、刚抓的 → 不该告警 ────────────────── */
  console.log('\n新鲜的头条');
  {
    await writeJson(tmp, TODAY, 60 * 1000); // 1 分钟前
    const { r, lines } = await capture(() => loadHeadlines(tmp, TODAY));
    check('读到了 2 条', r && r.items.length === 2, r ? `实际=${r.items.length}` : '返回 null');
    check('ageMs 在 1 分钟左右', r && r.ageMs > 0 && r.ageMs < 5 * 60 * 1000, r ? `ageMs=${r.ageMs}` : '');
    check('没有过期告警', !lines.some((l) => l.includes('已过')), lines.join(' | '));
    check('标记为当天文件', r && r.sameDayFile === true);
  }

  /* ────────────────── 2. 当天、5 小时前 → 必须告警 ────────────────── */
  console.log('\n过期了但没刷新（今天踩到的那种）');
  {
    await writeJson(tmp, TODAY, 5 * 60 * 60 * 1000); // 5 小时前
    const { r, lines } = await capture(() => loadHeadlines(tmp, TODAY));
    const warn = lines.find((l) => l.includes('已过'));
    check('有告警', !!warn, lines.join(' | '));
    check('告警里写了旧了多久', !!warn && warn.includes('300 分钟'), warn || '没有告警');
    check('告警里点了是哪些源', !!warn && warn.includes('微博热搜'), warn || '没有告警');
    check('告警里给了刷新命令', !!warn && warn.includes('daily_headlines.py'), warn || '没有告警');
    check('仍然照常返回条目（只是告警，不该中断构建）', r && r.items.length === 2);
    check('ageMs 反映真实年龄', r && r.ageMs > 4.5 * 60 * 60 * 1000, r ? `ageMs=${r.ageMs}` : '');
  }

  /* ────────────────── 3. 阈值边界：刚好在阈值内 → 不告警 ────────────────── */
  console.log('\n阈值边界');
  {
    await writeJson(tmp, TODAY, STALE_HEADLINES_MS - 60 * 1000); // 比阈值少 1 分钟
    const { lines } = await capture(() => loadHeadlines(tmp, TODAY));
    check('阈值内不告警', !lines.some((l) => l.includes('已过')), lines.join(' | '));
  }
  {
    await writeJson(tmp, TODAY, STALE_HEADLINES_MS + 60 * 1000); // 比阈值多 1 分钟
    const { lines } = await capture(() => loadHeadlines(tmp, TODAY));
    check('刚过阈值就告警', lines.some((l) => l.includes('已过')), lines.join(' | '));
  }

  /* ────────────────── 4. 非当天的文件（重建往期）→ 不该按「过期」喊 ────────────────── */
  console.log('\n重建往期（用的是别的日期那份）');
  {
    const { r, lines } = await capture(() => loadHeadlines(tmp, YESTERDAY));
    check('退回用了最新那份', r && r.items.length === 2, r ? `实际=${r.items.length}` : '返回 null');
    check('标记为非当天文件', r && r.sameDayFile === false);
    check('不按过期告警（往期本来就是旧内容）', !lines.some((l) => l.includes('已过')), lines.join(' | '));
  }

  /* ────────────────── 5. 没有 headlines 目录 → 返回 null（老行为不回归） ────────────────── */
  console.log('\n没有 headlines 目录');
  {
    const empty = path.join(tmp, 'nothing-here');
    await fs.mkdir(empty, { recursive: true });
    const { r } = await capture(() => loadHeadlines(empty, TODAY));
    check('返回 null（见报退化成只有 RSS）', r === null, r ? '不是 null' : '');
  }

  /* ────────────────── 6. 头条候选配图：JS 侧映射 ──────────────────
     头条的图是 Python 抓取器逐条抓条目页抠出来的，写在 headlines JSON 的 imgs 字段。
     JS 侧要做的是**原样搬过去，形状不能变** ——
     rss-images.mjs 直接读 cand.url / cand.kind，形状对不上会静默拿到 undefined，
     图一张都下不下来，而且**不报错**。 */
  console.log('\n头条候选配图的映射');
  {
    const dir = path.join(tmp, 'img-map');
    await fs.mkdir(path.join(dir, 'headlines'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'headlines', `headlines_${TODAY}.json`),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        ts: Math.floor(Date.now() / 1000),
        date: TODAY,
        sources: [],
        items: [
          { title: '带图的条目', link: 'https://a.example.com/1', source: '虎扑步行街', category: '社区',
            imgs: [{ url: 'https://cdn.example.com/a.jpg', kind: 'inline' }] },
          { title: '写成裸字符串的条目', link: 'https://a.example.com/2', source: '驱动之家', category: '科技',
            imgs: ['https://cdn.example.com/b.jpg'] },
          { title: '没有图的条目', link: 'https://a.example.com/3', source: '微博热搜', category: '微博' },
          { title: '非法的图地址', link: 'https://a.example.com/4', source: '微博热搜', category: '微博',
            imgs: [{ url: 'javascript:alert(1)', kind: 'inline' }, { url: 'https://cdn.example.com/c.jpg' }] },
        ],
      }),
      'utf8',
    );
    const r = await loadHeadlines(dir, TODAY);
    const byTitle = Object.fromEntries(r.items.map((i) => [i.title, i]));

    check('带图的条目把候选搬了过来', byTitle['带图的条目'].imgs.length === 1);
    check('形状是 {url, kind}',
      byTitle['带图的条目'].imgs[0].url === 'https://cdn.example.com/a.jpg' &&
      byTitle['带图的条目'].imgs[0].kind === 'inline',
      JSON.stringify(byTitle['带图的条目'].imgs[0]));
    check('裸字符串也归一成 {url, kind}',
      byTitle['写成裸字符串的条目'].imgs[0] &&
      byTitle['写成裸字符串的条目'].imgs[0].url === 'https://cdn.example.com/b.jpg' &&
      byTitle['写成裸字符串的条目'].imgs[0].kind === 'inline',
      JSON.stringify(byTitle['写成裸字符串的条目'].imgs));
    check('没有图的条目 imgs 是空数组', Array.isArray(byTitle['没有图的条目'].imgs) && byTitle['没有图的条目'].imgs.length === 0);
    check('javascript: 这种地址被滤掉',
      byTitle['非法的图地址'].imgs.length === 1 &&
      byTitle['非法的图地址'].imgs[0].url === 'https://cdn.example.com/c.jpg',
      JSON.stringify(byTitle['非法的图地址'].imgs));
    check('缺 kind 的也补上默认 kind',
      byTitle['非法的图地址'].imgs[0].kind === 'inline',
      JSON.stringify(byTitle['非法的图地址'].imgs[0]));
  }

  /* ────────────────── 7. 头条候选配图：Python 侧抽取（真跑 python） ────────────────── */
  console.log('\nPython 抽图模块');
  {
    const py = await hasPython();
    if (!py) {
      console.log('  ! 找不到 python，跳过 Python 侧断言');
    } else {
      const PY_CODE = [
        'import sys, json',
        "sys.path.insert(0, 'tools/grab')",
        'import headline_images as hi',
        'html = sys.stdin.read()',
        "print(json.dumps(hi.extract_candidates(html, 'https://example.com/p/1', limit=6), ensure_ascii=False))",
      ].join('\n');
      // 协议相对地址（//host/path）必须补成 https:// —— 站点是 https，
      // 页面里留着 // 浏览器能认，但落到 JSON 里当字符串就不好认了。
      const HTML = [
        '<html><body>',
        '<img src="https://cdn.example.com/static/logo.png">',
        '<img src="//cdn.example.com/2026/11/content1.jpg">',
        '<img data-src="https://cdn2.example.com/real.jpg">',
        '<img src="data:image/gif;base64,AAAA">',
        '<img src="https://cdn3.example.com/icon.png">',
        '<img src="https://cdn4.example.com/pic.JPG">',
        '<img src="https://cdn5.example.com/page.html">',
        '</body></html>',
      ].join('');
      const out = await runPython(PY_CODE, HTML);
      const cands = JSON.parse(out.trim().split('\n').pop());
      const urls = cands.map((c) => c.url);

      check('抽到 3 个候选', cands.length === 3, JSON.stringify(urls));
      check('协议相对地址补成了 https',
        urls.includes('https://cdn.example.com/2026/11/content1.jpg'), JSON.stringify(urls));
      check('认得懒加载属性 data-src',
        urls.includes('https://cdn2.example.com/real.jpg'), JSON.stringify(urls));
      check('大写后缀也认', urls.includes('https://cdn4.example.com/pic.JPG'), JSON.stringify(urls));
      check('logo / icon 被 URL 粗筛滤掉',
        !urls.some((u) => /logo|icon/i.test(u)), JSON.stringify(urls));
      check('data: 地址被丢掉', !urls.some((u) => u.startsWith('data:')), JSON.stringify(urls));
      check('非图片后缀被丢掉', !urls.some((u) => /page\.html$/.test(u)), JSON.stringify(urls));
      check('形状是 {url, kind}',
        cands.every((c) => typeof c.url === 'string' && c.kind === 'inline'),
        JSON.stringify(cands));
    }
  }
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
