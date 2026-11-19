-- daily-image-site 自建平台：安装到独立 schema 'platform'
-- 与现有 onetone 的 public 表完全隔离，零冲突
-- 由 Management API 代执行生成

create schema if not exists platform;
grant usage on schema platform to anon, authenticated;
set search_path to platform, public;

-- ===== PART 1: 建表 =====
-- daily-image-site / 用户自建信息平台：核心数据模型
--
-- 目标：
--   1. 后端中立：这是一套 PostgreSQL / Supabase 兼容的规范模型，后续可映射到
--      WorkBuddy 内置云服务、Cloudflare D1 或 Supabase。
--   2. 平台为核心：用户不是“订阅一个中央头条”，而是拥有自己的 platform。
--   3. 版权优先：默认只存索引、短导读、原文链接；全文与图片必须带授权字段。
--   4. 可审计：AI 筛选、审稿、广告、投诉都要有状态与日志。
--
-- 设计原则：
--   - 所有表使用 UUID 主键。
--   - 所有业务表带 created_at / updated_at。
--   - 不使用外键约束表达多态关系（follows / complaints / audit_logs），
--     由应用层校验 target_type + target_id。
--   - 默认不存正文全文；content_bodies 只在授权存在时使用。
--
-- 用法：
--   psql "$DATABASE_URL" -f db/schema.sql
--   psql "$DATABASE_URL" -f db/seed-core.sql

create extension if not exists pgcrypto;

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. 账号
-- ---------------------------------------------------------------------------

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  phone text unique,
  display_name text not null default '用户',
  avatar_url text,
  locale text not null default 'zh-CN',
  timezone text not null default 'Asia/Shanghai',
  status text not null default 'active'
    check (status in ('active', 'suspended', 'deleted')),
  plan text not null default 'free'
    check (plan in ('free', 'pro', 'brand', 'enterprise')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email is not null or phone is not null)
);

comment on table users is '平台账号。注册后可拥有一个或多个自建信息平台。';

-- ---------------------------------------------------------------------------
-- 2. 用户平台与栏目
-- ---------------------------------------------------------------------------

create table if not exists platforms (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  slug text not null unique,
  name text not null,
  description text,
  site_url text,
  custom_domain text unique,
  visibility text not null default 'private'
    check (visibility in ('private', 'unlisted', 'public')),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'archived')),
  default_timezone text not null default 'Asia/Shanghai',
  publish_time time not null default '07:30',
  ai_mode text not null default 'assisted'
    check (ai_mode in ('manual', 'assisted', 'auto')),
  review_policy text not null default 'human_confirm'
    check (review_policy in ('human_all', 'human_confirm', 'auto_trusted')),
  theme jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table platforms is '用户自建的信息平台。这是产品的核心对象，不是普通订阅关系。';

create table if not exists tag_packs (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  group_name text,
  risk_level text not null default 'low'
    check (risk_level in ('low', 'medium', 'high')),
  status text not null default 'active'
    check (status in ('active', 'disabled')),
  sample_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table tag_packs is '主源预配置的内容包，例如搞笑、人像美学、开源推荐、AI 资讯。';

create table if not exists platform_columns (
  id uuid primary key default gen_random_uuid(),
  platform_id uuid not null references platforms(id) on delete cascade,
  tag_pack_id uuid references tag_packs(id) on delete set null,
  key text not null,
  name text not null,
  position integer not null default 0,
  max_items integer not null default 6 check (max_items between 1 and 100),
  enabled boolean not null default true,
  source_mode text not null default 'tag_pack'
    check (source_mode in ('tag_pack', 'followed_platform', 'manual', 'mixed')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform_id, key)
);

comment on table platform_columns is '用户平台里的栏目。栏目固定，才有阅读习惯。';

-- ---------------------------------------------------------------------------
-- 3. 信息源与版权
-- ---------------------------------------------------------------------------

create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete set null,
  kind text not null
    check (kind in ('official', 'rss', 'api', 'manual', 'platform', 'newsletter', 'social')),
  name text not null,
  url text,
  feed_url text,
  homepage_url text,
  trust_score integer not null default 0 check (trust_score between 0 and 100),
  rights_status text not null default 'unknown'
    check (rights_status in ('unknown', 'authorized', 'official_api', 'cc_licensed', 'public_domain', 'blocked')),
  license text,
  allow_snippet boolean not null default true,
  allow_image boolean not null default false,
  allow_fulltext boolean not null default false,
  allow_cache boolean not null default false,
  takedown_contact text,
  status text not null default 'active'
    check (status in ('active', 'disabled', 'flagged')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table sources is '内容源。rights_* 字段决定能展示标题、摘要、图片还是全文。';

create table if not exists tag_pack_sources (
  tag_pack_id uuid not null references tag_packs(id) on delete cascade,
  source_id uuid not null references sources(id) on delete cascade,
  weight integer not null default 100,
  created_at timestamptz not null default now(),
  primary key (tag_pack_id, source_id)
);

comment on table tag_pack_sources is '内容包与信息源的多对多关系。';

-- ---------------------------------------------------------------------------
-- 4. 内容池
-- ---------------------------------------------------------------------------

create table if not exists content_items (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete cascade,
  canonical_url text not null,
  content_hash text not null,
  content_type text not null default 'article'
    check (content_type in ('article', 'image', 'video', 'podcast', 'link', 'note')),
  title text not null,
  summary text,
  author text,
  image_url text,
  published_at timestamptz,
  language text not null default 'zh-CN',
  rights_status text not null default 'unknown'
    check (rights_status in ('unknown', 'authorized', 'official_api', 'cc_licensed', 'public_domain')),
  license text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, content_hash)
);

comment on table content_items is '统一内容对象。默认只存标题、短摘要、原文链接，不强制存全文。';

create table if not exists content_bodies (
  content_item_id uuid primary key references content_items(id) on delete cascade,
  body_html text,
  body_text text,
  rights_basis text not null,
  license text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table content_bodies is '仅授权内容使用的正文存储。未授权内容不应出现在这里。';

create table if not exists content_tags (
  content_item_id uuid not null references content_items(id) on delete cascade,
  tag_pack_id uuid not null references tag_packs(id) on delete cascade,
  confidence numeric(5,2) not null default 100 check (confidence between 0 and 100),
  created_at timestamptz not null default now(),
  primary key (content_item_id, tag_pack_id)
);

-- ---------------------------------------------------------------------------
-- 5. 每日候选池、审稿与发布
-- ---------------------------------------------------------------------------

create table if not exists candidate_entries (
  id uuid primary key default gen_random_uuid(),
  platform_id uuid not null references platforms(id) on delete cascade,
  column_id uuid references platform_columns(id) on delete set null,
  content_item_id uuid not null references content_items(id) on delete cascade,
  issue_date date not null,
  source_type text not null default 'tag_pack'
    check (source_type in ('tag_pack', 'followed_platform', 'manual', 'ai_discovery')),
  score numeric(5,2) not null default 0 check (score between 0 and 100),
  ai_reason text,
  dedupe_group text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'pinned', 'trashed')),
  rank integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform_id, issue_date, content_item_id)
);

comment on table candidate_entries is '每个用户平台每天的候选池。审稿台操作的就是这张表。';

create table if not exists issues (
  id uuid primary key default gen_random_uuid(),
  platform_id uuid not null references platforms(id) on delete cascade,
  issue_date date not null,
  status text not null default 'draft'
    check (status in ('draft', 'review', 'published', 'failed')),
  title text,
  summary text,
  digest_json jsonb,
  public_url text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform_id, issue_date)
);

comment on table issues is '一期日报。digest_json 与现有 digest.json 概念对齐。';

create table if not exists issue_items (
  issue_id uuid not null references issues(id) on delete cascade,
  content_item_id uuid not null references content_items(id) on delete cascade,
  column_id uuid references platform_columns(id) on delete set null,
  rank integer not null default 0,
  editor_note text,
  is_headline boolean not null default false,
  display_mode text not null default 'link_card'
    check (display_mode in ('link_card', 'short_preview', 'authorized_full')),
  created_at timestamptz not null default now(),
  primary key (issue_id, content_item_id)
);

comment on table issue_items is '已通过审核并进入当期日报的内容。';

-- ---------------------------------------------------------------------------
-- 6. 关注、订阅与分发
-- ---------------------------------------------------------------------------

create table if not exists follows (
  id uuid primary key default gen_random_uuid(),
  follower_user_id uuid not null references users(id) on delete cascade,
  target_type text not null
    check (target_type in ('platform', 'column', 'tag_pack')),
  target_id uuid not null,
  notify_enabled boolean not null default true,
  status text not null default 'active'
    check (status in ('active', 'muted')),
  created_at timestamptz not null default now(),
  unique (follower_user_id, target_type, target_id)
);

comment on table follows is '关注关系。可关注平台、栏目或标签包。target_id 由应用层校验。';

create table if not exists delivery_channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  platform_id uuid references platforms(id) on delete cascade,
  channel_type text not null
    check (channel_type in ('email', 'telegram', 'webpush', 'rss')),
  target text not null,
  verified boolean not null default false,
  enabled boolean not null default true,
  send_mode text not null default 'reminder'
    check (send_mode in ('reminder', 'full_digest', 'feed_only')),
  send_time time not null default '07:30',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, platform_id, channel_type, target)
);

comment on table delivery_channels is '用户自己的分发渠道。默认 reminder，只提醒回站，避免全文搬运。';

create table if not exists issue_deliveries (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues(id) on delete cascade,
  channel_id uuid not null references delivery_channels(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'skipped')),
  provider_message_id text,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (issue_id, channel_id)
);

comment on table issue_deliveries is '每期对每个渠道的发送结果，保证幂等。';

-- ---------------------------------------------------------------------------
-- 7. 广告与商业化
-- ---------------------------------------------------------------------------

create table if not exists ad_slots (
  id uuid primary key default gen_random_uuid(),
  platform_id uuid not null references platforms(id) on delete cascade,
  key text not null,
  placement text not null
    check (placement in ('header', 'mid', 'footer', 'directory', 'recommendation')),
  format text not null default 'link'
    check (format in ('link', 'text', 'image', 'card')),
  status text not null default 'active'
    check (status in ('active', 'paused')),
  price_cents integer not null default 0 check (price_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform_id, key)
);

comment on table ad_slots is '用户平台里的广告位。第一阶段以用户自有推广位为主。';

create table if not exists ad_creatives (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  title text not null,
  body text,
  target_url text not null,
  image_url text,
  rights_attestation boolean not null default false,
  status text not null default 'draft'
    check (status in ('draft', 'pending', 'approved', 'rejected', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table ad_creatives is '广告素材。rights_attestation 表示提交者确认拥有素材与图片授权。';

create table if not exists ad_placements (
  id uuid primary key default gen_random_uuid(),
  ad_slot_id uuid not null references ad_slots(id) on delete cascade,
  creative_id uuid not null references ad_creatives(id) on delete cascade,
  platform_id uuid not null references platforms(id) on delete cascade,
  issue_id uuid references issues(id) on delete set null,
  starts_at timestamptz,
  ends_at timestamptz,
  daily_cap integer,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'active', 'paused', 'expired', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ad_events (
  id uuid primary key default gen_random_uuid(),
  placement_id uuid not null references ad_placements(id) on delete cascade,
  platform_id uuid references platforms(id) on delete set null,
  viewer_user_id uuid references users(id) on delete set null,
  event_type text not null check (event_type in ('impression', 'click')),
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- 8. 行为、审计、AI 与版权投诉
-- ---------------------------------------------------------------------------

create table if not exists reader_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  platform_id uuid not null references platforms(id) on delete cascade,
  issue_id uuid references issues(id) on delete set null,
  content_item_id uuid references content_items(id) on delete set null,
  event_type text not null
    check (event_type in ('view', 'open', 'save', 'dismiss', 'original_click', 'share', 'follow')),
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

comment on table reader_events is '阅读行为。用于形成用户画像、关注推荐和阅读习惯分析。';

create table if not exists ai_runs (
  id uuid primary key default gen_random_uuid(),
  platform_id uuid not null references platforms(id) on delete cascade,
  issue_date date not null,
  stage text not null
    check (stage in ('fetch', 'dedupe', 'rank', 'summarize', 'review', 'render', 'send')),
  model text,
  prompt_version text,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed')),
  input_refs jsonb not null default '[]'::jsonb,
  output_refs jsonb not null default '[]'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

comment on table ai_runs is 'AI 自动运营审计。每一步模型调用都要可追踪。';

create table if not exists rights_complaints (
  id uuid primary key default gen_random_uuid(),
  complainant_user_id uuid references users(id) on delete set null,
  complainant_email text,
  target_type text not null
    check (target_type in ('content_item', 'source', 'platform', 'ad_creative')),
  target_id uuid not null,
  reason text not null,
  evidence_url text,
  status text not null default 'open'
    check (status in ('open', 'processing', 'resolved', 'rejected')),
  resolution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table rights_complaints is '版权 / 肖像 / 广告投诉入口。上线前必须具备。';

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id) on delete set null,
  platform_id uuid references platforms(id) on delete set null,
  action text not null,
  target_type text,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table audit_logs is '平台操作日志。审稿、发布、广告审核、投诉处理都写这里。';

-- ---------------------------------------------------------------------------
-- 9. 索引
-- ---------------------------------------------------------------------------

create index if not exists idx_platforms_owner on platforms(owner_user_id);
create index if not exists idx_platform_columns_platform on platform_columns(platform_id, position);
create index if not exists idx_sources_kind_status on sources(kind, status);
create index if not exists idx_sources_rights on sources(rights_status);
create index if not exists idx_content_items_source on content_items(source_id);
create index if not exists idx_content_items_published on content_items(published_at desc);
create index if not exists idx_content_tags_tag on content_tags(tag_pack_id);
create index if not exists idx_candidates_platform_date on candidate_entries(platform_id, issue_date);
create index if not exists idx_candidates_status on candidate_entries(status);
create index if not exists idx_candidates_content on candidate_entries(content_item_id);
create index if not exists idx_issues_platform_date on issues(platform_id, issue_date);
create index if not exists idx_issue_items_issue_rank on issue_items(issue_id, rank);
create index if not exists idx_follows_follower on follows(follower_user_id, target_type);
create index if not exists idx_follows_target on follows(target_type, target_id);
create index if not exists idx_delivery_user_platform on delivery_channels(user_id, platform_id);
create index if not exists idx_issue_deliveries_issue on issue_deliveries(issue_id);
create index if not exists idx_ad_slots_platform on ad_slots(platform_id);
create index if not exists idx_ad_events_placement on ad_events(placement_id, occurred_at);
create index if not exists idx_reader_events_platform on reader_events(platform_id, occurred_at desc);
create index if not exists idx_reader_events_user on reader_events(user_id, occurred_at desc);
create index if not exists idx_ai_runs_platform_date on ai_runs(platform_id, issue_date);
create index if not exists idx_complaints_status on rights_complaints(status);
create index if not exists idx_audit_logs_platform on audit_logs(platform_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 10. updated_at 触发器
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'users', 'platforms', 'tag_packs', 'platform_columns', 'sources',
    'content_items', 'content_bodies', 'candidate_entries', 'issues',
    'delivery_channels', 'ad_slots', 'ad_creatives', 'ad_placements',
    'rights_complaints'
  ]
  loop
    execute format(
      'drop trigger if exists trg_%s_updated_at on %I',
      t, t
    );
    execute format(
      'create trigger trg_%s_updated_at before update on %I for each row execute function set_updated_at()',
      t, t
    );
  end loop;
end $$;

-- ===== PART 2: 种子数据 =====
set search_path to platform, public;
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
  ('hot', '综合速览', '热议速览（对齐 tophub 综合），标题+短摘要+原文', '综合', 'medium', 'active'),
  ('funny', '轻松一刻', '梗图、冷笑话、神回复、轻阅读内容', '娱乐', 'low', 'active'),
  ('portrait', '人像美学', '人物摄影、光影构图、街头人像', '视觉', 'medium', 'active'),
  ('opensource', '开源推荐', 'GitHub 项目、开发工具、开源框架', '社区', 'low', 'active'),
  ('ai', 'AI 资讯', '模型发布、工具更新、论文速递、Agent 实践', '科技', 'low', 'active'),
  ('design', '设计灵感', '界面、品牌、字体、配色、作品集', '视觉', 'low', 'active'),
  ('finance', '财经早报', '市场要闻、公司动态、宏观数据', '财经', 'medium', 'active'),
  ('tech', '科技新品', '硬件、软件、开发者工具、消费电子', '科技', 'low', 'active'),
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
  ('hot', 100),
  ('funny', 100),
  ('portrait', 100),
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

-- ===== PART 3: Supabase 集成 + RLS =====
set search_path to platform, public;
-- ===========================================================================
-- daily-image-site / 用户自建平台：Supabase 集成迁移
-- ===========================================================================
-- 前置：先执行 db/schema.sql（建表 + 索引 + updated_at 触发器），
--       再执行 db/seed-core.sql（标签包 + 主源占位）。
-- 本文件负责 Supabase 专属的三件事：
--   1. Auth 集成：auth.users 新用户 -> platform.users 业务行
--   2. RLS 行级隔离：用户只能碰自己的平台私有数据
--   3. 公开读：仅 visibility=public 且已发布的 issue 对外可读
--
-- 设计边界（重要）：
--   - 主源共享池 sources / tag_packs / content_items / content_tags：
--     所有登录用户可读，但只有 service_role（管理端 / Edge Function）能写。
--     这对应产品定位「主源由我们预配置，用户只做选择和审稿」。
--   - 平台私有数据 platforms / platform_columns / candidate_entries /
--     issues / issue_items / delivery_channels / follows：owner 可读写。
--   - 广告 / 投诉 / 阅读事件 / AI 审计：写受控，读按 owner。
--
-- 执行顺序：
--   psql "$SUPABASE_DB_URL" -f db/schema.sql
--   psql "$SUPABASE_DB_URL" -f db/seed-core.sql
--   psql "$SUPABASE_DB_URL" -f supabase/migration.sql
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. RLS 辅助函数（security definer 绕过 RLS，避免策略自引用递归）
-- ---------------------------------------------------------------------------

-- 判断平台是否属于当前登录用户
create or replace function platform.is_platform_owner(p_platform_id uuid)
returns boolean
language sql
security definer
stable
set search_path = platform, public
as $$
  select exists (
    select 1 from platform.platforms p
    where p.id = p_platform_id
      and p.owner_user_id = auth.uid()
  );
$$;

-- 判断平台是否可被公开读取
create or replace function platform.is_platform_public(p_platform_id uuid)
returns boolean
language sql
security definer
stable
set search_path = platform, public
as $$
  select exists (
    select 1 from platform.platforms p
    where p.id = p_platform_id
      and p.visibility = 'public'
      and p.status = 'active'
  );
$$;

-- 判断某一期是否已发布且所属平台公开（公开页读 issue / issue_items 用）
create or replace function platform.is_issue_public(p_issue_id uuid)
returns boolean
language sql
security definer
stable
set search_path = platform, public
as $$
  select exists (
    select 1 from platform.issues i
    join platform.platforms p on p.id = i.platform_id
    where i.id = p_issue_id
      and i.status = 'published'
      and p.visibility = 'public'
      and p.status = 'active'
  );
$$;

-- ---------------------------------------------------------------------------
-- 1. Auth 集成：注册后自动建业务 user 行（platform.users.id = auth.users.id）
-- ---------------------------------------------------------------------------

create or replace function platform.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = platform, public
as $$
declare
  v_email text := new.email;
  v_phone text := nullif(new.raw_user_meta_data ->> 'phone', '');
  v_name  text := nullif(new.raw_user_meta_data ->> 'display_name', '');
begin
  -- 既无邮箱也无手机号时不建行（避免违反 users 表的 check 约束）
  if v_email is null and v_phone is null then
    return new;
  end if;

  insert into platform.users (id, email, phone, display_name)
  values (
    new.id,
    v_email,
    v_phone,
    coalesce(v_name, '用户')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function platform.handle_new_auth_user();

comment on function platform.handle_new_auth_user is
  'Supabase Auth 注册后自动同步业务用户，保证 auth.uid() 直接等于 platform.users.id。';

-- ---------------------------------------------------------------------------
-- 2. 开启 RLS + 授权
-- ---------------------------------------------------------------------------

alter table users                enable row level security;
alter table platforms            enable row level security;
alter table tag_packs            enable row level security;
alter table platform_columns     enable row level security;
alter table sources              enable row level security;
alter table tag_pack_sources     enable row level security;
alter table content_items        enable row level security;
alter table content_bodies       enable row level security;
alter table content_tags         enable row level security;
alter table candidate_entries    enable row level security;
alter table issues               enable row level security;
alter table issue_items          enable row level security;
alter table follows              enable row level security;
alter table delivery_channels    enable row level security;
alter table issue_deliveries     enable row level security;
alter table ad_slots             enable row level security;
alter table ad_creatives         enable row level security;
alter table ad_placements        enable row level security;
alter table ad_events            enable row level security;
alter table reader_events        enable row level security;
alter table ai_runs              enable row level security;
alter table rights_complaints    enable row level security;
alter table audit_logs           enable row level security;

-- Supabase 默认已 grant，这里显式声明以便独立 PostgreSQL 环境也能用
grant usage on schema platform to anon, authenticated;
grant select on all tables in schema platform to anon, authenticated;
grant insert, update, delete on all tables in schema platform to authenticated;

-- ---------------------------------------------------------------------------
-- 3. 账号：本人读写自己
-- ---------------------------------------------------------------------------

drop policy if exists users_select_self on users;
create policy users_select_self on users
  for select to authenticated using (id = auth.uid());

drop policy if exists users_insert_self on users;
create policy users_insert_self on users
  for insert to authenticated
  with check (id = auth.uid());

drop policy if exists users_update_self on users;
create policy users_update_self on users
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- 说明：Auth 触发器会预建 users 行；前端 saveDb 仍用 upsert。
-- Postgres 对 INSERT…ON CONFLICT 仍检查 INSERT 策略，故必须有 insert self。

-- ---------------------------------------------------------------------------
-- 4. 平台与栏目：owner 全权；公开平台对外可读
-- ---------------------------------------------------------------------------

drop policy if exists platforms_owner_all on platforms;
create policy platforms_owner_all on platforms
  for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

drop policy if exists platforms_public_read on platforms;
create policy platforms_public_read on platforms
  for select to anon, authenticated
  using (visibility = 'public' and status = 'active');

drop policy if exists columns_owner_all on platform_columns;
create policy columns_owner_all on platform_columns
  for all to authenticated
  using (platform.is_platform_owner(platform_id))
  with check (platform.is_platform_owner(platform_id));

drop policy if exists columns_public_read on platform_columns;
create policy columns_public_read on platform_columns
  for select to anon, authenticated
  using (platform.is_platform_public(platform_id));

-- ---------------------------------------------------------------------------
-- 5. 主源共享池：所有人可读，只有 service_role 可写（无 policy 即拒绝）
-- ---------------------------------------------------------------------------

drop policy if exists tagpacks_read on tag_packs;
create policy tagpacks_read on tag_packs for select to anon, authenticated using (status = 'active');

drop policy if exists sources_read on sources;
create policy sources_read on sources for select to anon, authenticated using (status = 'active');

drop policy if exists tagpack_sources_read on tag_pack_sources;
create policy tagpack_sources_read on tag_pack_sources for select to anon, authenticated using (true);

drop policy if exists content_read on content_items;
create policy content_read on content_items for select to anon, authenticated using (true);

drop policy if exists contenttags_read on content_tags;
create policy contenttags_read on content_tags for select to anon, authenticated using (true);

-- 正文只在显式授权时对外可读；默认无 policy -> 只有 service_role 可读
drop policy if exists bodies_authorized_read on content_bodies;
create policy bodies_authorized_read on content_bodies
  for select to authenticated
  using (
    exists (
      select 1 from content_items ci
      where ci.id = content_item_id and ci.rights_status in ('authorized', 'official_api', 'cc_licensed', 'public_domain')
    )
  );

-- ---------------------------------------------------------------------------
-- 6. 候选池 / 发布：owner 全权；已发布且公开的期对外可读
-- ---------------------------------------------------------------------------

drop policy if exists candidates_owner_all on candidate_entries;
create policy candidates_owner_all on candidate_entries
  for all to authenticated
  using (platform.is_platform_owner(platform_id))
  with check (platform.is_platform_owner(platform_id));

drop policy if exists issues_owner_all on issues;
create policy issues_owner_all on issues
  for all to authenticated
  using (platform.is_platform_owner(platform_id))
  with check (platform.is_platform_owner(platform_id));

drop policy if exists issues_public_read on issues;
create policy issues_public_read on issues
  for select to anon, authenticated
  using (status = 'published' and platform.is_platform_public(platform_id));

-- issue_items 表无 platform_id，经 issues 反查 owner（旧写法引用不存在的列，策略会建失败）
drop policy if exists issueitems_owner_all on issue_items;
create policy issueitems_owner_all on issue_items
  for all to authenticated
  using (platform.is_platform_owner((select platform_id from issues where id = issue_id)))
  with check (platform.is_platform_owner((select platform_id from issues where id = issue_id)));

drop policy if exists issueitems_public_read on issue_items;
create policy issueitems_public_read on issue_items
  for select to anon, authenticated
  using (platform.is_issue_public(issue_id));

-- ---------------------------------------------------------------------------
-- 7. 关注 / 分发：本人读写
-- ---------------------------------------------------------------------------

drop policy if exists follows_own on follows;
create policy follows_own on follows
  for all to authenticated
  using (follower_user_id = auth.uid()) with check (follower_user_id = auth.uid());

drop policy if exists channels_own on delivery_channels;
create policy channels_own on delivery_channels
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists deliveries_own on issue_deliveries;
create policy deliveries_own on issue_deliveries
  for all to authenticated
  using (
    exists (select 1 from delivery_channels c where c.id = channel_id and c.user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 8. 广告 / 阅读 / AI / 投诉 / 审计：按 owner 或本人
-- ---------------------------------------------------------------------------

drop policy if exists adslots_owner on ad_slots;
create policy adslots_owner on ad_slots
  for all to authenticated
  using (platform.is_platform_owner(platform_id)) with check (platform.is_platform_owner(platform_id));

drop policy if exists adcreatives_owner on ad_creatives;
create policy adcreatives_owner on ad_creatives
  for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

drop policy if exists adplacements_owner on ad_placements;
create policy adplacements_owner on ad_placements
  for all to authenticated
  using (platform.is_platform_owner(platform_id)) with check (platform.is_platform_owner(platform_id));

-- 公开页可看已生效的广告位与素材（用于引流位渲染）
drop policy if exists adslots_public_read on ad_slots;
create policy adslots_public_read on ad_slots
  for select to anon, authenticated
  using (status = 'active' and platform.is_platform_public(platform_id));

drop policy if exists reader_events_owner on reader_events;
create policy reader_events_owner on reader_events
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists ai_runs_owner on ai_runs;
create policy ai_runs_owner on ai_runs
  for all to authenticated
  using (platform.is_platform_owner(platform_id)) with check (platform.is_platform_owner(platform_id));

drop policy if exists complaints_own on rights_complaints;
create policy complaints_own on rights_complaints
  for all to authenticated
  using (
    complainant_user_id = auth.uid()
    or platform.is_platform_owner(target_id)
  )
  with check (complainant_user_id = auth.uid());

-- 审计：可读自己的/自己平台的；只能以本人身份写入（不可改删）
drop policy if exists audit_owner on audit_logs;
drop policy if exists audit_select_own on audit_logs;
drop policy if exists audit_insert_own on audit_logs;
create policy audit_select_own on audit_logs
  for select to authenticated
  using (
    actor_user_id = auth.uid()
    or (platform_id is not null and platform.is_platform_owner(platform_id))
  );
create policy audit_insert_own on audit_logs
  for insert to authenticated
  with check (actor_user_id = auth.uid());

-- ad_events / tag_pack_sources 只写由服务端：
--   ad_events 需要匿名埋点 -> 用 service_role 的 Edge Function 接收后写入，
--   这里不开放 anon 直写，避免刷量。

-- ---------------------------------------------------------------------------
-- 9. 完成
-- ---------------------------------------------------------------------------

comment on table platforms is
  '平台核心对象。RLS: owner 全权 / visibility=public 且 active 时对外可读。';
