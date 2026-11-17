#!/usr/bin/env node
/**
 * 探针：抓完整响应头 + body，用来定位图片为什么加载不出来
 *
 * 用法：node tools/probe.mjs <url> [重复次数]
 */
const url = process.argv[2];
const times = Number(process.argv[3] || 1);

if (!url) {
  console.error('用法：node tools/probe.mjs <url> [次数]');
  process.exit(1);
}

for (let i = 0; i < times; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) MicroMessenger/8.0.32' } });
    const buf = Buffer.from(await res.arrayBuffer());
    const h = {};
    for (const [k, v] of res.headers) h[k] = v;
    console.log(
      `#${i + 1} ${res.status} ${res.statusText}  ${buf.length} bytes  ${Date.now() - t0}ms\n` +
        `    content-type: ${h['content-type']}\n` +
        `    content-length: ${h['content-length']}\n` +
        `    cache-control: ${h['cache-control']}\n` +
        `    cdn-cache-control: ${h['cdn-cache-control']}\n` +
        `    cloudflare-cdn-cache-control: ${h['cloudflare-cdn-cache-control']}\n` +
        `    content-range: ${h['content-range'] ?? '(无)'}\n` +
        `    accept-ranges: ${h['accept-ranges'] ?? '(无)'}\n` +
        `    etag: ${h['etag'] ?? '(无)'}\n` +
        `    cf-cache-status: ${h['cf-cache-status'] ?? '(无)'}\n` +
        `    age: ${h['age'] ?? '(无)'}`,
    );
  } catch (e) {
    console.log(`#${i + 1} 失败: ${e.message}`);
  }
}
