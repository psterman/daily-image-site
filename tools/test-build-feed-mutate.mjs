#!/usr/bin/env node
/**
 * 变异验证：证明 test-build-feed.mjs 真的有牙齿。
 *
 * 护栏自己「全绿」说明不了它能抓住坏版本 —— 只会说明它没坏。
 * 所以这里把被保护的文件**故意改坏**，再跑护栏，要求它**必须变红**。
 *
 * 变异体不碰真文件：写到 tools/.tmp-build-feed-mut/ 下，跑完删掉。
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
 * 用法：node tools/test-build-feed-mutate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, '.tmp-build-feed-mut');

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

/** 临时目录一定要清掉 —— 留着会让下一个人以为工程里多了个东西。 */
function cleanup() {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 清不掉也不影响结论 */
  }
}

// ⚠️ 用 utf8 读（不是 latin1）—— BOM 会以 \uFEFF 留在字符串开头，
//    写回去时又变回 EF BB BF，变异体的编码跟真文件保持一致。
const FEED_SRC = fs.readFileSync(path.join(ROOT, 'tools', 'build-feed.mjs'), 'utf8');
const BUILD_SRC = fs.readFileSync(path.join(ROOT, 'tools', 'build.mjs'), 'utf8');
const TPL_SRC = fs.readFileSync(path.join(ROOT, 'site', 'template.html'), 'utf8');

/* esc 的整段原文（多行锚点要用一模一样的缩进和引号） */
const ESC_BLOCK = `function esc(s) {
  return String(s)
    .replace(BAD_XML_CHARS, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}`;

const MUTANTS = [
  {
    label: 'build-feed.mjs：item 的 link 改成相对路径（阅读器手里没有站点根，点不开）',
    env: 'BUILD_FEED_MJS',
    file: 'build-feed.mjs',
    src: FEED_SRC,
    from: '    const link = `${base}/${day}/`;',
    to: '    const link = `/${day}/`;',
    expectFail: [
      '每个 item 的 link 都是绝对 URL（相对路径阅读器点不开）',
      '每个 item 的 guid 都是绝对 URL',
    ],
    expectGreen: [
      'feed 的 item 数 = 传入的期数（每期一条 item，不是每条内容一条）',
      'item 按期号倒序（新的在前）',
    ],
  },
  {
    label: 'build-feed.mjs：pubDate 改成本地时间（读者遍布全球，「这期是哪天」在不同机器上飘）',
    env: 'BUILD_FEED_MJS',
    file: 'build-feed.mjs',
    src: FEED_SRC,
    from: '  return d.toUTCString();',
    to: '  return d.toString();',
    expectFail: ['每个 item 的 pubDate 都以 GMT 结尾（UTC RFC822）'],
    expectGreen: [
      '每个 item 的 link 都是绝对 URL（相对路径阅读器点不开）',
      'item 按期号倒序（新的在前）',
      'rfc822 对非法日期抛错',
    ],
  },
  {
    label: 'build-feed.mjs：esc 变成原样返回（标题里的 & / < 不转义 → 整份 feed 是坏 XML）',
    env: 'BUILD_FEED_MJS',
    file: 'build-feed.mjs',
    src: FEED_SRC,
    from: ESC_BLOCK,
    to: `function esc(s) {
  return String(s).replace(BAD_XML_CHARS, '');
}`,
    expectFail: [
      '标题里的特殊字符都被转义（不转义整份 feed 是坏 XML）',
      '转义后的标题里没有裸 & 或裸 <（裸符号会让 XML 解析失败）',
    ],
    expectGreen: [
      'feed 的 item 数 = 传入的期数（每期一条 item，不是每条内容一条）',
      '每个 item 的 link 都是绝对 URL（相对路径阅读器点不开）',
    ],
  },
  {
    label: 'build-feed.mjs：排序改成升序（新的在后，阅读器默认按新的在前铺）',
    env: 'BUILD_FEED_MJS',
    file: 'build-feed.mjs',
    src: FEED_SRC,
    from: '      const d = issueTime(b.date) - issueTime(a.date);',
    to: '      const d = issueTime(a.date) - issueTime(b.date);',
    expectFail: ['item 按期号倒序（新的在前）'],
    expectGreen: [
      'feed 的 item 数 = 传入的期数（每期一条 item，不是每条内容一条）',
      '每个 item 的 link 都是绝对 URL（相对路径阅读器点不开）',
    ],
  },
  {
    label: 'build-feed.mjs：FEED_CN_NAMES 删掉 music（概览少一栏，听乐的条数不出现）',
    env: 'BUILD_FEED_MJS',
    file: 'build-feed.mjs',
    src: FEED_SRC,
    from: "  music: '听乐',\n",
    to: '',
    expectFail: [
      'FEED_CN_NAMES 恰好 6 个 key（见闻/见她/见笑/见报/听乐/看片）',
      'FEED_CN_NAMES 的顺序跟页面 6 个 tab 一致（概览按这个顺序出条数）',
    ],
    expectGreen: [
      'feed 的 item 数 = 传入的期数（每期一条 item，不是每条内容一条）',
      '每个 item 的 link 都是绝对 URL（相对路径阅读器点不开）',
    ],
  },
  {
    label: 'build-feed.mjs：channel 的 description 改回「三栏」（站点已经 6 个 tab 了）',
    env: 'BUILD_FEED_MJS',
    file: 'build-feed.mjs',
    src: FEED_SRC,
    from: "    '  <description>见闻 / 见她 / 见笑 图片，见报热榜，听乐与看片榜单，每日一阅。</description>',",
    to: "    '  <description>三栏图片，见报热榜，每日一阅。</description>',",
    expectFail: ['channel 的 description 里不再出现「三栏」（站点已经 6 个 tab）'],
    expectGreen: [
      'feed 的 item 数 = 传入的期数（每期一条 item，不是每条内容一条）',
      '每个 item 的 link 都是绝对 URL（相对路径阅读器点不开）',
      'item 的 description 是 6 个 tab 的条数摘要',
    ],
  },
  {
    label: 'build.mjs：feed.xml 写到当期目录（内容是所有往期，订阅者永远看不到历史）',
    env: 'BUILD_MJS',
    file: 'build.mjs',
    src: BUILD_SRC,
    from: "    await fs.writeFile(path.join(publishedRoot, 'feed.xml'), feedXml, 'utf8');",
    to: "    await fs.writeFile(path.join(publishedDir, 'feed.xml'), feedXml, 'utf8');",
    expectFail: [
      'feed.xml 写到 published 根目录（不是当期目录）',
      'feed.xml 没有写到当期目录',
    ],
    expectGreen: [
      'build.mjs import 了 buildFeedXml（来自 ./build-feed.mjs）',
      'feed 遍历的是往期目录列表 dates（不是只有当期）',
    ],
  },
  {
    label: 'build.mjs：feed 只扫当期不扫往期（订阅者只能看到今天这一期）',
    env: 'BUILD_MJS',
    file: 'build.mjs',
    src: BUILD_SRC,
    from: '    for (const d of dates) {',
    to: '    for (const d of [date]) {',
    expectFail: ['feed 遍历的是往期目录列表 dates（不是只有当期）'],
    expectGreen: [
      'feed.xml 写到 published 根目录（不是当期目录）',
      'feed 用 findLiveManifestName 找活 manifest（不是写死文件名）',
    ],
  },
  {
    label: 'template.html：type 改成 text/xml（很多阅读器不认这个类型，不自动发现）',
    env: 'TEMPLATE_HTML',
    file: 'template.html',
    src: TPL_SRC,
    from: 'type="application/rss+xml"',
    to: 'type="text/xml"',
    expectFail: ['订阅链接的 type 必须是 application/rss+xml（text/xml 很多阅读器不认）'],
    expectGreen: [
      '订阅链接的 rel 必须是 alternate',
      '订阅链接的 href 必须是根路径 /feed.xml（日期页和归档页深度不同）',
      'template.html 里有指向 /feed.xml 的 <link>',
    ],
  },
  {
    label: 'build-feed.mjs：rfc822 不再校验非法日期（静默产出坏时间，feed 里多一条假条目）',
    env: 'BUILD_FEED_MJS',
    file: 'build-feed.mjs',
    src: FEED_SRC,
    from: '  if (Number.isNaN(d.getTime())) throw new Error(`时间不合法：${String(date)}`);',
    to: '  if (Number.isNaN(d.getTime())) return \'\';',
    expectFail: ['rfc822 对非法日期抛错'],
    expectGreen: [
      '每个 item 的 pubDate 都以 GMT 结尾（UTC RFC822）',
      'feed 的 item 数 = 传入的期数（每期一条 item，不是每条内容一条）',
    ],
  },
  {
    label:
      'build.mjs：往期页（/archive/ 自带的 head）里的订阅链接被删（从「全部日期」进来没有订阅入口）',
    env: 'BUILD_MJS',
    file: 'build.mjs',
    src: BUILD_SRC,
    from:
      '<link rel="alternate" type="application/rss+xml" title="${title} · 每日更新" href="/feed.xml">\n',
    to: '',
    expectFail: [
      '往期页（buildIndexHtml 自带的 head）里也有指向 /feed.xml 的 <link>',
      '往期页那条订阅链接的 rel 是 alternate',
      '往期页那条订阅链接的 type 是 application/rss+xml',
    ],
    expectGreen: [
      'template.html 里有指向 /feed.xml 的 <link>',
      '订阅链接的 rel 必须是 alternate',
      'feed.xml 写到 published 根目录（不是当期目录）',
    ],
  },
];

console.log('\n0) 基线：没改坏之前，护栏必须全绿');
{
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-build-feed.mjs')], {
    encoding: 'utf8',
  });
  check(
    'test-build-feed.mjs 基线绿',
    r.status === 0,
    (r.stdout || '').trim().split('\n').pop()
  );
  if (r.status !== 0) {
    console.log('\n基线就不绿 —— 后面跑变异没有意义（红到底是「改坏」还是「本来就坏」分不清）。');
    console.log((r.stdout || '').trim());
    console.log((r.stderr || '').trim());
    cleanup();
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
    console.log(`  ✗ ${m.label}`);
    console.log(
      hits === 0
        ? '    锚点在原文件里找不到 —— 脚本过期了（源码改了？）'
        : `    锚点在原文件里命中 ${hits} 次（必须恰好 1 次）—— 脚本过期了（源码改了？）`
    );
    cleanup();
    process.exit(1);
  }

  const mutant = m.src.replace(m.from, m.to);
  const file = path.join(TMP, m.file);
  fs.writeFileSync(file, mutant, 'utf8');

  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-build-feed.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, [m.env]: file },
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';

  // ── 干净地红 ────────────────────────────────────────────────
  const hasStats = /(\d+) 通过 \/ (\d+) 失败/.test(stdout);
  const hasStack = /\n\s+at\s+\S/.test(stderr);
  if (!hasStats || hasStack) {
    check(
      m.label,
      false,
      !hasStats
        ? '护栏没跑出统计行（它是崩的，不是断言不成立）'
        : 'stderr 里有调用栈（是崩出来的红，不算抓到）'
    );
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

cleanup();
check('临时目录清掉了', !fs.existsSync(TMP));

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
