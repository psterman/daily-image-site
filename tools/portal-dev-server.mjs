#!/usr/bin/env node
/**
 * portal 本地静态服：根目录 = daily-image-site-open
 *   /portal        -> site/portal.html
 *   /fulltext/api  -> 按需抽正文（同域，不必另开 8792）
 *   /lib/*         -> lib/*
 *   其它           -> site/<path>（与 HANDOFF HttpListener 一致）
 *
 *   node tools/portal-dev-server.mjs [port=8765]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFulltext, safeArticleUrl } from '../lib/fulltext-fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8765;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function mapPath(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  if (!p || p === 'portal') p = 'site/portal.html';
  else if (!p.startsWith('site/') && !p.startsWith('lib/') && !p.startsWith('tools/')) {
    p = 'site/' + p;
  }
  const abs = path.resolve(ROOT, p);
  if (!abs.startsWith(ROOT)) return null;
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  if (!path.extname(abs) && fs.existsSync(abs + '.html')) return abs + '.html';
  return null;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function handleFulltext(req, res, searchParams) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept',
    });
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  const target = safeArticleUrl(searchParams.get('url'));
  if (!target) {
    sendJson(res, 400, { ok: false, error: '缺少合法 url 参数' });
    return;
  }
  const out = await fetchFulltext(target);
  if (!out.ok) {
    sendJson(res, out.status || 502, {
      ok: false,
      error: out.error || '全文失败',
      strategy: out.strategy,
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    title: out.title,
    text: out.text,
    html: out.html || '',
    chars: out.chars,
    source: out.source,
    strategy: out.strategy,
  });
}

const server = http.createServer((req, res) => {
  let pathname = '/';
  let searchParams = new URLSearchParams();
  try {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    pathname = u.pathname;
    searchParams = u.searchParams;
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad url');
    return;
  }

  if (pathname === '/fulltext/api') {
    handleFulltext(req, res, searchParams);
    return;
  }

  const file = mapPath(req.url || '/');
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 ' + req.url);
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`portal-dev http://127.0.0.1:${PORT}/portal  (root ${ROOT})`);
  console.log(`fulltext   http://127.0.0.1:${PORT}/fulltext/api?url=`);
});
