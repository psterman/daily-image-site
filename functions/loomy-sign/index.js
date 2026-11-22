/**
 * 讯飞星火（Loomy）短信登录签名服务 —— POST /loomy-sign
 *
 * 桌面端（OneTone）发短信验证码前，先来这里换一组签名请求头。
 * app 级密钥只存在 Cloudflare Secret 里，客户端与仓库都不再持有。
 *
 * 实现见 lib/loomy-signature.mjs（签名算法）与 lib/loomy-sign-service.mjs（HTTP 层）。
 */
import { handleSignRequest } from '../../lib/loomy-sign-service.mjs';

export async function onRequest(context) {
  const { request, env } = context;
  return handleSignRequest(request, env);
}
