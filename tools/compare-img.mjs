#!/usr/bin/env node
/**
 * 对比两个域名下全部图片的可达性，找出差异
 *
 * 注意：图片 URL 现在带不可猜的随机段（文件名形如 <nonce>_001.webp），
 * 所以不能再靠「按规律猜路径」来列举 —— 必须从 manifest 里取真实清单。
 * 这也顺带证明了一件事：路径已经无法被枚举了。
 *
 * 用法：node tools/compare-img.mjs <域名A> <域名B> [日期]
 */
const A = process.argv[2] || 'https://your-project.pages.dev';
const B = process.argv[3] || 'https://example.com';
const DATE = process.argv[4] || '2026-10-25';
const CONCURRENCY = 12;

async function head(url) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1' } });
    return { status: res.status, ct: res.headers.get('content-type') };
  } catch (e) {
    return { status: 0, ct: 'ERR:' + e.message };
  }
}

/* 从域名 A 的日期页里取出真实的图片路径清单 */
async function fetchManifestPaths(base) {
  const html = await (await fetch(`${base}/${DATE}/`)).text();
  const m = html.match(/<script src="(manifest\.[^"]+\.js)"/);
  if (!m) throw new Error(`${base}/${DATE}/ 里找不到 manifest 引用`);
  const js = await (await fetch(`${base}/${DATE}/${m[1]}`)).text();
  const paths = [...new Set([...js.matchAll(/\/img\/[^"]+\.webp/g)].map((x) => x[0]))];
  return paths;
}

async function run(base, label, paths) {
  const urls = paths.map((p) => base + p);
  let idx = 0;
  const out = new Map();
  const worker = async () => {
    while (idx < urls.length) {
      const u = urls[idx++];
      const r = await head(u);
      // 以 path 为 key，才能跨域名对比
      out.set(new URL(u).pathname, r);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\n=== ${label} (${base}) ===`);
  const stats = {};
  for (const [, r] of out) {
    const key = `${r.status} ${r.ct}`;
    stats[key] = (stats[key] || 0) + 1;
  }
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}  x${v}`);
  return out;
}

console.log(`读取 ${A} 的图片清单 …`);
const paths = await fetchManifestPaths(A);
console.log(`清单共 ${paths.length} 个文件`);

// 2xx 都算正常：请求带 Range 头时（微信 X5、部分代理/CDN 都会发）
// 服务端会返回 206 Partial Content，那也是成功的响应。
// 只认 200 会把 206 全列成「差异」，是假阳性。
const ok = (r) => r && r.status >= 200 && r.status < 300;

const ra = await run(A, 'A', paths);
const rb = await run(B, 'B', paths);

console.log('\n=== 差异（A 正常但 B 异常） ===');
let diff = 0;
for (const [u, a] of ra) {
  const b = rb.get(u);
  if (ok(a) && !ok(b)) {
    diff++;
    if (diff <= 15) console.log(`  ${u.replace(A, 'A')}\n     A=${a.status} ${a.ct}   B=${b.status} ${b.ct}`);
  }
}
console.log(`  合计差异：${diff}`);

console.log('\n=== 差异（B 正常但 A 异常） ===');
let diff2 = 0;
for (const [u, a] of ra) {
  const b = rb.get(u);
  if (!ok(a) && ok(b)) {
    diff2++;
    if (diff2 <= 15) console.log(`  ${u.replace(A, 'A')}\n     A=${a.status} ${a.ct}   B=${b.status} ${b.ct}`);
  }
}
console.log(`  合计差异：${diff2}`);

// 顺手验证「路径不可枚举」这条性质还在。
// 分两层看：
//   - 强制回源（加 cache-buster）-> 源站真实的判定，应该是 404
//   - 不加 cache-buster        -> 可能命中边缘缓存里旧的副本（24 小时内自然消失）
console.log('\n=== 枚举检查（按规律猜路径）===');
const guessNoCb = await head(`${B}/img/${DATE}/jianshe/001.webp`);
console.log(`  边缘缓存命中   : ${guessNoCb.status}${guessNoCb.status >= 200 && guessNoCb.status < 300 ? '  （旧副本还在缓存里，会随 24h TTL 自然过期）' : ''}`);
const guessCb = await head(`${B}/img/${DATE}/jianshe/001.webp?cb=${Date.now()}`);
console.log(`  强制回源       : ${guessCb.status}  ${guessCb.status === 404 ? '✓ 源站已拒绝，路径不可枚举' : '✗ 源站仍然放行'}`);

process.exit(diff + diff2 === 0 && guessCb.status === 404 ? 0 : 1);
