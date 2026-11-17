#!/usr/bin/env node
/**
 * 最终验证：线上所有日期的图片逐张下载比对。
 *
 * 日期不再写死 —— 扫 published/ 下所有 YYYY-MM-DD 目录，
 * 以后加了新的一期不用回来改这个脚本（漏改就会「以为验过了其实没验」）。
 *
 * 为什么必须有重试：
 *   没有重试的话，一次 TLS 握手被重置（ECONNRESET）就让整轮验证归零 ——
 *   跑了几分钟的结果全丢，还得从头再来一遍。
 *   网络抖动是常态，Cloudflare 偶发 5xx 也是。
 *   退避重试几次，比直接崩掉划算得多。
 *
 * 为什么并发：
 *   1364 个文件串行下载要好几分钟。并发 6 路，验证从「泡着等」变成「一两分钟」，
 *   而且失败时能更快定位到是哪一张。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 工程根和图像根都走 paths.mjs（唯一真源）—— 写死 Windows 路径的话，
// 拷到 macOS 上会直接读到一个不存在的目录，什么都验不出来。
import { ROOT, R2_LOCAL } from './paths.mjs';

const BASE = 'https://example.com';
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36';
const CONCURRENCY = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带退避重试的 fetch：网络异常和 5xx 都重试，其他状态码照常返回给调用方判断。 */
async function fetchRetry(url, opts = {}, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500 && i < tries - 1) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(400 * (i + 1));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i === tries - 1) break;
      await sleep(600 * (i + 1));
    }
  }
  throw lastErr;
}

let totalChecked = 0;
let totalBad = 0;
let problemHits = [];

/* 要验的日期 = published/ 下所有日期目录（按日期升序）
 * 也可以用 --date <YYYY-MM-DD> 只验某一天。 */
const onlyDate = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const DATES = fs.readdirSync(path.join(ROOT, 'published'))
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  .filter((d) => fs.existsSync(path.join(ROOT, 'published', d, 'index.html')))
  .filter((d) => !onlyDate || d === onlyDate)
  .sort();

if (!DATES.length) {
  console.error('published/ 下没有日期目录，没东西可验');
  process.exit(1);
}

for (const date of DATES) {
  const pub = path.join(ROOT, 'published', date);
  const mf = fs.readdirSync(pub).find((f) => /^manifest\..*\.js$/.test(f));
  const raw = fs.readFileSync(path.join(pub, mf), 'utf8');
  const man = JSON.parse(raw.match(/window\.__DAILY_MANIFEST__=(\{.*\});?\s*$/s)[1]);

  // 线上 manifest hash 是否与本地一致
  const page = await fetchRetry(`${BASE}/${date}/`, { headers: { 'User-Agent': UA } });
  const html = await page.text();
  const onlineHash = (html.match(/manifest\.([a-z0-9]+)\.js/) || [])[1];
  const localHash = mf.replace(/^manifest\.|\.js$/g, '');

  /* 把要验的条目先摊平成一张清单，再并发跑 ——
   * 串行 1364 次 fetch 太慢，而且出错时不好定位。 */
  const jobs = [];
  for (const tab of man.tabs) {
    if (tab.type === 'headlines') continue;
    for (const it of tab.items) {
      /* 全尺寸和缩略图都验 —— 缩略图才是首屏真正加载的那一批，
       * 只验全尺寸的话，缩略图挂了在页面上看起来就是一片白。 */
      for (const kind of ['full', 'thumb']) {
        const url = it[kind];
        jobs.push({
          url,
          localPath: path.join(R2_LOCAL, date, tab.key, path.posix.basename(url)),
        });
      }
    }
  }

  let checked = 0, bad = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        const res = await fetchRetry(BASE + job.url, {
          headers: { 'User-Agent': UA, Referer: `${BASE}/${date}/` },
        });
        if (!res.ok) {
          bad++;
          problemHits.push(`${date} ${res.status} ${job.url}`);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (!fs.existsSync(job.localPath)) {
          bad++;
          problemHits.push(`${date} 缺本地母本 ${job.url}`);
          continue;
        }
        if (md5(fs.readFileSync(job.localPath)) !== md5(buf)) {
          bad++;
          problemHits.push(`${date} 内容不一致 ${job.url}`);
          continue;
        }
        checked++;
      } catch (e) {
        bad++;
        problemHits.push(`${date} 请求失败 ${e.message} ${job.url}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker())
  );

  totalChecked += checked;
  totalBad += bad;
  console.log(
    `${date}  manifest 本地=${localHash} 线上=${onlineHash} ` +
    `${onlineHash === localHash ? 'OK' : '不同步!'}  文件 ${checked} 个，不一致 ${bad} 个`
  );
}

console.log(`\n合计核对 ${totalChecked} 张图片，不一致 ${totalBad} 张`);
if (problemHits.length) {
  console.log('\n问题明细：');
  for (const p of problemHits.slice(0, 20)) console.log('  ' + p);
}
process.exit(totalBad ? 1 : 0);
