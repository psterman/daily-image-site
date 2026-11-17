#!/usr/bin/env node
/**
 * 护栏：OG 分享卡片（og.jpg）不能被改坏。
 *
 * ── 这套护栏在保护什么 ─────────────────────────────────────────
 * 站点是「每日图片站」图片站，消费路径是微信 / QQ 群里分享链接。
 * **分享卡片是群友点开之前唯一的预览** —— og:image 挂了，
 * 分享出去就是一张白卡，而构建日志全程报「成功」。
 *
 * 所以下面这些约定必须被钉死（每一条都对应一次真实踩坑）：
 *   · 每期一张 published/<日期>/og.jpg，1200x630，三栏拼图
 *   · 图里不写文字（字体路径跨平台不可靠，文字放 og:title / og:description）
 *   · og:image 必须是绝对 URL（相对路径微信 / X / 知乎的爬虫拉不到）
 *   · URL 带日期（微信按分享 URL 缓存卡片，根 URL 固定 → 卡片停在缓存那天）
 *   · 根页 og:title / og:description 刻意不带日期（带日期 → 卡片永远停在第一天）
 *   · 合成失败退回 logo、不阻断构建
 *   · og.jpg 必须写在 build.mjs 的 fs.rm(published/<日期>) 之后，否则会被删掉
 *
 * ── 为什么所有匹配都先剥注释 ───────────────────────────────────
 * 这个工程的源码里「说明书」写得比代码还详细：build.mjs 的注释里就写着
 * "og:image"、"绝对 URL"，template.html 的注释里写着每一条 og:meta 的规则。
 * 护栏如果直接全文匹配，它会把自己的说明书当成合规证据 ——
 * 代码改坏了也照样全绿，那就是**假护栏**。
 * 所以一律先 stripJsComments / stripHtmlComments 再匹配。
 * （剥注释只用于匹配；统计字节数这类断言用原文件。）
 *
 * ── 为什么有的断言是「真的调用一次」而不是「看源码」 ──────────
 * ogImageUrl 是纯函数、不碰文件系统 —— 直接 import 进来调用，
 * 断言比静态匹配强得多：静态匹配挡不住「把站点根写死」这种改法。
 *
 * ── 护栏自己不能崩 ─────────────────────────────────────────────
 * 红必须是「断言不成立」，不是「护栏抛异常」——
 * 崩出来的红会把真缺口盖住（变异脚本那边会专门检查这一点）。
 * 所以取值用 ?. / ??，可能抛的调用包 try/catch，
 * 断言求值出错也记成一条失败，而不是让整个脚本挂掉。
 *
 * 用法：node tools/test-build-og.mjs
 * 退出码：0 = 全过；1 = 有失败
 *
 * 所有被检查的文件都支持环境变量覆盖（变异脚本靠这个把坏版本喂进来）：
 *   BUILD_OG_MJS / BUILD_MJS / TEMPLATE_HTML / VERIFY_BUILD_MJS
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripJsComments, stripHtmlComments } from './strip-comments.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ── 被检查的文件 ────────────────────────────────────────────── */

/** 环境变量覆盖目标路径；没给就用工程里的真文件。 */
function targetPath(envName, fallback) {
  const v = process.env[envName];
  if (!v) return path.join(ROOT, fallback);
  return path.isAbsolute(v) ? v : path.resolve(ROOT, v);
}

const BOG_FILE = targetPath('BUILD_OG_MJS', 'tools/build-og.mjs');
const BUILD_FILE = targetPath('BUILD_MJS', 'tools/build.mjs');
const TPL_FILE = targetPath('TEMPLATE_HTML', 'site/template.html');
const VERIFY_FILE = targetPath('VERIFY_BUILD_MJS', 'tools/verify-build.mjs');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readBytes(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

const bogRaw = readText(BOG_FILE);
const buildRaw = readText(BUILD_FILE);
const tplRaw = readText(TPL_FILE);
const verifyRaw = readText(VERIFY_FILE);

/** 只用于匹配；字节数/行数一类的断言用原文件。 */
const bogCode = bogRaw == null ? '' : stripJsComments(bogRaw);
const buildCode = buildRaw == null ? '' : stripJsComments(buildRaw);
const tplCode = tplRaw == null ? '' : stripHtmlComments(tplRaw);
const verifyCode = verifyRaw == null ? '' : stripJsComments(verifyRaw);

/* ── 断言小工具 ──────────────────────────────────────────────── */

let pass = 0;
let fail = 0;

function check(label, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    if (typeof r === 'boolean') ok = r;
    else if (r && typeof r === 'object') {
      ok = !!r.ok;
      detail = r.detail == null ? '' : String(r.detail);
    }
  } catch (e) {
    // 护栏自己不能崩 —— 求值出错也记成一条失败（红 = 断言不成立）。
    ok = false;
    detail = `断言求值抛错：${e && e.message ? e.message : String(e)}`;
  }
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? '  —— ' + detail : ''}`);
  }
}

/** 文件读不到时统一给一句人话，省得看的人以为是断言写错了。 */
function unreadable(file, raw) {
  return raw == null ? `读不到文件：${file}` : '';
}

/** 取两个标记之间的源码；标记找不到返回空串（让调用方的断言去判红）。 */
function between(src, startMark, endMark, from = 0) {
  const s = src.indexOf(startMark, from);
  if (s === -1) return '';
  if (!endMark) return src.slice(s);
  const e = src.indexOf(endMark, s + startMark.length);
  if (e === -1) return '';
  return src.slice(s, e);
}

/** 从 openIdx 处的 '{' 开始做花括号配对，取出整块。 */
function braceBlock(src, openIdx) {
  if (openIdx < 0) return '';
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return '';
}

/** 编码体检：BOM / CR / UTF-8 往返。返回空串 = 没问题。 */
function encodingProblem(bytes) {
  if (!bytes) return '读不到文件';
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return '有 UTF-8 BOM';
  }
  const cr = bytes.filter((b) => b === 0x0d).length;
  if (cr) return `有 ${cr} 个 CR（CRLF 或孤立 CR）`;
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    return '不是合法的 UTF-8（解码再编码对不上）';
  }
  return '';
}

/* ── 把 build-og.mjs 真的 import 进来（ogImageUrl 是纯函数，安全） ── */

let ogMod = null;
let ogImportError = '';
try {
  ogMod = await import(pathToFileURL(BOG_FILE).href);
} catch (e) {
  ogImportError = e && e.message ? e.message : String(e);
}

/**
 * 探针：让 composeOgImage 真的撞一次「ffmpeg 根本不存在」。
 *
 * 为什么敢在护栏里 spawn 一次：ffmpeg 那个路径是假的，进程压根起不来，
 * 产物文件**永远不会被创建**（outFile 指向的目录本来就存在，mkdir 是空操作）。
 * 整个探针离线、不写任何产物。
 *
 * 为什么必须探到这一层：只看源码里的 throw 挡不住「throw 改成 return」——
 * 那样 composeOgImage 会假装成功，build.mjs 就以为 og.jpg 出来了，
 * 卡片指向一个不存在的文件 → 白卡。
 */
async function probeFfmpegFailure() {
  if (!ogMod || typeof ogMod.composeOgImage !== 'function') {
    return { threw: false, msg: 'composeOgImage 不可用' };
  }
  const warn = console.warn;
  console.warn = () => {}; // 探针会打「第 1 张图不可用」的告警，挡住护栏自己的输出
  try {
    await ogMod.composeOgImage({
      ffmpeg: path.join(ROOT, 'tools', '__guard_no_such_ffmpeg__'),
      inputs: [path.join(ROOT, 'tools', '__guard_no_such_input__.jpg')],
      outFile: path.join(ROOT, 'tools', '__guard_og_probe__.jpg'),
    });
    return { threw: false, msg: '' };
  } catch (e) {
    return { threw: true, msg: e && e.message ? e.message : String(e) };
  } finally {
    console.warn = warn;
  }
}

const probe = await probeFfmpegFailure();

/* ── build-og.mjs 的源码片段 ─────────────────────────────────── */

const composeBody = between(bogCode, 'export async function composeOgImage', 'export function ogImageUrl');

/* ── build.mjs 的源码片段 ────────────────────────────────────── */

const composeIdx = buildCode.indexOf('await composeOgImage(');
const rmIdx = buildCode.indexOf('await fs.rm(publishedDir');
const mkdirIdx = buildCode.indexOf('await fs.mkdir(publishedDir');
const rootBlock = between(buildCode, 'const rootHtml = renderPage(template, {', '\n  });');
const dayBlock = between(buildCode, 'const dayHtml = renderPage(template, {', '\n  });', Math.max(composeIdx, 0));
const catchIdx = buildCode.indexOf('} catch (e) {', Math.max(composeIdx, 0));
const catchBody = catchIdx === -1 ? '' : braceBlock(buildCode, buildCode.indexOf('{', catchIdx + 1));

/** build.mjs 里的默认站点根（og:image 要绝对 URL，得知道拼出来长什么样）。 */
const defaultSiteUrl = (buildCode.match(/DEFAULT_SITE_URL\s*=\s*'([^']+)'/) || [])[1] || 'https://example.com';

/* ══════════════════════════════════════════════════════════════
   1) tools/build-og.mjs —— 分享图合成模块本身
   ══════════════════════════════════════════════════════════════ */
console.log('\n1) tools/build-og.mjs');

check('build-og.mjs 能被 import 进来（模块本身没坏）', () => ({
  ok: !!ogMod,
  detail: ogImportError ? `import 失败：${ogImportError}` : '',
}));

check('build-og.mjs 导出 composeOgImage 和 ogImageUrl', () => ({
  ok: !!ogMod && typeof ogMod.composeOgImage === 'function' && typeof ogMod.ogImageUrl === 'function',
  detail: ogImportError ? `import 失败：${ogImportError}` : 'composeOgImage / ogImageUrl 不都是函数',
}));

check('build-og.mjs 的默认宽高是 1200 / 630（分享卡片的尺寸是硬指标）', () => {
  const bad = unreadable(BOG_FILE, bogRaw);
  if (bad) return { ok: false, detail: bad };
  const w = /width\s*=\s*1200/.test(composeBody);
  const h = /height\s*=\s*630/.test(composeBody);
  return {
    ok: w && h,
    detail: w && h ? '' : `composeOgImage 里没找到 width = 1200 / height = 630（宽:${w} 高:${h}）`,
  };
});

check('ogImageUrl 拼出绝对 URL https://example.com/2026-11-17/og.jpg（无双斜杠）', () => {
  if (!ogMod || typeof ogMod.ogImageUrl !== 'function') {
    return { ok: false, detail: 'ogImageUrl 不可用' };
  }
  const got = ogMod.ogImageUrl({ siteUrl: 'https://example.com/', date: '2026-11-17' });
  const want = 'https://example.com/2026-11-17/og.jpg';
  return { ok: got === want, detail: got === want ? '' : `得到 ${got}，期望 ${want}` };
});

check('ogImageUrl 跟着传入的 siteUrl 走（站点根不是写死的）', () => {
  if (!ogMod || typeof ogMod.ogImageUrl !== 'function') {
    return { ok: false, detail: 'ogImageUrl 不可用' };
  }
  const got = ogMod.ogImageUrl({ siteUrl: 'https://another.example/', date: '2026-11-17' });
  return {
    ok: got.startsWith('https://another.example/'),
    detail: got.startsWith('https://another.example/') ? '' : `传了另一个域名，输出还是 ${got}`,
  };
});

check('composeOgImage 合成失败时抛 Error（build.mjs 靠 catch 兜底退回 logo）', () => ({
  ok: probe.threw,
  detail: probe.threw ? '' : `ffmpeg 根本不存在，composeOgImage 却正常返回了 —— build.mjs 会以为 og.jpg 出来了（卡片指向不存在的文件 → 白卡）`,
}));

check('composeOgImage 的报错带着失败原因（不是一句干巴巴的 Error）', () => {
  const bad = unreadable(BOG_FILE, bogRaw);
  if (bad) return { ok: false, detail: bad };
  const ok = /throw new Error\(\s*`[^`]*\$\{/.test(composeBody);
  return { ok, detail: ok ? '' : 'composeOgImage 里的 throw 没有把原因（退出码 / stderr）带进报错信息' };
});

check('composeOgImage 合成后校验产物字节数 > 0（退出码 0 不代表写出了东西）', () => {
  const bad = unreadable(BOG_FILE, bogRaw);
  if (bad) return { ok: false, detail: bad };
  const hasSize = /st\.size/.test(composeBody);
  const hasZeroCheck = /(size\s*<=\s*0)|(size\s*===\s*0)|(size\s*<\s*1)/.test(composeBody);
  return {
    ok: hasSize && hasZeroCheck,
    detail: hasSize && hasZeroCheck ? '' : '没看到 stat 之后的字节数校验（0 字节产物会照样上线）',
  };
});

check('build-og.mjs 的 ffmpeg filter 里没有 drawtext（图里不写文字）', () => {
  const bad = unreadable(BOG_FILE, bogRaw);
  if (bad) return { ok: false, detail: bad };
  return {
    ok: !/drawtext/i.test(bogCode),
    detail: /drawtext/i.test(bogCode) ? 'filter 里出现 drawtext —— 字体路径跨平台不可靠，文字必须放在 og:title / og:description' : '',
  };
});

/* ══════════════════════════════════════════════════════════════
   2) tools/build.mjs —— 集成（位置、顺序、降级）
   ══════════════════════════════════════════════════════════════ */
console.log('\n2) tools/build.mjs');

check("build.mjs 从 './build-og.mjs' import 了 composeOgImage / ogImageUrl", () => {
  const bad = unreadable(BUILD_FILE, buildRaw);
  if (bad) return { ok: false, detail: bad };
  const ok = /import\s*\{[^}]*composeOgImage[^}]*ogImageUrl[^}]*\}\s*from\s*['"]\.\/build-og\.mjs['"]/.test(buildCode);
  return { ok, detail: ok ? '' : 'build.mjs 没有从 ./build-og.mjs import 这两个函数' };
});

check("og.jpg 落在当期目录（path.join(publishedDir, 'og.jpg')）", () => {
  const bad = unreadable(BUILD_FILE, buildRaw);
  if (bad) return { ok: false, detail: bad };
  const ok = buildCode.includes("path.join(publishedDir, 'og.jpg')");
  return { ok, detail: ok ? '' : 'og.jpg 的落点不是当期目录（写在根目录的话，当期页面拿不到图）' };
});

check('og 合成写在 fs.rm / mkdir 之后（产物不会被删掉）', () => {
  const bad = unreadable(BUILD_FILE, buildRaw);
  if (bad) return { ok: false, detail: bad };
  if (rmIdx === -1 || mkdirIdx === -1 || composeIdx === -1) {
    return { ok: false, detail: 'build.mjs 里找不到 fs.rm(publishedDir) / fs.mkdir(publishedDir) / composeOgImage 调用' };
  }
  const ok = rmIdx < mkdirIdx && mkdirIdx < composeIdx;
  return {
    ok,
    detail: ok ? '' : `位置不对：rm=${rmIdx} < mkdir=${mkdirIdx} < compose=${composeIdx} 这个顺序必须成立（写在 rm 之前会被删掉）`,
  };
});

check('build.mjs 替换了全部三个 og 占位符（没有漏替换的 {{OG_IMAGE}}）', () => {
  const bad = unreadable(BUILD_FILE, buildRaw);
  if (bad) return { ok: false, detail: bad };
  const need = [
    [".replaceAll('{{OG_IMAGE}}', v.ogImage)", '{{OG_IMAGE}}'],
    [".replaceAll('{{OG_IMAGE_W}}', v.ogImageW)", '{{OG_IMAGE_W}}'],
    [".replaceAll('{{OG_IMAGE_H}}', v.ogImageH)", '{{OG_IMAGE_H}}'],
  ];
  const missing = need.filter(([code]) => !buildCode.includes(code)).map(([, ph]) => ph);
  const left = (buildCode.match(/\{\{OG_IMAGE/g) || []).length;
  const ok = missing.length === 0 && left === need.length;
  return {
    ok,
    detail: ok ? '' : `没替换：${missing.join(' ') || '（无）'}；源码里还剩 ${left} 处 {{OG_IMAGE...}}`,
  };
});

check('og 合成失败只退回 logo，不阻断构建（catch 里没有 throw / process.exit）', () => {
  const bad = unreadable(BUILD_FILE, buildRaw);
  if (bad) return { ok: false, detail: bad };
  if (!catchBody) return { ok: false, detail: '找不到包住 composeOgImage 的 catch 分支' };
  const noThrow = !/\bthrow\b/.test(catchBody);
  const noExit = !/process\.exit/.test(catchBody);
  const mentionsLogo = /logo/i.test(catchBody);
  return {
    ok: noThrow && noExit && mentionsLogo,
    detail: noThrow && noExit && mentionsLogo ? '' : `catch 里 throw:${!noThrow} exit:${!noExit} 退回 logo:${mentionsLogo}`,
  };
});

check('根页和日期页都指向当期那张图', () => {
  const bad = unreadable(BUILD_FILE, buildRaw);
  if (bad) return { ok: false, detail: bad };
  const assign = /ogImage\s*=\s*ogImageUrl\(\{\s*siteUrl\s*,\s*date\s*\}\)/.test(buildCode);
  const rootUses = /(^|\n)\s*ogImage\s*,/.test(rootBlock);
  const dayUses = /(^|\n)\s*ogImage\s*,/.test(dayBlock);
  return {
    ok: assign && rootUses && dayUses,
    detail: assign && rootUses && dayUses ? '' : `ogImage 取自当期:${assign} 根页用它:${rootUses} 日期页用它:${dayUses}`,
  };
});

check('根页的 og:title / og:description 不带日期（微信按 URL 缓存卡片）', () => {
  const bad = unreadable(BUILD_FILE, buildRaw);
  if (bad) return { ok: false, detail: bad };
  if (!rootBlock) return { ok: false, detail: '找不到根页的 renderPage 调用' };
  const titleLine = (rootBlock.match(/pageTitle:[^\n]*/) || [''])[0];
  const descLine = (rootBlock.match(/pageDesc:[^\n]*/) || [''])[0];
  const dated = (s) => /\$\{\s*date/i.test(s) || /\bdate[A-Za-z]*\b/.test(s) || /\d{4}-\d{2}-\d{2}/.test(s);
  const ok = !!titleLine && !!descLine && !dated(titleLine) && !dated(descLine);
  return {
    ok,
    detail: ok ? '' : `根页 title/desc 里带了日期：${dated(titleLine) ? titleLine : ''} ${dated(descLine) ? descLine : ''}`.trim(),
  };
});

check('og:image 拼出来是绝对 URL（https:// 开头，不是 /<日期>/og.jpg）', () => {
  if (!ogMod || typeof ogMod.ogImageUrl !== 'function') {
    return { ok: false, detail: 'ogImageUrl 不可用' };
  }
  const got = ogMod.ogImageUrl({ siteUrl: defaultSiteUrl, date: '2026-11-17' });
  const ok = got.startsWith('https://') && !got.startsWith('/');
  return { ok, detail: ok ? '' : `得到 ${got}（相对路径的话微信 / X / 知乎的爬虫拉不到 → 白卡）` };
});

/* ══════════════════════════════════════════════════════════════
   3) site/template.html —— 卡片 meta
   ══════════════════════════════════════════════════════════════ */
console.log('\n3) site/template.html');

check('模板里有 {{OG_IMAGE}} / {{OG_IMAGE_W}} / {{OG_IMAGE_H}} 三个占位符', () => {
  const bad = unreadable(TPL_FILE, tplRaw);
  if (bad) return { ok: false, detail: bad };
  const missing = ['{{OG_IMAGE}}', '{{OG_IMAGE_W}}', '{{OG_IMAGE_H}}'].filter((ph) => !tplCode.includes(ph));
  return { ok: missing.length === 0, detail: missing.length ? `模板里没有 ${missing.join(' ')}` : '' };
});

check('og:image 的 content 用的是 {{OG_IMAGE}} 占位符', () => {
  const bad = unreadable(TPL_FILE, tplRaw);
  if (bad) return { ok: false, detail: bad };
  const ok = tplCode.includes('<meta property="og:image" content="{{OG_IMAGE}}">');
  return { ok, detail: ok ? '' : '模板里 og:image 的 content 不是 {{OG_IMAGE}} 占位符（写死 URL 的话卡片永远不变）' };
});

check('og:image 不是相对路径（爬虫拉不到 → 白卡）', () => {
  const bad = unreadable(TPL_FILE, tplRaw);
  if (bad) return { ok: false, detail: bad };
  const m = tplCode.match(/<meta property="og:image" content="([^"]*)"/);
  if (!m) return { ok: false, detail: '模板里找不到 og:image 的 meta' };
  const value = m[1];
  const ok = value.startsWith('/') === false;
  return { ok, detail: ok ? '' : `og:image 的 content 是 ${value}（相对路径爬虫拼不出来）` };
});

check('模板里有 og:image:width 和 og:image:height（微信 / 知乎排版更稳）', () => {
  const bad = unreadable(TPL_FILE, tplRaw);
  if (bad) return { ok: false, detail: bad };
  const ok = tplCode.includes('og:image:width') && tplCode.includes('og:image:height');
  return { ok, detail: ok ? '' : '缺 og:image:width 或 og:image:height' };
});

check('模板里有 og:type', () => {
  const bad = unreadable(TPL_FILE, tplRaw);
  if (bad) return { ok: false, detail: bad };
  const ok = /<meta property="og:type" content="[^"]*"/.test(tplCode);
  return { ok, detail: ok ? '' : '缺 og:type' };
});

check('模板里有 twitter:card=summary_large_image 和 twitter:image（X 认 twitter:*，不认 og:image）', () => {
  const bad = unreadable(TPL_FILE, tplRaw);
  if (bad) return { ok: false, detail: bad };
  const card = /<meta name="twitter:card" content="summary_large_image">/.test(tplCode);
  const img = /<meta name="twitter:image" content="[^"]*">/.test(tplCode);
  return { ok: card && img, detail: card && img ? '' : `twitter:card:${card} twitter:image:${img}` };
});

check('模板里有 RSS 的 <link rel="alternate" ... href="/feed.xml">', () => {
  const bad = unreadable(TPL_FILE, tplRaw);
  if (bad) return { ok: false, detail: bad };
  const ok = /<link[^>]*rel="alternate"[^>]*type="application\/rss\+xml"[^>]*href="\/feed\.xml"[^>]*>/.test(tplCode);
  return { ok, detail: ok ? '' : '模板里没有指向 /feed.xml 的 RSS <link rel="alternate">' };
});

/* ══════════════════════════════════════════════════════════════
   4) tools/verify-build.mjs —— 发布前的自检
   ══════════════════════════════════════════════════════════════ */
console.log('\n4) tools/verify-build.mjs');

check('verify-build.mjs 自检 og:image 指向的文件存在且非 0 字节', () => {
  const bad = unreadable(VERIFY_FILE, verifyRaw);
  if (bad) return { ok: false, detail: bad };
  const hasOg = /og:image/.test(verifyCode);
  const hasStat = /statSync/.test(verifyCode);
  const hasZero = /(size\s*===\s*0)|(size\s*<=\s*0)|(size\s*<\s*1)/.test(verifyCode);
  return {
    ok: hasOg && hasStat && hasZero,
    detail: hasOg && hasStat && hasZero ? '' : `og:image:${hasOg} stat:${hasStat} 0 字节:${hasZero}（少了就抓不住「合成失败却照样发布」）`,
  };
});

/* ══════════════════════════════════════════════════════════════
   5) 编码：BOM / CR / UTF-8 往返
   ══════════════════════════════════════════════════════════════ */
console.log('\n5) 编码');

check('site/template.html 无 BOM、纯 LF、UTF-8 往返一致', () => {
  const p = encodingProblem(readBytes(TPL_FILE));
  return { ok: !p, detail: p };
});

check('tools/build-og.mjs 无 BOM、纯 LF、UTF-8 往返一致', () => {
  const p = encodingProblem(readBytes(BOG_FILE));
  return { ok: !p, detail: p };
});

/* ── 结果 ────────────────────────────────────────────────────── */
console.log('');
console.log(`  ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
