#!/usr/bin/env node
/**
 * 上游原帖 URL 反解 —— 从**源图原始文件名**反推原帖地址。
 *
 * 为什么要有：
 *   站里每张图都来自上游某个帖子（见笑 = Telegram 频道、见她 = 煎蛋网、见闻 = 喷嚏图卦），
 *   用户看到一张好图会想知道「原帖在哪」。manifest 里以前只有站内地址，点不回上游。
 *
 * 为什么放在**构建期**做：
 *   反解只需要源文件名，而构建期恰好拿得到 —— build.mjs 扫源目录时手里就是原始文件名。
 *   运行期再反解就得在 manifest 里另存一份文件名，白占体积。
 *
 * 这个文件是这套规则的**唯一真源**：
 *   以后加源只改这里，不要在 build.mjs 里写 if。
 *
 * 兜底：**任何情况下都不抛异常** —— 反解不出来只是「这张图没有原帖链接」，
 *   绝不能因为一个文件名把整次构建带崩。
 */
import { pathToFileURL } from 'node:url';

/**
 * 每条规则：
 *   tabKey  适用哪一栏（栏 key，不是中文目录名）；'*' = 通用（任何栏都适用）
 *   pattern 源文件名的正则（捕获组留给 build 用）
 *   build   由匹配结果拼出 URL；返回 null = 这一版还不给链接
 *   status  verified（实测能用）/ unverified（形状对，但没验通）/ impossible（根本反解不出）
 *   note    为什么是这个状态、怎么才能确认 —— 以后接手的人靠这段话决定要不要开
 */
export const UPSTREAM_RULES = [
  {
    tabKey: 'jianxiao',
    // 见笑 = Telegram 三个频道，文件名形如
    //   jandan_pic_184601_20261125_000105_img0.jpg
    //   pingrangTV_73383_20261125_103936_img0.jpg
    //   woshadiao_210887_20261125_002053_img0.jpg
    // 频道名里可能带下划线（jandan_pic），所以频道段用 [A-Za-z_]+ 而不是 \w+：
    //   \w+ 会连数字一起吃，频道名和消息 id 的边界就分不清了。
    pattern: /^([A-Za-z_]+)_(\d+)_(\d{8})_(\d{6})_img(\d+)\.[A-Za-z0-9]+$/,
    status: 'verified',
    note:
      'Telegram 频道消息 -> https://t.me/<频道>/<消息id>。' +
      '2026-11-26 实测三个频道（jandan_pic / pingrangTV / woshadiao）都返回 HTTP 200。' +
      '福利吧那批分流过来的图是 hash 命名，匹配不上本规则 -> 没有原帖链接。',
    build: (m) => `https://t.me/${m[1]}/${m[2]}`,
  },
  {
    tabKey: 'jianshe',
    // 见她 = 煎蛋网女装区，文件名形如 6252822_01.gif（前缀是帖子 id）
    pattern: /^(\d+)_(\d+)\.[A-Za-z0-9]+$/,
    status: 'unverified',
    note:
      '煎蛋网：详情页 https://jandan.net/cms/detail/<id> 实测 404；' +
      'beauty API 整站登录墙（带 cookie 也返回 {"code":1000,"msg":"较老的数据仅对登陆用户开放访问","data":null}）。' +
      '**怎么才能确认**：登录后调 API，从返回里拿真实 detail id，才能开这条规则。',
    // 这一版不给链接 —— 规则先留着，等上面那条路走通了把 build 填上就行。
    build: () => null,
  },
  {
    tabKey: 'jianwen',
    // 见闻 = 喷嚏图卦，文件名形如 001_37665.webp（后面 5 位是源 URL 的 md5 摘要）
    pattern: /^\d+_[0-9a-f]{5}\.[A-Za-z0-9]+$/,
    status: 'impossible',
    note:
      '源文件名只留了 URL 的 md5 摘要，没有帖子 id —— 反解不出原帖。' +
      '**怎么才能确认**：改上游的抓取命名，把原帖 id 一起写进文件名，这条规则才能开。',
    build: () => null,
  },
  {
    // 福利吧那批（分流到 见她/见笑）：文件名是 <序号>_<md5前5位>，跟见闻同一种命名。
    // 单独列一条，是为了把「为什么它也没有原帖链接」写清楚，而不是让它悄悄落到兜底分支。
    tabKey: '*',
    pattern: /^\d+_[0-9a-f]{5}\.[A-Za-z0-9]+$/,
    status: 'impossible',
    note:
      '福利吧：源文件名只留了 URL 的 md5 摘要，没有帖子 id —— 反解不出原帖。' +
      '**怎么才能确认**：抓的时候把原帖 id 写进文件名。',
    build: () => null,
  },
];

/**
 * 反解某个源图文件的上游原帖 URL。
 *
 * @param {string} tabKey   栏 key（jianxiao / jianshe / jianwen）
 * @param {string} fileName 源图文件名（原始文件名，不是转码后的产物名）
 * @returns {string|null} URL；反解不出来就是 null
 */
export function upstreamUrlFor(tabKey, fileName) {
  try {
    const key = String(tabKey || '');
    const name = String(fileName || '');
    if (!key || !name) return null;
    for (const rule of UPSTREAM_RULES) {
      if (rule.tabKey !== '*' && rule.tabKey !== key) continue;
      const m = rule.pattern.exec(name);
      if (!m) continue;
      const url = rule.build(m, name);
      return typeof url === 'string' && url.trim() ? url.trim() : null;
    }
    return null;
  } catch {
    // 兜底：反解失败不能把构建带崩 —— 少一个原帖链接只是少一个链接。
    return null;
  }
}

/**
 * 某条规则是不是「实测能用」—— 给构建日志/自测用。
 *
 * @param {string} tabKey
 * @param {string} fileName
 * @returns {object|null} 命中的规则（没命中就是 null）
 */
export function upstreamRuleFor(tabKey, fileName) {
  const key = String(tabKey || '');
  const name = String(fileName || '');
  for (const rule of UPSTREAM_RULES) {
    if (rule.tabKey !== '*' && rule.tabKey !== key) continue;
    if (rule.pattern.test(name)) return rule;
  }
  return null;
}

/* ------------------------------------------------------------ CLI 自测入口 */

function usage() {
  console.log(`上游原帖 URL 反解（自测入口）

  node tools/upstream-url.mjs <栏key> <源文件名> [...]

  例：
    node tools/upstream-url.mjs jianxiao jandan_pic_184601_20261125_000105_img0.jpg
    node tools/upstream-url.mjs jianshe 6252822_01.gif`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    usage();
    return 0;
  }
  const tabKey = argv[0];
  for (const name of argv.slice(1)) {
    const url = upstreamUrlFor(tabKey, name);
    const rule = upstreamRuleFor(tabKey, name);
    const status = rule ? rule.status : 'no-rule';
    console.log(`${name}\n  -> ${url || '(没有原帖链接)'}\n  [${status}]`);
  }
  return 0;
}

// ⚠️ Windows 上必须用 pathToFileURL(process.argv[1]).href ——
// 手写 `file://${argv[1]}` 会得到三个斜杠（file:///E:/...），入口根本不跑（exit 0 但零输出）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error('反解自测失败：', err && err.message ? err.message : err);
      process.exitCode = 1;
    });
}
