/**
 * 跨任务契约测试 —— 白名单三处复制会不会漂移。
 *
 * 背景：跟图评论的命名规则在**三个地方**各写了一遍：
 *   functions/likes/api.js   ID_RE / DATE_RE
 *   functions/board/api.js   IMG_DATE_RE / IMG_ID_RE / IMG_THUMB_RE
 *   site/board.html          IMG_DATE_RE / IMG_ID_RE / IMG_THUMB_RE（前端再挡一次）
 *
 * 三处现在是逐字相同的，但「逐字相同」是**当前**的事实，不是**以后**的事实。
 * 改了一处忘了另一处，症状是「前端能渲染、留言板返回 400」或者更糟
 * （前端放行了一个后端不放行的 URL）。
 *
 * 这条测试把三处**从文件里抠出来**互相比对，
 * 再拿**真实构建产物的 manifest** 去撞一遍 —— 改坏了会直接红。
 *
 * 为什么不用「手抄一遍正则来比对」：那样核对的是抄得对不对，不是产品对不对。
 * 所以这里是从生产代码里正则抠出来的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'published');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/** 从源文件里抠出 `const NAME = /.../flags;` —— 抠不到就报错，不许手抄 */
function grabRegex(file, name) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*/(.*)/([a-z]*)\\s*;');
  const m = src.match(re);
  if (!m) throw new Error('抠不到 ' + name + '（' + file + '）');
  return new RegExp(m[1], m[2]);
}

/** 从 board.html 里抠出 `var NAME = /.../flags;` */
function grabHtmlRegex(file, name) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = src.match(new RegExp('var\\s+' + name + '\\s*=\\s*/(.*)/([a-z]*)\\s*;'));
  if (!m) throw new Error('抠不到 ' + name + '（' + file + '）');
  return new RegExp(m[1], m[2]);
}

console.log('── 三处白名单必须逐字相同 ──');
const likeId = grabRegex('functions/likes/api.js', 'ID_RE');
const likeDate = grabRegex('functions/likes/api.js', 'DATE_RE');
const boardDate = grabRegex('functions/board/api.js', 'IMG_DATE_RE');
const boardId = grabRegex('functions/board/api.js', 'IMG_ID_RE');
const boardThumb = grabRegex('functions/board/api.js', 'IMG_THUMB_RE');
const boardParts = grabRegex('functions/board/api.js', 'IMG_THUMB_PARTS_RE');
const feDate = grabHtmlRegex('site/board.html', 'IMG_DATE_RE');
const feId = grabHtmlRegex('site/board.html', 'IMG_ID_RE');
const feThumb = grabHtmlRegex('site/board.html', 'IMG_THUMB_RE');

check('likes 的 ID_RE 与 board 的 IMG_ID_RE 相同', String(likeId) === String(boardId), { like: String(likeId), board: String(boardId) });
check('likes 的 DATE_RE 与 board 的 IMG_DATE_RE 相同', String(likeDate) === String(boardDate), { like: String(likeDate), board: String(boardDate) });
check('前端 board.html 的 IMG_DATE_RE 与后端相同', String(feDate) === String(boardDate), { fe: String(feDate), be: String(boardDate) });
check('前端 board.html 的 IMG_ID_RE 与后端相同', String(feId) === String(boardId), { fe: String(feId), be: String(boardId) });
check('前端 board.html 的 IMG_THUMB_RE 与后端相同', String(feThumb) === String(boardThumb), { fe: String(feThumb), be: String(boardThumb) });

/* 交叉校验用的那条正则（带捕获组）必须跟白名单那条描述**同一种字符串**。
   两边漂移的后果不是「测试变红」而是「功能变歪」：白名单拒了但交叉校验收了，
   或者白名单收了但交叉校验拒了 —— 后者会让合法投稿莫名其妙 400。
   这里用「去掉捕获组后 source 逐字相同」来判定：两条正则只差括号，
   去掉括号还一样，就说明它们接受的语言完全一样。
   （这条是为了堵一个真实的盲区：早先交叉校验的正则是在测试里手抄的，
     改生产端不会让任何一条测试变红。） */
{
  /* 剥掉捕获组：先保护转义括号（\( \)），再把成对的括号去掉只留内容。 */
  const strip = (s) => s.replace(/\\([()])/g, '\x00$1\x00').replace(/\(([^()]*)\)/g, '$1').replace(/\x00/g, '');
  check(
    '交叉校验正则与白名单正则描述同一种字符串（去掉捕获组后逐字相同）',
    strip(boardParts.source) === strip(boardThumb.source),
    { parts: boardParts.source, thumb: boardThumb.source },
  );
  /* 再加一条：捕获组必须正好三段，且抠出来的 id 要命中 IMG_ID_RE */
  const sample = '/img/2026-11-03/jianxiao/0b9873f370_001_t.webp';
  const m = sample.match(boardParts);
  check('交叉校验正则能抠出日期 / 栏目 / 序号三段', !!m && m.length === 4, m);
  check('抠出来的栏目_序号命中 IMG_ID_RE', !!m && boardId.test(m[2] + '_' + m[3]), m && m[2] + '_' + m[3]);
}

console.log('\n── 真实构建产物 vs 生产正则 ──');
if (!fs.existsSync(PUB)) {
  console.log('  （没有 published/ 目录，跳过 —— 跑一次 node tools/build.mjs 就能查）');
} else {
  const dates = fs.readdirSync(PUB).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  let nId = 0;
  let nThumb = 0;
  let nText = 0;
  let badId = 0;
  let badThumb = 0;
  let badDate = 0;
  let mismatched = 0;
  let maxSeq = 0;
  const samples = [];

  for (const d of dates) {
    const dir = path.join(PUB, d);
    const mf = fs.readdirSync(dir).find((f) => /^manifest\..*\.js$/.test(f));
    if (!mf) continue;
    const raw = fs.readFileSync(path.join(dir, mf), 'utf8');
    const man = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));

    if (!likeDate.test(man.date)) { badDate++; samples.push('BAD DATE ' + d); }

    for (const tab of man.tabs || []) {
      for (const it of tab.items || []) {
        /* 见报栏目是纯文字条目，本来就没有图、也没有 id —— 不参与核对 */
        if (!it.thumb && !it.full) { nText++; continue; }
        nId++;
        if (!likeId.test(it.id)) { badId++; if (samples.length < 8) samples.push('BAD ID ' + d + ' ' + it.id); }
        const seq = parseInt(String(it.id).split('_')[1] || '0', 10);
        if (seq > maxSeq) maxSeq = seq;
        if (!it.thumb) continue;
        nThumb++;
        if (!boardThumb.test(it.thumb)) { badThumb++; if (samples.length < 8) samples.push('BAD THUMB ' + d + ' ' + it.thumb); continue; }
        /* 缩略图里嵌的日期 / 栏目 / 序号必须跟 manifest 的 date / id 自洽 ——
           这正是留言板现在会做的交叉校验，两边必须一致。
           用的是从生产代码里抠出来的那条正则，不是手抄的副本 ——
           手抄的副本自己漂移了也没人知道。 */
        const tm = it.thumb.match(boardParts);
        if (!tm || tm[1] !== man.date || tm[2] + '_' + tm[3] !== it.id) {
          mismatched++;
          if (samples.length < 8) samples.push('MISMATCH ' + d + ' ' + it.id + ' vs ' + it.thumb);
        }
      }
    }
  }

  console.log('  期数 ' + dates.length + '，图片 ' + nId + '，缩略图 ' + nThumb + '，文字条目 ' + nText);
  check('所有图片 id 命中 ID_RE', badId === 0, samples.filter((s) => s.indexOf('BAD ID') === 0));
  check('所有缩略图命中 IMG_THUMB_RE', badThumb === 0, samples.filter((s) => s.indexOf('BAD THUMB') === 0));
  check('所有日期命中 DATE_RE', badDate === 0, samples.filter((s) => s.indexOf('BAD DATE') === 0));
  check('缩略图与 date / id 全部自洽', mismatched === 0, samples.filter((s) => s.indexOf('MISMATCH') === 0));
  check('最大序号仍是 3 位（ID_RE 要求恰好 3 位）', maxSeq < 1000, maxSeq);
}

console.log('\n── r2-prune 不能把非图片数据当垃圾删掉 ──');
{
  /* r2-prune.mjs 删的是「不符合 PRODUCT_RE 的对象」。
     留言板（board/）和点赞（likes/）都不是图片产物，
     但它们也不符合 PRODUCT_RE —— 所以必须显式列进排除名单，
     否则跑一次 prune 就把数据全删了。

     2026-11-04 加点赞功能时就是这个坑：likes/ 是新前缀，忘了加，
     跑一次 `node tools/r2-prune.mjs` 就会把全部点赞计数删光。
     这条断言就是防它再犯。 */
  const pruneSrc = fs.readFileSync(path.join(ROOT, 'tools/r2-prune.mjs'), 'utf8');
  const m = pruneSrc.match(/const\s+NON_IMAGE_PREFIXES\s*=\s*\[([^\]]*)\]/);
  check('r2-prune.mjs 里有 NON_IMAGE_PREFIXES 名单', !!m);
  const excluded = m
    ? (m[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, ''))
    : [];

  /* 从 Functions 里把实际用到的 R2 key 抠出来 */
  const usedKeys = [];
  for (const f of ['functions/likes/api.js', 'functions/board/api.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    /* const XXX_KEY = 'board/messages.json' */
    for (const km of src.matchAll(/const\s+\w*KEY\w*\s*=\s*'([^']+)'/g)) {
      usedKeys.push({ file: f, key: km[1] });
    }
    /* likesKey(date) { return 'likes/' + date + '.json'; } */
    for (const lm of src.matchAll(/return\s+'([a-z][a-z0-9-]*\/)'\s*\+/g)) {
      usedKeys.push({ file: f, key: lm[1] + '<动态>' });
    }
  }
  check('从 Functions 里抠到了 R2 key', usedKeys.length > 0, usedKeys);

  const prefixes = Array.from(new Set(usedKeys.map((u) => u.key.split('/')[0] + '/')));
  for (const p of prefixes) {
    check(
      `R2 前缀 ${p} 在 r2-prune 的排除名单里（否则会被当垃圾删掉）`,
      excluded.indexOf(p) >= 0,
      { excluded, prefixes },
    );
  }
  console.log('  · Functions 用到的 R2 key：' + usedKeys.map((u) => u.key).join('、'));
  console.log('  · prune 排除名单：' + excluded.join('、'));
}

console.log('\n── 栏目中文名：board.html 的 TAB_LABELS 必须覆盖 build.mjs 的每一个栏目 ──');
{
  /* 留言板要跟用户说「见笑」，不是内部 id「jianxiao_012」。
     中文名写在 site/board.html 的 TAB_LABELS 里，栏目的权威定义在 tools/build.mjs。
     两边漏一个（build.mjs 加了栏目、board.html 没加）的话，
     留言板上就会显示一串没人看得懂的 jianxiao_012 —— 而且没有任何报错。
     所以这里从 build.mjs 抠出全部栏目，逐个查 TAB_LABELS 里有、且中文名一模一样。 */
  const buildSrc = fs.readFileSync(path.join(ROOT, 'tools/build.mjs'), 'utf8');
  const pairs = [];
  for (const m of buildSrc.matchAll(/key:\s*'([a-z]+)'[\s\S]{0,60}?label:\s*'([^']+)'/g)) {
    pairs.push({ key: m[1], label: m[2] });
  }
  check('从 build.mjs 抠到了栏目定义', pairs.length >= 4, pairs.map((p) => p.key));

  const htmlSrc = fs.readFileSync(path.join(ROOT, 'site/board.html'), 'utf8');
  const tm = htmlSrc.match(/var\s+TAB_LABELS\s*=\s*\{([^}]*)\}/);
  check('从 board.html 抠到了 TAB_LABELS', !!tm);
  const labels = {};
  if (tm) {
    for (const m of tm[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']*)'/g)) labels[m[1]] = m[2];
  }
  for (const p of pairs) {
    check(
      `栏目 ${p.key} 在 TAB_LABELS 里，中文名是「${p.label}」`,
      labels[p.key] === p.label,
      { TAB_LABELS里是: labels[p.key], 应该是: p.label },
    );
  }
}

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail) process.exit(1);