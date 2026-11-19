/**
 * Auth 生产化准备：扩 uri_allow_list，保留本地开发；不关 autoconfirm（需人工确认后再关）。
 */
import fs from 'fs';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const pat = env.SUPABASE_PAT;
const ref = 'efqljinkeatzpobvuouj';

const get = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
  headers: { Authorization: `Bearer ${pat}` },
});
const cur = await get.json();
console.log('before', {
  site_url: cur.site_url,
  uri_allow_list: cur.uri_allow_list,
  mailer_autoconfirm: cur.mailer_autoconfirm,
});

const allow = new Set(
  String(cur.uri_allow_list || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean),
);
[
  'http://127.0.0.1:8765/**',
  'http://127.0.0.1:8791/**',
  'http://localhost:8765/**',
  'http://localhost:8791/**',
  'https://efqljinkeatzpobvuouj.pages.dev/**',
  'https://*.pages.dev/**',
].forEach((u) => allow.add(u));

const body = {
  site_url: 'https://efqljinkeatzpobvuouj.pages.dev/site/portal.html',
  uri_allow_list: [...allow].join(','),
  // 生产前再关：mailer_autoconfirm: false
};

const patch = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const after = await patch.json();
console.log('patch', patch.status);
console.log('after', {
  site_url: after.site_url,
  uri_allow_list: after.uri_allow_list,
  mailer_autoconfirm: after.mailer_autoconfirm,
});
console.log('NOTE: mailer_autoconfirm 仍为', after.mailer_autoconfirm, '——上线前再关');
