/**
 * fulltext-client.mjs —— 浏览器侧按需全文（只活在内存，不落库）
 *
 * 点开才请求 /fulltext/api；同 URL 本页会话内复用。
 */
import { safeArticleUrl } from './extract-article.mjs';

const mem = new Map();

/**
 * 解析全文接口：
 *   - 绝对地址原样用
 *   - 相对路径走同域（portal-dev / Pages Function 都挂 /fulltext/api）
 *   - 仅当页面不是经 portal-dev 打开、又没配路径时，才回退 8792 独立代理
 */
export function resolveFulltextEndpoint(configured) {
  const cfg = String(configured || '').trim();
  if (cfg && /^https?:\/\//i.test(cfg)) return cfg.replace(/\/$/, '');
  if (cfg.startsWith('/')) return cfg.replace(/\/$/, '') || '/fulltext/api';
  if (typeof location !== 'undefined') {
    const host = location.hostname;
    if (host === '127.0.0.1' || host === 'localhost') {
      return 'http://127.0.0.1:8792/fulltext/api';
    }
  }
  return '/fulltext/api';
}

/**
 * @param {string} articleUrl
 * @param {string} [endpoint]
 * @returns {Promise<{ ok: boolean, title?: string, text?: string, chars?: number, error?: string, cached?: boolean }>}
 */
export async function fetchFullText(articleUrl, endpoint) {
  const url = safeArticleUrl(articleUrl);
  if (!url) return { ok: false, error: '链接无效' };
  if (mem.has(url)) return { ...mem.get(url), cached: true };

  const ep = resolveFulltextEndpoint(endpoint);
  let res;
  try {
    res = await fetch(ep + '?url=' + encodeURIComponent(url), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    return {
      ok: false,
      error: '全文服务不可达（请用 node tools/portal-dev-server.mjs 打开门户，或另开 fulltext-dev）',
    };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: '全文响应无法解析' };
  }
  if (!res.ok || !data || !data.ok) {
    return { ok: false, error: (data && data.error) || ('HTTP ' + res.status) };
  }
  const out = {
    ok: true,
    title: data.title || '',
    text: data.text || '',
    html: data.html || '',
    chars: data.chars || (data.text || '').length,
    strategy: data.strategy || '',
  };
  mem.set(url, out);
  return out;
}

export function clearFullTextCache() {
  mem.clear();
}
