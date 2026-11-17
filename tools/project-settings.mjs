#!/usr/bin/env node
/**
 * 查看 / 调整 Cloudflare Pages 项目设置
 *
 * 关注点：Web Analytics。Cloudflare 开启后会在**构建期**把
 * <script src="https://static.cloudflareinsights.com/beacon.min.js/...">
 * 注入到每个页面 HTML 里 —— 部署是不可变的，所以开了之后每个新部署都会带上，
 * 关掉之后也只有**之后的新部署**才不再带（旧部署永久保留）。
 *
 * 用法：
 *   node tools/project-settings.mjs            查看
 *   node tools/project-settings.mjs --off      关闭 Web Analytics（需重新部署才生效）
 *   node tools/project-settings.mjs --on       开启
 *
 * 退出码：0 = 成功；1 = 失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const env = {};
const envFile = path.join(ROOT, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const token = process.env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
const acc = process.env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
const proj = process.env.PAGES_PROJECT || env.PAGES_PROJECT || 'your-project';

if (!token || !acc) {
  console.error('缺少 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（检查 .env.local）');
  process.exit(2);
}

const H = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};
const base = 'https://api.cloudflare.com/client/v4';
const url = `${base}/accounts/${acc}/pages/projects/${proj}`;

async function getProject() {
  const res = await fetch(url, { headers: H });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const errs = (body.errors || []).map((e) => `${e.code}:${e.message}`).join('; ');
    throw new Error(`HTTP ${res.status} ${errs}`);
  }
  return body.result;
}

/* 最近的部署：能看出是谁触发的（wrangler / Dashboard / CI） */
async function getDeployments(n = 6) {
  const res = await fetch(`${url}/deployments?per_page=${n}`, { headers: H });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) return [];
  return body.result || [];
}

async function describeDeployments() {
  const deps = await getDeployments();
  if (!deps.length) {
    console.log('\n最近部署：（读不到）');
    return;
  }
  console.log('\n最近部署：');
  for (const d of deps) {
    const stage = d.latest_stage?.name || d.stage || '?';
    const when = d.created_on ? new Date(d.created_on).toLocaleString('zh-CN') : '?';
    const by = d.deployment_trigger?.type || d.trigger?.type || '?';
    const who = d.deployment_trigger?.metadata?.commit_hash
      ? ` commit=${String(d.deployment_trigger.metadata.commit_hash).slice(0, 7)}`
      : '';
    console.log(`  ${String(d.id).slice(0, 8)}  ${when}  stage=${stage}  trigger=${by}${who}`);
  }
}

function describe(p) {
  const wa = p.web_analytics;
  console.log(`项目      : ${p.name}`);
  console.log(`子域      : ${p.subdomain}`);
  console.log(`生产分支  : ${p.production_branch || '(未设置)'}`);
  console.log(`源仓库    : ${p.source ? `${p.source.type} (${p.source.config?.owner}/${p.source.config?.repo_name})` : '(无 —— wrangler 直接部署)'}`);
  console.log(`Web Analytics: ${wa === undefined ? '(GET 未返回该字段)' : wa.enabled ? '已开启' : '已关闭'}`);
  console.log(`顶层字段  : ${Object.keys(p).join(', ')}`);
  const dc = p.deployment_configs || {};
  for (const [k, v] of Object.entries(dc)) {
    const vars = Object.keys(v?.env_vars || {});
    console.log(`  [${k}] env_vars: ${vars.length ? vars.join(', ') : '(无)'}`);
    // R2 绑定：Function 靠它读图，缺了图片会静默走静态兜底
    const r2 = v?.r2_buckets || v?.r2_bucket_names;
    if (r2 && (Array.isArray(r2) ? r2.length : r2)) {
      const list = Array.isArray(r2)
        ? r2.map((b) => `${b.binding || b.name || '?'}->${b.bucket_name || b.bucket || '?'}`).join(', ')
        : String(r2);
      console.log(`  [${k}] r2_buckets: ${list}`);
    }
  }
}

const mode = process.argv[2];

try {
  if (!mode) {
    describe(await getProject());
    await describeDeployments();
    console.log('\n提示：加 --on / --off 可以开关 Web Analytics（改完需重新部署才生效）。');
    process.exit(0);
  }

  const want = mode === '--on';
  if (mode !== '--on' && mode !== '--off') {
    console.error('未知参数，只支持 --on / --off');
    process.exit(2);
  }

  const cur = await getProject();
  // 注意：GET 可能根本不返回 web_analytics 字段（读不到 ≠ 关闭）。
  // 所以只有在「明确读到 enabled=false」时才认为无需改动；
  // 字段缺失时一律照改 —— 多发一次 PATCH 没有副作用，
  // 但漏改的后果是 beacon 一直注入、每次首屏多等 0.6~4.7 秒。
  const known = typeof cur.web_analytics?.enabled === 'boolean';
  const wasOn = cur.web_analytics?.enabled === true;
  if (known && wasOn === want) {
    console.log(`Web Analytics 本来就是${want ? '开启' : '关闭'}状态，无需改动。`);
    process.exit(0);
  }
  if (!known) {
    console.log('（GET 没返回 web_analytics 字段，按「未关闭」处理，直接写入目标状态）');
  }

  const res = await fetch(url, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ web_analytics: { enabled: want } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const errs = (body.errors || []).map((e) => `${e.code}:${e.message}`).join('; ');
    console.error(`修改失败：HTTP ${res.status} ${errs}`);
    process.exit(1);
  }
  console.log(`Web Analytics 已${want ? '开启' : '关闭'}（项目设置）。`);
  console.log('注意：部署是不可变的，必须重新跑一次 publish.ps1 才生效。');
  console.log('旧部署的 HTML 里那行 beacon 会永久留在那里，不影响。');
} catch (e) {
  console.error('失败:', e.message);
  process.exit(1);
}
