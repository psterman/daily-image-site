#!/usr/bin/env node
/**
 * 变异测试：故意改坏「产物有效性」的三道闸门，看主护栏抓不抓得住。
 *
 * 护栏有没有牙齿，判定标准就是变异测试：改坏实现，测试必须变红。全绿 = 护栏是空的。
 *
 * 为什么不能只看退出码（本项目踩过多次假护栏）：
 *   副本要是语法坏了，测试会直接崩，退出码照样非 0 —— 那是「假红」。
 *   所以每个变异都要同时核对三件事：
 *     1) 变异锚点在源码里**逐字唯一命中**（不唯一就报错退出 —— 源码变了，脚本过期了）；
 *     2) 副本 node --check 语法 OK（排除假红）；
 *     3) 红的正好是**指定的那几条断言** —— 不是别的断言。
 *
 * 手法：把 tools/{build,verify-build,upload-r2}.mjs 之一按变异规则改写，
 * 复制到 tools/.tmp-product-validity-mutate/mutants/<变异号>/，
 * 再用 PRODUCT_VALIDITY_IMPL_DIR 指过去跑一遍主护栏
 * （PRODUCT_VALIDITY_SECTION 只跑相关那一段，省时间）。
 *
 * ⚠️ expectGreen：每条变异还指定了「必须保持绿」的断言 ——
 *    红的正好是指定的那几条，不是别的断言碰巧红了。
 *
 * 跑法：node tools/test-product-validity-mutate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UNIT = path.join(__dirname, 'test-product-validity.mjs');
const TMP = path.join(__dirname, '.tmp-product-validity-mutate');

/* ── 变异清单 ─────────────────────────────────────────────
 * from 必须是磁盘上当前源码里逐字存在的片段（在**本文件内唯一命中**）。
 *
 * expectFail：预期应该变红的那几条断言名（子串匹配）。
 * expectGreen：预期必须保持绿的那几条断言名（子串匹配）。
 */
const MUTATIONS = [
  {
    id: 'M1',
    file: 'build.mjs',
    section: 'build',
    name: 'build.mjs：--no-convert 复用路径不再查产物有效性（文件在就算数）',
    from: '        const pFull = await productProblem(destFull);\n        const pThumb = await productProblem(destThumb);',
    to: '        const pFull = null;\n        const pThumb = null;',
    expectFail: [
      'build.mjs：0 字节 / 坏文件头的产物**触发了回退**',
      'build.mjs：回退日志指名道姓说了是哪个文件（0 字节那个）',
      'build.mjs：回退日志指名道姓说了是哪个文件（坏文件头那个）',
      'build.mjs：回退日志说清了是什么问题（0 字节）',
      'build.mjs：0 字节的产物被重新转码，不再是空文件',
      'build.mjs：回退后的 0 字节产物是**有效 WebP**',
      'build.mjs：回退后的坏文件头产物是**有效 WebP**',
    ],
    expectGreen: [
      'build.mjs：第一次构建（真转码）成功',
      'build.mjs：产物都有效时 --no-convert **不**回退成真转码',
      'build.mjs：带坏产物的 --no-convert 构建仍然成功',
      'build.mjs：只回退坏的那几个',
    ],
  },
  {
    id: 'M2',
    file: 'build.mjs',
    section: 'build',
    name: 'build.mjs：有效性检查不再单独报「0 字节」（文案退化成「文件过短」）',
    from: "  if (st.size === 0) return '是 0 字节的空文件';",
    to: "  if (false) return '是 0 字节的空文件';",
    expectFail: ['build.mjs：回退日志说清了是什么问题（0 字节）'],
    expectGreen: [
      'build.mjs：0 字节 / 坏文件头的产物**触发了回退**',
      'build.mjs：回退日志指名道姓说了是哪个文件（0 字节那个）',
      'build.mjs：回退日志指名道姓说了是哪个文件（坏文件头那个）',
      'build.mjs：0 字节的产物被重新转码，不再是空文件',
      'build.mjs：回退后的 0 字节产物是**有效 WebP**',
      'build.mjs：回退后的坏文件头产物是**有效 WebP**',
    ],
  },
  {
    id: 'M3',
    file: 'build.mjs',
    section: 'build',
    name: 'build.mjs：查出产物坏了也不回退成真转码（needConvert 不再置 true）',
    from: '        if (pFull || pThumb) {\n          needConvert = true;',
    to: '        if (pFull || pThumb) {\n          needConvert = false;',
    expectFail: [
      'build.mjs：0 字节的产物被重新转码，不再是空文件',
      'build.mjs：回退后的 0 字节产物是**有效 WebP**',
      'build.mjs：回退后的坏文件头产物是**有效 WebP**',
      'build.mjs：产物都修好之后 --no-convert 不再回退（闸门不是一直拦）',
    ],
    expectGreen: [
      'build.mjs：0 字节 / 坏文件头的产物**触发了回退**',
      'build.mjs：回退日志指名道姓说了是哪个文件（0 字节那个）',
      'build.mjs：回退日志指名道姓说了是哪个文件（坏文件头那个）',
      'build.mjs：回退日志说清了是什么问题（0 字节）',
    ],
  },
  {
    id: 'M3b',
    file: 'build.mjs',
    section: 'build',
    name: 'build.mjs：--no-convert 也一律重新转码（一刀切，不再复用）',
    from: '      let needConvert = !args.skipConvert;',
    to: '      let needConvert = true;',
    expectFail: [
      'build.mjs：产物都有效时 --no-convert **没有重转**（文件没被动过）',
      'build.mjs：只回退坏的那几个，没坏的产物**没有被重转**（不是一刀切）',
    ],
    expectGreen: [
      'build.mjs：产物都有效时 --no-convert **不**回退成真转码',
      'build.mjs：0 字节 / 坏文件头的产物**触发了回退**',
      'build.mjs：0 字节的产物被重新转码，不再是空文件',
    ],
  },
  {
    id: 'M4',
    file: 'verify-build.mjs',
    section: 'verify',
    name: 'verify-build.mjs：自检退回「只查存不存在」，不查产物有效性',
    from: '        const productIssue = await productProblem(path.join(r2Date, tab.key, f));',
    to: "        const productIssue = fs.existsSync(path.join(r2Date, tab.key, f)) ? null : '不存在';",
    expectFail: [
      'verify-build.mjs：0 字节的产物让自检不通过（exit=1）',
      'verify-build.mjs：报错说清了是哪个文件',
      'verify-build.mjs：报错说清了是什么问题（0 字节）',
      'verify-build.mjs：坏文件头的产物让自检不通过（exit=1）',
      'verify-build.mjs：报错说清了「不是有效的 WebP」',
    ],
    expectGreen: [
      'verify-build.mjs：产物全都有效时自检通过',
      'verify-build.mjs：产物缺失仍然让自检不通过（exit=1，老行为没丢）',
      'verify-build.mjs：产物缺失的报错说清了「不存在」',
      'verify-build.mjs：0 字节的见报配图让自检不通过（exit=1）',
      'verify-build.mjs：配图的报错点名了是哪个文件',
      'verify-build.mjs：0 字节的封面让自检不通过（exit=1）',
      'verify-build.mjs：封面的报错点名了是哪个文件',
    ],
  },
  {
    id: 'M5',
    file: 'verify-build.mjs',
    section: 'verify',
    name: 'verify-build.mjs：有效性检查不再单独报「0 字节」（文案退化成「文件过短」）',
    from: "  if (st.size === 0) return '是 0 字节的空文件';",
    to: "  if (false) return '是 0 字节的空文件';",
    expectFail: ['verify-build.mjs：报错说清了是什么问题（0 字节）'],
    expectGreen: [
      'verify-build.mjs：产物全都有效时自检通过',
      'verify-build.mjs：0 字节的产物让自检不通过（exit=1）',
      'verify-build.mjs：报错说清了是哪个文件',
      'verify-build.mjs：坏文件头的产物让自检不通过（exit=1）',
      'verify-build.mjs：报错说清了「不是有效的 WebP」',
      'verify-build.mjs：产物缺失仍然让自检不通过（exit=1，老行为没丢）',
      'verify-build.mjs：0 字节的见报配图让自检不通过（exit=1）',
      'verify-build.mjs：0 字节的封面让自检不通过（exit=1）',
    ],
  },
  {
    id: 'M6',
    file: 'verify-build.mjs',
    section: 'verify',
    name: 'verify-build.mjs：查出产物坏了只警告，不计入 problems（自检照样放行）',
    from:
      '        if (productIssue) {\n' +
      '          problems.push(`${tab.key}/${f} 被 manifest 引用，但母本里的产物${productIssue}`);\n' +
      '        }',
    to:
      '        if (productIssue) {\n' +
      '          console.warn(`${tab.key}/${f} 被 manifest 引用，但母本里的产物${productIssue}`);\n' +
      '        }',
    expectFail: [
      'verify-build.mjs：0 字节的产物让自检不通过（exit=1）',
      'verify-build.mjs：坏文件头的产物让自检不通过（exit=1）',
      'verify-build.mjs：产物缺失仍然让自检不通过（exit=1，老行为没丢）',
    ],
    expectGreen: [
      'verify-build.mjs：产物全都有效时自检通过',
      'verify-build.mjs：报错说清了是哪个文件',
      'verify-build.mjs：报错说清了是什么问题（0 字节）',
      'verify-build.mjs：报错说清了「不是有效的 WebP」',
      'verify-build.mjs：0 字节的见报配图让自检不通过（exit=1）',
      'verify-build.mjs：配图的报错点名了是哪个文件',
      'verify-build.mjs：0 字节的封面让自检不通过（exit=1）',
      'verify-build.mjs：封面的报错点名了是哪个文件',
    ],
  },
  {
    id: 'M7',
    file: 'upload-r2.mjs',
    section: 'upload',
    name: 'upload-r2.mjs：上传前不做有效性检查（坏产物照传）',
    from:
      '      const problem = await productProblem(f.file);\n' +
      '      if (problem) invalid.push({ date: job.date, key: f.key, problem });',
    to: '      const problem = null;\n      if (problem) invalid.push({ date: job.date, key: f.key, problem });',
    expectFail: [
      'upload-r2.mjs：0 字节的产物让 --dry 以非 0 退出',
      'upload-r2.mjs：--dry 的报错点名了是哪个文件',
      'upload-r2.mjs：--dry 的报错说清了「0 字节」',
      'upload-r2.mjs：坏文件头的产物让 --dry 以非 0 退出',
      'upload-r2.mjs：--dry 的报错说清了「不是有效的 WebP」',
      'upload-r2.mjs：有坏产物时**一个网络请求都没发**',
    ],
    expectGreen: [
      'upload-r2.mjs：产物全都有效时 --dry 正常（exit=0）',
      'upload-r2.mjs：--dry 打印了上传计划',
      'upload-r2.mjs：真上传的失败不是「缺少环境变量」顶替的',
    ],
  },
  {
    id: 'M8',
    file: 'upload-r2.mjs',
    section: 'upload',
    name: 'upload-r2.mjs：坏产物只报个名字，不当成失败（不 exit 1）',
    from:
      "    console.error('多半是转码被中断留下的 0 字节母本 —— 先重新构建，再发布。');\n" +
      '    process.exit(1);',
    to: "    console.error('多半是转码被中断留下的 0 字节母本 —— 先重新构建，再发布。');",
    expectFail: [
      'upload-r2.mjs：0 字节的产物让 --dry 以非 0 退出',
      'upload-r2.mjs：坏文件头的产物让 --dry 以非 0 退出',
      'upload-r2.mjs：有坏产物时**一个网络请求都没发**',
    ],
    expectGreen: [
      'upload-r2.mjs：--dry 的报错点名了是哪个文件',
      'upload-r2.mjs：--dry 的报错说清了「0 字节」',
      'upload-r2.mjs：0 字节的产物让真上传以非 0 退出（发布停住）',
      'upload-r2.mjs：真上传的失败不是「缺少环境变量」顶替的',
      'upload-r2.mjs：真上传的报错点名了是哪个文件',
    ],
  },
  {
    id: 'M9',
    file: 'upload-r2.mjs',
    section: 'upload',
    name: 'upload-r2.mjs：有效性检查不再单独报「0 字节」（文案退化成「文件过短」）',
    from: "  if (st.size === 0) return '是 0 字节的空文件';",
    to: "  if (false) return '是 0 字节的空文件';",
    expectFail: ['upload-r2.mjs：--dry 的报错说清了「0 字节」'],
    expectGreen: [
      'upload-r2.mjs：产物全都有效时 --dry 正常（exit=0）',
      'upload-r2.mjs：0 字节的产物让 --dry 以非 0 退出',
      'upload-r2.mjs：--dry 的报错点名了是哪个文件',
      'upload-r2.mjs：有坏产物时**一个网络请求都没发**',
      'upload-r2.mjs：坏文件头的产物让 --dry 以非 0 退出',
      'upload-r2.mjs：--dry 的报错说清了「不是有效的 WebP」',
    ],
  },
  {
    /* 本地化封面挂在文本型 tab 的 it.cover 上（豆瓣图床 418 → 必须自存）。
       这一条是「文本型 tab 的封面闸门」唯一的一道防线 ——
       covers/ 目录**不在孤儿检查范围**里（文本型 tab 的 key 压根没进 referenced），
       所以闸门一旦退回「只查存不存在」，0 字节封面就一路混到线上（2026-11-14 实测真缺陷）。 */
    id: 'M10',
    file: 'verify-build.mjs',
    section: 'verify',
    name: 'verify-build.mjs：文本型 tab 的本地化封面退回「只查存不存在」（0 字节封面照样放行）',
    from: '        const coverProblem = await productProblem(coverFile);',
    to: "        const coverProblem = fs.existsSync(coverFile) ? null : '不存在';",
    expectFail: [
      'verify-build.mjs：0 字节的封面让自检不通过（exit=1）',
      'verify-build.mjs：封面的报错点名了是哪个文件',
    ],
    expectGreen: [
      'verify-build.mjs：产物全都有效时自检通过',
      'verify-build.mjs：0 字节的产物让自检不通过（exit=1）',
      'verify-build.mjs：报错说清了是哪个文件',
      'verify-build.mjs：报错说清了是什么问题（0 字节）',
      'verify-build.mjs：坏文件头的产物让自检不通过（exit=1）',
      'verify-build.mjs：报错说清了「不是有效的 WebP」',
      'verify-build.mjs：产物缺失仍然让自检不通过（exit=1，老行为没丢）',
      'verify-build.mjs：产物缺失的报错说清了「不存在」',
      'verify-build.mjs：0 字节的见报配图让自检不通过（exit=1）',
      'verify-build.mjs：配图的报错点名了是哪个文件',
    ],
  },
];

/* ── 小工具 ───────────────────────────────────────────── */

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 从测试 stdout 里抠出**变红的那几条断言名**（断言名在 `  ✗ ` 之后、`  —— ` 之前）。
 *
 * ⚠️ 必须严格匹配主护栏的格式（正好两个空格 + ✗）：
 *    被测脚本自己的输出里也有 '✗ ...' 开头的行（比如 verify-build 的
 *    「✗ 1/1 期不通过 —— 不要发布」），宽松匹配会把它们当成红掉的断言。
 */
function failedAssertions(stdout) {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.match(/^ {2}✗ (.*)$/);
    if (m) out.push(m[1].split('  —— ')[0].trim());
  }
  return out;
}

/** 副本自检：变异真落地（排除空变异） */
function selfCheck(mutated, original, to) {
  if (mutated === original) return { ok: false, note: '变异没落地（副本跟原文一样）' };
  if (!mutated.includes(to)) return { ok: false, note: '变异片段没出现在副本里' };
  return { ok: true, note: '副本完好，变异已落地' };
}

/** 把变异体写进独立目录（主护栏会用 PRODUCT_VALIDITY_IMPL_DIR 指过来） */
function setupMutant(id, file, source) {
  const dir = path.join(TMP, 'mutants', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), source, 'utf8');
  return dir;
}

function runUnit(mutantDir, section) {
  const res = spawnSync(process.execPath, [UNIT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PRODUCT_VALIDITY_IMPL_DIR: mutantDir,
      PRODUCT_VALIDITY_SECTION: section,
    },
    timeout: 600000,
  });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  return {
    code: res.status,
    stdout,
    stderr,
    failed: failedAssertions(stdout),
    crashed: stderr.trim().length > 0,
  };
}

/* ── 主流程 ───────────────────────────────────────────── */

function main() {
  console.log('变异测试：故意改坏「产物有效性」三道闸门，看主护栏抓不抓得住\n');

  const targets = ['build.mjs', 'verify-build.mjs', 'upload-r2.mjs'];
  const before = {};
  for (const f of targets) before[f] = sha256(path.join(__dirname, f));
  console.log('── 本体哈希（跑之前）');
  for (const f of targets) console.log(`   tools/${f}  ${before[f]}`);

  const orig = {};
  for (const f of targets) orig[f] = fs.readFileSync(path.join(__dirname, f), 'utf8');

  /* 锚点自检：每个 from 必须**在本文件里唯一命中**当前源码 —— 找不到/不唯一就是脚本过期了 */
  console.log('\n── 锚点自检（from 必须在被改文件里唯一命中）');
  const brokenAnchors = [];
  for (const m of MUTATIONS) {
    const hits = orig[m.file].split(m.from).length - 1;
    if (hits !== 1) {
      brokenAnchors.push(`${m.id} ${m.name}（在 ${m.file} 里命中 ${hits} 次）`);
      console.log(`   ✗ ${m.id} ${m.name} —— 命中 ${hits} 次（必须恰好 1 次）`);
    }
  }
  if (brokenAnchors.length) {
    console.log('\n✗ 锚点没对上 —— 变异脚本过期了（源码改了？）');
    for (const b of brokenAnchors) console.log(`   ${b}`);
    process.exit(1);
  }
  console.log(`   ✓ ${MUTATIONS.length} 个锚点全部唯一命中`);

  /* 基线：没变异的副本，测试必须全绿。不绿的话，后面的「红」没有意义。 */
  console.log('\n── 基线（未变异的副本）');
  {
    const dir = path.join(TMP, 'mutants', '_baseline');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of targets) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
    const base = runUnit(dir, 'all');
    console.log(`   主护栏退出码 = ${base.code}，失败断言 = ${base.failed.length} 条`);
    if (base.code !== 0 || base.failed.length > 0) {
      console.log('\n✗ 基线不绿 —— 变异测试没有意义，先修主护栏。');
      console.log(base.stdout.split(/\r?\n/).filter((l) => /✗/.test(l)).join('\n'));
      console.log(base.stderr.split(/\r?\n/).slice(0, 10).join('\n'));
      process.exit(1);
    }
    console.log('   ✓ 基线绿');
  }

  /* 逐个变异 */
  const results = [];
  for (const m of MUTATIONS) {
    console.log(`\n── 变异 ${m.id}：${m.name}`);

    const mutated = orig[m.file].replace(m.from, m.to);
    const dir = path.join(TMP, 'mutants', m.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '_syntax-probe.mjs'), mutated, 'utf8');
    const self = selfCheck(mutated, orig[m.file], m.to);
    if (!self.ok) {
      console.log(`   ✗ ${self.note}`);
      results.push({ id: m.id, name: m.name, verdict: 'BROKEN_MUTANT' });
      continue;
    }
    // 语法自检（node --check）：语法坏了就是假红，不算数
    const syntax = spawnSync(process.execPath, ['--check', path.join(dir, '_syntax-probe.mjs')], { encoding: 'utf8' });
    if (syntax.status !== 0) {
      console.log('   ✗ 副本语法坏了（假红，不算数）');
      results.push({ id: m.id, name: m.name, verdict: 'BROKEN_MUTANT' });
      continue;
    }
    console.log('   副本语法 OK，变异已落地');

    const mutantDir = setupMutant(m.id, m.file, mutated);
    let res = runUnit(mutantDir, m.section);

    /* 护栏自己崩了 = 这一轮不算数（崩溃造成的红不是红）。
       先重跑一次；连崩两次就如实报出来，别把崩溃当成「抓到了」。 */
    if (res.crashed) {
      console.log('   注：护栏自己崩了（崩溃造成的红不算红）—— 重跑一次');
      res = runUnit(mutantDir, m.section);
    }
    if (res.crashed) {
      const errLine = res.stderr
        .split(/\r?\n/)
        .filter((l) => /Error/.test(l) && !/^\s*at /.test(l))
        .slice(0, 2)
        .join(' | ');
      console.log(`   ✗ 护栏连跑两次都崩了 —— 这一轮不算数：${errLine}`);
      results.push({ id: m.id, name: m.name, verdict: 'CRASHED' });
      continue;
    }

    const missExpected = m.expectFail.filter((want) => !res.failed.some((f) => f.includes(want)));
    const polluted = m.expectGreen.filter((want) => res.failed.some((f) => f.includes(want)));
    const expectedSet = m.expectFail.map((w) => w.slice(0, 12));
    const unexpected = res.failed.filter(
      (f) => !m.expectFail.some((w) => f.includes(w)) && !m.expectGreen.some((w) => f.includes(w)),
    );

    console.log(`   期望红的断言：${m.expectFail.length} 条`);
    console.log(`   实际红的断言：${res.failed.length ? res.failed.join(' / ') : '（无）'}`);
    if (missExpected.length) {
      console.log(`   ✗ 没红：${missExpected.join(' / ')}`);
    }
    if (polluted.length) {
      console.log(`   ✗ 本该保持绿却红了：${polluted.join(' / ')}`);
    }
    if (unexpected.length) {
      console.log(`   （另有 ${unexpected.length} 条未列入清单的红：${unexpected.join(' / ')}）`);
    }
    if (res.crashed) {
      const errLine = res.stderr
        .split(/\r?\n/)
        .filter((l) => /Error|error/.test(l) && !/^\s*at /.test(l))
        .slice(0, 2)
        .join(' | ');
      console.log(`   注：测试随后崩了（stderr 非空）：${errLine || res.stderr.split(/\r?\n/).filter(Boolean)[0] || ''}`);
    }

    let verdict;
    if (res.stderr.includes('SyntaxError')) verdict = 'BROKEN_MUTANT'; // 副本/测试文件语法坏了 = 假红
    else if (missExpected.length === 0 && polluted.length === 0) verdict = 'CAUGHT';
    else if (missExpected.length === 0) verdict = 'FALSE_RED';
    else if (res.code === 0) verdict = 'MISSED';
    else verdict = 'FALSE_RED';

    const label = {
      CAUGHT: '✓ 被抓到了',
      MISSED: '✗ 没被抓到 —— 主护栏有缺口',
      FALSE_RED: '✗ 红了但红的不对（假红）',
      BROKEN_MUTANT: '✗ 变异体坏了（假红）',
      CRASHED: '✗ 护栏崩了 —— 这一轮不算数（环境问题，不是护栏的缺口）',
    }[verdict];
    console.log(`   判定：${label}`);

    results.push({ id: m.id, name: m.name, verdict, missExpected, polluted, failed: res.failed });
  }

  /* 收尾：哈希比对（本体不能被改）+ 清掉临时目录 */
  const after = {};
  for (const f of targets) after[f] = sha256(path.join(__dirname, f));
  console.log('\n── 本体哈希（跑之后）');
  for (const f of targets) console.log(`   tools/${f}  ${after[f]}`);
  const same = targets.every((f) => before[f] === after[f]);
  console.log(`   本体字节级未变：${same ? '是' : '否 —— 本体被改了！'}`);

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`   临时副本目录已清：${TMP}`);
  } catch {
    console.log(`   临时副本目录没清掉（删不掉就算了）：${TMP}`);
  }

  const caught = results.filter((r) => r.verdict === 'CAUGHT').length;
  console.log(`\n变异测试：${caught}/${results.length} 被抓到`);
  const missed = results.filter((r) => r.verdict !== 'CAUGHT');
  if (missed.length) {
    console.log('\n没抓到的变异（主护栏的缺口，不是本脚本的问题）：');
    for (const r of missed) {
      console.log(
        `   ${r.id} ${r.name} —— ${r.verdict}：` +
          `${(r.missExpected || []).join(' / ') || (r.polluted || []).join(' / ') || '（锚点没命中）'}`,
      );
    }
  }
  if (!same) process.exit(1);
  process.exit(caught === results.length ? 0 : 1);
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
