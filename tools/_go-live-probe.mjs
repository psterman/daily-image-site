/**
 * 一次性上线验收：DailyHot 白名单 + probeOnly 质量打分。
 *   node tools/_go-live-probe.mjs
 */
import { loadDailyhotConfig, fetchOneDailyhot } from './fetch-dailyhot.mjs';

const cfg = loadDailyhotConfig();
const expectDomain = {
  ngabbs: [/nga\.(cn|com)/i],
  '52pojie': [/52pojie\.cn/i],
  nodeseek: [/nodeseek\.com/i],
  miyoushe: [/miyoushe\.com|bbs\.mihoyo\.com|hoyolab/i],
  acfun: [/acfun\.cn/i],
  'douban-group': [/douban\.com/i],
  kuaishou: [/kuaishou\.com|chenzhongtech\.com/i],
  csdn: [/csdn\.net/i],
  jianshu: [/jianshu\.com/i],
  hostloc: [/hostloc\.com/i],
  coolapk: [/coolapk\.com/i],
};

function scoreSource(id, r) {
  const issues = [];
  const items = r.items || [];
  if (!r.ok) {
    return { verdict: 'NO', reason: r.error || 'fail', n: 0, heatN: 0, domRatio: 0, uniq: 0, issues: [r.error || 'fail'], samples: [] };
  }

  const rows = items.map((x) => ({
    title: String(x.title || x.name || '').trim(),
    link: String(x.url || x.link || x.mobileUrl || '').trim(),
    hot: x.hot,
  })).filter((x) => x.title && x.link);

  if (rows.length < 5) issues.push(`条数过少(${rows.length})`);
  const ratio = rows.length / Math.max(items.length, 1);
  if (ratio < 0.8) issues.push(`title/link 完整率 ${Math.round(ratio * 100)}%`);

  const domains = expectDomain[id] || [];
  let domainHit = 0;
  for (const x of rows.slice(0, 20)) {
    try {
      const h = new URL(x.link).hostname;
      if (!domains.length || domains.some((re) => re.test(h))) domainHit++;
    } catch {
      issues.push('坏链接');
    }
  }
  const sampleN = Math.max(Math.min(rows.length, 20), 1);
  const domRatio = Math.round((domainHit / sampleN) * 100);
  if (domains.length && domRatio < 70) issues.push(`域名命中率 ${domRatio}%`);

  const titles = rows.map((x) => x.title);
  const uniq = new Set(titles.slice(0, 20).map((t) => t.slice(0, 40))).size;
  if (titles.length >= 8 && uniq / Math.min(titles.length, 20) < 0.5) issues.push('标题重复率高');

  const spamRe = /喝茶|麻将|兼职|加微信|到账|包过|刷单|色情|约炮|赌场/;
  const spamN = titles.filter((t) => spamRe.test(t)).length;
  if (spamN >= 2 || (titles.length && spamN / titles.length >= 0.3)) {
    issues.push(`营销/垃圾标题 ${spamN}/${titles.length}`);
  }

  const heatN = rows.filter((x) => x.hot != null && x.hot !== '' && Number(x.hot) > 0).length;

  let verdict = 'GO';
  if (rows.length < 5) verdict = 'NO';
  else if (issues.some((i) => i.startsWith('营销') || i.startsWith('域名'))) verdict = 'HOLD';
  else if (issues.length) verdict = 'HOLD';

  return {
    verdict,
    n: rows.length,
    heatN,
    domRatio,
    uniq,
    issues,
    samples: rows.slice(0, 3).map((x) => ({ t: x.title.slice(0, 48), u: x.link })),
  };
}

const all = [
  ...(cfg.sources || []).map((s) => ({ ...s, liveCfg: true })),
  ...(cfg.probeOnly || []).map((s) => ({ ...s, liveCfg: false })),
];

const rows = [];
for (const s of all) {
  const r = await fetchOneDailyhot(cfg.baseUrl, s.id, { timeoutMs: cfg.timeoutMs });
  const sc = scoreSource(s.id, r);
  rows.push({ id: s.id, name: s.name, liveCfg: s.liveCfg, status: r.status, ...sc });
}

const go = rows.filter((x) => x.verdict === 'GO');
const hold = rows.filter((x) => x.verdict === 'HOLD');
const no = rows.filter((x) => x.verdict === 'NO');

console.log(`baseUrl: ${cfg.baseUrl}`);
console.log(`GO ${go.length} · HOLD ${hold.length} · NO ${no.length}\n`);
for (const x of rows) {
  const flag = x.verdict.padEnd(4);
  const cfg = x.liveCfg ? 'live' : 'probe';
  const issue = x.issues.length ? ` | ${x.issues.join('; ')}` : '';
  console.log(`${flag} ${cfg.padEnd(5)} ${x.id.padEnd(14)} n=${String(x.n).padStart(3)} heat=${String(x.heatN).padStart(2)} dom=${String(x.domRatio).padStart(3)}% uniq=${x.uniq}${issue}`);
  for (const s of x.samples) console.log(`       · ${s.t}`);
}
console.log('\n── 建议 ──');
console.log('上线:', go.map((x) => x.id).join(', ') || '(无)');
console.log('暂缓:', hold.map((x) => `${x.id}(${x.issues[0] || ''})`).join(', ') || '(无)');
console.log('不下:', no.map((x) => `${x.id}(${x.issues[0] || x.reason || ''})`).join(', ') || '(无)');
