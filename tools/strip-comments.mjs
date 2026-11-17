#!/usr/bin/env node
/**
 * 剥掉注释，只留代码 —— 给护栏用。
 *
 * ── 为什么护栏必须剥注释 ────────────────────────────────────
 * 这个工程的源码里，「说明书」写得比代码还详细：
 * build.mjs 的注释里就写着 "og:image"、"RSS"、"绝对 URL" 这些词，
 * template.html 的注释里写着每一处 og:meta 的规则。
 * 护栏如果直接全文匹配，它会把自己的说明书当成合规证据 ——
 * 于是「代码被改坏了」也照样全绿，护栏就成了假护栏。
 *
 * ── 为什么不能简单按 // 切 ─────────────────────────────────
 * 朴素的剥法（把 // 之后全删）会把字符串里的 URL 吃掉：
 *   const siteUrl = 'https://example.com';
 * 一旦 "//" 之后全没了，后面真正的代码也一起没了。
 * 所以这里是个**状态机**：字符串、模板串、正则字面量都要单独认，
 * 只有真正落在代码状态里的 // 和 /* 才是注释。
 *
 * ── 为什么正则字面量要单独认 ───────────────────────────────
 * /a\/\/b/ 这种写法里确实有 //，如果当注释切，正则本身就坏了。
 * 判定「这个 / 是正则还是除号」用常见启发式：
 * 前一个有效字符是标识符/数字/右括号/右方括号 → 除号；否则 → 正则。
 * 判错的后果只是「这条注释没被剥掉」，不会让代码段乱掉，
 * 所以启发式够用，不需要真正的 JS 词法分析器。
 *
 * ── 用法 ────────────────────────────────────────────────────
 *   import { stripJsComments, stripHtmlComments, stripCssComments } from './strip-comments.mjs';
 *   const code = stripJsComments(fs.readFileSync(f, 'utf8'));
 *
 * 块注释被剥掉后补一个换行 —— 免得「注释前一行」和「注释后一行」
 * 挤成同一行，匹配时看不出是哪一处。
 */

/**
 * 剥掉 JS 注释。
 *
 * @param {string} src
 * @returns {string}
 */
export function stripJsComments(src) {
  const s = String(src ?? '');
  const n = s.length;
  let out = '';
  let i = 0;
  /** 上一个「有效」字符（跳过空白），用来判断 / 是除号还是正则开头。 */
  let prev = '';

  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];

    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }

    // 块注释
    if (c === '/' && c2 === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += '\n';
      continue;
    }

    // 字符串 / 模板串
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (s[j] === '\\') {
          j += 2;
          continue;
        }
        if (s[j] === q) {
          j++;
          break;
        }
        j++;
      }
      out += s.slice(i, j);
      i = j;
      prev = q;
      continue;
    }

    // 正则字面量
    if (c === '/' && canStartRegex(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = s[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        out += s.slice(i, j);
        i = j;
        prev = '/';
        continue;
      }
      // 没闭合（多半是除号），按普通字符处理
    }

    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return out;
}

/**
 * 剥掉 HTML 注释（<!-- ... -->）。
 *
 * @param {string} src
 * @returns {string}
 */
export function stripHtmlComments(src) {
  return String(src ?? '').replace(/<!--[\s\S]*?-->/g, '\n');
}

/**
 * 剥掉 CSS 注释（/* ... *\/）。
 *
 * @param {string} src
 * @returns {string}
 */
export function stripCssComments(src) {
  return String(src ?? '').replace(/\/\*[\s\S]*?\*\//g, '\n');
}

/**
 * / 到底是除号还是正则开头？
 *
 * 前一个有效字符是标识符字符、数字、) 或 ] → 是除号；
 * 否则（=、(、,、:、;、!、&、|、?、{、}、运算符、开头）→ 是正则。
 *
 * @param {string} prev
 * @returns {boolean}
 */
function canStartRegex(prev) {
  if (!prev) return true;
  return !/[A-Za-z0-9_$)\]]/.test(prev);
}
