#!/usr/bin/env node
/**
 * 变异测试：故意改坏「见报搜索」的 9 处实现，看前端测试抓不抓得住。
 *
 * 护栏有没有牙齿，判定标准就是变异测试：改坏实现，测试必须变红。全绿 = 护栏是空的。
 *
 * 为什么不能只看退出码（这个项目已经踩过 7 次假护栏）：
 *   副本要是语法坏了，测试会直接崩，退出码照样非 0 —— 那是「假红」。
 *   所以每个变异都要同时核对三件事：
 *     1) 变异体本身没坏（app.js 能解析 / app.css 括号配平）—— 排除假红；
 *     2) 变异真的落地了（目标代码片段在副本里）；
 *     3) 红的正好是**预期的那几条断言** —— 不是别的断言。
 *
 * 手法：把 site/ 和测试脚本复制到临时目录 tools/.tmp-search-mutate，
 * 只改副本里的 app.js / app.css，跑副本里的 test-news-ui.mjs。
 *
 * 本体文件（site/app.js、site/app.css、tools/test-news-ui.mjs）全程只读，
 * 跑完用 sha256 比对证明没被改过。
 *
 * 跑法：node tools/test-news-search-mutate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const TMP = path.join(SITE, 'tools', '.tmp-search-mutate');
const TMPSITE = path.join(TMP, 'site');
const TMPTOOLS = path.join(TMP, 'tools');

const APPJS = path.join(SITE, 'site', 'app.js');
const APPCSS = path.join(SITE, 'site', 'app.css');
const UNIT = path.join(SITE, 'tools', 'test-news-ui.mjs');

/* ── 变异清单 ───────────────────────────────────────────
 * from 必须是磁盘上当前源码里逐字存在的片段，
 * 脚本会先校验它唯一存在，找不到就报错退出（源码变了，脚本过期了）。
 *
 * expectFail：预期应该变红的那几条断言名（子串匹配）。
 */
const MUTATIONS = [
  {
    id: 'M1',
    name: '关键词维度失效（恒真，搜索等于没做）',
    file: 'app.js',
    from: "        var hitQ = !q || (lis[k].getAttribute('data-search') || '').indexOf(q) >= 0;",
    to: "        var hitQ = true;",
    expectFail: ['按标题搜命中 1 条', '按来源搜命中「效率两条」', '按摘要搜命中「效率一条」', '搜不到时 0 条'],
  },
  {
    id: 'M2',
    name: '三个维度从 AND 改成 OR',
    file: 'app.js',
    from: "        var hit = hitTag && hitSrc && hitQ;",
    to: "        var hit = hitTag || hitSrc || hitQ;",
    expectFail: ['当前分类下 0 条', '源 ∩ 关键词 = 0 条', '搜不到时 0 条'],
  },
  {
    id: 'M3',
    name: '搜索范围把标签也算进去',
    file: 'app.js',
    from: "        ((it.title || '') + ' ' + (it.source || '') + ' ' + (it.desc || '')).toLowerCase());",
    to: "        ((it.title || '') + ' ' + (it.source || '') + ' ' + (it.desc || '') + ' ' + (it.tags || []).join(' ')).toLowerCase());",
    expectFail: ['data-search 里没有标签文字', '标签挂着「科技」的「跨类一条」不因为标签而命中'],
  },
  {
    id: 'M4',
    name: '去掉「当前筛选 0 条 · 全局 N 条」提示',
    file: 'app.js',
    from: "      } else if (shown === 0 && globalHit > 0) {",
    to: "      } else if (false) {",
    expectFail: ['提示「当前筛选 0 条 · 全局 2 条」', '全局有命中时给提示'],
  },
  {
    id: 'M5',
    name: 'Esc 不清空搜索',
    file: 'app.js',
    from: "      if (e.key !== 'Escape') return;",
    to: "      if (e.key !== 'EscapeNotAllowed') return;",
    /* 注意：断言必须是「合成 Esc」那几条。
     * Chrome 原生就会清空 search 输入框并触发 input 事件 ——
     * 用真实按键测的话，Chrome 顶掉我们的实现，断言照样绿，护栏就成了空壳。
     * 合成 keydown 是不可信事件，不触发浏览器默认动作，只走我们的 JS。 */
    expectFail: ['合成 Esc 后输入框空了', '合成 Esc 后计数空了'],
  },
  {
    id: 'M6',
    name: '清空按钮（✕）不绑事件',
    file: 'app.js',
    /* 锚点要多带几行才唯一 —— 榜单 tab 里也有一套一样的搜索框
       （2026-11-16 v2 加的多层 chip 搜索），只锚第一行会命中两处。 */
    from: "    clearBtn.addEventListener('click', function () {\n      input.value = '';\n      curQuery = '';\n      clearBtn.hidden = true;\n      applyFilter();",
    to: "    clearBtn.addEventListener('click-disabled', function () {\n      input.value = '';\n      curQuery = '';\n      clearBtn.hidden = true;\n      applyFilter();",
    expectFail: ['点 ✕ 后输入框空了', '点 ✕ 后计数空了', '点 ✕ 后条目恢复'],
  },
  {
    id: 'M7',
    name: '结果计数永远不显示',
    file: 'app.js',
    from: "        countEl.textContent = '找到 ' + shown + ' 条';",
    to: "        countEl.textContent = '';",
    expectFail: ['计数是「找到 1 条」', '计数变「找到 2 条」'],
  },
  {
    id: 'M8',
    name: '换分类时把搜索词清掉（搜索不再持久）',
    file: 'app.js',
    from: "        curTag = btn.getAttribute('data-tag') || '';\n        curSrc = '';              // 换大类时把源的选择重置",
    to: "        curTag = btn.getAttribute('data-tag') || '';\n        curSrc = '';              // 换大类时把源的选择重置\n        curQuery = '';\n        input.value = '';",
    expectFail: ['换分类后搜索词还在'],
  },
  {
    id: 'M9',
    name: '结果计数被 CSS 藏起来',
    file: 'app.css',
    from: ".news-search-count {\n  display: block;",
    to: ".news-search-count {\n  display: none;",
    expectFail: ['有词时计数可见'],
  },
];

/* ── 小工具 ───────────────────────────────────────────── */

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/** 从测试 stdout 里抠出**变红的那几条断言名**（断言名在 `  -> ` 之前）。 */
function failedAssertions(stdout) {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.match(/^\s*✗\s+(.*)$/);
    if (m) out.push(m[1].split('  -> ')[0].trim());
  }
  return out;
}

/* ── 临时工程 ─────────────────────────────────────────── */
function setupProject(origJs, origCss) {
  rmrf(TMP);
  fs.mkdirSync(TMPSITE, { recursive: true });
  fs.mkdirSync(TMPTOOLS, { recursive: true });
  for (const f of ['template.html']) {
    fs.copyFileSync(path.join(SITE, 'site', f), path.join(TMPSITE, f));
  }
  fs.copyFileSync(UNIT, path.join(TMPTOOLS, 'test-news-ui.mjs'));
  fs.writeFileSync(path.join(TMPSITE, 'app.js'), origJs, 'utf8');
  fs.writeFileSync(path.join(TMPSITE, 'app.css'), origCss, 'utf8');
}

function runUnit() {
  const args = [path.join(TMPTOOLS, 'test-news-ui.mjs')];
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stdout, stderr: '', failed: failedAssertions(stdout), crashed: false };
  } catch (e) {
    const stdout = e.stdout || '';
    const stderr = e.stderr || '';
    return {
      code: e.status ?? -1,
      stdout,
      stderr,
      failed: failedAssertions(stdout),
      crashed: stderr.trim().length > 0,
    };
  }
}

/**
 * 变异体自检：确认副本没坏（假红排查）+ 变异真的落地了。
 * app.js 用 vm.Script 解析（语法坏了测试会崩，那是假红）；
 * app.css 查花括号配平 + 目标片段在位。
 */
function selfCheck(file, mutated, original, to) {
  if (file === 'app.js') {
    try {
      new vm.Script(mutated, { filename: 'app.js' });
    } catch (e) {
      return { ok: false, note: '语法坏了：' + String(e.message).split('\n')[0] };
    }
  } else {
    const open = (mutated.match(/\{/g) || []).length;
    const close = (mutated.match(/\}/g) || []).length;
    if (open !== close) return { ok: false, note: `花括号不配平（${open} vs ${close}）` };
  }
  if (mutated === original) return { ok: false, note: '变异没落地（副本跟原文一样）' };
  if (mutated.indexOf(to) < 0) return { ok: false, note: '变异片段没出现在副本里' };
  return { ok: true, note: '副本完好，变异已落地' };
}

/* ── 主流程 ───────────────────────────────────────────── */

function main() {
  console.log('变异测试：故意改坏「见报搜索」，看前端测试抓不抓得住\n');

  const before = { js: sha256(APPJS), css: sha256(APPCSS), unit: sha256(UNIT) };
  console.log('── 本体哈希（跑之前）');
  console.log(`   site/app.js            ${before.js}`);
  console.log(`   site/app.css           ${before.css}`);
  console.log(`   tools/test-news-ui.mjs ${before.unit}`);

  const origJs = fs.readFileSync(APPJS, 'utf8');
  const origCss = fs.readFileSync(APPCSS, 'utf8');

  /* 基线：没变异的副本，测试必须全绿。不绿的话，后面的「红」没有意义。 */
  console.log('\n── 基线（未变异的副本）');
  {
    setupProject(origJs, origCss);
    const base = runUnit();
    console.log(`   前端测试退出码 = ${base.code}，失败断言 = ${base.failed.length} 条`);
    rmrf(TMP);
    if (base.code !== 0 || base.failed.length > 0) {
      console.log('\n✗ 基线不绿 —— 变异测试没有意义，先修前端测试。');
      console.log(base.stdout);
      process.exit(1);
    }
    console.log('   ✓ 基线绿');
  }

  /* 逐个变异 */
  const results = [];
  for (const m of MUTATIONS) {
    console.log(`\n── 变异 ${m.id}：${m.name}`);

    const src = m.file === 'app.css' ? origCss : origJs;
    const hits = src.split(m.from).length - 1;
    if (hits !== 1) {
      console.log(`   ✗ 变异锚点没找到（或不唯一，命中 ${hits} 次）—— 变异脚本过期了，源码改了？`);
      rmrf(TMP);
      process.exit(1);
    }

    const mutated = src.replace(m.from, m.to);
    setupProject(origJs, origCss);
    fs.writeFileSync(path.join(TMPSITE, m.file), mutated, 'utf8');

    // 1) 副本自检（排除假红 / 空变异）
    const self = selfCheck(m.file, mutated, src, m.to);
    if (!self.ok) {
      console.log(`   ✗ ${self.note}`);
      rmrf(TMP);
      results.push({ id: m.id, name: m.name, verdict: 'BROKEN_MUTANT', failed: [], expectFail: m.expectFail, missed: m.expectFail });
      continue;
    }
    console.log(`   ${self.note}`);

    // 2) 跑前端测试，看红的是不是预期那几条断言
    const res = runUnit();
    const hitExpected = m.expectFail.filter((want) => res.failed.some((f) => f.includes(want)));
    const missExpected = m.expectFail.filter((want) => !res.failed.some((f) => f.includes(want)));

    console.log(`   期望红的断言：${m.expectFail.join(' / ')}`);
    console.log(`   实际红的断言：${res.failed.length ? res.failed.join(' / ') : '（无）'}`);
    if (res.crashed) {
      console.log(`   注：测试随后崩了（stderr 非空），是变异的连带后果：${res.stderr.split(/\r?\n/).filter(Boolean)[0] || ''}`);
    }

    let verdict;
    if (missExpected.length === 0) verdict = 'CAUGHT';
    else if (res.code === 0) verdict = 'MISSED';        // 全绿 = 护栏没牙齿
    else verdict = 'FALSE_RED';                         // 红了但红的不是预期断言

    const label = {
      CAUGHT: '✓ 被抓到了',
      MISSED: '✗ 没被抓到 —— 前端测试有缺口',
      FALSE_RED: '✗ 红了但红的是别的断言（假红）',
      BROKEN_MUTANT: '✗ 变异体坏了（假红）',
    }[verdict];
    console.log(`   判定：${label}`);

    results.push({
      id: m.id, name: m.name, verdict,
      expectFail: m.expectFail, missed: missExpected, failed: res.failed,
    });

    rmrf(TMP);
  }

  /* 收尾：哈希比对 + 临时目录清理确认 */
  const after = { js: sha256(APPJS), css: sha256(APPCSS), unit: sha256(UNIT) };
  console.log('\n── 本体哈希（跑之后）');
  console.log(`   site/app.js            ${after.js}`);
  console.log(`   site/app.css           ${after.css}`);
  console.log(`   tools/test-news-ui.mjs ${after.unit}`);
  const same = before.js === after.js && before.css === after.css && before.unit === after.unit;
  console.log(`   本体字节级未变：${same ? '是' : '否 —— 本体被改了！'}`);
  console.log(`   临时目录已清理：${!fs.existsSync(TMP) ? '是' : '否 —— 目录还在！'}`);

  const caught = results.filter((r) => r.verdict === 'CAUGHT').length;
  console.log(`\n变异测试：${caught}/${results.length} 被抓到`);
  const missed = results.filter((r) => r.verdict !== 'CAUGHT');
  if (missed.length) {
    console.log('\n没抓到的变异（前端测试的缺口，不是本脚本的问题）：');
    for (const r of missed) {
      console.log(`   ${r.id} ${r.name} —— 期望红的断言没红：${(r.missed || []).join(' / ') || r.verdict}`);
    }
  }
  if (!same || fs.existsSync(TMP)) process.exit(1);
  process.exit(caught === results.length ? 0 : 1);
}

try {
  main();
} catch (e) {
  rmrf(TMP);
  console.error(e);
  process.exit(1);
}
