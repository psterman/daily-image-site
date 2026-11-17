#!/usr/bin/env node
/**
 * 本地预览服务器：把「线上站」原样搬到本机来给人看。
 *
 * 为什么不用 `python -m http.server`（2026-11-16 实测踩到的坑）：
 *
 * ① **伺服哪一层，logo 就会裂。**
 *    构建产物有两层：根目录的 `index.html`（logo 走 `assets/logo.jpg`、
 *    脚本走 `/<日期>/app.*.js`）和 `<日期>/index.html`（同一份页面，但 logo
 *    改成 `../assets/logo.jpg`、脚本改成同目录相对路径）。
 *    伺服**根目录** → logo 和脚本都对；
 *    伺服**日期目录** → `../assets/...` 解析到根，根下又没有 `assets/` → **404 裂图**。
 *    （实测 8809 就是伺服在日期目录上 → 左上角 logo 是个裂图标。）
 *
 * ② **图片根本不在构建产物里。**
 *    `/img/<日期>/<分类>/<文件>` 指的是 **R2 私有桶**里的对象，构建输出里没有
 *    img/ 目录 → 纯静态服务器必然 404 → 三栏照片整片空白。
 *    这个服务器把 `/img/*` 映射到**本地 R2 母本**（`~/image-root\r2`，
 *    与线上 URL 的 `<日期>/<分类>/<文件>` 结构完全一致）→ 预览能看真图。
 *
 * 用法：
 *   node tools/preview-server.mjs [--root <dir>] [--img-root <dir>] [--port 8809]
 *   --root     默认 = 工程根下的 published/（线上部署面，和线上长得一模一样）
 *   --img-root 覆盖 R2 母本目录（测试用；默认从 paths.mjs 的候选里找）
 *   --port 0  = 让系统随机给一个端口（测试用；启动行会打印真实端口）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, r2SearchRoots } from './paths.mjs';

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

const PORT = Number(arg('--port', '8809'));
const WEB_ROOT = path.resolve(arg('--root', path.join(ROOT, 'published')));
const IMG_ROOTS = arg('--img-root', '') ? [path.resolve(arg('--img-root', ''))] : r2SearchRoots();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
};

function mime(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** 防目录穿越：解析后的路径必须还在 root 里面 */
function inside(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + file);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    /* 预览：别让浏览器缓存住旧版产物（改完刷新就该看到新的） */
    const cache = ext === '.html' || ext === '.js' || ext === '.css'
      ? 'no-store'
      : 'public, max-age=0, must-revalidate';
    res.writeHead(200, {
      'Content-Type': mime(file),
      'Content-Length': st.size,
      'Cache-Control': cache,
    });
    if (res.req && res.req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400); res.end('bad url'); return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  /* --- /img/* → 本地 R2 母本 --- */
  if (pathname.startsWith('/img/')) {
    const rel = pathname.slice('/img/'.length);
    for (const r of IMG_ROOTS) {
      const f = path.join(r, rel);
      if (inside(f, r) && fs.existsSync(f)) { sendFile(res, f); return; }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 图片不在本地母本里：' + rel);
    return;
  }

  /* --- 其余走构建产物 --- */
  let f = path.join(WEB_ROOT, pathname);
  if (!inside(f, WEB_ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403');
    return;
  }

  /* clean URL（跟 Cloudflare Pages 一致）：
     `/board/` → 产物里是 `board.html`（没有 board/ 目录）。
     Pages 会自动补 `.html`，本地服务器也得补 —— 否则「留言板」入口在预览里 404。 */
  if (!fs.existsSync(f) && pathname.endsWith('/index.html')) {
    const stem = pathname.replace(/index\.html$/, '').replace(/\/$/, ''); // '/board/index.html' -> '/board'
    const alt = path.join(WEB_ROOT, stem + '.html');                    // -> <root>/board.html
    if (inside(alt, WEB_ROOT) && fs.existsSync(alt)) f = alt;
  }

  sendFile(res, f);
});

server.listen(PORT, '127.0.0.1', () => {
  const real = server.address().port;
  console.log(`预览服务 : http://127.0.0.1:${real}/`);
  console.log(`伺服目录 : ${WEB_ROOT}`);
  console.log(`图片母本 : ${IMG_ROOTS.join(' | ')}  （/img/* 映射到这儿）`);
  console.log(`PORT=${real}`);
});
