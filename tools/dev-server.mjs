#!/usr/bin/env node
/**
 * 本地预览服务器
 *
 *   /            -> published/index.html      （历史索引）
 *   /<date>/     -> published/<date>/index.html
 *   /img/<...>   -> r2/<...>                  （模拟线上的 R2 代理）
 *
 * 用法：node tools/dev-server.mjs [端口] [根目录]
 *   根目录默认 published/；传 dist-tmp 可预览自包含静态包
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, R2_LOCAL } from './paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLISHED = path.join(ROOT, 'published');
const R2 = R2_LOCAL;

const PORT = Number(process.argv[2]) || 8788;
const BASE = process.argv[3] ? path.resolve(process.argv[3]) : PUBLISHED;
/* 图片从哪取：
     'self' —— BASE/img（自包含静态包，图就打包在里面）
     'r2'   —— 本地 R2 母本（跟线上一致）
   默认值保持老行为：给了 BASE 就 self，没给就 r2。
   新增的用法：build.mjs --out 出来的试验产物里只有页面、没有图片，
   这时用 `dev-server.mjs <端口> <产物目录> r2` —— 页面伺服试验产物，
   图片仍然从 R2 母本取。 */
const IMG_MODE = process.argv[4] || (process.argv[3] ? 'self' : 'r2');
const SELF_CONTAINED = IMG_MODE === 'self';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.sep + rel);
  if (!p.startsWith(base)) return null;
  return p;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);

    let base = BASE;
    let rel = pathname;

    /* /likes/api 是 Pages Function（线上才有），本地预览补一个空实现 ——
       不补的话前端 fetch 会 404，浏览器控制台报一条错，
       verify-news 的「无控制台/网络错误」那条必红 ——
       一个跟内容毫无关系的假故障，把真正的错误淹掉。 */
    if (pathname.startsWith('/likes/api')) {
      const date = url.searchParams.get('date') || '';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, date, counts: {}, comments: {} }));
      return;
    }

    if (!SELF_CONTAINED && pathname.startsWith('/img/')) {
      base = R2;
      rel = pathname.slice('/img'.length);
    }

    let file = safeJoin(base, rel);
    if (!file) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let stat = await fs.stat(file).catch(() => null);
    if (stat && stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await fs.stat(file).catch(() => null);
    }
    if (!stat) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + pathname);
      return;
    }

    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    const stream = createReadStream(file);
    stream.on('error', (e) => {
      console.error(`读取失败 ${file}: ${e.message}`);
      res.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    console.error(`处理 ${req.url} 出错: ${err.stack || err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
    } else {
      res.destroy();
    }
  }
});

server.on('clientError', (err, socket) => {
  console.error(`客户端错误: ${err.message}`);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, () => {
  console.log(`预览地址 : http://localhost:${PORT}/`);
  console.log(`根目录   : ${BASE}`);
  console.log(`图片来源 : ${SELF_CONTAINED ? `BASE/img（自包含）` : `${R2}  (映射到 /img/*)`}`);
});
