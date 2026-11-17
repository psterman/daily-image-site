#!/usr/bin/env node
/**
 * 护栏：注释剥离器（tools/strip-comments.mjs）
 *
 * 用法：node tools/test-strip-comments.mjs
 * 退出码：0 = 全过；1 = 有失败
 *
 * ── 为什么这个也要有护栏 ────────────────────────────────────
 * 三套新护栏（OG 卡片 / RSS / 模糊占位）**全都靠它**在匹配前剥掉注释：
 * 工程源码的注释里就写着 "og:image"、"RSS"、"绝对 URL"、"LQIP" 这些词，
 * 护栏若全文匹配，会把自己的说明书当成合规证据 → 代码改坏了也照样全绿 → 假护栏。
 *
 * 也就是说：**剥离器一坏，三套护栏一起变成假护栏**，而且没有任何报错。
 * 所以它自己必须被盯住。
 *
 * ── 它最容易坏在哪 ──────────────────────────────────────────
 * 朴素的剥法（把 // 之后全删）会把字符串里的 URL 吃掉：
 *   const siteUrl = 'https://example.com';
 * 一旦 "//" 之后全没了，后面真正的代码也一起没了 → 护栏匹配不到东西，
 * 护栏会「因为文件读不出来」而误判成失败（还好）或者误判成通过（更糟）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsComments, stripHtmlComments, stripCssComments } from './strip-comments.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

function readText(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

console.log('\n0) 文件在不在');
const stripSrc = readText('tools/strip-comments.mjs');
check('tools/strip-comments.mjs 存在', stripSrc !== null);
if (stripSrc === null) {
  console.log('\n缺文件，后面没法测了。');
  process.exit(1);
}

console.log('\n1) JS：字符串里的 // 和 /* 不能被当注释吃掉');
{
  const src = [
    "const siteUrl = 'https://example.com'; // 行注释：这里写着 og:image",
    '/* ZZBLOCKZZ',
    '   多行',
    '   绝对 URL */',
    'const re = /a\\/\\/b/;',
    'const t = `模板里的 // 不是注释`;',
    "const q = '/* 字符串里的块注释头 */';",
    'const div = total / count / 2;',
  ].join('\n');

  const code = stripJsComments(src);
  check('字符串里的 https URL 还在', code.includes("'https://example.com'"), code);
  check('行注释被剥掉了', !code.includes('行注释'), code);
  check('块注释被剥掉了', !code.includes('ZZBLOCKZZ'), code);
  check('正则字面量没被拆坏', code.includes('/a\\/\\/b/'), code);
  check('模板串没被拆坏', code.includes('`模板里的 // 不是注释`'), code);
  check('字符串里的 /* */ 没被误剥', code.includes("'/* 字符串里的块注释头 */'"), code);
  check('除号表达式没被误判成正则', code.includes('total / count / 2'), code);
}

console.log('\n2) JS：剥注释后代码还在（不能整段被吃光）');
{
  const build = readText('tools/build.mjs');
  check('tools/build.mjs 读得到', build !== null);
  if (build !== null) {
    const code = stripJsComments(build);
    check('剥完还剩很多行', code.split('\n').length > 1000, String(code.split('\n').length));
    check('代码里的 og.jpg 还在', code.includes('og.jpg'));
    check('代码里的 feed.xml 还在', code.includes('feed.xml'));
    check('代码里的站点绝对地址还在', code.includes('https://example.com'));
  }
}

console.log('\n3) HTML / CSS');
{
  const tpl = readText('site/template.html');
  check('site/template.html 读得到', tpl !== null);
  if (tpl !== null) {
    const code = stripHtmlComments(tpl);
    check('HTML 注释被剥', !code.includes('og:image 规则'), code.slice(0, 200));
    check('og:image meta 还在', code.includes('og:image'));
  }

  const css = readText('site/app.css');
  check('site/app.css 读得到', css !== null);
  if (css !== null) {
    const code = stripCssComments(css);
    check('CSS 注释被剥', !code.includes('模糊占位'), code.slice(0, 200));
    check('--lqip 规则还在', code.includes('--lqip'));
  }
}

console.log('\n4) 编码');
{
  const bytes = fs.readFileSync(path.join(ROOT, 'tools/strip-comments.mjs'));
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = bytes.toString('utf8');
  const crlf = (text.match(/\r\n/g) || []).length;
  const loneCr = (text.match(/\r(?!\n)/g) || []).length;
  check('无 BOM', !hasBom);
  check('无 CRLF', crlf === 0, String(crlf));
  check('无孤立 CR', loneCr === 0, String(loneCr));
  check('UTF-8 往返一致', Buffer.from(text, 'utf8').equals(bytes));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
