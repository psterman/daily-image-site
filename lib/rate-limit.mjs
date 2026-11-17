/**
 * 共享的按 IP 哈希限流器。
 *
 * 留言板和点赞接口的限流逻辑结构一样，只有几个常量不同，所以抽出来共用一份。
 * IP 只存加盐哈希，不存原始 IP。
 */
import { readJson, mutate, sha256hex } from './r2-json.mjs';

/**
 * @param {object} cfg
 * @param {string} cfg.key         计数文件在 R2 里的 key
 * @param {string} cfg.salt        哈希盐（不同用途要用不同的盐，避免哈希可互相反查）
 * @param {number} cfg.perMinute   每分钟上限
 * @param {number} cfg.perHour     每小时上限
 * @param {number} cfg.historyMax  计数文件里最多留多少条历史
 */
export function makeRateLimiter(cfg) {
  const { key, salt, perMinute, perHour, historyMax } = cfg;

  return {
    key,

    async check(bucket, request) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      // 加盐再哈希：不存原始 IP，也避免有人反查哈希表
      const ipHash = (await sha256hex(salt + '|' + ip)).slice(0, 16);
      const now = Date.now();
      const rate = await readJson(bucket, key, { hits: [] });
      const hits = Array.isArray(rate.hits) ? rate.hits : [];
      const hourAgo = now - 3600_000;

      const mine = hits.filter((h) => h && h.ip === ipHash && typeof h.ts === 'number' && h.ts > hourAgo);
      const inMinute = mine.filter((h) => h.ts > now - 60_000).length;

      if (inMinute >= perMinute || mine.length >= perHour) {
        return { ok: false, ipHash, retryAfter: inMinute >= perMinute ? 60 : 600 };
      }

      return { ok: true, ipHash, now };
    },

    async record(bucket, ipHash, now) {
      try {
        await mutate(bucket, key, { hits: [] }, (data) => {
          const hourAgo = now - 3600_000;
          const hits = (Array.isArray(data.hits) ? data.hits : []).filter(
            (h) => h && typeof h.ts === 'number' && h.ts > hourAgo,
          );
          hits.push({ ts: now, ip: ipHash });
          data.hits = hits.slice(-historyMax);
        });
      } catch {
        // 限流计数写失败不该拦住用户操作 —— 顶多少拦一次
      }
    },
  };
}
