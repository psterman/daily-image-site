#!/usr/bin/env node
/**
 * 独立全文代理（可选）。日常请用 portal-dev-server（已内嵌同域 /fulltext/api）。
 * 仅在用纯静态伺服 site/、没有 portal-dev 时才需要本进程。
 *
 *   node tools/fulltext-dev.mjs
 *   → http://127.0.0.1:8792/fulltext/api?url=
 */
import http from 'node:http';
import { fetchFulltext, safeArticleUrl } from '../lib/fulltext-fetch.mjs';

const PORT = Number(process.env.FULLTEXT_PORT || 8792);

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept',
    });
    res.end();
    return;
  }

  let pathname;
  let search;
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    pathname = u.pathname;
    search = u.searchParams;
  } catch {
    send(res, 400, { ok: false, error: 'bad url' });
    return;
  }

  if (req.method !== 'GET' || (pathname !== '/fulltext/api' && pathname !== '/')) {
    send(res, 404, { ok: false, error: 'not found' });
    return;
  }

  if (pathname === '/') {
    send(res, 200, { ok: true, service: 'fulltext-dev', endpoint: '/fulltext/api?url=' });
    return;
  }

  const target = safeArticleUrl(search.get('url'));
  if (!target) {
    send(res, 400, { ok: false, error: '缺少合法 url 参数' });
    return;
  }

  const out = await fetchFulltext(target);
  if (!out.ok) {
    send(res, out.status || 502, {
      ok: false,
      error: out.error || '全文失败',
      strategy: out.strategy,
    });
    return;
  }
  send(res, 200, {
    ok: true,
    title: out.title,
    text: out.text,
    html: out.html || '',
    chars: out.chars,
    source: out.source,
    strategy: out.strategy,
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('fulltext-dev http://127.0.0.1:' + PORT + '/fulltext/api?url=');
});
