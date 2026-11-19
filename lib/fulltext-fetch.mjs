/**
 * fulltext-fetch.mjs —— 按需全文统一核（Node / Workers 通用）
 *
 * 按域名分流：微信 #js_content、Twitter syndication、B 站专栏、通用 HTML。
 * 只服务当次阅读，不写共享池 / content_bodies。
 */
import {
  extractArticle,
  extractWechatArticle,
  extractBilibiliRead,
  tweetJsonToText,
  safeArticleUrl,
  MAX_FULLTEXT,
} from './extract-article.mjs';

const UA_GENERIC =
  'Mozilla/5.0 (compatible; OneToneFulltext/0.1; +https://github.com/psterman/daily-image-site)';
const UA_WECHAT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x18002831) NetType/WIFI Language/zh_CN';

/**
 * @param {string} link
 * @returns {'wechat'|'twitter'|'bilibili_read'|'generic'}
 */
export function classifyFulltextUrl(link) {
  const url = safeArticleUrl(link);
  if (!url) return 'generic';
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, '').toLowerCase();
    path = u.pathname || '';
  } catch {
    return 'generic';
  }
  if (host === 'mp.weixin.qq.com' || host.endsWith('.weixin.qq.com')) return 'wechat';
  if (
    host === 'twitter.com' ||
    host === 'x.com' ||
    host === 'mobile.twitter.com' ||
    host.endsWith('.twitter.com') ||
    host.endsWith('.x.com')
  ) {
    return 'twitter';
  }
  // xgo.ing 镜像：能抠出 status id 才走 syndication
  if (/(^|\.)xgo\.ing$/i.test(host) && extractTweetId(url)) return 'twitter';
  if (/(^|\.)bilibili\.com$/i.test(host) && /\/read\//i.test(path)) return 'bilibili_read';
  return 'generic';
}

/** @param {string} link */
export function extractTweetId(link) {
  const url = safeArticleUrl(link);
  if (!url) return '';
  const m =
    /(?:twitter\.com|x\.com|mobile\.twitter\.com)\/(?:#!\/)?[^/]+\/status(?:es)?\/(\d+)/i.exec(url) ||
    /(?:^|[?&#])(?:id|tweet_id|status_id)=(\d+)/i.exec(url) ||
    /status(?:es)?\/(\d+)/i.exec(url);
  return m ? m[1] : '';
}

async function fetchHtml(url, headers) {
  const upstream = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(headers || {}),
    },
    signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
  });
  if (!upstream.ok) {
    const err = new Error('源站 HTTP ' + upstream.status);
    err.status = 502;
    err.code = 'upstream_http';
    throw err;
  }
  const ctype = String(upstream.headers.get('content-type') || '');
  if (ctype && !/html|xml|text\/plain|json/i.test(ctype)) {
    const err = new Error('源站不是 HTML');
    err.status = 415;
    throw err;
  }
  const html = await upstream.text();
  if (html.length > 2_000_000) {
    const err = new Error('页面过大');
    err.status = 413;
    throw err;
  }
  return html;
}

async function fetchTwitter(url) {
  const id = extractTweetId(url);
  if (!id) {
    return { ok: false, error: '无法解析推文 ID', status: 400, strategy: 'twitter' };
  }
  const endpoint =
    'https://cdn.syndication.twimg.com/tweet-result?id=' +
    encodeURIComponent(id) +
    '&token=a';
  let res;
  try {
    res = await fetch(endpoint, {
      redirect: 'follow',
      headers: { Accept: 'application/json', 'User-Agent': UA_GENERIC },
      signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
    });
  } catch {
    return { ok: false, error: '源站拉取失败', status: 502, strategy: 'twitter' };
  }
  if (!res.ok) {
    return { ok: false, error: '源站 HTTP ' + res.status, status: 502, strategy: 'twitter' };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: '推文响应无法解析', status: 502, strategy: 'twitter' };
  }
  const art = tweetJsonToText(data);
  if (!art.text || art.chars < 8) {
    return {
      ok: false,
      error: '抽不出正文，请打开原文',
      status: 422,
      strategy: 'twitter',
    };
  }
  const text = art.text.slice(0, MAX_FULLTEXT);
  const paras = text.split(/\n\n+/).filter(Boolean);
  const html = paras.map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('');
  return {
    ok: true,
    title: art.title,
    text,
    html,
    chars: Math.min(art.chars, MAX_FULLTEXT),
    source: url,
    strategy: 'twitter',
  };
}

/**
 * @param {string} articleUrl
 * @returns {Promise<{ok:boolean,title?:string,text?:string,chars?:number,source?:string,strategy:string,error?:string,status?:number}>}
 */
export async function fetchFulltext(articleUrl) {
  const url = safeArticleUrl(articleUrl);
  if (!url) {
    return { ok: false, error: '缺少合法 url 参数', status: 400, strategy: 'generic' };
  }
  const strategy = classifyFulltextUrl(url);

  if (strategy === 'twitter') {
    return fetchTwitter(url);
  }

  try {
    if (strategy === 'wechat') {
      const html = await fetchHtml(url, { 'User-Agent': UA_WECHAT });
      let art = extractWechatArticle(html, { max: MAX_FULLTEXT, baseUrl: url });
      if (!art.text || art.chars < 40) {
        art = extractArticle(html, { max: MAX_FULLTEXT, baseUrl: url });
      }
      if (!art.text || art.chars < 40) {
        return {
          ok: false,
          error: '抽不出正文，请打开原文',
          status: 422,
          strategy,
        };
      }
      return {
        ok: true,
        title: art.title,
        text: art.text,
        html: art.html || '',
        chars: art.chars,
        source: url,
        strategy,
      };
    }

    if (strategy === 'bilibili_read') {
      const html = await fetchHtml(url, { 'User-Agent': UA_GENERIC });
      let art = extractBilibiliRead(html, { max: MAX_FULLTEXT, baseUrl: url });
      if (!art.text || art.chars < 40) {
        art = extractArticle(html, { max: MAX_FULLTEXT, baseUrl: url });
      }
      if (!art.text || art.chars < 40) {
        return {
          ok: false,
          error: '抽不出正文，请打开原文',
          status: 422,
          strategy,
        };
      }
      return {
        ok: true,
        title: art.title,
        text: art.text,
        html: art.html || '',
        chars: art.chars,
        source: url,
        strategy,
      };
    }

    const html = await fetchHtml(url, { 'User-Agent': UA_GENERIC });
    const art = extractArticle(html, { max: MAX_FULLTEXT, baseUrl: url });
    if (!art.text || art.chars < 40) {
      return {
        ok: false,
        error: '抽不出正文，请打开原文',
        status: 422,
        strategy: 'generic',
      };
    }
    return {
      ok: true,
      title: art.title,
      text: art.text,
      html: art.html || '',
      chars: art.chars,
      source: url,
      strategy: 'generic',
    };
  } catch (e) {
    const status = (e && e.status) || 502;
    return {
      ok: false,
      error: (e && e.message) || '源站拉取失败',
      status,
      strategy,
    };
  }
}

export { safeArticleUrl };
