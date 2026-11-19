-- 核心种子数据：标签内容包与一个占位主源
--
-- 注意：
--   - 这里不接入任何第三方 RSS 地址，避免把未授权源写死进项目。
--   - 真正的 RSS / API 源应该在后台确认 rights_status 后再插入 sources 表。
--   - 标签包只是“内容兴趣入口”，用户选择后生成 platform_columns。
--
-- 用法：
--   psql "$DATABASE_URL" -f db/seed-core.sql

insert into sources (
  kind, name, url, feed_url, homepage_url, trust_score,
  rights_status, allow_snippet, allow_image, allow_fulltext, allow_cache, status
)
values (
  'manual',
  '主源编辑池',
  null,
  null,
  null,
  100,
  'authorized',
  true,
  false,
  false,
  false,
  'active'
)
on conflict do nothing;

insert into tag_packs (key, name, description, group_name, risk_level, status)
values
  ('news', '新闻速览', '综合新闻与时政媒体速览', '资讯', 'low', 'active'),
  ('hot', '热议', '社交与社区热榜速览，标题+短摘要+原文', '社区', 'medium', 'active'),
  ('funny', '轻松一刻', '梗图、冷笑话、神回复、轻阅读内容', '娱乐', 'low', 'active'),
  ('portrait', '人像美学', '人物摄影、光影构图、街头人像', '视觉', 'medium', 'active'),
  ('sight', '见闻', '街拍、旅行与日常视觉（站内见闻精选）', '视觉', 'low', 'active'),
  ('opensource', '开源推荐', '开源项目、论坛与独立开发社区', '社区', 'low', 'active'),
  ('ai', 'AI 资讯', '模型发布、工具更新、论文速递、Agent 实践', '科技', 'low', 'active'),
  ('design', '设计灵感', '界面、品牌、字体、配色、作品集', '视觉', 'low', 'active'),
  ('finance', '财经早报', '市场要闻、公司动态、宏观数据', '财经', 'medium', 'active'),
  ('tech', '科技新品', '硬件、软件、GitHub/V2EX 开发者热帖、消费电子', '科技', 'low', 'active'),
  ('movie', '电影音乐', '片单、音乐、演出、播客', '文化', 'low', 'active')
on conflict (key) do update set
  name = excluded.name,
  description = excluded.description,
  group_name = excluded.group_name,
  risk_level = excluded.risk_level,
  status = excluded.status,
  updated_at = now();

insert into tag_pack_sources (tag_pack_id, source_id, weight)
select tp.id, s.id, v.weight
from (values
  ('news', 100),
  ('hot', 100),
  ('funny', 100),
  ('portrait', 100),
  ('sight', 100),
  ('opensource', 100),
  ('ai', 100),
  ('design', 100),
  ('finance', 100),
  ('tech', 100),
  ('movie', 100)
) as v(key, weight)
join tag_packs tp on tp.key = v.key
join sources s on s.name = '主源编辑池'
on conflict do nothing;

-- 说明：human-readable 的运行状态不要写进 enum，直接由后台配置写入 settings JSON。
-- 例如用户选择轻松一刻 + 开源推荐后，由应用层写 platform_columns 表。
