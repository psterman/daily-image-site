/**
 * 讯飞星火（Loomy）短信登录签名 —— 纯逻辑，Node 与 Cloudflare Workers 通用。
 *
 * 为什么签名要搬到服务端：
 *   app 级 AccessKey 一旦进客户端就等于公开 —— 仓库 raw 匿名可读、
 *   安装包可解包，别人拿去冒用你的身份给任意手机号发短信。
 *   密钥挪进 Cloudflare Secret 后，客户端只拿到「签好的请求头」。
 *
 * 隐私上的额外好处（比「服务端转发整个请求体」更好）：
 *   签名串第 4 段是 base64(MD5(body))，不是 body 本身。
 *   客户端本地算好这个指纹再发过来，服务端只看到一串指纹，
 *   **看不到手机号，也看不到验证码**；上游请求仍由用户自己的 IP 发出，
 *   行为与改动前完全一致。
 *
 * 等价性（重要，改任何一处都要重跑对账）：
 *   buildSigningString / httpDateFromMs 与 src-tauri/src/loomy_oauth.rs
 *   的原实现逐字节一致 —— 由 tools/test-loomy-sign.mjs 用黄金向量对账。
 *   黄金向量由原 Rust 实现一次性生成后固化在测试里，任何一边改了都会红。
 */

/** 只允许给这两个接口签名 —— 否则等于开放一个「任意 body 签名器」。 */
export const SIGNABLE_PATHS = Object.freeze([
  '/login/phone/sendMsgCode',
  '/login/phone/checkCode',
]);

const DAYS = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC3986 转义（逐字对应 Rust 版 escape_rfc3986） */
export function escapeRfc3986(value) {
  let out = '';
  const bytes = new TextEncoder().encode(String(value));
  for (const b of bytes) {
    const unreserved =
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      (b >= 0x30 && b <= 0x39) || // 0-9
      b === 0x2d || // -
      b === 0x5f || // _
      b === 0x2e || // .
      b === 0x7e; // ~
    out += unreserved ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** 路径逐段转义（逐字对应 Rust 版 build_escaped_path） */
export function buildEscapedPath(rawPath) {
  let clean = String(rawPath).startsWith('/') ? String(rawPath) : `/${rawPath}`;
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, clean.length - 1);
  return clean
    .split('/')
    .map((seg) => (seg === '' ? '' : escapeRfc3986(seg)))
    .join('/');
}

/**
 * RFC 1123 GMT 时间头（逐字对应 Rust 版 httpdate_now）。
 * 手写而不是用 toUTCString()：后者的输出格式不是 CAccount 要的那种。
 */
export function httpDateFromMs(ms) {
  const secs = Math.floor(ms / 1000);
  const days = Math.floor(secs / 86400);
  const tod = secs % 86400;
  const hh = Math.floor(tod / 3600);
  const mm = Math.floor((tod % 3600) / 60);
  const ss = tod % 60;
  const weekday = DAYS[days % 7];
  // civil from days —— Howard Hinnant 算法（与 Rust 版逐字对应）
  const z = days + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${weekday}, ${p2(d)} ${MONTHS[m - 1]} ${year} ${p2(hh)}:${p2(mm)}:${p2(ss)} GMT`;
}

/**
 * CAccount 签名串：9 段、\n 分隔、结尾两个空段（即以 \n\n 结束）。
 * 第 4 段是请求体的 Content-MD5 指纹（base64(MD5(body))），不是 body。
 */
export function buildSigningString({
  method = 'POST',
  path,
  contentMd5 = '',
  contentType = 'application/json',
  date,
  nonce,
}) {
  return [
    String(method).toUpperCase(),
    buildEscapedPath(path),
    '',
    contentMd5,
    contentType,
    date,
    nonce,
    '',
    '',
  ].join('\n');
}

export function base64FromBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** HMAC-SHA1(secret, message) → base64 */
export async function hmacSha1Base64(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message)));
  return base64FromBytes(new Uint8Array(sig));
}

/**
 * 给一个请求体指纹签出一组请求头（与 Rust 版 auth_headers 一一对应）。
 * 返回的头就是上游要的那几个：Authorization / Date / Nonce / Content-Type / Accept / Content-MD5。
 */
export async function signRequest({
  accessKeyId,
  accessKeySecret,
  path,
  contentMd5 = '',
  date,
  nonce,
}) {
  const stringToSign = buildSigningString({ method: 'POST', path, contentMd5, date, nonce });
  const sig = await hmacSha1Base64(accessKeySecret, stringToSign);
  const headers = {
    Authorization: `account ${accessKeyId}:${sig}`,
    Date: date,
    Nonce: nonce,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (contentMd5) headers['Content-MD5'] = contentMd5;
  return headers;
}
