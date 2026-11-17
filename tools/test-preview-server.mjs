#!/usr/bin/env node
/**
 * 预览服务器的护栏。
 *
 * 为什么要测它（2026-11-16 实测踩到的坑）：
 * 8809 预览伺服的是**日期目录**而不是**构建根** →
 *   ① 日期页的 logo 路径是 `../assets/logo.webp`，解析到根后根下没有 `assets/`
 *      → **logo 裂成裂图标**
 *   ② 构建输出里没有 `img/` 目录 → **三栏照片整片 404**
 * 这两条正好是「用户看到的就是一屏裂图」，所以必须有护栏盯着。
 *
 * 用法：node tools/test-preview-server.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, '.tmp-preview-test');
const SERVER = path.join(__dirname, 'preview-server.mjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? '  —— ' + detail : ''}`); }
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ } }

/* ── 夹具：一个小小的「线上部署面」 ─────────────────────── */
rmrf(TMP);
const web = path.join(TMP, 'published');
const img = path.join(TMP, 'r2');
fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
fs.mkdirSync(path.join(web, 'archive'), { recursive: true });
fs.mkdirSync(path.join(img, '2026-11-16', 'jianwen'), { recursive: true });

fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>root</title><img src="assets/logo.webp">');
fs.writeFileSync(path.join(web, 'board.html'), '<!doctype html><title>board</title>');
fs.mkdirSync(path.join(web, 'archive'), { recursive: true });
fs.writeFileSync(path.join(web, 'archive', 'index.html'), '<!doctype html><title>archive</title>');
fs.writeFileSync(path.join(web, 'assets', 'logo.webp'), Buffer.from('RIFF0000WEBPfake', 'utf8'));
fs.writeFileSync(path.join(img, '2026-11-16', 'jianwen', 'abcd123456_001.webp'), Buffer.from('fakewebp', 'utf8'));

/* ── 起服务器（端口 0 = 让系统分配） ─────────────────────── */
const child = spawn(process.execPath, [SERVER, '--root', web, '--img-root', img, '--port', '0'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });

const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('服务器没起来：\n' + out)), 15000);
  const iv = setInterval(() => {
    const m = out.match(/PORT=(\d+)/);
    if (m) { clearInterval(iv); clearTimeout(t); resolve(Number(m[1])); }
  }, 100);
});

const B = `http://127.0.0.1:${port}`;

async function hit(p) {
  const r = await fetch(B + p, { cache: 'no-store' });
  const b = await r.arrayBuffer();
  return { status: r.status, len: b.byteLength, type: r.headers.get('content-type') || '' };
}

try {
  console.log('\n预览服务器护栏（端口 ' + port + '）\n');

  const root = await hit('/');
  check('根路径返回构建根的 index.html', root.status === 200 && root.len > 0, `status=${root.status} len=${root.len}`);

  /* 这一条正是「logo 裂成裂图标」那次的根因：
     伺服根目录时 logo 走 assets/logo.webp（相对根），必须能取到。 */
  const logo = await hit('/assets/logo.webp');
  check('logo（/assets/logo.webp）能取到 —— 伺服日期层时这条就是 404', logo.status === 200 && logo.len > 0, `status=${logo.status} len=${logo.len}`);

  const photo = await hit('/img/2026-11-16/jianwen/abcd123456_001.webp');
  check('/img/* 映射到 R2 母本（照片能显示，不再整片 404）', photo.status === 200 && photo.len > 0, `status=${photo.status} len=${photo.len}`);

  const missing = await hit('/img/2026-11-16/jianwen/不存在.webp');
  check('母本里没有的图 → 404（而不是 500/挂起）', missing.status === 404, `status=${missing.status}`);

  const board = await hit('/board/');
  check('clean URL：/board/ → board.html（跟 Cloudflare Pages 规则一致）', board.status === 200 && board.len > 0, `status=${board.status} len=${board.len}`);

  const archive = await hit('/archive/');
  check('归档页 /archive/ 能取到', archive.status === 200 && archive.len > 0, `status=${archive.status} len=${archive.len}`);

  /* 目录穿越必须挡住 —— 判据是「**有没有把文件内容发出去**」，不是状态码。
     ⚠️ 两个坑：
     ① 直接写 `/../x` 会被 URL 解析器**提前归一化**成 `/x` → 请求根本没穿出去，
        断言会「假绿」（2026-11-16 第一版就是这么写成假绿的）。
     ② 所以用**金丝雀文件**（伺服根之外、内容带唯一标记）来判：
        只要响应里没有那个标记，就说明没泄露 —— 至于状态码是 403（被 inside() 挡下）
        还是 404（被 URL 解析器归一化后压根不存在），都算安全。 */
  const TOKEN = 'CANARY-LEAK-9f3a';
  fs.writeFileSync(path.join(TMP, 'canary.txt'), TOKEN);

  const trav = await hit('/%2e%2e/canary.txt');
  const travBody = await (await fetch(B + '/%2e%2e/canary.txt', { cache: 'no-store' })).text();
  check('目录穿越没泄露伺服根之外的文件（%2e%2e 形式）',
    trav.status !== 200 && !travBody.includes(TOKEN), `status=${trav.status} body=${travBody.slice(0, 40)}`);

  /* 这一条能真正打到 inside() 防护：%2f 不会被 URL 解析器解码，
     是服务器自己 decodeURIComponent 之后才变成 `..` */
  const trav2 = await hit('/%2f..%2fcanary.txt');
  const trav2Body = await (await fetch(B + '/%2f..%2fcanary.txt', { cache: 'no-store' })).text();
  check('目录穿越被 inside() 挡住（%2f..%2f 形式 → 403）',
    trav2.status === 403 && !trav2Body.includes(TOKEN), `status=${trav2.status} body=${trav2Body.slice(0, 40)}`);

  const trav3 = await hit('/img/%2f..%2f..%2fcanary.txt');
  const trav3Body = await (await fetch(B + '/img/%2f..%2f..%2fcanary.txt', { cache: 'no-store' })).text();
  check('/img/* 的目录穿越也没泄露', trav3.status !== 200 && !trav3Body.includes(TOKEN), `status=${trav3.status}`);

  const css = await hit('/2026-11-16/app.css');
  check('构建根下按原样伺服静态文件（缺失就是 404）', css.status === 404, `status=${css.status}`);
} finally {
  child.kill();
  rmrf(TMP);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
