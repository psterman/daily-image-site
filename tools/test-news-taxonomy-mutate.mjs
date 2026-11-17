#!/usr/bin/env node
/**
 * 变异测试：故意破坏 6 条规则，验证单元测试抓得住。
 *
 * 护栏有没有牙齿，判定标准就是变异测试：
 * 改坏实现，测试必须变红。全绿 = 护栏是空的。
 *
 * 手法：把 news-taxonomy.mjs 的源码按变异规则改写，复制到临时目录，
 * 连同单元测试一起在临时目录里跑一遍，看测试是不是**指定的那几条断言**红了。
 *
 * 为什么不能只看退出码（这个项目已经踩过 7 次假护栏）：
 *   副本要是语法坏了，单元测试会直接崩，退出码照样非 0 —— 那是「假红」。
 *   所以每个变异都要同时核对三件事：
 *     1) 变异真的改坏了行为（探针核对）—— 排除「空变异」；
 *     2) 红的正好是预期的那几条断言 —— 不是别的断言；
 *     3) 副本语法没坏 —— 探针能 import 成功。
 *
 * 本体文件（tools/news-taxonomy.mjs、tools/test-news-taxonomy.mjs）全程只读，
 * 跑完用 sha256 比对证明没被改过。
 *
 * 跑法：node tools/test-news-taxonomy-mutate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..');
const TMP = path.join(SITE, 'tools', '.tmp-news-mutate');
const TMPTOOLS = path.join(TMP, 'tools');

const IMPL_FILE = path.join(SITE, 'tools', 'news-taxonomy.mjs');
const UNIT_FILE = path.join(SITE, 'tools', 'test-news-taxonomy.mjs');

/* ── 变异清单 ───────────────────────────────────────────
 * from 必须是磁盘上 tools/news-taxonomy.mjs 的**当前源码**里逐字存在的片段，
 * 脚本会先校验它唯一存在，找不到就报错退出（源码变了，脚本过期了）。
 *
 * expectFail：预期应该变红的那几条断言名（子串匹配）。
 * probe：行为探针的编号，用来确认「这个变异真的改坏了行为」。
 */
const MUTATIONS = [
  {
    id: 'M1',
    name: '源未映射时 fallback 到「其它」而不是报错',
    // 锚点扩到整条 throw 语句：只替换前半截的话，后面的 `);` 会留下，
    // 副本语法直接坏掉，单元测试是「崩」红的不是断言红的 —— 那是假红。
    from: "    throw new Error(\n      `源「${src}」没有配分类（news-taxonomy.json 的 sourceCategory 缺这一项）。` +\n      `已配的源：${known}`\n    );",
    to: "    return { tag: '其它', tags: ['其它'], mainKey: 'other', keys: ['other'] };",
    expectFail: ['源未映射时抛错'],
    probe: 'M1',
  },
  {
    id: 'M2',
    name: '分类列表改回按条数降序',
    from: "for (const c of taxonomy.categories) {\n    const n = count.get(c.label) || 0;\n    if (n > 0) out.push({ label: c.label, count: n });\n  }",
    to: "for (const c of taxonomy.categories) {\n    const n = count.get(c.label) || 0;\n    if (n > 0) out.push({ label: c.label, count: n });\n  }\n  out.sort((a, b) => b.count - a.count);",
    expectFail: ['条数变了顺序不变', '顺序 = taxonomy 顺序'],
    probe: 'M2',
  },
  {
    id: 'M3',
    name: '关键词只匹配标题不匹配摘要',
    // 源码里 \n 是字面量两字符（反斜杠 + n），所以锚点里要写 \\n
    from: "const text = `${(item && item.title) || ''}\\n${(item && item.desc) || ''}`;",
    to: "const text = `${(item && item.title) || ''}`;",
    expectFail: ['摘要参与匹配'],
    probe: 'M3',
  },
  {
    id: 'M4',
    name: '多归属退化成单归属',
    from: "const keys = [mainKey, ...extraKeys].slice(0, 1 + maxExtra);",
    to: "const keys = [mainKey];",
    expectFail: ['关键词命中追加「AI」'],
    probe: 'M4',
  },
  {
    id: 'M5',
    name: '去掉「重复 keywordTags tag」的校验',
    from: "    if (ktTags.has(kt.tag)) errs.push(`keywordTags 的 tag 重复：${kt.tag}`);",
    to: "    // 变异 M5：删掉重名 tag 的校验 —— 条目会挂重复分类、chip 计数虚高",
    expectFail: ['keywordTags 重名 tag 被校验器拒掉', 'keywordTags 重名 tag 被拒'],
    probe: 'M5',
  },
  {
    id: 'M6',
    name: '去掉「maxExtraTags 必须是整数/非负」的校验',
    from: "  if (t.maxExtraTags !== undefined) {\n    if (!Number.isInteger(t.maxExtraTags)) errs.push(`maxExtraTags 必须是整数：${t.maxExtraTags}`);\n    else if (t.maxExtraTags < 0) errs.push(`maxExtraTags 不能是负数：${t.maxExtraTags}`);\n  }",
    to: "  // 变异 M6：删掉 maxExtraTags 的整数/非负校验 —— 2.5 会被静默回落成 2",
    expectFail: ['maxExtraTags 非整数被拒', 'maxExtraTags 负数被拒'],
    probe: 'M6',
  },
];

/* ── 行为探针 ───────────────────────────────────────────
 * 每个探针在**被变异的模块**上跑一个能直接看出行为变了没有的场景。
 * 探针在原始模块上跑必须全是「没被改坏」—— 这是探针自身的护栏。
 */
const PROBES = {
  M1(mod, tax) {
    try {
      mod.classifyItem({ source: '不存在的源', title: 'x' }, tax);
      return { effective: true, note: '源没配分类时不再抛错，悄悄返回「其它」' };
    } catch (e) {
      return { effective: false, note: '仍然抛错：' + String(e.message).slice(0, 40) };
    }
  },
  M2(mod, tax) {
    // 故意造一个「条数顺序跟 taxonomy 顺序相反」的输入：AI 3 条、热议 1 条
    const items = [{ tags: ['AI'] }, { tags: ['AI'] }, { tags: ['AI'] }, { tags: ['热议'] }];
    const out = mod.orderCategories(tax, items).map((x) => x.label);
    const fixed = tax.categories.map((c) => c.label).filter((l) => out.includes(l));
    const effective = out.join('、') !== fixed.join('、');
    // 顺便把单元测试自己那个 fixture 的条数算出来：
    // 它恰好让「条数降序」跟「taxonomy 固定顺序」重合，所以排序类断言看不见这个变异。
    const fx = [{ tags: ['热议', 'AI'] }, { tags: ['热议'] }, { tags: ['热议', 'AI'] }];
    const cnt = {};
    for (const it of fx) for (const t of it.tags) cnt[t] = (cnt[t] || 0) + 1;
    const fxNote = Object.entries(cnt).map(([k, v]) => `${k}=${v}`).join('/');
    return {
      effective,
      note: `条数降序后顺序 = ${out.join('、')}（taxonomy 固定顺序应为 ${fixed.join('、')}）；`
        + `单元测试自己的 fixture 条数是 ${fxNote}，本来就等于 taxonomy 顺序，降序排序在它上面是恒等变换`,
    };
  },
  M3(mod, tax) {
    const it = mod.classifyItem({ source: '驱动之家', title: '普通标题', desc: '大模型' }, tax);
    const effective = !it.tags.includes('AI');
    return { effective, note: `desc 里的「大模型」没参与匹配，归属 = ${it.tags.join('、')}` };
  },
  M4(mod, tax) {
    const it = mod.classifyItem({ source: '微博热搜', title: 'AI 大模型发布', desc: '' }, tax);
    const effective = it.tags.length === 1;
    return { effective, note: `多归属退化成单归属，归属 = ${it.tags.join('、')}` };
  },
  M5(mod) {
    const dup = {
      categories: [{ key: 'a', label: 'A' }],
      sourceCategory: { s: 'a' },
      keywordTags: [{ tag: 'a', words: ['x'] }, { tag: 'a', words: ['y'] }],
    };
    const errs = mod.validateTaxonomy(dup);
    const effective = !errs.some((e) => /tag 重复/.test(e));
    return { effective, note: `重名 tag 不再报错，errs = ${JSON.stringify(errs)}` };
  },
  M6(mod) {
    const frac = {
      categories: [{ key: 'a', label: 'A' }],
      sourceCategory: { s: 'a' },
      maxExtraTags: 2.5,
    };
    const errs = mod.validateTaxonomy(frac);
    const effective = !errs.some((e) => /必须是整数/.test(e));
    return { effective, note: `maxExtraTags=2.5 不再报错，errs = ${JSON.stringify(errs)}` };
  },
};

/* ── 小工具 ───────────────────────────────────────────── */

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * 从单元测试的 stdout 里抠出**变红的那几条断言名**。
 * 单元测试失败时打印的是 `  ✗ 断言名  -> 附加信息`，断言名在 `  -> ` 之前。
 */
function failedAssertions(stdout) {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.match(/^\s*✗\s+(.*)$/);
    if (m) out.push(m[1].split('  -> ')[0].trim());
  }
  return out;
}

/* ── 临时工程 ───────────────────────────────────────────
 * 照抄 tools/test-keep-manifest.mjs 的现成模式：
 * tools/.tmp-<名字>，测试脚本用 path.resolve(__dirname, '..') 算 SITE，
 * 放对了它就自动指向临时目录；跑完由脚本自己 fs.rmSync 删掉。
 */
function setupProject(origSource) {
  rmrf(TMP);
  fs.mkdirSync(path.join(TMPTOOLS, 'grab'), { recursive: true });
  for (const f of ['test-news-taxonomy.mjs', 'rss.config.json', 'news-taxonomy.json']) {
    fs.copyFileSync(path.join(SITE, 'tools', f), path.join(TMPTOOLS, f));
  }
  fs.copyFileSync(
    path.join(SITE, 'tools', 'grab', 'daily_headlines.py'),
    path.join(TMPTOOLS, 'grab', 'daily_headlines.py')
  );
  // 每个变异都从原始内容重新写一遍，不在前一个变异的基础上叠加
  fs.writeFileSync(path.join(TMPTOOLS, 'news-taxonomy.mjs'), origSource, 'utf8');
}

function runUnit() {
  const args = [path.join(TMPTOOLS, 'test-news-taxonomy.mjs')];
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
      // 单元测试只往 stdout 打印，stderr 非空 = 未捕获异常崩了
      crashed: stderr.trim().length > 0,
    };
  }
}

/**
 * 导入被变异的模块，跑行为探针。
 * 用带编号的文件名导入，避开 ESM 模块缓存（同名文件只会加载一次）。
 * fileTag 决定文件名，probeKey 决定用哪个探针（基线时文件名叫 BASE-M1，探针还是 M1）。
 */
async function probeMutant(fileTag, probeKey, mutatedSource) {
  const probeFile = path.join(TMPTOOLS, `probe-taxonomy-${fileTag}.mjs`);
  fs.writeFileSync(probeFile, mutatedSource, 'utf8');
  const mod = await import(pathToFileURL(probeFile).href);
  const tax = mod.loadTaxonomy(TMP);
  return PROBES[probeKey](mod, tax);
}

/* ── 主流程 ───────────────────────────────────────────── */

async function main() {
  console.log('变异测试：故意改坏实现，看单元测试抓不抓得住\n');

  const before = { impl: sha256(IMPL_FILE), unit: sha256(UNIT_FILE) };
  console.log('── 本体哈希（跑之前）');
  console.log(`   news-taxonomy.mjs        ${before.impl}`);
  console.log(`   test-news-taxonomy.mjs  ${before.unit}`);

  const orig = fs.readFileSync(IMPL_FILE, 'utf8');

  /* 基线：没变异的副本，测试必须全绿、探针必须全部判定「行为没被改坏」。
   * 基线不绿的话，后面的「红」就没有意义。 */
  console.log('\n── 基线（未变异的副本）');
  {
    setupProject(orig);
    const base = runUnit();
    console.log(`   单元测试退出码 = ${base.code}，失败断言 = ${base.failed.length} 条`);
    const probes = [];
    for (const m of MUTATIONS) {
      const p = await probeMutant('BASE-' + m.id, m.id, orig);
      probes.push(`${m.id}:${p.effective ? '异常(探针失效)' : '正常'}`);
    }
    console.log(`   探针在原始实现上的判定：${probes.join(' ')}`);
    rmrf(TMP);
    if (base.code !== 0 || base.failed.length > 0) {
      console.log('\n✗ 基线不绿 —— 变异测试没有意义，先修单元测试。');
      console.log(base.stdout);
      process.exit(1);
    }
    if (probes.some((x) => x.includes('探针失效'))) {
      console.log('\n✗ 有探针在原始实现上就判「行为被改坏」—— 探针本身失效了。');
      process.exit(1);
    }
    console.log('   ✓ 基线绿，探针自身有效');
  }

  /* 逐个变异 */
  const results = [];
  for (const m of MUTATIONS) {
    console.log(`\n── 变异 ${m.id}：${m.name}`);

    const hits = orig.split(m.from).length - 1;
    if (hits !== 1) {
      console.log(`   ✗ 变异锚点没找到（或不唯一，命中 ${hits} 次）—— 变异脚本过期了，源码改了？`);
      rmrf(TMP);
      process.exit(1);
    }

    // 临时工程重建 + 副本重写为原始内容，然后才改坏
    setupProject(orig);
    const mutated = orig.replace(m.from, m.to);
    fs.writeFileSync(path.join(TMPTOOLS, 'news-taxonomy.mjs'), mutated, 'utf8');

    // 1) 探针：变异有没有真的改坏行为（同时验证副本语法没坏）
    let probe;
    try {
      probe = await probeMutant(m.id, m.id, mutated);
      console.log(`   变异体语法：OK（能 import）`);
    } catch (e) {
      console.log(`   ✗ 变异体语法坏了，单元测试会「崩」而不是断言红 —— 不算抓到：${e.message.split('\n')[0]}`);
      rmrf(TMP);
      results.push({ id: m.id, name: m.name, verdict: 'BROKEN_MUTANT', failed: [], expectFail: m.expectFail });
      continue;
    }
    console.log(`   行为确实被改坏：${probe.effective ? '是' : '否'} —— ${probe.note}`);

    // 2) 跑单元测试，看红的是不是预期那几条断言
    const res = runUnit();
    const hitExpected = m.expectFail.filter((want) => res.failed.some((f) => f.includes(want)));
    const missExpected = m.expectFail.filter((want) => !res.failed.some((f) => f.includes(want)));

    console.log(`   期望红的断言：${m.expectFail.join(' / ')}`);
    console.log(`   实际红的断言：${res.failed.length ? res.failed.join(' / ') : '（无）'}`);
    if (res.crashed) {
      const frame = (res.stderr.split(/\r?\n/).find((l) => /:\d+:\d+/.test(l)) || '').trim();
      console.log(`   注：单元测试随后崩了（stderr 非空），是变异的连带后果：${res.stderr.split(/\r?\n/).filter(Boolean)[0] || ''}${frame ? '  @ ' + frame : ''}`);
    }

    let verdict;
    if (!probe.effective) {
      verdict = 'NOT_EFFECTIVE'; // 空变异：改坏了代码但行为没变，探针兜住了
    } else if (missExpected.length === 0) {
      verdict = 'CAUGHT';
    } else if (res.code === 0) {
      verdict = 'MISSED'; // 全绿 = 护栏没牙齿
    } else {
      verdict = 'FALSE_RED'; // 红了但红的不是预期断言
    }

    const label = {
      CAUGHT: '✓ 被抓到了',
      MISSED: '✗ 没被抓到 —— 单元测试有缺口',
      FALSE_RED: '✗ 红了但红的是别的断言（假红）',
      NOT_EFFECTIVE: '✗ 变异没改坏行为（空变异）',
      BROKEN_MUTANT: '✗ 变异体语法坏了（假红）',
    }[verdict];
    console.log(`   判定：${label}`);

    results.push({
      id: m.id,
      name: m.name,
      verdict,
      probe: probe.note,
      expectFail: m.expectFail,
      missed: missExpected,
      failed: res.failed,
      crashed: res.crashed,
      code: res.code,
    });

    // 每个变异跑完，临时目录必须清理干净
    rmrf(TMP);
  }

  /* 收尾：哈希比对 + 临时目录清理确认 */
  const after = { impl: sha256(IMPL_FILE), unit: sha256(UNIT_FILE) };
  console.log('\n── 本体哈希（跑之后）');
  console.log(`   news-taxonomy.mjs        ${after.impl}`);
  console.log(`   test-news-taxonomy.mjs  ${after.unit}`);
  const same = before.impl === after.impl && before.unit === after.unit;
  console.log(`   本体字节级未变：${same ? '是' : '否 —— 本体被改了！'}`);
  console.log(`   临时目录已清理：${!fs.existsSync(TMP) ? '是' : '否 —— 目录还在！'}`);

  const caught = results.filter((r) => r.verdict === 'CAUGHT').length;
  console.log(`\n变异测试：${caught}/${results.length} 被抓到`);
  const missed = results.filter((r) => r.verdict !== 'CAUGHT');
  if (missed.length) {
    console.log('\n没抓到的变异（单元测试的缺口，不是本脚本的问题）：');
    for (const r of missed) {
      console.log(`   ${r.id} ${r.name} —— 期望红的断言没红：${(r.missed || []).join(' / ') || r.verdict}`);
    }
  }
  if (!same || fs.existsSync(TMP)) process.exit(1);
  process.exit(caught === results.length ? 0 : 1);
}

main().catch((e) => {
  rmrf(TMP);
  console.error(e);
  process.exit(1);
});
