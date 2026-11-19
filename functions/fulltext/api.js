/**
 * 按需全文 —— /fulltext/api?url=
 *
 * 点开才拉原文页并抽取正文。不写 R2 / 不进 Supabase 共享池。
 * 响应可短缓存，热文重复点开省 Workers 出站。
 */
import { json } from '../../lib/r2-json.mjs';
import { fetchFulltext, safeArticleUrl } from '../../lib/fulltext-fetch.mjs';

function cors(extra) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept',
    ...(extra || {}),
  };
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors() });
  }
  if (request.method !== 'GET') {
    return json({ ok: false, error: '只支持 GET' }, 405, cors());
  }

  const target = safeArticleUrl(new URL(request.url).searchParams.get('url'));
  if (!target) return json({ ok: false, error: '缺少合法 url 参数' }, 400, cors());

  const out = await fetchFulltext(target);
  if (!out.ok) {
    return json(
      { ok: false, error: out.error || '全文失败', strategy: out.strategy },
      out.status || 502,
      cors({
        'Cache-Control': out.status === 422 ? 'private, max-age=60' : 'no-store',
      }),
    );
  }

  return json(
    {
      ok: true,
      title: out.title,
      text: out.text,
      html: out.html || '',
      chars: out.chars,
      source: out.source,
      strategy: out.strategy,
    },
    200,
    cors({
      // 同 URL 一小时内边缘可复用；不落 R2，也不进业务库
      'Cache-Control': 'public, max-age=3600',
    }),
  );
}
