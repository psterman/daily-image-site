#!/usr/bin/env node
/**
 * 变异验证：证明 test-build-lqip.mjs 真的有牙齿。
 *
 * 护栏自己「全绿」说明不了它能抓住坏版本 —— 只会说明它没坏。
 * 所以这里把被保护的文件**故意改坏**，再跑护栏，要求它**必须变红**。
 *
 * 变异体不碰真文件：写到 tools/.tmp-build-lqip-mut/ 下，跑完删掉。
 * （不用系统 temp 目录 —— 出问题时得能在工程里翻到它。）
 *
 * 每个变异体写三件事：
 *   · from → to     —— 改哪一段（锚点必须在目标文件里**唯一命中一次**）
 *   · expectFail    —— 期望变红的那几条断言（子串匹配）
 *   · expectGreen   —— 期望仍然绿的那几条断言（子串匹配；它们变红就是**误伤**，
 *                       说明护栏的判据太粗，改坏一处把不相干的东西也判成坏的）
 *
 * ⚠️ **必须「干净地红」**：护栏变红是因为**断言不成立**，
 *    不是护栏自己抛异常。所以这里同时检查：
 *      ① 护栏跑出了「N 通过 / M 失败」的统计行（崩了就没有这行）
 *      ② stderr 里没有调用栈
 *    崩出来的红会把真缺口盖住 —— 那不算抓到。
 *
 * 用法：node tools/test-build-lqip-mutate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, '.tmp-build-lqip-mut');

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

const GUARD = path.join(__dirname, 'test-build-lqip.mjs');

// ⚠️ 用 utf8 读（不是 latin1）—— BOM 会以 \uFEFF 留在字符串开头，
//    写回去时又变回 EF BB BF，变异体的编码跟真文件保持一致。
const LQIP = fs.readFileSync(path.join(ROOT, 'tools/build-lqip.mjs'), 'utf8');
const BUILD = fs.readFileSync(path.join(ROOT, 'tools/build.mjs'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT, 'site/app.js'), 'utf8');
const APP_CSS = fs.readFileSync(path.join(ROOT, 'site/app.css'), 'utf8');

const MUTANTS = [
  {
    label: 'build-lqip.mjs：flags=fast_bilinear 写成 flags=fast（ffmpeg 9.0.2 非法值 → 整批 182 张全废）',
    env: 'BUILD_LQIP_MJS',
    file: 'build-lqip.mjs',
    src: LQIP,
    from: 'flags=fast_bilinear',
    to: 'flags=fast',
    expectFail: ['build-lqip.mjs 用 flags=fast_bilinear', 'build-lqip.mjs 没有非法的 flags=fast'],
    expectGreen: [
      'build-lqip.mjs 默认 batchSize = 12',
      'build-lqip.mjs 的 LQIP 宽度默认 24px',
      'makeLqipDataUris 全失败时返回空 Map 且不抛异常',
    ],
  },
  {
    label: 'build-lqip.mjs：默认 batchSize 从 12 改成 1（一图一进程 = 182 次 ffmpeg ≈ +45 秒构建）',
    env: 'BUILD_LQIP_MJS',
    file: 'build-lqip.mjs',
    src: LQIP,
    from: 'const DEFAULT_BATCH_SIZE = 12;',
    to: 'const DEFAULT_BATCH_SIZE = 1;',
    expectFail: ['build-lqip.mjs 默认 batchSize = 12', 'makeLqipDataUris 24 张图只起 2 次 ffmpeg'],
    expectGreen: [
      'build-lqip.mjs 用 flags=fast_bilinear',
      'build-lqip.mjs 的 LQIP 宽度默认 24px',
      'build-lqip.mjs 一批一次 ffmpeg 调用（只有一个调用点）',
    ],
  },
  {
    label: 'build-lqip.mjs：LQIP 宽度从 24px 改成 96px（占位图太大，manifest 暴涨）',
    env: 'BUILD_LQIP_MJS',
    file: 'build-lqip.mjs',
    src: LQIP,
    from: 'const DEFAULT_WIDTH = 24;',
    to: 'const DEFAULT_WIDTH = 96;',
    expectFail: ['build-lqip.mjs 的 LQIP 宽度默认 24px'],
    expectGreen: [
      'build-lqip.mjs 默认 batchSize = 12',
      'build-lqip.mjs 用 flags=fast_bilinear',
      'makeLqipDataUris 24 张图只起 2 次 ffmpeg',
    ],
  },
  {
    label: 'build-lqip.mjs：整批失败改成 throw（LQIP 是锦上添花，不该把整期掀翻）',
    env: 'BUILD_LQIP_MJS',
    file: 'build-lqip.mjs',
    src: LQIP,
    from: '      console.warn(`  ! LQIP 批次 ${no}/${totalBatches} 失败（${batch.length} 张整批跳过）：${errText(err)}`);\n    }',
    to: '      console.warn(`  ! LQIP 批次 ${no}/${totalBatches} 失败（${batch.length} 张整批跳过）：${errText(err)}`);\n      throw err;\n    }',
    expectFail: [
      'makeLqipDataUris 全失败时返回空 Map 且不抛异常',
      'makeLqipDataUris 24 张图只起 2 次 ffmpeg',
    ],
    expectGreen: [
      'build-lqip.mjs 导出 makeLqipDataUris',
      'build-lqip.mjs 默认 batchSize = 12',
      'build.mjs 的 LQIP 失败只降级不阻断构建',
    ],
  },
  {
    label: 'build.mjs：manifest 条目上不写 lqip 字段（占位图永远发不出去）',
    env: 'BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: '        j.item.lqip = uri;\n',
    to: '',
    expectFail: ['build.mjs 把 LQIP 写进 manifest 条目的 lqip 字段'],
    expectGreen: [
      'build.mjs 的 lqipMap 就是 makeLqipDataUris 的返回值',
      'build.mjs 的 LQIP 失败只降级不阻断构建',
      'build.mjs 只给三栏照片收集 LQIP',
    ],
  },
  {
    label: 'build.mjs：LQIP 失败直接 throw（掀翻整个构建）',
    env: 'BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: '    } catch (e) {\n      console.log(`  ! 模糊占位生成失败（${e.message}）—— 不影响发布`);\n    }',
    to: '    } catch (e) {\n      console.log(`  ! 模糊占位生成失败（${e.message}）—— 不影响发布`);\n      throw e;\n    }',
    expectFail: ['build.mjs 的 LQIP 失败只降级不阻断构建'],
    expectGreen: [
      'build.mjs 把 LQIP 写进 manifest 条目的 lqip 字段',
      'build.mjs 只给三栏照片收集 LQIP',
      'build.mjs import 了 makeLqipDataUris',
    ],
  },
  {
    label: 'app.js：不再设置 --lqip 变量（首屏又变回一格格空的深色方块）',
    env: 'APP_JS',
    file: 'app.js',
    src: APP_JS,
    from: `        if (item.lqip) {
          cell.style.setProperty('--lqip', 'url("' + item.lqip + '")');
        }`,
    to: `        if (item.lqip) {
          /* 变异体：不再设置 --lqip */
        }`,
    expectFail: ['app.js 把 item.lqip 写进 --lqip 变量', 'app.js 的 --lqip 值是 url("...") 形式'],
    expectGreen: [
      'app.js 没有 lqip 时不写变量',
      'app.css 的 .cell::before 用 background-image: var(--lqip, none)',
      'app.css 里没有 filter: blur(',
    ],
  },
  {
    label: 'app.css：.cell.is-loaded::before 的 opacity 从 0 改成 .9（模糊层永远盖在图上面）',
    env: 'APP_CSS',
    file: 'app.css',
    src: APP_CSS,
    from: '.cell.is-loaded::before { opacity: 0; }',
    to: '.cell.is-loaded::before { opacity: .9; }',
    expectFail: ['app.css 的 .cell.is-loaded::before 是 opacity: 0'],
    expectGreen: [
      'app.css 的 .cell::before 用 background-image: var(--lqip, none)',
      'app.css 里没有 filter: blur(',
      'app.js 把 item.lqip 写进 --lqip 变量',
    ],
  },
  {
    label: 'app.css：给 .cell::before 加 filter: blur(20px)（182 个模糊图层，手机上掉帧）',
    env: 'APP_CSS',
    file: 'app.css',
    src: APP_CSS,
    from: '  background-image: var(--lqip, none);\n  background-size: cover;',
    to: '  background-image: var(--lqip, none);\n  filter: blur(20px);\n  background-size: cover;',
    expectFail: ['app.css 里没有 filter: blur('],
    expectGreen: [
      'app.css 的 .cell::before 用 background-image: var(--lqip, none)',
      'app.css 的 .cell.is-loaded::before 是 opacity: 0',
    ],
  },
];

console.log('\n0) 基线：没改坏之前，护栏必须全绿');
{
  const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8' });
  check('test-build-lqip.mjs 基线绿', r.status === 0,
    (r.stdout || '').trim().split('\n').pop() + ' / ' + (r.stderr || '').trim().split('\n').pop());
  if (r.status !== 0) {
    console.log('\n基线就不绿 —— 下面的变异结果没有意义（红绿分不清是谁造成的）。');
    process.exit(1);
  }
}

console.log('\n1) 变异：每改坏一处，对应护栏必须变红');

fs.mkdirSync(TMP, { recursive: true });

for (const m of MUTANTS) {
  // ── 锚点自检 ────────────────────────────────────────────────
  // 锚点必须**恰好命中一次**。
  //   命中 0 次 = 源码改了、脚本过期了（这时候红不代表抓到了）
  //   命中 2 次 = 锚点不唯一，改一处会改两处（红得没有说服力）
  const hits = m.src.split(m.from).length - 1;
  if (hits !== 1) {
    check(m.label, false,
      hits === 0
        ? '锚点在原文件里找不到（源文件变了？脚本过期了？）'
        : `锚点在原文件里命中 ${hits} 次（必须恰好 1 次）`);
    continue;
  }

  // ⚠️ 用函数形式替换 —— 替换串里有 ${...}（模板串），
  //    字符串形式的 replace 会把 $& / $` 当成特殊替换模式处理。
  const mutant = m.src.replace(m.from, () => m.to);
  const file = path.join(TMP, m.file);
  fs.writeFileSync(file, mutant, 'utf8');

  const r = spawnSync(process.execPath, [GUARD], {
    encoding: 'utf8',
    env: { ...process.env, [m.env]: file },
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';

  // ── 干净地红 ────────────────────────────────────────────────
  const hasStats = /(\d+) 通过 \/ (\d+) 失败/.test(stdout);
  const hasStack = /\n\s+at\s+\S/.test(stderr);
  if (!hasStats || hasStack) {
    check(m.label, false,
      !hasStats
        ? '护栏没跑出统计行（它是崩的，不是断言不成立）'
        : 'stderr 里有调用栈（是崩出来的红，不算抓到）');
    continue;
  }
  if (r.status === 0) {
    const lastLine = stdout.trim().split('\n').pop();
    check(m.label, false, `护栏居然还是绿的（exit 0，末行：${lastLine}）`);
    continue;
  }

  // ── 期望红的那几条，必须真的红 ──────────────────────────────
  const redLines = stdout.split('\n').filter((l) => l.trim().startsWith('✗')).join('\n');
  const missingFail = (m.expectFail || []).filter((label) => !redLines.includes(label));
  if (missingFail.length) {
    check(m.label, false, '这些断言该红却没红：' + missingFail.join(' | '));
    continue;
  }
  // ── 期望仍然绿的那几条，不许被误伤 ──────────────────────────
  const wronglyRed = (m.expectGreen || []).filter((label) => redLines.includes(label));
  if (wronglyRed.length) {
    check(m.label, false, '这些断言被误伤了：' + wronglyRed.join(' | '));
    continue;
  }
  check(m.label, true);
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录留着也不影响 */
}
check('临时目录清掉了', !fs.existsSync(TMP));

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
