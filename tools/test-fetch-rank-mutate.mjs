#!/usr/bin/env node
/**
 * 变异测试：故意改坏「榜单抓取 v2」的实现，看主护栏抓不抓得住。
 *
 * 护栏有没有牙齿，判定标准就是变异测试：改坏实现，测试必须变红。全绿 = 护栏是空的。
 *
 * 为什么不能只看退出码（这个项目已经踩过多次假护栏）：
 *   副本要是语法坏了，测试会直接崩，退出码照样非 0 —— 那是「假红」。
 *   所以每个变异都要同时核对三件事：
 *     1) 变异体本身没坏（node --check 过）—— 排除假红；
 *     2) 变异真的落地了（目标片段在副本里、且与原文不同）；
 *     3) 红的正好是**预期的那几条断言** —— 不是别的断言。
 *
 * 手法：把 tools/fetch-rank.mjs 的源码按变异规则改写，复制到
 * tools/.tmp-fetch-rank-mutate/<变异号>/（连 paths.mjs / env.mjs 一起复制，
 * 否则副本 import 不到 ./paths.mjs 会「崩」而不是断言红），
 * 再用 FETCH_RANK 指过去跑一遍主护栏，看是不是**指定的那几条断言**红了。
 *
 * 这个模块同时被 tools/test-fetch-rank.mjs 复用（主护栏内嵌的那段变异测试
 * 用的是同一份清单）—— 清单只有一份，改一处两边都跟着变。
 *
 * 跑法：node tools/test-fetch-rank-mutate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMPL = path.join(__dirname, 'fetch-rank.mjs');
const UNIT = path.join(__dirname, 'test-fetch-rank.mjs');
const TMP = path.join(__dirname, '.tmp-fetch-rank-mutate');

/* ── 变异清单 ────────────────────────────────────────────────────────────
 * from 必须是磁盘上当前源码里**逐字存在**的片段，
 * 脚本会先校验它唯一存在，找不到就报错退出（源码变了，脚本过期了）。
 *
 * expectFail：预期应该变红的那几条断言名（子串匹配）。
 * 每条变异都要能被 tools/test-fetch-rank.mjs 的断言抓到。
 */
export const MUTATIONS = [
  {
    id: 'M1',
    name: 'toHttps 不再把 http 换成 https（封面 mixed content 回来）',
    from: "  return s.startsWith('http://') ? 'https://' + s.slice('http://'.length) : s;",
    to: '  return s;',
    expectFail: ['网易云：封面 http 换成 https', '契约：所有 cover 要么空、要么 https 开头'],
  },
  {
    id: 'M2',
    name: '网易云的 tags 丢掉 @<层号>: 前缀（前端 chip 认不出层级）',
    from: '      tags: [`@1:${groupLabel}`, `@2:${chart.label}`],',
    to: '      tags: [groupLabel, chart.label],',
    expectFail: ['契约：tags 形如 @<数字>:<非空文字>', '契约：每个条目恰好一个 @1 标签'],
  },
  {
    id: 'M3',
    name: 'rank 全写 1（不再连号）',
    from: '  const out = { rank };',
    to: '  const out = { rank: 1 };',
    expectFail: [
      '契约：music rank 从 1 连号',
      '契约：movie rank 从 1 连号',
      '契约：video rank 从 1 连号',
      '抓取：music rank 从 1 连号',
      '抓取：movie rank 从 1 连号',
      '抓取：video rank 从 1 连号',
    ],
  },
  {
    id: 'M4',
    name: '输出里把 tags 清空（前端没有 chip 可渲染）',
    from: "  out.tags = Array.isArray(src.tags) ? src.tags.filter((t) => typeof t === 'string' && t) : [];",
    to: '  out.tags = [];',
    expectFail: ['契约：每个条目 tags 非空'],
  },
  {
    id: 'M5',
    name: '猫眼封面不裁图（原图 430 KB，看片 tab 每屏拉好几 MB）',
    from: "'?imageMogr2/thumbnail/200x200^/gravity/center/crop/200x200/quality/80'",
    to: "'?'",
    expectFail: ['猫眼封面：带 crop/200x200 参数', '契约：猫眼封面带 crop/200x200'],
  },
  {
    id: 'M6',
    name: '猫眼封面改成 thumbnail/!（不裁剪只限最长边 → 反而涨到 559 KB）',
    from: "'?imageMogr2/thumbnail/200x200^/gravity/center/crop/200x200/quality/80'",
    to: "'?imageMogr2/thumbnail/!200x200'",
    expectFail: ['猫眼封面：不含 thumbnail/!', '契约：猫眼封面不含 thumbnail/!'],
  },
  {
    id: 'M7',
    name: '电影排序不再「有封面的靠前」（用户明确要求尽量有图的靠前）',
    from: '      const ha = a.it.cover ? 0 : 1;\n      const hb = b.it.cover ? 0 : 1;',
    to: '      const ha = a.it.cover ? 1 : 0;\n      const hb = b.it.cover ? 1 : 0;',
    expectFail: ['契约：近期即将上映里，有封面的排在无封面的前面', '契约：电影顺序（封面优先 + 上映日升序）'],
  },
  {
    id: 'M8',
    name: '片名去重失效（猫眼和豆瓣的重叠片会出现两条）',
    from: '    if (seen.has(key)) continue;',
    to: '    if (false) continue;',
    expectFail: ['契约：猫眼和豆瓣同名片只留一条', '契约：电影顺序（封面优先 + 上映日升序）'],
  },
  {
    id: 'M9',
    name: 'source 写成和 tag 一样（发布方信息丢了）',
    from: "      source: '猫眼',",
    to: '      source: tag,',
    expectFail: ['契约：source ≠ tag'],
  },
  {
    id: 'M10',
    name: '源失败不记进 errors（静默失败）',
    from: '    errors.push(`${name}: ${msg}`);',
    to: '    void msg;',
    expectFail: ['抓取：单源失败 → 进 errors'],
  },
  {
    id: 'M11',
    name: 'video 数组写空（视频 tab 直接空掉）',
    from: '    video: video.map((it, i) => normalizeItem(it, i + 1)),',
    to: '    video: [],',
    expectFail: ['契约：video 数组非空', '抓取：video 有条目'],
  },
  {
    id: 'M12',
    name: '一个条目挂两个 @1 标签（前端 chip 会打架）',
    from: "      tags: ['@1:电影', `@2:${tag}`],",
    to: "      tags: ['@1:电影', '@1:视频', `@2:${tag}`],",
    expectFail: ['契约：每个条目恰好一个 @1 标签'],
  },
  {
    id: 'M13',
    name: '网易云分组的中文名写错（chip 文案对不上）',
    from: "export const GROUP_LABEL = { cn: '中文榜', intl: '国际榜', scene: '场景榜' };",
    to: "export const GROUP_LABEL = { cn: '中文榜单', intl: '国际榜', scene: '场景榜' };",
    expectFail: ['契约：@1 的值都在已知板块里', '网易云：tags = @1:中文榜 + @2:热歌榜'],
  },
  {
    id: 'M14',
    name: 'generatedAt 改成墙上时钟（同一天重跑结果不一致）',
    from: '    generatedAt: `${d}T00:00:00.000Z`,',
    to: '    generatedAt: new Date().toISOString(),',
    expectFail: ['契约：generatedAt 是当天零点'],
  },
  {
    id: 'M15',
    name: 'B站接口 code≠0 不当失败处理（风控返回会被当成空榜）',
    from: '      if (j && j.code !== undefined && j.code !== 0) {',
    to: '      if (false) {',
    expectFail: ['抓取：B站 code≠0 → 当失败处理'],
  },
  {
    id: 'M16',
    name: '停更老榜不跳过（把过时的榜单也端上桌）',
    from: '        if (updateTime && now - updateTime > STALE_CHART_MS) {',
    to: '        if (false) {',
    expectFail: ['抓取：停更老榜被跳过（不进 errors）'],
  },
  {
    id: 'M17',
    name: '网易云每榜不截断到 50 条（一个榜能塞 200 条）',
    from: 'parseNeteaseChart(j, chart).slice(0, NETEASE_LIMIT)',
    to: 'parseNeteaseChart(j, chart)',
    expectFail: ['抓取：网易云每榜最多 50 条'],
  },
  {
    id: 'M18',
    name: '电影排序里上映日方向反了',
    from: '      if (ka !== kb) return ka < kb ? -1 : 1;',
    to: '      if (ka !== kb) return ka < kb ? 1 : -1;',
    expectFail: ['契约：电影顺序（封面优先 + 上映日升序）'],
  },
];

/* ── 小工具 ─────────────────────────────────────────────────────────── */

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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

/** 副本自检：变异真落地（排除空变异） */
function selfCheck(mutated, original, to) {
  if (mutated === original) return { ok: false, note: '变异没落地（副本跟原文一样）' };
  if (to && !mutated.includes(to)) return { ok: false, note: '变异片段没出现在副本里' };
  return { ok: true, note: '副本完好，变异已落地' };
}

/** 把变异体写进独立目录（连 paths.mjs / env.mjs 一起，否则 import 不到） */
function setupMutant(id, source) {
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fetch-rank.mjs'), source, 'utf8');
  fs.copyFileSync(path.join(__dirname, 'paths.mjs'), path.join(dir, 'paths.mjs'));
  fs.copyFileSync(path.join(__dirname, 'env.mjs'), path.join(dir, 'env.mjs'));
  return path.join(dir, 'fetch-rank.mjs');
}

function runUnit(mutantPath) {
  const res = spawnSync(process.execPath, [UNIT], {
    encoding: 'utf8',
    env: { ...process.env, FETCH_RANK: mutantPath },
    /* 超时兜底：万一变异体把子进程卡死，别让整个变异测试挂在这儿 */
    timeout: 120000,
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

/* ── 主流程 ─────────────────────────────────────────────────────────── */

/**
 * 跑一遍全部变异。
 *
 * @param {{quiet?: boolean}} opts quiet=true 时不打印过程（主护栏内嵌那段用）
 * @returns {{caught:number, total:number, results:Array}}
 */
export function runMutationSuite({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  log('变异测试：故意改坏「榜单抓取 v2」，看主护栏抓不抓得住\n');

  const orig = fs.readFileSync(IMPL, 'utf8');
  const before = { impl: sha256(IMPL), unit: sha256(UNIT) };
  log('── 本体哈希（跑之前）');
  log(`   tools/fetch-rank.mjs     ${before.impl}`);
  log(`   tools/test-fetch-rank.mjs ${before.unit}`);

  const results = [];

  /* 基线：没变异的副本，测试必须全绿。不绿的话，后面的「红」没有意义。 */
  log('\n── 基线（未变异的副本）');
  {
    const base = runUnit(setupMutant('_baseline', orig));
    log(`   主护栏退出码 = ${base.code}，失败断言 = ${base.failed.length} 条`);
    if (base.code !== 0 || base.failed.length > 0) {
      log('\n✗ 基线不绿 —— 变异测试没有意义，先修主护栏。');
      log(base.stdout.split(/\r?\n/).filter((l) => /✗/.test(l)).join('\n'));
      results.push({
        id: 'baseline',
        name: '未变异的副本必须全绿',
        verdict: 'BROKEN_MUTANT',
        expectFail: [],
        missed: ['基线不绿'],
        failed: base.failed,
        note: '基线不绿',
      });
    } else {
      log('   ✓ 基线绿');
    }
  }

  /* 逐个变异 */
  for (const m of MUTATIONS) {
    log(`\n── 变异 ${m.id}：${m.name}`);

    const hits = orig.split(m.from).length - 1;
    if (hits !== 1) {
      log(`   ✗ 变异锚点没找到（或不唯一，命中 ${hits} 次）—— 变异脚本过期了，源码改了？`);
      results.push({
        id: m.id,
        name: m.name,
        verdict: 'BROKEN_MUTANT',
        expectFail: m.expectFail,
        missed: m.expectFail,
        failed: [],
        note: `锚点命中 ${hits} 次（要求恰好 1 次）`,
      });
      continue;
    }

    const mutated = orig.replace(m.from, m.to);
    const self = selfCheck(mutated, orig, m.to);
    if (!self.ok) {
      log(`   ✗ ${self.note}`);
      results.push({
        id: m.id, name: m.name, verdict: 'BROKEN_MUTANT',
        expectFail: m.expectFail, missed: m.expectFail, failed: [], note: self.note,
      });
      continue;
    }

    const dir = path.join(TMP, m.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '_syntax-probe.mjs'), mutated, 'utf8');
    const syntax = spawnSync(process.execPath, ['--check', path.join(dir, '_syntax-probe.mjs')], { encoding: 'utf8' });
    if (syntax.status !== 0) {
      log('   ✗ 副本语法坏了（假红，不算数）');
      results.push({
        id: m.id, name: m.name, verdict: 'BROKEN_MUTANT',
        expectFail: m.expectFail, missed: m.expectFail, failed: [], note: '副本语法坏了',
      });
      continue;
    }
    log('   副本语法 OK，变异已落地');

    const mutantPath = setupMutant(m.id, mutated);
    const res = runUnit(mutantPath);
    const hitExpected = m.expectFail.filter((want) => res.failed.some((f) => f.includes(want)));
    const missExpected = m.expectFail.filter((want) => !res.failed.some((f) => f.includes(want)));

    log(`   期望红的断言：${m.expectFail.join(' / ')}`);
    log(`   实际红的断言：${res.failed.length ? res.failed.join(' / ') : '（无）'}`);

    let verdict;
    let note = '';
    if (res.crashed) {
      verdict = 'BROKEN_MUTANT';
      note = '变异体把主护栏跑崩了（假红，不算数）';
    } else if (missExpected.length === 0) {
      verdict = 'CAUGHT';
      note = '预期断言全红';
    } else if (res.code === 0) {
      verdict = 'MISSED';
      note = `主护栏没抓到：${missExpected.join(' / ')}`;
    } else {
      verdict = 'FALSE_RED';
      note = `红的是别的断言，缺：${missExpected.join(' / ')}`;
    }

    const label = {
      CAUGHT: '✓ 被抓到了',
      MISSED: '✗ 没被抓到 —— 主护栏有缺口',
      FALSE_RED: '✗ 红了但红的是别的断言（假红）',
      BROKEN_MUTANT: '✗ 变异体坏了（假红）',
    }[verdict];
    log(`   判定：${label}`);

    results.push({
      id: m.id, name: m.name, verdict,
      expectFail: m.expectFail, missed: missExpected, failed: res.failed, note,
    });
  }

  /* 收尾：哈希比对（本体不能被改）+ 清掉临时目录 */
  const after = { impl: sha256(IMPL), unit: sha256(UNIT) };
  log('\n── 本体哈希（跑之后）');
  log(`   tools/fetch-rank.mjs     ${after.impl}`);
  log(`   tools/test-fetch-rank.mjs ${after.unit}`);
  const same = before.impl === after.impl && before.unit === after.unit;
  log(`   本体字节级未变：${same ? '是' : '否 —— 本体被改了！'}`);

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了 —— 不影响判定 */
  }
  log(`   临时副本目录已清：${TMP}`);

  const caught = results.filter((r) => r.verdict === 'CAUGHT').length;
  const total = MUTATIONS.length;
  log(`\n变异测试：${caught}/${total} 被抓到`);
  const missed = results.filter((r) => r.verdict !== 'CAUGHT');
  if (missed.length) {
    log('\n没抓到的变异（主护栏的缺口，不是本脚本的问题）：');
    for (const r of missed) {
      log(`   ${r.id} ${r.name} —— ${r.verdict}：${(r.missed || []).join(' / ') || '（锚点没命中）'}`);
    }
  }

  return { caught, total, results, same };
}

/* 直接跑这个文件时：跑全套并用退出码表态。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = runMutationSuite();
  process.exitCode = r.caught === r.total && r.same ? 0 : 1;
}
