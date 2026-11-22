#!/usr/bin/env node
/**
 * 讯飞星火（Loomy）签名服务自检（不打真上游）。
 *   node tools/test-loomy-sign.mjs
 *
 * 两部分：
 *   1) 黄金向量对账 —— JS 签名必须与**原 Rust 实现**逐字节一致。
 *      向量由 src-tauri/src/loomy_oauth.rs 的原实现一次性生成后固化在这里；
 *      原实现已从客户端删除，两边任何一边改动都会让这个套件变红。
 *   2) HTTP 层 —— 路径白名单、指纹校验、缺密钥、限流、成功路径。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  SIGNABLE_PATHS,
  buildSigningString,
  buildEscapedPath,
  escapeRfc3986,
  httpDateFromMs,
  signRequest,
} from '../lib/loomy-signature.mjs';
import { handleSignRequest, _resetRateLimit } from '../lib/loomy-sign-service.mjs';
import { onRequest } from '../functions/loomy-sign/index.js';

const V = {
  secret: 'vector-secret-not-a-real-key',
  keyId: 'vector-key-id',
  date: 'Wed, 01 Jan 2020 00:00:00 GMT',
  nonce: '1a2b3c4d5e6f',
};

const BODY_SEND =
  '{"base":{"appid":"GM3LOOMY","devid":"web","modelid":"Web","traceid":"18f3a2b1c4d5e6f7","ua":"Loomy|Desktop|Electron|macOS","version":"1.0.0"},"param":{"ccode":"86","expire":300,"phone":"13800138000"}}';
const BODY_CHECK =
  '{"base":{"appid":"GM3LOOMY","devid":"web","modelid":"Web","traceid":"18f3a2b1c4d5e6f7","ua":"Loomy|Desktop|Electron|macOS","version":"1.0.0"},"param":{"ccode":"86","expire":1209600,"mcode":"123456","msgid":"m-1","phone":"13800138000"}}';

const CASES = [
  {
    label: 'send',
    path: '/login/phone/sendMsgCode',
    body: BODY_SEND,
    signingString:
      'POST\n/login/phone/sendMsgCode\n\n54Gs1n0+8CWYC3LlbS4Aow==\napplication/json\nWed, 01 Jan 2020 00:00:00 GMT\n1a2b3c4d5e6f\n\n',
    authorization: 'account vector-key-id:lY4YCclXUrmEbiwTDfsjpRjNKJo=',
    contentMd5: '54Gs1n0+8CWYC3LlbS4Aow==',
  },
  {
    label: 'check',
    path: '/login/phone/checkCode',
    body: BODY_CHECK,
    signingString:
      'POST\n/login/phone/checkCode\n\nzXDHX2Ex1T4clqBYTS27aA==\napplication/json\nWed, 01 Jan 2020 00:00:00 GMT\n1a2b3c4d5e6f\n\n',
    authorization: 'account vector-key-id:Apxh4Oi95fVFGOCNmmjOtA6EEO8=',
    contentMd5: 'zXDHX2Ex1T4clqBYTS27aA==',
  },
  {
    label: 'empty',
    path: '/login/phone/sendMsgCode',
    body: '',
    signingString:
      'POST\n/login/phone/sendMsgCode\n\n\napplication/json\nWed, 01 Jan 2020 00:00:00 GMT\n1a2b3c4d5e6f\n\n',
    authorization: 'account vector-key-id:VP3VBSXxW4ykzrnlVyoARFXnUWQ=',
    contentMd5: '',
  },
  {
    label: 'escaped',
    path: '/login/phone/send msg',
    body: BODY_SEND,
    signingString:
      'POST\n/login/phone/send%20msg\n\n54Gs1n0+8CWYC3LlbS4Aow==\napplication/json\nWed, 01 Jan 2020 00:00:00 GMT\n1a2b3c4d5e6f\n\n',
    authorization: 'account vector-key-id:3oi/a8TP8QwLfnht5fY1ucZuK2k=',
    contentMd5: '54Gs1n0+8CWYC3LlbS4Aow==',
  },
];

const DATES = [
  { ms: 0, http: 'Thu, 01 Jan 1970 00:00:00 GMT' },
  { ms: 1_000_000_000_000, http: 'Sun, 09 Sep 2001 01:46:40 GMT' },
  { ms: 1_767_225_599_999, http: 'Wed, 31 Dec 2025 23:59:59 GMT' },
  { ms: 1_795_353_492_117, http: 'Sun, 22 Nov 2026 13:18:12 GMT' },
];

// ---- 1) 黄金向量对账 -------------------------------------------------------

for (const c of CASES) {
  const sts = buildSigningString({
    method: 'POST',
    path: c.path,
    contentMd5: c.contentMd5,
    contentType: 'application/json',
    date: V.date,
    nonce: V.nonce,
  });
  assert.equal(sts, c.signingString, `签名串不一致：${c.label}`);

  const headers = await signRequest({
    accessKeyId: V.keyId,
    accessKeySecret: V.secret,
    path: c.path,
    contentMd5: c.contentMd5,
    date: V.date,
    nonce: V.nonce,
  });
  assert.equal(headers.Authorization, c.authorization, `Authorization 不一致：${c.label}`);
  assert.equal(headers.Date, V.date);
  assert.equal(headers.Nonce, V.nonce);
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers.Accept, 'application/json');
  assert.equal(headers['Content-MD5'] ?? '', c.contentMd5, `Content-MD5 不一致：${c.label}`);
}

// body 指纹本身也要对上（证明 body 字节与原实现产出一致）
for (const c of CASES) {
  if (!c.body) {
    assert.equal(c.contentMd5, '', '空 body 不应有 Content-MD5');
    continue;
  }
  const md5 = crypto.createHash('md5').update(c.body, 'utf8').digest('base64');
  assert.equal(md5, c.contentMd5, `body 指纹不一致：${c.label}`);
}

for (const d of DATES) {
  assert.equal(httpDateFromMs(d.ms), d.http, `时间头不一致：${d.ms}`);
}

// 转义与路径
assert.equal(escapeRfc3986('a b/c'), 'a%20b%2Fc');
assert.equal(escapeRfc3986('a-b_c.d~e'), 'a-b_c.d~e');
assert.equal(buildEscapedPath('/login/phone/sendMsgCode'), '/login/phone/sendMsgCode');
assert.equal(buildEscapedPath('/login/phone/send msg'), '/login/phone/send%20msg');
assert.equal(buildEscapedPath('login/phone/x'), '/login/phone/x');
assert.equal(buildEscapedPath('/a/'), '/a');
assert.deepEqual([...SIGNABLE_PATHS], ['/login/phone/sendMsgCode', '/login/phone/checkCode']);

// ---- 2) HTTP 层 -----------------------------------------------------------

const ENV = { LOOMY_ACCESS_KEY_ID: 'test-key-id', LOOMY_ACCESS_KEY_SECRET: 'test-secret' };
const MD5_OK = '54Gs1n0+8CWYC3LlbS4Aow==';

function makeRequest(payload, headers = {}) {
  return new Request('https://my.onetone.app/loomy-sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Loomy-Sign': '1', ...headers },
    body: JSON.stringify(payload),
  });
}

_resetRateLimit();

// 成功路径
{
  const res = await handleSignRequest(
    makeRequest({ path: '/login/phone/sendMsgCode', contentMd5: MD5_OK }),
    ENV,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control') || '', /no-store/, '必须 no-store，否则 Pages 会缓存');
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.match(data.headers.Authorization, /^account test-key-id:/);
  assert.equal(data.headers['Content-MD5'], MD5_OK);
  assert.match(data.headers.Date, /GMT$/);
  assert.ok(data.headers.Nonce);
}

// 只传指纹也能签 —— 说明服务端确实不需要 body
{
  const res = await handleSignRequest(
    makeRequest({ path: '/login/phone/checkCode', contentMd5: MD5_OK }),
    ENV,
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.match(data.headers.Authorization, /^account test-key-id:/);
}

// 路径白名单
{
  const res = await handleSignRequest(
    makeRequest({ path: '/login/phone/other', contentMd5: MD5_OK }),
    ENV,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'path_not_allowed');
}

// 指纹格式
{
  const res = await handleSignRequest(
    makeRequest({ path: '/login/phone/sendMsgCode', contentMd5: 'not-a-md5' }),
    ENV,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_content_md5');
}

// 缺自定义头（挡浏览器跨站表单）
{
  const res = await handleSignRequest(
    makeRequest({ path: '/login/phone/sendMsgCode', contentMd5: MD5_OK }, { 'X-Loomy-Sign': '' }),
    ENV,
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'missing_sign_header');
}

// 非 POST
{
  const res = await handleSignRequest(
    new Request('https://my.onetone.app/loomy-sign', { method: 'GET' }),
    ENV,
  );
  assert.equal(res.status, 405);
}

// 缺密钥 —— 必须明确报「没配」，不能静默签错
{
  const res = await handleSignRequest(
    makeRequest({ path: '/login/phone/sendMsgCode', contentMd5: MD5_OK }),
    {},
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'sign_not_configured');
}

// 限流：同一 IP 连打 25 次，第 21 次起必须被拦
{
  _resetRateLimit();
  let limited = 0;
  for (let i = 0; i < 25; i++) {
    const res = await handleSignRequest(
      makeRequest({ path: '/login/phone/sendMsgCode', contentMd5: MD5_OK }, { 'CF-Connecting-IP': '1.2.3.4' }),
      ENV,
    );
    if (res.status === 429) limited++;
  }
  assert.equal(limited, 5, `限流应拦下 5 次，实际 ${limited}`);
}

// Pages 入口文件本身也要能跑通（functions/loomy-sign/index.js -> POST /loomy-sign）
{
  _resetRateLimit();
  const res = await onRequest({
    request: makeRequest({ path: '/login/phone/sendMsgCode', contentMd5: MD5_OK }),
    env: ENV,
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.match(data.headers.Authorization, /^account test-key-id:/);
  assert.equal(data.headers['Content-MD5'], MD5_OK);
}

_resetRateLimit();
console.log('ok test-loomy-sign');
