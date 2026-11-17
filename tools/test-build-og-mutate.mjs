#!/usr/bin/env node
/**
 * 变异验证：证明 test-build-og.mjs 真的有牙齿。
 *
 * 护栏自己「全绿」说明不了它能抓住坏版本 —— 只会说明它没坏。
 * 所以这里把被保护的文件**故意改坏**，再跑护栏，要求它**必须变红**。
 *
 * 变异体不碰真文件：写到 tools/.tmp-build-og-mut/ 下，跑完删掉。
 * （不用系统 temp 目录 —— 出问题时得能在工程里翻到它。）
 *
 * 每个变异体写三件事：
 *   · edits        —— 改哪一段（锚点必须在目标文件里**唯一命中一次**）
 *   · expectFail   —— 期望变红的那几条断言（子串匹配）
 *   · expectGreen  —— 期望仍然绿的那几条断言（子串匹配；它们变红就是**误伤**，
 *                      说明护栏的判据太粗，改坏一处把不相干的东西也判成坏的）
 *
 * ⚠️ **必须「干净地红」**：护栏变红是因为**断言不成立**，
 *    不是护栏自己抛异常。所以这里同时检查：
 *      ① 护栏跑出了「N 通过 / M 失败」的统计行（崩了就没有这行）
 *      ② stderr 里没有调用栈
 *    崩出来的红会把真缺口盖住 —— 那不算抓到。
 *
 * 统计只切**本次运行**的输出（不读任何历史累计文件）——
 * 否则历史残留会把这次的结论带偏。
 *
 * 用法：node tools/test-build-og-mutate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, '.tmp-build-og-mut');
const GUARD = path.join(__dirname, 'test-build-og.mjs');

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

/**
 * 多行锚点拼装。
 * 为什么要这么麻烦：这些锚点里有反引号和 ${}（ffmpeg 的报错信息、console.log 的模板串），
 * 写进普通字符串要么转义要么串味 —— 用数组逐行拼最不容易出错。
 */
const L = (...lines) => lines.join('\n');

// ⚠️ 用 utf8 读（不是 latin1）—— BOM 会以 \uFEFF 留在字符串开头，
//    写回去时又变回 EF BB BF，变异体的编码跟真文件保持一致。
//    否则护栏里「无 BOM」那条会因为变异体本身没 BOM 而恒红，
//    红得没有意义（那不叫「抓到了」，那叫「自己坏掉了」）。
const BOG = fs.readFileSync(path.join(ROOT, 'tools/build-og.mjs'), 'utf8');
const BUILD = fs.readFileSync(path.join(ROOT, 'tools/build.mjs'), 'utf8');
const TPL = fs.readFileSync(path.join(ROOT, 'site/template.html'), 'utf8');

/** build.mjs 里那整块 og 合成代码（原样搬运的锚点）。 */
const OG_BLOCK = L(
  '  if (ogPhotos.length) {',
  '    try {',
  '      const og = await composeOgImage({',
  '        ffmpeg,',
  '        inputs: ogPhotos.map((p) => p.file),',
  "        outFile: path.join(publishedDir, 'og.jpg'),",
  '      });',
  '      ogImage = ogImageUrl({ siteUrl, date });',
  '      ogImageW = String(og.width);',
  '      ogImageH = String(og.height);',
  '      console.log(`  · 分享图：og.jpg（${(og.bytes / 1024).toFixed(0)}KB，${ogPhotos.length} 张拼图）`);',
  '    } catch (e) {',
  '      console.log(`  ! 分享图合成失败（${e.message}）—— 退回 logo 当 og:image`);',
  '    }',
  '  }',
  '',
);

const MUTANTS = [
  {
    label: 'build-og.mjs：默认宽高改成 640（卡片排版垮了）',
    env: 'BUILD_OG_MJS',
    file: 'build-og.mjs',
    src: BOG,
    edits: [{ from: 'width = 1200, height = 630', to: 'width = 640, height = 630' }],
    expectFail: ['build-og.mjs 的默认宽高是 1200 / 630'],
    expectGreen: [
      'composeOgImage 合成失败时抛 Error',
      'composeOgImage 合成后校验产物字节数 > 0',
      'ogImageUrl 拼出绝对 URL',
    ],
  },
  {
    label: 'build-og.mjs：ogImageUrl 把站点根写死（忽略传进来的 siteUrl）',
    env: 'BUILD_OG_MJS',
    file: 'build-og.mjs',
    src: BOG,
    edits: [
      {
        from: "  const base = String(siteUrl || '').replace(/\\/+$/, '');",
        // ⚠️ 这里写死的域名**必须跟护栏夹具的域名不一样**。
        // 夹具用的是 https://example.com —— 如果变异体也写死 example.com，
        // 变异结果跟夹具期望**完全相同** → 断言照样绿 → 变异白做（静默失效）。
        // （脱敏时踩过：原来这里写死的是真域名，脱敏成 example.com 之后就撞上了。）
        to: "  const base = 'https://hardcoded.example.net';",
      },
    ],
    expectFail: ['ogImageUrl 拼出绝对 URL', 'ogImageUrl 跟着传入的 siteUrl 走'],
    expectGreen: ['build-og.mjs 的默认宽高是 1200 / 630', 'og:image 拼出来是绝对 URL'],
  },
  {
    label: 'build-og.mjs：ffmpeg 失败时把 throw 改成 return（build.mjs 以为合成成功）',
    env: 'BUILD_OG_MJS',
    file: 'build-og.mjs',
    src: BOG,
    edits: [
      {
        from: L(
          '  } catch (e) {',
          '    const detail = errText(e).trim().slice(0, 300);',
          '    throw new Error(',
        ),
        to: L(
          '  } catch (e) {',
          '    return { width, height, bytes: 0, file: outFile };',
          '    throw new Error(',
        ),
      },
    ],
    expectFail: ['composeOgImage 合成失败时抛 Error'],
    expectGreen: [
      'composeOgImage 的报错带着失败原因',
      'composeOgImage 合成后校验产物字节数 > 0',
      'build-og.mjs 的默认宽高是 1200 / 630',
    ],
  },
  {
    label: 'build-og.mjs：去掉合成后的 size > 0 校验（0 字节产物会照样上线）',
    env: 'BUILD_OG_MJS',
    file: 'build-og.mjs',
    src: BOG,
    edits: [
      {
        from: L(
          '  if (!st || st.size <= 0) {',
          '    throw new Error(`ffmpeg 退出码 0，但产物是空文件：${outFile}`);',
          '  }',
        ),
        to: '',
      },
    ],
    expectFail: ['composeOgImage 合成后校验产物字节数 > 0'],
    expectGreen: [
      'composeOgImage 合成失败时抛 Error',
      'composeOgImage 的报错带着失败原因',
      'build-og.mjs 的默认宽高是 1200 / 630',
    ],
  },
  {
    label: "build.mjs：og.jpg 的落点改到根目录（当期页面拿不到图）",
    env: 'BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    edits: [
      {
        from: "        outFile: path.join(publishedDir, 'og.jpg'),",
        to: "        outFile: path.join(publishedRoot, 'og.jpg'),",
      },
    ],
    expectFail: ["og.jpg 落在当期目录"],
    expectGreen: [
      'og 合成写在 fs.rm / mkdir 之后',
      '根页和日期页都指向当期那张图',
      'og 合成失败只退回 logo，不阻断构建',
    ],
  },
  {
    label: 'build.mjs：og 合成整块挪到 fs.rm 之前（产物会被删掉）',
    env: 'BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    // 「搬家」没法用单条替换表达 —— 显式写成三步：删掉原位的 og 块、
    // 删掉原位的 ogPhotos 声明、再把两者插到 fs.rm 前面。
    // ogPhotos 跟着搬，是为了让变异体只坏在「顺序」这一处 ——
    // 不跟着搬的话它会因为引用了还没声明的变量而整个崩掉，那是另一种坏法。
    edits: [
      { from: OG_BLOCK, to: '' },
      { from: '\n  const ogPhotos = [];', to: '' },
      {
        at: '\n  await fs.rm(publishedDir, { recursive: true, force: true });',
        text: OG_BLOCK + '\n  const ogPhotos = [];',
      },
    ],
    expectFail: ['og 合成写在 fs.rm / mkdir 之后'],
    expectGreen: [
      "og.jpg 落在当期目录",
      '根页和日期页都指向当期那张图',
      'build.mjs 替换了全部三个 og 占位符',
      'og 合成失败只退回 logo，不阻断构建',
    ],
  },
  {
    label: 'build.mjs：根页 og:title 带上日期（微信缓存的卡片会永远停在第一天）',
    env: 'BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    edits: [
      {
        from: '\n    pageTitle: SITE_TITLE,',
        to: '\n    pageTitle: `${SITE_TITLE} · ${date}`,',
      },
    ],
    expectFail: ['根页的 og:title / og:description 不带日期'],
    expectGreen: [
      '根页和日期页都指向当期那张图',
      'og:image 拼出来是绝对 URL',
      'og 合成写在 fs.rm / mkdir 之后',
    ],
  },
  {
    label: 'template.html：og:image 换成写死的 logo URL（URL 不带日期 → 卡片永远不变）',
    env: 'TEMPLATE_HTML',
    file: 'template.html',
    src: TPL,
    edits: [
      {
        from: '<meta property="og:image" content="{{OG_IMAGE}}">',
        to: '<meta property="og:image" content="https://example.com/assets/logo.jpg">',
      },
    ],
    expectFail: ['og:image 的 content 用的是 {{OG_IMAGE}} 占位符'],
    expectGreen: [
      '模板里有 {{OG_IMAGE}} / {{OG_IMAGE_W}} / {{OG_IMAGE_H}} 三个占位符',
      'og:image 不是相对路径',
    ],
  },
  {
    label: 'template.html：og:image 改成相对路径（爬虫拉不到 → 白卡）',
    env: 'TEMPLATE_HTML',
    file: 'template.html',
    src: TPL,
    edits: [
      {
        from: '<meta property="og:image" content="{{OG_IMAGE}}">',
        to: '<meta property="og:image" content="/{{OG_IMAGE}}">',
      },
    ],
    expectFail: ['og:image 的 content 用的是 {{OG_IMAGE}} 占位符', 'og:image 不是相对路径'],
    expectGreen: ['模板里有 {{OG_IMAGE}} / {{OG_IMAGE_W}} / {{OG_IMAGE_H}} 三个占位符'],
  },
  {
    label: 'template.html：删掉 twitter:image（X 只认 twitter:*，不认 og:image）',
    env: 'TEMPLATE_HTML',
    file: 'template.html',
    src: TPL,
    edits: [
      { from: '\n<meta name="twitter:image" content="{{OG_IMAGE}}">', to: '' },
    ],
    expectFail: ['模板里有 twitter:card=summary_large_image 和 twitter:image'],
    expectGreen: [
      '模板里有 {{OG_IMAGE}} / {{OG_IMAGE_W}} / {{OG_IMAGE_H}} 三个占位符',
      'og:image 的 content 用的是 {{OG_IMAGE}} 占位符',
    ],
  },
];

/**
 * 应用一条编辑，并顺手做锚点自检。
 *   { from, to }  —— 把 from 换成 to（to 是空串 = 删掉）
 *   { at, text }  —— 在 at 前面插入 text
 *
 * 锚点必须**恰好命中一次**：
 *   命中 0 次 = 源码改了、脚本过期了（这时候红不代表抓到了）
 *   命中 2 次 = 锚点不唯一，改一处会改两处（红得没有说服力）
 * 漂移要**立刻**退出，不能混进「没抓到」的统计里 —— 那会把两种失败混成一种。
 */
function applyEdit(src, edit, where) {
  const anchor = edit.at != null ? edit.at : edit.from;
  const hits = src.split(anchor).length - 1;
  if (hits !== 1) {
    console.error(`✗ 脚本过期了（源码改了？）：${where}`);
    console.error(`   锚点在${edit.at != null ? '插入点' : '替换点'}命中 ${hits} 次（必须恰好 1 次）`);
    console.error(`   ${JSON.stringify(anchor.slice(0, 160))}`);
    process.exit(1);
  }
  const i = src.indexOf(anchor);
  if (edit.at != null) return src.slice(0, i) + edit.text + src.slice(i);
  return src.slice(0, i) + (edit.to ?? '') + src.slice(i + anchor.length);
}

console.log('\n0) 基线：没改坏之前，护栏必须全绿');
{
  const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8' });
  const stdout = r.stdout || '';
  check('test-build-og.mjs 基线绿', r.status === 0, stdout.trim().split('\n').pop() || `exit ${r.status}`);
}

console.log('\n1) 变异：每改坏一处，对应护栏必须变红');

fs.mkdirSync(TMP, { recursive: true });

for (const m of MUTANTS) {
  const mutant = m.edits.reduce((s, e) => applyEdit(s, e, m.label), m.src);
  const file = path.join(TMP, m.file);
  fs.writeFileSync(file, mutant, 'utf8');

  // 兜底：把真的 build-og.mjs 也拷一份进临时目录。
  // 变异体里的 build.mjs 用的是相对 import './build-og.mjs'，
  // 万一以后护栏改成真的 import build.mjs，也不至于因为找不到模块而崩。
  if (m.file !== 'build-og.mjs') {
    fs.writeFileSync(path.join(TMP, 'build-og.mjs'), BOG, 'utf8');
  }

  const r = spawnSync(process.execPath, [GUARD], {
    encoding: 'utf8',
    env: { ...process.env, [m.env]: file },
  });
  // 统计只切本次 spawn 的输出 —— 不读任何历史累计文件。
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
