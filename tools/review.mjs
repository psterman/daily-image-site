#!/usr/bin/env node
/**
 * 审稿台 —— 上传 R2 之前的最后一道人工关卡。
 *
 * 为什么要这个：
 *   自动化抓来的图里总会混进广告图、废图、不该出现的写真。
 *   以前是「抓完直接上传部署」，发现不对时东西已经发到群里了 ——
 *   撤回要等 24 小时边缘缓存，而且链接已经发出去收不回来。
 *   所以拆成两段：先在本地审，确认干净了再上传部署。
 *
 * 用法：
 *   node tools/review.mjs                        # 审今天要发布的那一期（北京今天）
 *   node tools/review.mjs 2026-10-27             # 指定日期
 *   node tools/review.mjs --port=9000            # 指定端口
 *
 *   端口被占用会自动往下顺延（最多 10 个），实际端口写在 .review-port 里。
 *
 * 流程：
 *   1. 审稿台列出当天三个分类的所有图（缩略图 + 原图可点开）
 *   2. 勾选不要的图 -> 点「应用勾选」-> 服务端直接从源图目录删掉
 *   3. 或者勾选后点「移到 见闻/见她/见笑」-> 源图文件在分类目录之间移动
 *      （自动分流不可能百分百准，写真和梗图混在一起时需要人工纠正）
 *   4. 全部确认无误 -> 点「通过审核」-> 生成放行凭证 .review-passed
 *   5. 之后跑 tools/publish.ps1 才会被允许上传（没凭证就拦下）
 *
 * 移动和删除都会让放行凭证作废 —— 审稿结论是针对
 * 「当时那批图和它们的归属」的，归属变了结论就不作数了。
 *
 * 放行凭证：<工程目录>/.review-passed-<日期>
 *   publish.ps1 检查它；日期对不上就拒绝上传（防的是拿昨天的凭证放今天的行）。
 *   凭证里还记着通过时的图片数量和每个分类各多少张 ——
 *     数量或归属变了说明图又动过，凭证作废。
 *
 * 为什么连分类也要记：
 *   把 4 张图从「见笑」挪到「见她」，总数一点没变，但归属变了 ——
 *   而审稿结论是针对「当时那批图和它们的归属」的。
 *   只比总数的话，这种改动会悄悄从闸门底下钻过去。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, SRC_LOCAL, R2_LOCAL } from './paths.mjs';
import { computePublishState, describeDeadState } from './publish-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const PORT = Number((argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 8789;
const APPLY = argv.includes('--apply');
/* --open：起好服务后自动用默认浏览器打开（给一键脚本用） */
const OPEN = argv.includes('--open');

/**
 * 北京今天（= 站点要发布的那一期的日期）。
 * 站点「日期页 = 发布日期」，所以审稿默认审今天这一期就对了。
 */
function beijingToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

/* 不传日期就用北京今天 —— 日常流程不用每次手敲日期 */
const DATE = argv.find((a) => !a.startsWith('--')) || beijingToday();

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error('用法：node tools/review.mjs [YYYY-MM-DD] [--port=8789] [--open]');
  process.exit(1);
}

const SRC_DIR = path.join(SRC_LOCAL, DATE);
const R2_DIR = path.join(R2_LOCAL, DATE);
const PASS_FILE = path.join(ROOT, `.review-passed-${DATE}`);

/* 端口记录文件 —— 默认写工程根的 .review-port。
   测试用 REVIEW_PORT_FILE 指到临时目录，免得把「正在跑的那个审稿台」
   的端口记录覆盖掉（覆盖了的话人打开的就是个连不上的端口）。 */
const PORT_FILE = process.env.REVIEW_PORT_FILE && process.env.REVIEW_PORT_FILE.trim()
  ? path.resolve(process.env.REVIEW_PORT_FILE.trim())
  : path.join(ROOT, '.review-port');

/* 分类目录名 -> 内部 key（跟 build.mjs 的 TABS 对齐） */
const CATS = [
  { dir: '见笑', key: 'jianxiao', label: '见笑' },
  { dir: '见闻', key: 'jianwen', label: '见闻' },
  { dir: '见她', key: 'jianshe', label: '见她' },
];

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

/* ---------------------------------------------------------------- 扫描 */

function listSourceImages() {
  const out = [];
  for (const cat of CATS) {
    const dir = path.join(SRC_DIR, cat.dir);
    let files = [];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && IMG_EXTS.has(path.extname(d.name).toLowerCase()))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
    } catch {
      /* 目录不存在 */
    }
    files.forEach((name, i) => {
      out.push({
        cat: cat.key,
        catLabel: cat.label,
        catDir: cat.dir,
        name,
        // 序号 = 在该分类里的排序位置 —— 跟 build.mjs 的编号规则一致
        idx: i + 1,
      });
    });
  }
  return out;
}

/* ---------------------------------------------------------------- 删图 */

/**
 * 按「分类 + 文件名」删除源图。
 *
 * 为什么要同时删 R2 母本：
 *   母本是构建产物缓存，源图删了但母本还在的话，
 *   重建时 build.mjs 会从源图重新转码 —— 母本里的旧文件会被覆盖，
 *   不会出问题。但留着是垃圾，清掉更干净。
 *   （真正要删的是 R2 桶里的对象，那个在上传前还没传，不存在。）
 */
function applyDelete(catKey, name) {
  const cat = CATS.find((c) => c.key === catKey);
  if (!cat) return { ok: false, error: '未知分类' };
  const srcPath = path.join(SRC_DIR, cat.dir, name);
  let removed = false;
  try {
    if (fs.existsSync(srcPath)) {
      fs.unlinkSync(srcPath);
      removed = true;
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  // 母本里同名同序号的产物
  try {
    const dir = path.join(R2_DIR, cat.key);
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.webp')) {
        const m = f.match(/_(\d{3})(_t)?\.webp$/);
        if (m) {
          // 母本文件名是 <nonce>_<序号>.webp，序号是构建时的位置
          // 源图删了之后位置会变，这里按「序号 >= 删除位置」保守清理
          // 实际以源图是否还在为准，见下面的 rebuild 提示
        }
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return { ok: true, removed };
}

/* ---------------------------------------------------------------- 移图 */

/**
 * 把一张源图从某个分类目录移到另一个分类目录。
 *
 * 为什么必须支持这个：
 *   自动分流（福利吧靠人脸检测判写真）不可能百分百准 —— 羊驼的肤色比
 *   大部分真人还高，动物特写和真人写真用同一套阈值根本分不开。
 *   最终一定要有人来纠正，而纠正必须发生在上传 R2 之前。
 *
 * 移动的是源图目录里的文件本身：站点构建时按目录分 tab，
 * 所以移动完重新构建，栏目就变了。
 *
 * 重名处理：不同分类里常有同名文件（见闻/001_xxx.gif 和 见笑/001_xxx.gif）。
 * 移过去撞名不能覆盖 —— 覆盖掉别人那张就等于悄悄删了一张图。
 * 所以加 _m1 / _m2 后缀。
 */
function applyMove(catKey, name, toKey) {
  const from = CATS.find((c) => c.key === catKey);
  const to = CATS.find((c) => c.key === toKey);
  if (!from) return { ok: false, error: '未知原分类 ' + catKey };
  if (!to) return { ok: false, error: '未知目标分类 ' + toKey };
  if (from.key === to.key) return { ok: true, skipped: true };

  const srcPath = path.join(SRC_DIR, from.dir, name);
  if (!fs.existsSync(srcPath)) return { ok: false, error: '文件不存在：' + name };

  const dstDir = path.join(SRC_DIR, to.dir);
  try {
    fs.mkdirSync(dstDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  let dstPath = path.join(dstDir, name);
  if (fs.existsSync(dstPath)) {
    const m = name.match(/^(.*?)(\.[^.]+)$/);
    const base = m ? m[1] : name;
    const ext = m ? m[2] : '';
    let i = 1;
    do {
      dstPath = path.join(dstDir, base + '_m' + i + ext);
      i += 1;
    } while (fs.existsSync(dstPath));
  }

  try {
    fs.renameSync(srcPath, dstPath);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, to: to.key, name: path.basename(dstPath) };
}

/* ---------------------------------------------------------------- 路由 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/* 审稿台页面（下面这一整块模板串）。
 *
 * ⚠️ 这是一个**反引号模板字符串** —— 里面（页面自带的 CSS/JS 和它的注释）
 * **绝对不能出现反引号**，写一个就会把模板提前截断，Node 直接报
 * 「SyntaxError: Unexpected token」而且报错行号指向模板里面，很难看出是注释惹的祸。
 * 2026-11-06 踩过：注释里写了 `delete on[id]`，整个审稿台起不来。
 * 要强调某段代码，写中文引号「」或者纯文字。 */
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>审稿台 · __DATE__</title>
<style>
  :root{--bg:#0f1115;--fg:#e8eaed;--dim:#9aa0a6;--line:#2a2e37;--card:#181b22;--del:#e5484d;--ok:#3ddc97;--focus:#4a8cff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  header{position:sticky;top:0;z-index:10;background:rgba(15,17,21,.94);
         backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:14px 20px}
  h1{margin:0 0 4px;font-size:18px}
  .sub{color:var(--dim);font-size:13px}
  .bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
  button{border:1px solid var(--line);background:var(--card);color:var(--fg);
         padding:7px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit}
  button:hover{border-color:#4a5060}
  button.primary{background:var(--ok);color:#06231a;border-color:transparent;font-weight:600}
  button.danger{background:var(--del);color:#fff;border-color:transparent;font-weight:600}
  button:disabled{opacity:.4;cursor:not-allowed}
  /* 禁用态要一眼看得出来 ——
     原来只有 opacity:.4，红色的「应用勾选（删除）」变成暗红，
     用户完全看不出它点不动，只会以为「点了没反应」（2026-10-30 踩到）。 */
  button:disabled{filter:grayscale(1);pointer-events:none}
  .spacer{flex:1}
  .sep{width:1px;height:22px;background:var(--line);margin:0 2px}
  .lbl{color:var(--dim);font-size:13px}
  button.mv{border-color:#3a4150;color:#c8d0dc}
  button.mv:hover{border-color:#6b7488;background:#20242e}
  .stat{color:var(--dim);font-size:13px}
  .stat b{color:var(--fg)}
  main{padding:18px 20px 60px}
  .group{margin-bottom:26px}
  .group h2{font-size:15px;margin:0 0 10px;display:flex;align-items:center;gap:8px}
  .tag{font-size:12px;color:var(--dim);border:1px solid var(--line);border-radius:20px;padding:1px 9px}
  .grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
  .cell{position:relative;background:var(--card);border:1px solid var(--line);
        border-radius:10px;overflow:hidden;cursor:pointer}
  .cell.marked{border-color:var(--del);opacity:.45}
  /* 键盘操作时的焦点框 —— 没有它，Tab/回车流里根本看不出焦点在哪 */
  .cell:focus{outline:2px solid var(--focus);outline-offset:-2px}
  .cell.marked::after{content:"已标记";position:absolute;inset:auto 0 0 0;background:var(--del);
        color:#fff;text-align:center;font-size:12px;padding:3px;font-weight:600}
  .cell img{width:100%;height:150px;object-fit:cover;display:block;background:#0b0d11}
  .cell .meta{padding:5px 7px;font-size:11px;color:var(--dim);
              white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cell .no{position:absolute;top:5px;left:5px;background:rgba(0,0,0,.72);
            color:#fff;font-size:11px;padding:1px 6px;border-radius:5px}
  .mark{position:absolute;top:5px;right:5px;width:20px;height:20px;border-radius:50%;
        background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.4);
        display:flex;align-items:center;justify-content:center;font-size:13px;line-height:1}
  .cell.marked .mark{background:var(--del);border-color:var(--del)}
  .empty{color:var(--dim);padding:20px 0}
  #tip{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;
       background:#20242e;border:1px solid var(--line);border-radius:10px;
       padding:10px 18px;opacity:0;transition:opacity .25s;pointer-events:none;font-size:13px}
  #tip.on{opacity:1}
  #lb{position:fixed;inset:0;background:rgba(0,0,0,.92);display:none;
      align-items:center;justify-content:center;z-index:50;padding:24px}
  #lb.on{display:flex}
  #lb img{max-width:94vw;max-height:88vh;object-fit:contain}
  #lb .x{position:absolute;top:16px;right:20px;font-size:30px;cursor:pointer;color:#fff}
  #lb .tip2{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);color:#ccc;font-size:13px}
  /* 键盘审稿时看的信息条：当前是哪张、第几张 */
  #lb .lbinfo{position:absolute;top:18px;left:22px;right:80px;color:#ddd;font-size:13px;
              display:flex;gap:14px;align-items:baseline}
  #lb .lbname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #lb .lbcount{color:#8ab4f8;flex:none}
  #lb .lbmark{position:absolute;top:46px;left:22px;color:#ff8a8a;font-size:13px;
              background:rgba(255,90,90,.16);border:1px solid rgba(255,90,90,.55);
              padding:2px 9px;border-radius:6px}
  #lb .lbmark[hidden]{display:none}
  /* 页面内确认条。
   * 不用原生 confirm()：那是阻塞式弹窗，看不清要确认什么，
   * 批量操作时尤其容易误点「取消」白勾一遍。 */
  #cfm{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:60;
       display:flex;align-items:center;gap:12px;
       background:#20242e;border:1px solid var(--line);border-radius:12px;
       padding:12px 16px;box-shadow:0 8px 32px rgba(0,0,0,.5)}
  #cfm[hidden]{display:none}
  #cfmText{font-size:13px}
  button.ghost{background:transparent;color:var(--dim)}
  /* 一键发布的日志抽屉 —— 从底部升起来，不挡住上面的图 */
  #plog{position:fixed;left:0;right:0;bottom:0;z-index:70;display:none;
       flex-direction:column;background:#14171d;border-top:1px solid var(--line);
       box-shadow:0 -8px 32px rgba(0,0,0,.5);max-height:46vh}
  #plog.on{display:flex}
  #plog .ph{display:flex;align-items:center;gap:12px;padding:9px 16px;border-bottom:1px solid var(--line)}
  #plog .ph b{font-size:13px}
  #plog .ph .sp{flex:1}
  #plog .ph .st{font-size:12px;color:var(--dim)}
  #plog .ph .st.ok{color:var(--ok)}
  #plog .ph .st.err{color:var(--del)}
  #plog pre{margin:0;padding:11px 16px;overflow:auto;flex:1;
       font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;
       color:#c9d1d9;white-space:pre-wrap;word-break:break-all}
  #plog a{color:#8ab4f8}
</style>
</head>
<body>
<header>
  <h1>审稿台 · __DATE__</h1>
  <div class="sub">点图放大看 · 放大后用 <b>← → ↑ ↓</b> 翻页、<b>Enter</b> 选中这张（再按一次取消）· 点左上角圆圈也能标记 · 确认无误后点「通过审核」</div>
  <div class="bar">
    <button id="markAll">标记全部</button>
    <button id="clearAll">清空标记</button>
    <button id="apply" class="danger">应用勾选（删除）</button>
    <span class="sep"></span>
    <span class="lbl">移到</span>
    <button id="mv-jianwen" class="mv">见闻</button>
    <button id="mv-jianshe" class="mv">见她</button>
    <button id="mv-jianxiao" class="mv">见笑</button>
    <span class="spacer"></span>
    <span class="stat">共 <b id="total">0</b> 张 · 已标记 <b id="marked">0</b> 张</span>
    <button id="pass" class="primary">通过审核</button>
    <button id="publish" title="生成放行凭证 → 完整重建 → 上传 R2 → 部署 Pages（约 3~5 分钟）">通过审核并发布</button>
  </div>
</header>
<main id="main"></main>
<div id="lb"><span class="x" id="lbx">&times;</span><img id="lbi" alt=""><div class="lbinfo"><span class="lbname" id="lbmeta"></span><span class="lbcount" id="lbcount"></span></div><div class="lbmark" id="lbmark" hidden>已标记 · 准备删除</div><div class="tip2">← → ↑ ↓ 切换上一张 / 下一张 · Enter 选中这张 · Delete 直接删除这张 · Esc 关闭</div></div>
<div id="tip"></div>
<div id="cfm" hidden>
  <span id="cfmText"></span>
  <button id="cfmNo" class="ghost">取消</button>
  <button id="cfmYes" class="primary">确定</button>
</div>
<div id="plog">
  <div class="ph">
    <b>发布日志</b>
    <span class="st" id="plogState"></span>
    <span class="sp"></span>
    <button id="plogToggle" class="ghost">收起</button>
    <button id="plogClose" class="ghost">关闭</button>
  </div>
  <pre id="plogPre"></pre>
</div>
<script>
var DATE = "__DATE__";
var marked = new Set();
var ALL = [];

/* ---------------------------------------------------------------- 键盘审稿
 *
 * 为什么做这个：
 *   一天 200+ 张图，鼠标流程是「点图 → 记住位置 → 找下一张 → 再点标记」，
 *   眼睛来回扫网格找图很慢。键盘流是「← → 一路翻，Enter 顺手选中」，
 *   手不用离开键盘，也不怕点错格子。
 *
 * 选中用哪个键：
 *   Enter 和 Delete 都行 —— Enter 是主（笔记本的 Delete 要按 Fn+Delete，
 *   手够不着），Delete 保留是因为老习惯。
 *
 * 翻页范围 = 当前所在栏目（分类）。
 *   三个栏目各有各的审核标准（见闻=新闻截图、见她=写真、见笑=梗图），
 *   混着翻容易拿错标准判断 —— 所以只在同一个栏目内前后走。
 */
var viewList = [];   // 当前栏目的图，顺序跟网格一致
var viewIdx = -1;    // 当前在看第几张

/* ---------------------------------------------------------------- 标记持久化
 *
 * 为什么：标记只存在页面内存里，刷新一次就没了 ——
 * 审 200+ 张图，中间手滑按了 F5，前面的功夫全白费。
 * 存 localStorage 后刷新、关标签页、重开浏览器都还在。
 *
 * key 按日期分开：换一天审稿不会把昨天的标记带过来。
 *
 * 为什么存成 {on, off} 两张表而不是一个数组：
 *   localStorage 是**所有标签页共用**的。要是开着两个审稿台页面，
 *   旧的那个（内存里的标记已经过时）一保存，就会把新的那个覆盖掉 ——
 *   前面标的图凭空消失。
 *   加上「墓碑表」之后：
 *     on  = 两个页面都同意要删的
 *     off = 两个页面都同意不删的
 *   合并规则 = (on 的并集) 减 (off 的并集)。
 *   谁标了谁生效、谁取消了谁生效，谁都不会把对方的决定吃掉。
 *
 *   但有一条更优先：**这一页动过的 id，以这一页的决定为准**。
 *   不加这条的话，「清空标记」之后重新选中的图存不进去（off 里的旧墓碑
 *   会在合并时把它抹掉），刷新就没了 —— 详见 saveMarks() 里的说明。
 *
 *   —— 2026-11-06 改：整套换成了带时间戳的模型，理由见下面 onTs/offTs 那段。
 */
var MARK_KEY = 'review-marked-' + DATE;

/* 每个 id 两个时间戳：
     onTs  = 最后一次「标上（准备删除）」的时间
     offTs = 最后一次「取消」的时间
   哪个新算哪个；一样新算「取消」（宁可少删，别误删）。
   acts = 本页做过的操作（id -> {side, ts}），保存时跟存储合并用。 */
var onTs = new Map();
var offTs = new Map();
var acts = new Map();
var tsClock = 0;          // 本页的时间戳游标，保证严格递增

/* 为什么换成时间戳，而不是原来那两张表（on / off 集合）：
     原来的合并规则是「on 的并集 减 off 的并集」，off 是**墓碑** ——
     一旦某张图被取消过，它就永远在 off 里。后果有两个，都是实测过的：
       1. 「清空标记」把全部 id 写进 off，之后你重新选中其中一张，
          保存时又会被旧墓碑抹掉 —— 页面看着有标记，刷新就没了。
       2. 两个标签页互相踩：一个标签页的旧墓碑能干掉另一个标签页刚标的图。
   带时间戳之后规则就一句话：**最后一次操作赢**。
     · 先取消后标上 → 标上的时间更新 → 标上生效
     · 两个标签页各标各的 → 谁后标谁赢，谁也不吃掉谁
   老格式（{on:[], off:[]}）按时间戳 0 读进来 —— 本页的第一次操作就比它新，
   顺手把老状态顶掉，不用写迁移脚本。 */
var marked = new Set();    // 界面上「已标记」的 id（由 onTs/offTs 算出来）
var unmarked = new Set();  // 界面上「已取消」的 id

/* 本页的时间戳：严格递增（同毫秒连按两下也不会撞） */
function nowTs() {
  var t = Date.now();
  if (t <= tsClock) t = tsClock + 1;
  tsClock = t;
  return t;
}

/* 老格式是数组（没有时间戳，一律当 0），新格式是 {id: ts} */
function toTsMap(v) {
  var m = {};
  if (!v) return m;
  if (Array.isArray(v)) { v.forEach(function(id){ m[id] = 0; }); return m; }
  Object.keys(v).forEach(function(id){ m[id] = Number(v[id]) || 0; });
  return m;
}

function readStore() {
  try {
    var raw = localStorage.getItem(MARK_KEY);
    if (!raw) return { on: {}, off: {} };
    var o = JSON.parse(raw);
    // 兼容早期版本存的老格式（就是一个数组）
    if (Array.isArray(o)) return { on: toTsMap(o), off: {} };
    return { on: toTsMap(o.on), off: toTsMap(o.off) };
  } catch (e) { return { on: {}, off: {} }; }
}

/* 由 onTs/offTs 算出界面上的两个集合 */
function recomputeMarks() {
  marked.clear();
  unmarked.clear();
  var ids = {};
  onTs.forEach(function(ts, id){ ids[id] = 1; });
  offTs.forEach(function(ts, id){ ids[id] = 1; });
  Object.keys(ids).forEach(function(id){
    var o = onTs.get(id);
    var f = offTs.get(id);
    if (o === undefined) { unmarked.add(id); return; }
    if (f === undefined || o > f) marked.add(id);
    else unmarked.add(id);
  });
}

function loadMarks() {
  onTs.clear();
  offTs.clear();
  var st = readStore();
  Object.keys(st.on).forEach(function(id){ onTs.set(id, st.on[id]); });
  Object.keys(st.off).forEach(function(id){ offTs.set(id, st.off[id]); });
  recomputeMarks();
}

function saveMarks() {
  try {
    var st = readStore();
    var on = {}, off = {};
    /* 存储里已有的 —— 别的标签页可能刚写过 */
    Object.keys(st.on).forEach(function(id){ on[id] = st.on[id]; });
    Object.keys(st.off).forEach(function(id){ off[id] = st.off[id]; });
    /* 本页做过的操作 —— 时间戳新的赢 */
    acts.forEach(function(act, id){
      if (act.side === 'on') {
        if (on[id] === undefined || act.ts >= on[id]) on[id] = act.ts;
      } else {
        if (off[id] === undefined || act.ts >= off[id]) off[id] = act.ts;
      }
    });
    /* 已经被删掉/移走的图不再算 —— 不然「已标记 N 张」会虚高，
       而且下次点删除会对着不存在的文件报错 */
    var alive = aliveIds();
    if (alive) Object.keys(on).forEach(function(id){ if (!alive[id]) delete on[id]; });
    localStorage.setItem(MARK_KEY, JSON.stringify({ v: 2, on: on, off: off }));
  } catch (e) { /* 存不进去就算了，只是刷新会丢标记 */ }
}

/* 当前磁盘上还存在的图（id -> 1）。ALL 还没加载时返回 null = 「不筛选」 */
function aliveIds() {
  if (!ALL || !ALL.length) return null;
  var a = {};
  ALL.forEach(function(it){ a[it.cat + '/' + it.name] = 1; });
  return a;
}

/* 标记 / 取消标记的唯一入口 —— 两个方向都要记（带时间戳），
   保存时跟别的标签页写进存储的决定比时间，新的赢 */
function setMark(id, on) {
  var ts = nowTs();
  acts.set(id, { side: on ? 'on' : 'off', ts: ts });
  if (on) onTs.set(id, ts); else offTs.set(id, ts);
  recomputeMarks();
  sync();
}

/* 图被删掉/移走了 —— 它的标记也该跟着消失。
   不然「已标记 N 张」会虚高，而且下次点删除会对着不存在的文件报错。 */
function forgetMarks(ids) {
  ids.forEach(function(id){
    marked.delete(id);
    unmarked.delete(id);
    onTs.delete(id);
    offTs.delete(id);
    acts.delete(id);
  });
}

function toast(msg) {
  var t = document.getElementById('tip');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(t._h); t._h = setTimeout(function(){ t.classList.remove('on'); }, 2600);
}

/* 页面内确认条（不用原生 confirm —— 阻塞式弹窗看不清要确认什么） */
var pendingCfm = null;
function askConfirm(text, fn) {
  pendingCfm = fn;
  document.getElementById('cfmText').textContent = text;
  document.getElementById('cfm').hidden = false;
}
document.getElementById('cfmNo').addEventListener('click', function(){
  pendingCfm = null;
  document.getElementById('cfm').hidden = true;
});
document.getElementById('cfmYes').addEventListener('click', function(){
  var f = pendingCfm; pendingCfm = null;
  document.getElementById('cfm').hidden = true;
  if (f) f();
});
document.addEventListener('keydown', function(e){
  /* 确认条开着的时候，键只服务于确认条 */
  if (pendingCfm) {
    if (e.key === 'Escape') {
      pendingCfm = null;
      document.getElementById('cfm').hidden = true;
    }
    return;
  }

  var lb = document.getElementById('lb');
  var inViewer = lb.classList.contains('on');

  /* Enter = 选中当前这张图（标记，批量删除走这条路）。
     查看器里是「正在看的那张」，网格里是「刚点过的那张」。
     Delete 从 2026-11-09 起改成「直接删除」，标记只剩回车这一条路 ——
     反正有些笔记本的 Delete 要按 Fn+Delete，手够不着，回车本来就更顺手。 */
  if (isEnterKey(e)) {
    /* 焦点在按钮/输入框上时不抢 —— 回车归那个控件。
       不然点完「通过审核」再按回车，会顺手把眼前这张标成要删。 */
    if (isFormish(e.target)) return;
    e.preventDefault();
    if (inViewer) toggleMarkCurrent();
    else toggleMarkFocusedCell();
    return;
  }

  if (!inViewer) return;   // 没开查看器就把方向键还给页面（正常滚动）

  /* Delete 键：不同环境上报的键名不一样 ——
     物理键盘是 e.key='Delete'，有些自动化环境上报 'Del'，
     所以再拿 e.code 兜一次（键位名，跟键盘布局无关，最稳）。 */
  if (e.key === 'Delete' || e.key === 'Del' || e.code === 'Delete') {
    /* Backspace 在部分浏览器里会变成「后退」，
       所以都拦掉 preventDefault，不然删一张图页面就跳走了 */
    e.preventDefault();
    /* 焦点在按钮/输入框上时不抢 —— 跟回车一个道理。
       不然点完「通过审核」顺手按 Delete，会把眼前这张直接删了。 */
    if (isFormish(e.target)) return;
    deleteCurrent();
    return;
  }

  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      e.preventDefault();
      moveViewer(-1);
      break;
    case 'ArrowRight':
    case 'ArrowDown':
      e.preventDefault();
      moveViewer(1);
      break;
    case 'Escape':
      e.preventDefault();
      lb.classList.remove('on');
      break;
  }
});

function esc(s){ return String(s).replace(/[&<>"]/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

/* ---------------------------------------------------------------- 缩略图队列
 *
 * 为什么要有队列：
 *   一天 254 张图，每张都要请求一次 /thumb。浏览器对同一域名只允许
 *   6 个并发连接，254 个请求一排队，「通过审核」那个 fetch 就排在最后面 ——
 *   实测点了以后 5 秒都没发出去，页面看着像卡死了。
 *
 *   限流到 4 个在途，其余排队，fetch 就能立刻插队。
 *
 * 为什么不用 loading="lazy"：
 *   lazy 会把视口外的请求推迟，于是那些图的 load 事件永远不触发，
 *   在途计数回不来 —— 队列直接死锁（实测第 150 张图一直拿不到 src）。
 *   并发控制由队列做，lazy 是多余且有害的。
 */
var MAX_INFLIGHT = 4;
var imgQueue = [];
var inflight = 0;

function pumpQueue() {
  while (inflight < MAX_INFLIGHT && imgQueue.length) {
    var el = imgQueue.shift();
    inflight += 1;
    var done = function(){ inflight -= 1; pumpQueue(); };
    el.addEventListener('load', done, { once: true });
    el.addEventListener('error', done, { once: true });
    el.src = el.dataset.src;
  }
}

function render() {
  var groups = {};
  ALL.forEach(function(it){ (groups[it.catLabel] = groups[it.catLabel] || []).push(it); });
  var html = '';
  Object.keys(groups).forEach(function(label){
    var items = groups[label];
    html += '<section class="group"><h2>' + esc(label)
         + ' <span class="tag">' + items.length + ' 张</span></h2><div class="grid">';
    items.forEach(function(it){
      var id = it.cat + '/' + it.name;
      var on = marked.has(id);
      html += '<figure class="cell' + (on ? ' marked' : '') + '" tabindex="-1" data-id="' + esc(id) + '">'
        + '<img data-src="/thumb/' + it.cat + '/' + encodeURIComponent(it.name) + '" alt="">'
        + '<span class="no">#' + it.idx + '</span>'
        + '<span class="mark">' + (on ? '✓' : '') + '</span>'
        + '<figcaption class="meta">' + esc(it.name) + '</figcaption>'
        + '</figure>';
    });
    html += '</div></section>';
  });
  if (!ALL.length) html = '<p class="empty">这一天没有找到图片。</p>';
  document.getElementById('main').innerHTML = html;
  /* 新的 img 用 data-src 占位，排进队列再逐个放行 */
  imgQueue.length = 0;
  inflight = 0;
  document.querySelectorAll('#main img[data-src]').forEach(function(el){ imgQueue.push(el); });
  pumpQueue();
  document.getElementById('total').textContent = ALL.length;
  document.getElementById('marked').textContent = marked.size;
}

function sync() {
  document.querySelectorAll('.cell').forEach(function(el){
    var on = marked.has(el.dataset.id);
    el.classList.toggle('marked', on);
    el.querySelector('.mark').textContent = on ? '✓' : '';
  });
  document.getElementById('marked').textContent = marked.size;
  saveMarks();
}

document.getElementById('main').addEventListener('click', function(e){
  var cell = e.target.closest('.cell');
  if (!cell) return;
  var id = cell.dataset.id;
  /* 把焦点落到格子上 —— 回车「选中」要知道是哪一张 */
  try { cell.focus(); } catch (_) { /* 焦点拿不到也不影响鼠标流 */ }
  if (e.target.classList.contains('mark')) {
    setMark(id, !marked.has(id));
    return;
  }
  // 点缩略图 -> 看原图
  var it = ALL.find(function(x){ return x.cat + '/' + x.name === id; });
  if (!it) return;
  openViewer(it);
});

/* ---------------------------------------------------------------- 查看器 */

function openViewer(it) {
  // 翻页范围 = 同一个栏目的全部图
  viewList = ALL.filter(function(x){ return x.catLabel === it.catLabel; });
  viewIdx = -1;
  for (var i = 0; i < viewList.length; i++) {
    if (viewList[i].cat + '/' + viewList[i].name === it.cat + '/' + it.name) { viewIdx = i; break; }
  }
  if (viewIdx < 0) { viewList = [it]; viewIdx = 0; }
  paintViewer();
  document.getElementById('lb').classList.add('on');
}

function paintViewer() {
  var it = viewList[viewIdx];
  if (!it) return;
  document.getElementById('lbi').src = '/orig/' + it.cat + '/' + encodeURIComponent(it.name);
  document.getElementById('lbmeta').textContent = it.catLabel + ' #' + it.idx + '  ' + it.name;
  document.getElementById('lbcount').textContent = (viewIdx + 1) + ' / ' + viewList.length;
  document.getElementById('lbmark').hidden = !marked.has(it.cat + '/' + it.name);
  preloadAround();
}

/* 预载左右邻居 —— 翻页要的是「点了就有图」，不是「点了等一下」。
   只预载 2 张：再多会把浏览器的连接占满，反而拖累当前图的加载。 */
function preloadAround() {
  if (viewList.length < 2) return;
  [viewIdx - 1, viewIdx + 1].forEach(function(i){
    var it = viewList[(i + viewList.length) % viewList.length];
    if (!it) return;
    var im = new Image();
    im.src = '/orig/' + it.cat + '/' + encodeURIComponent(it.name);
  });
}

function moveViewer(delta) {
  if (!viewList.length) return;
  var n = viewList.length;
  // 循环翻：到最后一张再按「下一张」回到第一张，审到底不用停
  viewIdx = (viewIdx + delta + n) % n;
  paintViewer();
}

/* 回车：标记/取消标记当前这张，进「准备删除」清单（批量删除走这条路） */
function toggleMarkCurrent() {
  var it = viewList[viewIdx];
  if (!it) return;
  var id = it.cat + '/' + it.name;
  var willMark = !marked.has(id);
  setMark(id, willMark);
  toast(willMark ? ('已标记（准备删除）：' + it.name)
                 : ('已取消标记：' + it.name));
  paintViewer();
}

/* Delete 键：直接删掉当前这张图（2026-11-09 改）。
 *
 * 为什么从「标记」改成「直接删」：
 *   以前 Delete 只是标记，要再点「应用勾选（删除）」才真删。
 *   一天两百多张图，审到一张该删的就得多点一次，太啰嗦。
 *
 * 为什么可以不等隔离区：
 *   隔离区是给**清洗脚本**兜底的 —— 那是规则判定的，误删过正常梗图，
 *   源站图床挂了就再也取不回来。审稿台是**人眼判定**，你盯着看过就是该删。
 *
 * ⚠️ 删掉的图**回不来**：抓取台账记着「这张抓过」，
 *    重跑抓图会直接跳过它（真要找回，得清掉台账里那条 URL 记录再重抓）。
 *    所以批量删除那条路（「应用勾选（删除）」）仍然保留确认条。
 */
async function deleteCurrent() {
  var it = viewList[viewIdx];
  if (!it) return;
  var id = it.cat + '/' + it.name;
  var label = it.catLabel;
  try {
    var res = await fetch('/api/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [ { cat: it.cat, name: it.name } ] })
    });
    var j = await res.json();
    if (!j.ok) { toast('删除失败：' + (j.error || '未知错误')); return; }
    toast('已删除 ' + it.name);
    forgetMarks([id]);
    saveMarks();
    /* 凭证会作废（服务端 /api/delete 删掉了放行凭证文件），
       按钮状态得跟着回到「通过审核」，不然界面还显示「已通过审核」。 */
    setPassState('idle', '通过审核');
    await load();
    /* load() 只重建网格，不动 viewList —— 被删的那张还在翻页列表里，
       查看器会继续显示一张已经不存在的图（src 404）。
       这里按新列表重建当前栏目的翻页范围，停在同一位置（= 原来的下一张）。 */
    viewList = ALL.filter(function(x){ return x.catLabel === label; });
    if (!viewList.length) {
      document.getElementById('lb').classList.remove('on');
      viewIdx = -1;
      return;
    }
    if (viewIdx >= viewList.length) viewIdx = viewList.length - 1;
    paintViewer();
  } catch (err) {
    toast('请求失败：' + err.message);
  }
}

/* 回车 —— 不同环境上报的键名不一样（e.key / e.code / 小键盘），
   三种都认，别只在其中一种上报下能用。 */
function isEnterKey(e) {
  return e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter';
}

/* 焦点是不是落在按钮/输入框这类控件上 —— 是的话回车归它，别抢 */
function isFormish(el) {
  if (!el || !el.closest) return false;
  return !!el.closest('button, a, input, select, textarea, [contenteditable]');
}

/* 网格里按回车：标记「刚点过的那张」。
   格子的 tabindex 是 -1（不进 Tab 序列 —— 279 个 Tab 停靠点太折磨人），
   但点一下能拿到焦点，于是回车照样能用。 */
function toggleMarkFocusedCell() {
  var ae = document.activeElement;
  var cell = (ae && ae.closest) ? ae.closest('.cell') : null;
  if (!cell) return;
  var id = cell.dataset.id;
  var name = (cell.querySelector('.meta') || {}).textContent || id;
  var willMark = !marked.has(id);
  setMark(id, willMark);
  toast(willMark ? ('已标记（准备删除）：' + name)
                 : ('已取消标记：' + name));
}

document.getElementById('lb').addEventListener('click', function(e){
  // 只有点背景才关 —— 点图片、点信息条、点按钮都不关
  if (e.target.id !== 'lb') return;
  document.getElementById('lb').classList.remove('on');
});
document.getElementById('lbx').addEventListener('click', function(){
  document.getElementById('lb').classList.remove('on');
});

document.getElementById('markAll').addEventListener('click', function(){
  /* 「标记全部」也要留时间戳 —— 它是一次明确操作，
     比别的标签页早先写下的取消更晚就该赢 */
  var ts = nowTs();
  ALL.forEach(function(it){
    var id = it.cat + '/' + it.name;
    onTs.set(id, ts);
    acts.set(id, { side: 'on', ts: ts });
  });
  recomputeMarks();
  sync();
});
document.getElementById('clearAll').addEventListener('click', function(){
  /* 全部取消也要留时间戳，否则另一个标签页一保存就把它们全带回来 */
  var ts = nowTs();
  ALL.forEach(function(it){
    var id = it.cat + '/' + it.name;
    offTs.set(id, ts);
    acts.set(id, { side: 'off', ts: ts });
  });
  recomputeMarks();
  sync();
});

document.getElementById('apply').addEventListener('click', function(){
  if (!marked.size) { toast('没有勾选任何图'); return; }
  askConfirm('确定删除 ' + marked.size + ' 张图？删除后需要重新构建才能看到效果。', doApply);
});

async function doApply() {
  var list = markedList();
  var btn = document.getElementById('apply');
  btn.disabled = true;
  try {
    var res = await fetch('/api/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: list })
    });
    var j = await res.json();
    if (!j.ok) { toast('删除失败：' + (j.error || '未知错误')); return; }
    toast('已删除 ' + j.deleted + ' 张，正在重新载入');
    forgetMarks(list.map(function(it){ return it.cat + '/' + it.name; }));
    saveMarks();
    setPassState('idle', '通过审核');
    await load();
  } catch (err) {
    toast('请求失败：' + err.message);
  } finally {
    /* 按钮必须复位 —— 不复位的话第一次删完就永久 disabled，
       后面再想删就点不动了（2026-10-30 用户实际踩到）。 */
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------- 移动分类 */
//
// 为什么要这个：自动分流（福利吧靠人脸检测判写真）不可能百分百准 ——
// 羊驼的肤色比大部分真人还高，动物特写和真人写真用同一套阈值分不开。
// 所以最终一定得有人来纠正，而纠正的动作发生在「上传 R2 之前」。
//
// 移动的是源图目录里的文件本身（src/<日期>/<分类>/xxx），
// 站点构建时按目录分 tab，所以移动完重新构建，栏目就变了。

var MOVE_LABELS = { jianwen: '见闻', jianshe: '见她', jianxiao: '见笑' };

function markedList() {
  var list = [];
  marked.forEach(function(id){
    var p = id.split('/');
    list.push({ cat: p[0], name: p.slice(1).join('/') });
  });
  return list;
}

Object.keys(MOVE_LABELS).forEach(function(to){
  document.getElementById('mv-' + to).addEventListener('click', function(){
    if (!marked.size) { toast('没有勾选任何图'); return; }
    /* 已经在这个栏目里的就别移了 —— 否则移动过去还会再移回来 */
    var list = markedList().filter(function(it){ return it.cat !== to; });
    if (!list.length) { toast('勾选的图已经在「' + MOVE_LABELS[to] + '」里了'); return; }
    askConfirm('确定把 ' + list.length + ' 张图移到「' + MOVE_LABELS[to]
             + '」？移动完需要重新构建才能看到效果。', function(){ doMove(list, to); });
  });
});

async function doMove(list, to) {
  var btn = document.getElementById('mv-' + to);
  btn.disabled = true;
  try {
    var res = await fetch('/api/move', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: list, to: to })
    });
    var j = await res.json();
    if (!j.ok) { toast('移动失败：' + (j.error || '未知错误')); return; }
    toast('已移动 ' + j.moved + ' 张到「' + MOVE_LABELS[to] + '」，正在重新载入');
    forgetMarks(list.map(function(it){ return it.cat + '/' + it.name; }));
    saveMarks();
    setPassState('idle', '通过审核');
    await load();
  } catch (err) {
    toast('请求失败：' + err.message);
  } finally {
    /* 同 doApply：按钮要复位，否则移过一次就永久 disabled */
    btn.disabled = false;
  }
}

// 「通过审核」按钮的状态机
//
// 为什么不能「点成功一次就永久禁用」：
//   服务端在删图 / 移图之后会把放行凭证作废（审稿结论针对的是
//   「当时那批图和它们的归属」，归属变了结论就不作数）。
//   如果按钮还停在「✓ 已通过」又点不动，页面会让人以为已经通过，
//   等跑发布命令被拦下才发现 —— 白跑一趟，还容易以为是脚本坏了。
//
// 所以只有「请求还在飞」的时候才禁用；成功和失败都要恢复可点，
// 删图/移图之后更是要主动把文案退回「通过审核」，
// 提醒「刚才那轮结论已经作废了，得重新过一次」。
function setPassState(state, text) {
  var b = document.getElementById('pass');
  b.textContent = text;
  b.disabled = (state === 'busy');
  if (state === 'idle' && text === '通过审核') {
    b.title = '点一下生成放行凭证（之后才能跑发布命令）';
  } else if (state === 'idle' && text === '✓ 已通过') {
    b.title = '已生成放行凭证 · 再点一次可重新生成';
  }
}

document.getElementById('pass').addEventListener('click', async function(){
  if (marked.size) { toast('还有 ' + marked.size + ' 张没处理'); return; }
  setPassState('busy', '处理中…');
  try {
    var res = await fetch('/api/pass', { method: 'POST' });
    var j = await res.json();
    if (j.ok) {
      toast('✓ 已通过审核，可以跑发布命令了');
      setPassState('idle', '✓ 已通过');
    } else {
      toast('失败：' + (j.error || ''));
      setPassState('idle', '通过审核');
    }
  } catch (err) {
    toast('请求失败：' + err.message);
    setPassState('idle', '通过审核');
  }
});

/* ---------------------------------------------------------------- 一键发布
 *
 * 「通过审核」只写放行凭证，上传 R2 / 部署 Pages 要另外跑 publish.ps1。
 * 这个按钮把那条链路接上：点一下 → 后台跑完整流程 → 这里实时显示日志。
 *
 * 为什么单独一个按钮，而不是并进「通过审核」：
 *   发布是把内容推到公网，发出去就收不回来（撤回要等 24 小时边缘缓存）。
 *   「看一眼觉得没问题」和「决定公开它」是两件事，不该绑在一个点击上。
 *   所以分成两个按钮，发布那个还要再过一次确认条。
 *
 * 日志拼接用 String.fromCharCode(10) 而不是 '\n' ——
 *   这整段代码在一个 JS 模板字符串里，写 '\n' 会被模板先解析成真的换行，
 *   生成的 JS 里字符串就断成两行（语法错误）。
 */
var publishBtn = document.getElementById('publish');
var plog = document.getElementById('plog');
var plogPre = document.getElementById('plogPre');
var plogState = document.getElementById('plogState');
var plogTimer = null;

function plogShow(lines, state, cls) {
  plog.classList.add('on');
  plogPre.textContent = (lines || []).join(String.fromCharCode(10));
  plogState.textContent = state || '';
  plogState.className = 'st' + (cls ? ' ' + cls : '');
  plogPre.scrollTop = plogPre.scrollHeight;
}

/* 只改状态文字，不动日志内容。
   轮询失败（比如审稿台自己挂了）的时候，日志是**唯一**的线索 ——
   清空它等于把用户仅有的东西也拿走了。 */
function plogStatus(state, cls) {
  plog.classList.add('on');
  plogState.textContent = state || '';
  plogState.className = 'st' + (cls ? ' ' + cls : '');
}

document.getElementById('plogToggle').addEventListener('click', function(){
  if (plogPre.style.display === 'none') { plogPre.style.display = ''; this.textContent = '收起'; }
  else { plogPre.style.display = 'none'; this.textContent = '展开'; }
});
document.getElementById('plogClose').addEventListener('click', function(){
  plog.classList.remove('on');
});

document.getElementById('publish').addEventListener('click', function(){
  if (marked.size) { toast('还有 ' + marked.size + ' 张没处理'); return; }
  askConfirm('确定发布 ' + DATE + ' 吗？会完整重建 → 上传 R2 → 部署到公网，约 3~5 分钟。'
    + '发出去就收不回来了（撤回要等 24 小时边缘缓存）。', function(){ doPublish(); });
});

async function doPublish() {
  publishBtn.disabled = true;
  publishBtn.textContent = '发布中…';
  plogShow(['正在启动发布流程…'], '启动中…');
  try {
    var res = await fetch('/api/publish', { method: 'POST' });
    /* 不要直接 res.json() —— 服务端返回 HTML 或半截 JSON 时，
       V8 报的「Unexpected non-whitespace character after JSON」根本看不出是哪出的问题。
       先拿原文再自己解析，报错时把 HTTP 码和正文前 300 字带出来。 */
    var raw = await res.text();
    var j;
    try { j = JSON.parse(raw); }
    catch (e) { throw new Error('服务端返回的不是 JSON（HTTP ' + res.status + '）：' + raw.slice(0, 300)); }
    if (!j.ok) {
      plogShow(['✗ ' + (j.error || '未知错误')], '启动失败', 'err');
      publishBtn.disabled = false;
      publishBtn.textContent = '通过审核并发布';
      return;
    }
    pollPublish();
  } catch (err) {
    plogShow(['✗ ' + err.message], '启动失败', 'err');
    publishBtn.disabled = false;
    publishBtn.textContent = '通过审核并发布';
  }
}

function pollPublish() {
  if (plogTimer) clearTimeout(plogTimer);
  plogTimer = setTimeout(async function(){
    try {
      var res = await fetch('/api/publish/status', { cache: 'no-store' });
      var raw = await res.text();
      var j;
      try { j = JSON.parse(raw); }
      catch (e) { throw new Error('HTTP ' + res.status + '：' + raw.slice(0, 300)); }
      plogShow(j.lines || [], '发布中…');
      if (j.running) { pollPublish(); return; }
      var ok = (j.exitCode === 0);
      var why = ok ? '✓ 发布完成'
            : (j.exitCode === null || j.exitCode === undefined
                ? '✗ 发布已停止（没有结束标记 —— 发布进程可能被强杀）'
                : '✗ 发布失败（退出码 ' + j.exitCode + '）');
      plogShow(j.lines || [], why, ok ? 'ok' : 'err');
      publishBtn.disabled = false;
      publishBtn.textContent = '通过审核并发布';
      if (ok) toast('✓ 发布完成，线上 https://example.com/');
    } catch (err) {
      /* 别清空日志 —— 轮询失败时日志是唯一的线索。
         2026-11-04 那次就是在这儿被清掉的：页面只剩一句
         「轮询失败：Failed to fetch」，发布到底跑没跑一个字都没留下。 */
      plogStatus('轮询失败：' + err.message + '（发布可能仍在后台跑，看 .review-publish-' + DATE + '.log）', 'err');
      pollPublish();
    }
  }, 1200);
}

/* 刷新页面后如果发布还在跑，要把日志接回来 —— 否则用户以为白点了 */
(async function(){
  try {
    var res = await fetch('/api/publish/status', { cache: 'no-store' });
    var j = await res.json();
    if (!j.lines || !j.lines.length) return;
    if (j.running) { plogShow(j.lines, '发布中…'); pollPublish(); return; }
    plogShow(j.lines, j.exitCode === 0 ? '✓ 发布完成'
             : (j.exitCode === null || j.exitCode === undefined
                 ? '✗ 发布已停止（没有结束标记 —— 发布进程可能被强杀）'
                 : '✗ 发布失败（退出码 ' + j.exitCode + '）'),
             j.exitCode === 0 ? 'ok' : 'err');
  } catch (e) { /* 没发布过是正常的，忽略 */ }
})();

async function load() {
  loadMarks();
  var res = await fetch('/api/list');
  ALL = await res.json();
  /* 删掉/移走的图已经从磁盘上没了，标记里也得剔掉 ——
     不然「已标记 N 张」会虚高，点删除还会对着不存在的文件报错。 */
  var alive = aliveIds();
  var pruned = false;
  if (alive) {
    Array.from(marked).forEach(function(id){
      if (!alive[id]) { forgetMarks([id]); pruned = true; }
    });
    Array.from(unmarked).forEach(function(id){
      if (!alive[id]) { forgetMarks([id]); pruned = true; }
    });
  }
  render();
  if (pruned) saveMarks();
}
setPassState('idle', '通过审核');
load();
</script>
</body>
</html>`;

/* ---------------------------------------------------------------- 一键发布
 *
 * 「通过审核」只写放行凭证，上传 R2 / 部署 Pages 一直是 publish.ps1 的活。
 * 这个端点把那条链路接上：审完点一下，后台跑完整流程，页面实时看日志。
 *
 * 三件事必须做对：
 *
 *   1. 编码 —— Windows 的 PowerShell 默认吐 GBK，Node 按 utf8 解会全是乱码。
 *      所以用 -Command 包一层，先把控制台编码设成 UTF8 再调脚本。
 *
 *   2. 退出码 —— publish.ps1 里 throw 的时候，PowerShell 自己的退出码是 1；
 *      正常跑完时 $LASTEXITCODE 来自最后那条 wrangler 命令。
 *      两种情况都要能区分「发布成功」和「发布失败」。
 *
 *   3. 只允许本机 —— 审稿台只监听 127.0.0.1，但这个端点能直接把内容推到公网，
 *      所以额外挡一道：请求必须来自本机，且不能带 Origin（浏览器跨站 POST）。
 */
const publishState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  pid: null,
  lines: [],
  /* 发布进程被腰斩时写给人看的一句话（只放内存，不写回日志文件） */
  deadNote: null,
};

/**
 * 发布日志落盘的文件。
 *
 * 为什么必须落盘（2026-11-04 踩出来的）：
 *   发布日志原来只存在内存里（publishState.lines）。而「一键发布」是
 *   审稿台 spawn 一个子进程跑 publish.ps1 —— **子进程跟审稿台绑在同一个
 *   控制台**，那个控制台窗口一关（用户关窗口 / 会话结束），
 *   审稿台和发布进程**一起被腰斩**，日志也跟着蒸发。
 *   症状是浏览器只看到「轮询失败：Failed to fetch」，
 *   而真正的原因（发布跑到哪一步、哪一步炸的）一个字都看不到。
 *
 * 落盘之后：审稿台死了，日志文件还在；发布进程用 detached 起，
 *   不再跟父进程同生共死。
 */
const PUBLISH_LOG = path.join(ROOT, `.review-publish-${DATE}.log`);

/** 往发布日志文件追加一行。写不了也不能让发布流程崩掉。 */
function appendPublishLog(line) {
  if (!line) return;
  try {
    fs.appendFileSync(PUBLISH_LOG, line + '\n', 'utf8');
  } catch { /* 落盘失败不影响发布本身 */ }
}

function pushPublishLine(line) {
  if (!line || !line.trim()) return;
  publishState.lines.push(line);
  // 只留最近 500 行 —— 发布日志能到几千行（build 会打印每一张图），
  // 全留着会把内存和返回体积都撑大，而用户只看最后几十行。
  if (publishState.lines.length > 500) {
    publishState.lines.splice(0, publishState.lines.length - 500);
  }
  appendPublishLog(line);
}

/** 从落盘的日志里取最后 N 行 —— 状态接口用它，别只靠内存。 */
function readPublishLogLines(max = 120) {
  try {
    const raw = fs.readFileSync(PUBLISH_LOG, 'utf8');
    const arr = raw.split(/\r?\n/).filter((l) => l.trim());
    return arr.slice(-max);
  } catch {
    return publishState.lines.slice(-max);
  }
}

/**
 * 从日志里找发布进程自己写的结束标记。
 *
 * 标记由**发布进程**写（包装脚本里的 AppendAllText），不是审稿台 ——
 * 审稿台中途死了就没人写标记了，而那正是最需要它的时候。
 *
 * 没找到标记有两种可能：还在跑，或者被强杀（没机会写）。
 * 靠「跑多久了」来兜底判断后者。
 */
function readPublishDone() {
  let mtime = 0;
  try {
    mtime = fs.statSync(PUBLISH_LOG).mtimeMs;
  } catch { /* 日志还没有 */ }
  try {
    const raw = fs.readFileSync(PUBLISH_LOG, 'utf8');
    const m = raw.match(/=== PUBLISH_DONE exit=(-?\d+) ===/);
    if (m) return { done: true, exitCode: Number(m[1]), mtime };
  } catch { /* 日志还没有 */ }
  return { done: false, exitCode: null, mtime };
}

/** 发布跑了多久还没标记 —— 超过这个时长就当它死了。
 *  常量搬到 tools/publish-state.mjs 了（那边是纯函数，能单测；
 *  这个文件里曾经只等着 45 分钟兜底，结果发布被腰斩时界面一直转「发布中…」）。 */

/** 写放行凭证 —— 「通过审核」和「通过审核并发布」共用 */
function writePassFile() {
  const imgs = listSourceImages();
  // 每个分类各多少张也要记 ——
  // 只记总数不够：把 4 张从「见笑」挪到「见她」，总数一样但归属变了，
  // 而审稿结论是针对「当时那批图和它们的归属」的。所以逐个分类也比一遍。
  const counts = {};
  for (const c of CATS) counts[c.key] = 0;
  for (const im of imgs) counts[im.cat]++;
  const pass = {
    date: DATE,
    passedAt: new Date().toISOString(),
    count: imgs.length,
    counts,
    by: 'review.mjs',
  };
  fs.writeFileSync(PASS_FILE, JSON.stringify(pass, null, 2), 'utf8');
  return { count: imgs.length, counts };
}

/**
 * 给发布子进程准备一份「干净」的环境变量。
 *
 * 为什么不能直接继承：
 *   审稿台是长驻进程，它启动时继承来的环境里可能烤着一份**过期的**
 *   Cloudflare token（启动那一刻的 .env.local 还是旧的，之后 token 续期了，
 *   但这个进程的环境不会跟着变）。
 *   publish.ps1 里是「环境变量已存在就不覆盖」，于是那份过期的赢 ——
 *   结果 R2 探测直接 401 code=10000，发布走到一半才炸。
 *
 * 所以这里以 .env.local 的当前内容为准重新铺一遍，
 * 顺便把继承来的同名变量顶掉。
 */
function freshEnv() {
  const env = { ...process.env };
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v) env[m[1]] = v;
    }
  } catch { /* 读不到就沿用继承的环境，不影响发布 */ }
  return env;
}

function startPublish() {
  if (publishState.running) {
    return { ok: false, error: '已经在发布了，等它跑完' };
  }

  // 先写凭证 —— publish.ps1 的审稿闸门会检查它，没有就 exit=1
  let count;
  try {
    count = writePassFile().count;
  } catch (e) {
    return { ok: false, error: '写放行凭证失败：' + e.message };
  }

  const ps1 = path.join(ROOT, 'tools', 'publish.ps1');
  const runner = path.join(ROOT, `.review-publish-${DATE}-runner.ps1`);
  const q = (s) => String(s).replace(/'/g, "''");

  /* 包装脚本：由**发布进程自己**做三件事
   *   1. 把 publish.ps1 的全部输出（含 stderr）写进日志文件
   *   2. 跑完把退出码写进「结束标记」
   *   3. 把退出码原样传出去
   *
   * 结束标记为什么必须由发布进程写、不能由审稿台写：
   *   审稿台要是中途死了（用户关窗口 / 崩溃），它就没机会写标记 ——
   *   而那正是你最需要知道「发布到底成没成」的时候。
   */
  const runnerScript = [
    '$ErrorActionPreference = "Continue"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    /* 必须用 *>&1，不能用 2>&1。
     * 实测：publish.ps1 的阶段标题是 `Write-Host -ForegroundColor`，
     * 而 Write-Host 写的是 host、**不走 stdout** ——
     *   2>&1  只合并 stderr -> Write-Host 全丢（连「=== 6/6 部署 ===」都看不到）
     *   *>&1  合并所有流   -> Write-Host / Write-Output / 原生命令 stdout / stderr 全收
     */
    `& '${q(ps1)}' -Date '${q(DATE)}' *>&1 | Out-File -FilePath '${q(PUBLISH_LOG)}' -Append -Encoding utf8`,
    '$c = $LASTEXITCODE',
    `[System.IO.File]::AppendAllText('${q(PUBLISH_LOG)}', [Environment]::NewLine + '=== PUBLISH_DONE exit=' + $c + ' ===' + [Environment]::NewLine)`,
    'exit $c',
    '',
  ].join('\r\n');
  try {
    fs.writeFileSync(runner, runnerScript, 'utf8');
  } catch (e) {
    return { ok: false, error: '写发布包装脚本失败：' + e.message };
  }

  publishState.running = true;
  publishState.startedAt = Date.now();
  publishState.finishedAt = null;
  publishState.exitCode = null;
  publishState.lines = [];
  publishState.deadNote = null;
  // 先把落盘日志清空，再写第一行 —— 顺序反了会把上一次的日志混进来
  try { fs.writeFileSync(PUBLISH_LOG, '', 'utf8'); } catch { /* 写不了就只在内存里 */ }
  pushPublishLine('=== 开始发布 ' + DATE + '（' + count + ' 张）===');

  let ps;
  try {
    if (process.platform === 'win32') {
      /* 用 `cmd /c start /b` 起发布，而不是直接 spawn powershell。
       *
       * 为什么（2026-11-04 实测出来的）：
       *   直接 spawn 的子进程**继承审稿台的控制台**。Windows 上父进程一死，
       *   控制台连带子进程一起没 —— 那次发布就是这么腰斩的：
       *   跑到 build 中途被杀，线上还停在 11-03，浏览器只剩一句
       *   「轮询失败：Failed to fetch」。
       *
       *   `start /b` 让发布进程有一个**自己的控制台**，
       *   审稿台死了它照跑不误。
       *
       * 三个坑都踩过了，别改回去：
       *   - **不能加 detached**：Windows 上 detached=true 会让 powershell.exe
       *     在 137ms 内「成功」退出（exit 0），一个字都不输出。
       *   - **start 后面必须带 /b**：审稿台自己就没有控制台，
       *     不带 /b 时 start 根本起不来新进程（实测 5 个变体，只有 /b 能跑）。
       *   - **不能带 windowsHide**：带了就退化成「继承控制台」，又会被连坐。
       */
      ps = spawn('cmd.exe', [
        '/c', 'start', '/b', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner,
      ], {
        cwd: ROOT,
        stdio: 'ignore',
        env: freshEnv(),
      });
    } else {
      /* macOS/Linux：没有 Job Object，也没有「控制台连坐」那回事，
       * 所以不用 `cmd /c start /b` 那套绕法 —— 直接 spawn pwsh
       * （PowerShell 7，macOS 上由 Homebrew 提供）就行。
       *
       * 目的跟 Windows 分支完全一样：**审稿台死了发布照跑不误**。
       * 这边靠 detached 达成 —— 它让发布进程脱离父进程的生命周期，
       * 审稿台关掉不影响它。unref 只在这边调（Windows 分支一个字都不动）。 */
      ps = spawn('pwsh', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner,
      ], {
        cwd: ROOT,
        stdio: 'ignore',
        env: freshEnv(),
        detached: true,
      });
      ps.unref();
    }
  } catch (e) {
    publishState.running = false;
    publishState.exitCode = -1;
    publishState.finishedAt = Date.now();
    pushPublishLine('启动失败：' + e.message);
    return { ok: false, error: e.message };
  }

  publishState.pid = ps.pid;

  ps.on('error', (err) => {
    publishState.running = false;
    publishState.exitCode = -1;
    publishState.finishedAt = Date.now();
    pushPublishLine('进程错误：' + err.message);
  });

  /* cmd /c start 是**立刻**返回的（它只是把发布进程甩出去），
     所以 close 事件不代表发布结束 —— 结束要看日志里的 PUBLISH_DONE 标记。
     这里只处理「发布进程压根没起来」的情况：
     判据是「日志里除抬头以外一行发布输出都没有」。
     （早先这里只等 3 秒就判失败，结果把正在正常跑的发布误报成 exit=-1。） */
  ps.on('close', () => {
    setTimeout(() => {
      if (readPublishDone().done) return;
      const lines = readPublishLogLines(2000);
      // 抬头那行 + publish.ps1 的第一行输出（token 刷新之类）都算「起来了」
      if (lines.length > 2) return;
      publishState.running = false;
      publishState.exitCode = -1;
      publishState.finishedAt = Date.now();
      pushPublishLine('发布进程启动后就没了（cmd 起不来，日志里也没有发布输出）');
    }, 8000);
  });

  return { ok: true, pid: ps.pid, count };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  try {
    /* --- API --- */
    if (p === '/api/list') {
      return sendJson(res, 200, listSourceImages());
    }

    /* 一键发布：只接本机，且不接受浏览器跨站 POST */
    if (p === '/api/publish' && req.method === 'POST') {
      const remote = req.socket.remoteAddress || '';
      if (!/^(::1|::ffff:127\.|127\.)/.test(remote)) {
        return sendJson(res, 403, { ok: false, error: '只允许本机触发发布' });
      }
      // Node 的 req.headers 是普通对象，没有 Headers.prototype.get() ——
      // 用 .get() 会抛 TypeError，整个请求变成 500，前端 res.json() 解析不了，
      // 页面上只显示「Unexpected non-whitespace character after JSON」。
      const origin = req.headers['origin'];
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch { host = ''; }
        if (host !== 'localhost:8789' && host !== '127.0.0.1:8789') {
          return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' });
        }
      }
      const r = startPublish();
      return sendJson(res, r.ok ? 200 : 409, r);
    }

    if (p === '/api/publish/status') {
      /* 状态以「发布进程自己写的结束标记」为准：
       *   有标记 -> 跑完了，退出码从标记里读
       *   没标记 -> 还在跑（或者被强杀了 —— 用「日志多久没动」兜底）
       * 这样即使审稿台中途重启过，状态也不会说谎。
       *
       * 2026-11-15 加的「日志多久没动」这一条：
       *   原来只有 45 分钟兜底，发布被腰斩时界面会一直转「发布中…」，
       *   用户看着像「审核了但没发布」。日志超过 6 分钟没动 = 进程已经没了，
       *   立刻报失败。 */
      const done = readPublishDone();
      const st = computePublishState({
        done: done.done,
        doneExitCode: done.exitCode,
        mtime: done.mtime,
        startedAt: publishState.startedAt,
        running: publishState.running,
      });
      if (st.dead && !publishState.deadNote) {
        publishState.deadNote = describeDeadState(st);
        publishState.running = false;
        publishState.exitCode = st.exitCode;
        publishState.finishedAt = Date.now();
        /* 只记在内存里，**不要**写回日志文件 ——
           写回去会刷新日志的 mtime，「多久没动」就永远归零。 */
        publishState.lines.push(publishState.deadNote);
      }
      const lines = readPublishLogLines(120);
      if (publishState.deadNote && !lines.includes(publishState.deadNote)) {
        lines.push(publishState.deadNote);
      }
      return sendJson(res, 200, {
        running: st.running,
        startedAt: publishState.startedAt,
        finishedAt: done.done ? (publishState.finishedAt || Date.now()) : publishState.finishedAt,
        exitCode: done.done ? done.exitCode : (st.dead ? st.exitCode : publishState.exitCode),
        pid: publishState.pid,
        // 从落盘的日志读，不只靠内存 —— 审稿台重启过也还能看到上次的发布过程
        lines,
      });
    }

    if (p === '/api/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      let deleted = 0;
      const failed = [];
      for (const it of items) {
        const r = applyDelete(it.cat, it.name);
        if (r.ok && r.removed) deleted++;
        else if (!r.ok) failed.push(it.name + ': ' + r.error);
      }
      // 放行凭证要作废 —— 图变了，之前那轮审稿结论就不算了
      try { fs.unlinkSync(PASS_FILE); } catch { /* 本来就没有 */ }
      return sendJson(res, 200, { ok: failed.length === 0, deleted, error: failed.join('; ') });
    }

    if (p === '/api/move' && req.method === 'POST') {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      const to = body.to;
      let moved = 0;
      const failed = [];
      for (const it of items) {
        const r = applyMove(it.cat, it.name, to);
        if (r.ok) {
          if (!r.skipped) moved += 1;
        } else {
          failed.push(it.name + '：' + (r.error || '未知错误'));
        }
      }
      // 放行凭证要作废 —— 分类变了，之前那轮审稿结论就不算了
      try { fs.unlinkSync(PASS_FILE); } catch { /* 本来就没有 */ }
      return sendJson(res, 200, { ok: failed.length === 0, moved, error: failed.join('; ') });
    }

    if (p === '/api/pass' && req.method === 'POST') {
      const { count, counts } = writePassFile();
      return sendJson(res, 200, { ok: true, file: PASS_FILE, count, counts });
    }

    /* --- 缩略图 ---
     *
     * 直接给源图，让浏览器自己缩放。
     *
     * 为什么不用 r2 母本里的 webp：
     *   母本文件名是 <nonce>_<序号>.webp，序号是「构建时的位置」，
     *   而审稿时可能还没构建（或者构建过了但删过图，位置已经变了），
     *   按序号反查对不上，404 一片。
     *   源图是唯一真源，文件名稳定，浏览器缩放也不费什么事。
     */
    if (p.startsWith('/thumb/') || p.startsWith('/orig/')) {
      const isThumb = p.startsWith('/thumb/');
      const rel = p.slice((isThumb ? '/thumb/' : '/orig/').length);
      const parts = rel.split('/');
      const catKey = parts[0];
      const name = parts.slice(1).join('/');
      const cat = CATS.find((c) => c.key === catKey);
      if (!cat) { res.writeHead(404).end('404'); return; }
      const file = path.join(SRC_DIR, cat.dir, name);
      if (!fs.existsSync(file)) { res.writeHead(404).end('404'); return; }
      const st = await fsp.stat(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    /* --- 页面 --- */
    if (p === '/' || p === '/index.html') {
      const html = PAGE.replaceAll('__DATE__', DATE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    res.writeHead(404).end('404');
  } catch (err) {
    console.error('处理出错:', err);
    if (!res.headersSent) res.writeHead(500).end('500 ' + err.message);
    else res.destroy();
  }
});

if (APPLY) {
  console.error('--apply 模式已废弃：勾选删除直接在审稿台页面里点「应用勾选」即可。');
  process.exit(1);
}

/* 端口自适应：8789 被占用就往下找，最多试 10 个。
 *
 * 为什么不能直接报错退出：审稿台天天在关键路径上，
 * 上一次忘了关、或者端口被别的服务占了，
 * 不该把当天的发版流程整个卡死 —— 换个端口继续审才是对的。
 */
let chosenPort = PORT;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && chosenPort < PORT + 9) {
    const prev = chosenPort;
    chosenPort += 1;
    console.log('  端口 ' + prev + ' 被占用，改用 ' + chosenPort);
    server.listen(chosenPort);
    return;
  }
  console.error('审稿台启动失败：' + err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  const imgs = listSourceImages();
  const passed = fs.existsSync(PASS_FILE);
  const url = 'http://localhost:' + chosenPort + '/';
  /* 把实际端口写下来 —— 一键脚本据此打开浏览器，不用猜 */
  try {
    fs.writeFileSync(PORT_FILE, String(chosenPort), 'utf8');
  } catch { /* 写不了不影响用 */ }
  console.log('');
  console.log('  审稿台 : ' + url);
  console.log('  日期   : ' + DATE);
  console.log('  图片   : ' + imgs.length + ' 张');
  console.log('  放行   : ' + (passed ? '已通过审核' : '未通过（publish 会被拦下）'));
  console.log('');
  console.log('  审完点「通过审核」，然后跑：');
  // 提示语要跟平台对上：macOS 上没有 powershell.exe，
  // 路径也用正斜杠（反斜杠在 Unix 上不是分隔符）。
  const publishHint = process.platform === 'win32'
    ? '    powershell -ExecutionPolicy Bypass -File tools/publish.ps1 -Date ' + DATE
    : '    pwsh -NoProfile -File tools/publish.ps1 -Date ' + DATE;
  console.log(publishHint);
  console.log('');

  if (OPEN) {
    /* Windows 用 start，macOS/Linux 用 open/xdg-open */
    const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      console.log('  （自动打开浏览器失败，手动打开 ' + url + '）');
    }
  }
});
