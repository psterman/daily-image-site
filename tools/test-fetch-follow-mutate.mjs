#!/usr/bin/env node
/**
 * 变异测试：故意改坏「追更抓取 v2」的实现，看主护栏抓不抓得住。
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
 * 手法：把 tools/fetch-follow.mjs 的源码按变异规则改写，复制到
 * tools/.tmp-fetch-follow-cli/mutants/<变异号>/（连 paths.mjs / env.mjs 一起复制，
 * 否则副本 import 不到 ./paths.mjs 会「崩」而不是断言红），
 * 再用 FETCH_FOLLOW 指过去跑一遍主护栏，看是不是**指定的那几条断言**红了。
 *
 * ⚠️ 锚点必须是磁盘上当前源码里**逐字存在且唯一**的片段 ——
 *    脚本会先校验它唯一命中，找不到 / 不唯一就报错退出（源码变了，脚本过期了）。
 *
 * 跑法：node tools/test-fetch-follow-mutate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMPL = path.join(__dirname, 'fetch-follow.mjs');
const UNIT = path.join(__dirname, 'test-fetch-follow.mjs');
const TMP = path.join(__dirname, '.tmp-fetch-follow-cli', 'mutants');

/* ── 变异清单 ─────────────────────────────────────────────
 * from 必须是磁盘上当前源码里逐字存在的片段（唯一命中）。
 *
 * expectFail：预期应该变红的那几条断言名（子串匹配）。
 */
const MUTATIONS = [
  {
    id: 'M1',
    name: '去掉兜底通道「输出绝不含 URL」的硬性自检',
    from: 'if (URL_RE.test(v)) throw new Error(`兜底输出含 URL：${k}=${v}`);',
    to: 'if (false) throw new Error(`兜底输出含 URL：${k}=${v}`);',
    expectFail: ['兜底：自检会抛（配置名里带 URL）'],
  },
  {
    id: 'M2',
    name: '兜底解析不再剥离页面上的 URL（播放地址会漏出去）',
    from: `    .replace(/https?:\\/\\/[^\\s"'<>]+/gi, ' ')`,
    to: "    .replace(/__never_match__/gi, ' ')",
    expectFail: ['兜底：正常配置不抛', '兜底：条数对'],
  },
  {
    id: 'M3',
    name: '第一层板块名写错（频道更新 → 剧集更新）',
    from: "export const L1_SCHEDULE = '频道更新';",
    to: "export const L1_SCHEDULE = '剧集更新';",
    expectFail: ['契约：schedule 条目含 @1:频道更新 和 @2:<平台>', '语言：Night Show → English'],
  },
  {
    id: 'M4',
    name: '平台别名归并整体失效（Tencent QQ / iQIYI / Youku 全不归并）',
    from: 'if (b.match.some((m) => name === m || name.startsWith(m))) return b.label;',
    to: 'if (false) return b.label;',
    expectFail: ['别名：Tencent QQ → 腾讯视频', '别名：iQIYI → 爱奇艺', '别名：Youku → 优酷'],
  },
  {
    id: 'M5',
    name: '腾讯视频的别名表被改名（Tencent QQ → 腾讯）',
    from: "{ label: '腾讯视频', match: ['Tencent QQ', 'Tencent Video', 'Tencent'] },",
    to: "{ label: '腾讯', match: ['Tencent QQ', 'Tencent Video', 'Tencent'] },",
    expectFail: ['别名：Tencent QQ → 腾讯视频'],
  },
  {
    id: 'M6',
    name: '换回 /schedule?country=（按国家分组的旧接口 —— 给不出用户点名的平台）',
    from: 'const raw = await httpGet(`${TVMAZE_BASE}/schedule/full?date=${d}`, {',
    to: 'const raw = await httpGet(`${TVMAZE_BASE}/schedule?date=${d}`, {',
    expectFail: ['源：走的是 /schedule/full（不是 /schedule?country=）'],
  },
  {
    id: 'M7',
    name: '不再按 airdate 精确过滤（date= 是窗口起点，会混进别的日子）',
    from: "if (target && String(ep.airdate || '') !== target) continue;",
    to: 'if (false) continue;',
    expectFail: ['TVmaze：昨天/明天的条目被过滤掉'],
  },
  {
    id: 'M8',
    name: '条目结构读成 `show`（/schedule 的结构）而不是 `_embedded.show`',
    from: 'const show = (ep._embedded && ep._embedded.show) || ep.show;',
    to: 'const show = ep.show || (ep._embedded && ep._embedded.show);',
    expectFail: ['TVmaze：条目结构是 _embedded.show'],
  },
  {
    id: 'M9',
    name: '同一剧同一天多集不再留最早的那一集（留了最后一集）',
    from: 'if (prev) {',
    to: 'if (false) {',
    expectFail: ['TVmaze：留的是最早播出的一集'],
  },
  {
    id: 'M9b',
    name: '同一剧同一天多集不再去重（一天好几集全塞进来）',
    from: '    byShow.set(id, { ep, show, airstamp });\n  }',
    to: '    byShow.set(`${id}-${ep.id}`, { ep, show, airstamp });\n  }',
    expectFail: ['TVmaze：同一剧同一天多集 → 只留一条', 'TVmaze：目标日'],
  },
  {
    id: 'M10',
    name: '剧集更新不再按类型过滤（新闻/脱口秀/真人秀全混进来）',
    from: 'if (types && showType && !types.includes(showType)) continue;',
    to: 'if (false) continue;',
    expectFail: ['TVmaze：News 类型的条目被过滤掉'],
  },
  {
    id: 'M11',
    name: 'type 缺失的条目被丢掉（判不出来就丢数据）',
    from: 'if (types && showType && !types.includes(showType)) continue;',
    to: 'if (types && !types.includes(showType)) continue;',
    expectFail: ['TVmaze：type 缺失的条目照样保留'],
  },
  {
    id: 'M12',
    name: '行政区又被 slice 掉了（旧 bug 回归 → 区这个维度没了）',
    from: 'district = parts[0];',
    to: 'district = "";',
    expectFail: ['豆瓣：行政区**保留**在 tags 的 @3', '豆瓣：subtitle = 行政区 · 场馆 · 地址'],
  },
  {
    id: 'M13',
    name: '演出条目不写 @3 行政区标签',
    from: 'if (district) tags.push(`@3:${district}`);',
    to: 'if (false) tags.push(`@3:${district}`);',
    expectFail: ['豆瓣：有区有类型 → @3 + @4 都有', '豆瓣：行政区**保留**在 tags 的 @3'],
  },
  {
    id: 'M14',
    name: '演出条目瞎写 @4 类型（判不出来也硬填）',
    from: 'if (type) tags.push(`@4:${type}`);',
    to: "tags.push('@4:未知');",
    expectFail: ['豆瓣：判不出类型 → 不写 @4', '豆瓣：没有行政区 → 不写 @3'],
  },
  {
    id: 'M15',
    name: '豆瓣封面不再本地化（直接留远程 URL → 浏览器必然裂图 / 418）',
    from: `    it.cover = 'local:follow-covers/' + name;
    ok++;
    if (delay > 0) await sleep(delay);`,
    to: `    it.cover = u;
    ok++;
    if (delay > 0) await sleep(delay);`,
    expectFail: ['封面：cover 写成 local: 标记', 'CLI：写出来的封面是 local: 标记'],
  },
  {
    id: 'M16',
    name: '下载豆瓣封面时不带 Referer（不带就是 418）',
    from: `        const buf = await httpBinary(u, { Referer: DOUBAN_IMAGE_REFERER }, { fetchImpl: opts.fetchImpl });
        if (!buf || buf.length < 500) {
          fail++;`,
    to: `        const buf = await httpBinary(u, {}, { fetchImpl: opts.fetchImpl });
        if (!buf || buf.length < 500) {
          fail++;`,
    expectFail: ['封面：下载时带 Referer', 'CLI：豆瓣封面下载带了 Referer'],
  },
  {
    id: 'M17',
    name: '豆瓣同城请求不带 Referer',
    from: 'await httpGet(url, { headers: { Referer: doubanReferer(slug) }, fetchImpl: doFetch })',
    to: 'await httpGet(url, { fetchImpl: doFetch })',
    expectFail: ['Referer：豆瓣同城请求带 Referer', 'CLI：豆瓣请求带了 Referer'],
  },
  {
    id: 'M18',
    name: '城市 slug 写错（北京 beijing → beijin）',
    from: "  { name: '北京', slug: 'beijing' },",
    to: "  { name: '北京', slug: 'beijin' },",
    expectFail: ['城市表：北京 = beijing'],
  },
  {
    id: 'M19',
    name: '输出里去掉 rank 字段',
    from: 'function normalizeItem(it, i) {\n  const o = it || {};\n  return {\n    rank: i + 1,',
    to: 'function normalizeItem(it, i) {\n  const o = it || {};\n  return {',
    expectFail: ['契约：条目字段就这 9 个', '契约：schedule rank 从 1 连号'],
  },
  {
    id: 'M20',
    name: 'rank 不是从 1 开始（0 连号）',
    from: "    rank: i + 1,\n    title: String(o.title || '').trim(),",
    to: "    rank: i,\n    title: String(o.title || '').trim(),",
    expectFail: ['契约：schedule rank 从 1 连号', '契约：events rank 从 1 连号'],
  },
  {
    id: 'M21',
    name: '顶层少一个字段（channels 写空 → 平台 chip 全没了）',
    from: 'channels: Array.isArray(channels) && channels.length ? channels.map((c) => String(c)) : deriveChannels(sched),',
    to: 'channels: [],',
    expectFail: ['契约：channels 里有 B站番剧', '产出：channels 第一个是 Netflix'],
  },
  {
    id: 'M22',
    name: '语言 chip 不按条目数从多到少排（改成首次出现顺序）',
    from: 'const d = (count.get(b) || 0) - (count.get(a) || 0);',
    to: 'const d = 0;',
    expectFail: ['契约：languages 按条目数从多到少'],
  },
  {
    id: 'M23',
    name: '兜底通道不再默认关闭（配置文件不存在也开）',
    from: '      enabled: false,\n      fallbacks: [],\n      path: p,\n      missing: true,',
    to: '      enabled: true,\n      fallbacks: [{ name: \'兜底\', url: \'https://example.invalid/list\' }],\n      path: p,\n      missing: true,',
    expectFail: ['兜底配置：文件不存在 → 通道关闭', '兜底配置：文件不存在 → fallbacks 为空'],
  },
  {
    id: 'M24',
    name: 'link 不再把 http:// 升级成 https://（mixed content 回来了）',
    from: "export function toHttps(url) {\n  const s = String(url || '');\n  return s.startsWith('http://') ? 'https://' + s.slice('http://'.length) : s;\n}",
    to: "export function toHttps(url) {\n  return String(url || '');\n}",
    expectFail: ['TVmaze：officialSite 是 http:// 时升级成 https://'],
  },
  {
    id: 'M25',
    name: '平台顺序不再「用户点名的优先」（改成字母序）',
    from: 'for (const ch of CHANNEL_PRIORITY) {',
    to: 'for (const ch of [...CHANNEL_PRIORITY].sort()) {',
    expectFail: ['分组：channels 顺序 = 点名平台 → B站番剧 → 港剧 → 长尾 → 其他平台'],
  },
  {
    id: 'M26',
    name: '港剧被踢出混排（不再跟别的平台排在一起）',
    from: "export const CHANNEL_SOURCES = ['B站番剧', '港剧'];",
    to: "export const CHANNEL_SOURCES = ['B站番剧'];",
    expectFail: ['分组：channels 顺序 = 点名平台 → B站番剧 → 港剧 → 长尾 → 其他平台', '分组：港剧不是独立板块（它就是平台 chip 里的一个）'],
  },
  {
    id: 'M27',
    name: '演出类型判定失效（@4 永远不写）',
    from: 'if (rule.re.test(t)) return rule.type;',
    to: 'if (false) return rule.type;',
    expectFail: ['类型：音乐会 → 音乐', '豆瓣：有区有类型 → @3 + @4 都有'],
  },
  {
    id: 'M28',
    name: 'events 的 tag 写错（城市中文名 → 同城）',
    from: 'tag: city,',
    to: "tag: '同城',",
    expectFail: ['豆瓣：tag = 城市中文名', '契约：events 条目含 @1:本地演出 和 @2:<城市>'],
  },
  {
    id: 'M29',
    name: '兜底 link 换成原站的播放页（不再是豆瓣搜索 → 站点成盗版外链跳板）',
    from: 'link: doubanSearchLink(title),',
    to: "link: String((cfg && cfg.url) || 'https://play.example/' + encodeURIComponent(title)),",
    expectFail: ['兜底：link = 豆瓣站内搜索', '兜底：正常配置不抛'],
  },
  {
    id: 'M30',
    name: '「其他平台」合并组不再封顶（长尾全塞进来）',
    from: 'for (const it of merged.slice(0, OTHER_MAX_TOTAL)) out.push(retagChannel(it, OTHER_CHANNEL));',
    to: 'for (const it of merged) out.push(retagChannel(it, OTHER_CHANNEL));',
    expectFail: ['分组：长尾合并后总数封顶 40'],
  },
  {
    id: 'M31',
    name: 'B站番剧多写一层语言（B站没有语言维度）',
    from: "tags: normalizeTags([`@1:${L1_SCHEDULE}`, '@2:B站番剧']),",
    to: "tags: normalizeTags([`@1:${L1_SCHEDULE}`, '@2:B站番剧', '@3:Japanese']),",
    expectFail: ['B站：tags 只有 @1/@2（没有语言层）'],
  },
  {
    id: 'M32',
    name: '自己不再跟随 301（豆瓣的软跳转 → 拿到的是跳转提示页）',
    from: 'if (REDIRECT_CODES.has(res.status) && loc) {',
    to: 'if (false) {',
    expectFail: ['网络：301 会自己跟到底', '网络：跳转后 Referer 还在'],
  },
  {
    id: 'M33',
    name: '失败重试次数改成 1（不重试）',
    from: '    attempts = HTTP_ATTEMPTS,\n    backoffMs = RETRY_BACKOFF_MS,',
    to: '    attempts = 1,\n    backoffMs = RETRY_BACKOFF_MS,',
    expectFail: ['网络：失败会重试并最终拿到内容', '网络：至少请求了 2 次'],
  },
  {
    id: 'M34',
    name: '请求去掉桌面 Chrome UA',
    from: "        headers: { 'User-Agent': UA, Accept: '*/*', ...headers },",
    to: "        headers: { Accept: '*/*', ...headers },",
    expectFail: ['网络：请求带桌面 Chrome UA', '网络：UA 与常量一致'],
  },
  {
    id: 'M35',
    name: '_key 排序键变成可枚举（契约里就多出一个字段）',
    from: 'enumerable: false,',
    to: 'enumerable: true,',
    expectFail: ['TVmaze：条目字段就这 9 个', 'TVmaze：_key 不可枚举'],
  },
  {
    id: 'M36',
    name: '封面下载失败时保留远程 URL（会裂图的地址漏出去）',
    from: '      } catch {\n        fail++;\n        it.cover = \'\';\n        continue;\n      }',
    to: '      } catch {\n        fail++;\n        continue;\n      }',
    expectFail: ['封面：输出里不许残留 doubanio.com 的远程 URL', '封面：下载失败的留空字符串'],
  },
  {
    id: 'M36b',
    name: '封面字节数不足时保留远程 URL（会裂图的地址漏出去）',
    from: 'if (!buf || buf.length < 500) {\n          fail++;\n          it.cover = \'\';\n          continue;\n        }',
    to: 'if (!buf || buf.length < 500) {\n          fail++;\n          continue;\n        }',
    expectFail: ['封面：输出里不许残留 doubanio.com 的远程 URL', '封面：字节数不足的也留空字符串'],
  },
  {
    id: 'M37',
    name: '长尾平台不再按条目数从多到少排',
    from: '    .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));',
    to: '    .sort((a, b) => (a[0] < b[0] ? -1 : 1));',
    expectFail: ['分组：channels 顺序 = 点名平台 → B站番剧 → 港剧 → 长尾 → 其他平台', '分组：长尾按条目数从多到少'],
  },
  {
    id: 'M38',
    name: '演出的 source 写错（豆瓣同城 → 豆瓣）',
    from: 'source: EVENTS_SOURCE,',
    to: "source: '豆瓣',",
    expectFail: ['豆瓣：source = 豆瓣同城'],
  },
];

/* ── 小工具 ───────────────────────────────────────────── */

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
  if (!mutated.includes(to)) return { ok: false, note: '变异片段没出现在副本里' };
  return { ok: true, note: '副本完好，变异已落地' };
}

/** 把变异体写进独立目录（连 paths.mjs / env.mjs 一起，否则 import 不到） */
function setupMutant(id, source) {
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fetch-follow.mjs'), source, 'utf8');
  fs.copyFileSync(path.join(__dirname, 'paths.mjs'), path.join(dir, 'paths.mjs'));
  fs.copyFileSync(path.join(__dirname, 'env.mjs'), path.join(dir, 'env.mjs'));
  return path.join(dir, 'fetch-follow.mjs');
}

function runUnit(mutantPath) {
  const res = spawnSync(process.execPath, [UNIT], {
    encoding: 'utf8',
    env: { ...process.env, FETCH_FOLLOW: mutantPath },
    timeout: 180000,
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
  console.log('变异测试：故意改坏「追更抓取 v2」，看主护栏抓不抓得住\n');

  const before = { impl: sha256(IMPL), unit: sha256(UNIT) };
  console.log('── 本体哈希（跑之前）');
  console.log(`   tools/fetch-follow.mjs       ${before.impl}`);
  console.log(`   tools/test-fetch-follow.mjs   ${before.unit}`);

  const orig = fs.readFileSync(IMPL, 'utf8');

  /* 锚点自检：每个 from 必须**唯一命中**当前源码 —— 找不到就是脚本过期了 */
  console.log('\n── 锚点自检（from 必须在源码里唯一命中）');
  const brokenAnchors = [];
  for (const m of MUTATIONS) {
    const hits = orig.split(m.from).length - 1;
    if (hits !== 1) {
      brokenAnchors.push(`${m.id} ${m.name}（命中 ${hits} 次）`);
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
    const base = runUnit(setupMutant('_baseline', orig));
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

    const mutated = orig.replace(m.from, m.to);
    const dir = path.join(TMP, m.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '_syntax-probe.mjs'), mutated, 'utf8');
    const self = selfCheck(mutated, orig, m.to);
    if (!self.ok) {
      console.log(`   ✗ ${self.note}`);
      results.push({ id: m.id, name: m.name, verdict: 'BROKEN_MUTANT', failed: [], missed: m.expectFail });
      continue;
    }
    // 语法自检（node --check）：语法坏了就是假红，不算数
    const syntax = spawnSync(process.execPath, ['--check', path.join(dir, '_syntax-probe.mjs')], { encoding: 'utf8' });
    if (syntax.status !== 0) {
      console.log('   ✗ 副本语法坏了（假红，不算数）');
      results.push({ id: m.id, name: m.name, verdict: 'BROKEN_MUTANT', failed: [], missed: m.expectFail });
      continue;
    }
    console.log('   副本语法 OK，变异已落地');

    const mutantPath = setupMutant(m.id, mutated);
    const res = runUnit(mutantPath);
    const hitExpected = m.expectFail.filter((want) => res.failed.some((f) => f.includes(want)));
    const missExpected = m.expectFail.filter((want) => !res.failed.some((f) => f.includes(want)));

    console.log(`   期望红的断言：${m.expectFail.join(' / ')}`);
    console.log(`   实际红的断言：${res.failed.length ? res.failed.join(' / ') : '（无）'}`);
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
    else if (missExpected.length === 0) verdict = 'CAUGHT';
    else if (res.code === 0) verdict = 'MISSED';
    else verdict = 'FALSE_RED';

    const label = {
      CAUGHT: '✓ 被抓到了',
      MISSED: '✗ 没被抓到 —— 主护栏有缺口',
      FALSE_RED: '✗ 红了但红的是别的断言（假红）',
      BROKEN_MUTANT: '✗ 变异体坏了（假红）',
    }[verdict];
    console.log(`   判定：${label}`);

    results.push({
      id: m.id,
      name: m.name,
      verdict,
      expectFail: m.expectFail,
      missed: missExpected,
      failed: res.failed,
    });
  }

  /* 收尾：哈希比对（本体不能被改）+ 清掉临时目录 */
  const after = { impl: sha256(IMPL), unit: sha256(UNIT) };
  console.log('\n── 本体哈希（跑之后）');
  console.log(`   tools/fetch-follow.mjs       ${after.impl}`);
  console.log(`   tools/test-fetch-follow.mjs   ${after.unit}`);
  const same = before.impl === after.impl && before.unit === after.unit;
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
      console.log(`   ${r.id} ${r.name} —— ${r.verdict}：${(r.missed || []).join(' / ') || '（锚点没命中）'}`);
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
