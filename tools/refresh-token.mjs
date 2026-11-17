#!/usr/bin/env node
/**
 * Cloudflare OAuth token 续期 + 同步
 *
 * 为什么需要这个：
 *   - wrangler 登录后把 access token 存在**按平台不同的**目录里：
 *       Windows → C:\Users\<user>\AppData\Roaming\xdg.config\.wrangler\config\default.toml
 *       macOS/Linux → $XDG_CONFIG_HOME 或 ~/.config/.wrangler/config/default.toml
 *     （setup-cloudflare.ps1 的 Get-WranglerConfigPath 用的是同一套路径 —— 两边必须一致）
 *   - 这个 token 只有几小时寿命（通常 4 小时左右），到期后 wrangler 未必会自动刷新，
 *     会直接报 "Invalid access token / Max auth failures reached"，
 *     而且失败次数过多 Cloudflare 会临时锁掉该 token，连刷新都做不了。
 *   - 本项目自己的脚本（check-r2 / upload-r2 / setup-cloudflare）也用同一份 token
 *     直接调 REST API，那份拷贝过期得比 wrangler 自己那份更早察觉。
 *
 * 这个脚本做两件事：
 *   1. token 过期就用 refresh_token 换一个新的，写回 default.toml
 *   2. 把最新 token 同步进 .env.local 的 CLOUDFLARE_API_TOKEN
 *
 * 用法：node tools/refresh-token.mjs [--check]
 *   --check 只检查状态，不续期（退出码 0=有效 1=已过期）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * wrangler v3 的 OAuth 配置目录按平台分：
 *   Windows   → %USERPROFILE%\AppData\Roaming\xdg.config\.wrangler\config\default.toml
 *   macOS/Linux → $XDG_CONFIG_HOME 或 ~/.config/.wrangler/config/default.toml
 *
 * 跟 setup-cloudflare.ps1 的 Get-WranglerConfigPath 保持一致 ——
 * 两边算出不同的路径，就变成「一个找得到、另一个找不到」。
 */
function wranglerConfigPath() {
  if (process.env.WRANGLER_CONFIG_DIR) return process.env.WRANGLER_CONFIG_DIR;
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'xdg.config', '.wrangler', 'config', 'default.toml');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, '.wrangler', 'config', 'default.toml');
}

const CF_CONFIG = wranglerConfigPath();

// wrangler OAuth 应用的 client_id（来自 wrangler 登录时打开的授权链接）
const CLIENT_ID = '54d11594-84e4-41aa-b438-e81b8fa78ee7';

const checkOnly = process.argv.includes('--check');

function readToml(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const get = (k) => {
    const m = raw.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm'));
    return m ? m[1] : null;
  };
  return {
    raw,
    oauthToken: get('oauth_token'),
    refreshToken: get('refresh_token'),
    expiration: get('expiration_time'),
  };
}

function writeToml(file, cfg, newToken, newExpiration) {
  let raw = cfg.raw;
  raw = raw.replace(/^(\s*oauth_token\s*=\s*")[^"]*(")/m, `$1${newToken}$2`);
  raw = raw.replace(/^(\s*expiration_time\s*=\s*")[^"]*(")/m, `$1${newExpiration}$2`);
  fs.writeFileSync(file, raw, 'utf8');
}

function syncEnvLocal(token) {
  const envFile = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envFile)) return false;
  let raw = fs.readFileSync(envFile, 'utf8');
  const re = /^(\s*CLOUDFLARE_API_TOKEN\s*=\s*).*$/m;
  if (!re.test(raw)) {
    raw += `\nCLOUDFLARE_API_TOKEN=${token}\n`;
  } else {
    raw = raw.replace(re, `$1${token}`);
  }
  fs.writeFileSync(envFile, raw, 'utf8');
  return true;
}

function isExpired(expiration) {
  if (!expiration) return true;
  const t = Date.parse(expiration);
  return Number.isNaN(t) ? true : t <= Date.now();
}

/**
 * 提前续期的余量：剩余寿命不足这么多，就当它该续了。
 *
 * 为什么（2026-11-15 实测的真凶之二）：
 *   Cloudflare 的 OAuth token **只活 1 小时**（expires_in = 3600）。
 *   只在「已经过期」时才续期，就会出现这种局面：开头判断「还有 12 分钟，有效」→ 放行，
 *   而发布链路（构建 + 产物自检 + R2 探测 + 上传 + 部署）完全可能跨过这个点 ——
 *   2026-11-14 那次发布就是这样：上传到一半 token 过期，
 *   **249 个文件 401 code 10000**，整次发布 exit 1，Pages 根本没部署。
 *
 * 所以：剩余不足 MIN_TTL_MS 就提前续，别赌它撑到上传完。
 */
const MIN_TTL_MS = 15 * 60 * 1000;

function needsRenewal(expiration) {
  if (!expiration) return true;
  const t = Date.parse(expiration);
  if (Number.isNaN(t)) return true;
  return t - Date.now() < MIN_TTL_MS;
}

async function refresh(refreshToken) {
  // 注意：Cloudflare 的 OAuth 端点在 dash.cloudflare.com，不在 api.cloudflare.com
  // （后者只有 REST 路径，用 /client/v4/oauth2/token 会得到 7000 No route for that URI）
  const res = await fetch('https://dash.cloudflare.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  const body = await res.json().catch(() => ({}));
  // OAuth 端点返回的是标准 OAuth 信封 { access_token, refresh_token, expires_in }，
  // 不是 Cloudflare REST 那套 { success, result, errors }。
  if (!res.ok || !body.access_token) {
    const errs = (body.errors || []).map((e) => `${e.code}:${e.message}`).join('; ');
    const safe = JSON.stringify(body).replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>');
    throw new Error(`续期失败 HTTP ${res.status} ${errs || body.error_description || ''} ${safe.slice(0, 240)}`);
  }
  return body;
}

async function main() {
  const cfg = readToml(CF_CONFIG);
  if (!cfg) {
    console.error(`找不到 wrangler 配置：${CF_CONFIG}`);
    console.error('先跑一次 `npx wrangler login`');
    process.exit(2);
  }

  const expired = isExpired(cfg.expiration);
  const stale = needsRenewal(cfg.expiration);
  console.log(`wrangler 配置 : ${CF_CONFIG}`);
  console.log(`token          : ${cfg.oauthToken ? cfg.oauthToken.slice(0, 12) + '…' : '(无)'}`);
  console.log(`过期时间       : ${cfg.expiration || '(无)'}  (${expired ? '已过期' : stale ? '快过期了' : '有效'})`);

  if (checkOnly) {
    process.exit(expired ? 1 : 0);
  }

  let token = cfg.oauthToken;
  let expiration = cfg.expiration;

  if (stale) {
    if (!cfg.refreshToken) {
      console.error('\n没有 refresh_token，只能重新 `npx wrangler login`');
      process.exit(2);
    }
    console.log('\n正在用 refresh_token 换新 token …');
    const r = await refresh(cfg.refreshToken);
    token = r.access_token;
    // expires_in 是秒数；wrangler 配置里用 ISO 时间串
    expiration = r.expires_in
      ? new Date(Date.now() + r.expires_in * 1000).toISOString()
      : new Date(Date.now() + 4 * 3600 * 1000).toISOString();
    if (r.refresh_token) {
      // 换新的 refresh_token 也要写回去（Cloudflare 每次刷新都会轮换）
      let raw = cfg.raw.replace(/^(\s*refresh_token\s*=\s*")[^"]*(")/m, `$1${r.refresh_token}$2`);
      fs.writeFileSync(CF_CONFIG, raw, 'utf8');
      cfg.raw = raw;
    }
    writeToml(CF_CONFIG, cfg, token, expiration);
    console.log(`✓ 已续期，新过期时间 ${expiration}`);
  } else {
    console.log('\ntoken 仍有效，无需续期');
  }

  // 同步进 .env.local，让本项目自己的 REST 调用用上同一份
  if (syncEnvLocal(token)) {
    console.log('✓ 已同步 .env.local 的 CLOUDFLARE_API_TOKEN');
  }

  // 立刻验证一下能不能用
  const acc = process.env.CLOUDFLARE_ACCOUNT_ID || readEnvValue('CLOUDFLARE_ACCOUNT_ID');
  if (acc) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.success) {
      console.log('✓ 验证通过：账号接口可正常访问');
    } else {
      const errs = (body.errors || []).map((e) => `${e.code}:${e.message}`).join('; ');
      console.log(`! 验证未通过：HTTP ${res.status} ${errs}`);
    }
  }
}

function readEnvValue(key) {
  const envFile = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envFile)) return null;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
