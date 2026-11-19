-- ===========================================================================
-- daily-image-site / 用户自建平台：Supabase 集成迁移
-- ===========================================================================
-- 前置：先执行 db/schema.sql（建表 + 索引 + updated_at 触发器），
--       再执行 db/seed-core.sql（标签包 + 主源占位）。
-- 本文件负责 Supabase 专属的三件事：
--   1. Auth 集成：auth.users 新用户 -> public.users 业务行
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
create or replace function public.is_platform_owner(p_platform_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.platforms p
    where p.id = p_platform_id
      and p.owner_user_id = auth.uid()
  );
$$;

-- 判断平台是否可被公开读取
create or replace function public.is_platform_public(p_platform_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.platforms p
    where p.id = p_platform_id
      and p.visibility = 'public'
      and p.status = 'active'
  );
$$;

-- 判断某一期是否已发布且所属平台公开（公开页读 issue / issue_items 用）
create or replace function public.is_issue_public(p_issue_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.issues i
    join public.platforms p on p.id = i.platform_id
    where i.id = p_issue_id
      and i.status = 'published'
      and p.visibility = 'public'
      and p.status = 'active'
  );
$$;

-- ---------------------------------------------------------------------------
-- 1. Auth 集成：注册后自动建业务 user 行（public.users.id = auth.users.id）
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
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

  insert into public.users (id, email, phone, display_name)
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
  for each row execute function public.handle_new_auth_user();

comment on function public.handle_new_auth_user is
  'Supabase Auth 注册后自动同步业务用户，保证 auth.uid() 直接等于 public.users.id。';

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
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on all tables in schema public to authenticated;

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
  using (public.is_platform_owner(platform_id))
  with check (public.is_platform_owner(platform_id));

drop policy if exists columns_public_read on platform_columns;
create policy columns_public_read on platform_columns
  for select to anon, authenticated
  using (public.is_platform_public(platform_id));

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
  using (public.is_platform_owner(platform_id))
  with check (public.is_platform_owner(platform_id));

drop policy if exists issues_owner_all on issues;
create policy issues_owner_all on issues
  for all to authenticated
  using (public.is_platform_owner(platform_id))
  with check (public.is_platform_owner(platform_id));

drop policy if exists issues_public_read on issues;
create policy issues_public_read on issues
  for select to anon, authenticated
  using (status = 'published' and public.is_platform_public(platform_id));

-- issue_items 无 platform_id，经 issues 反查 owner
drop policy if exists issueitems_owner_all on issue_items;
create policy issueitems_owner_all on issue_items
  for all to authenticated
  using (public.is_platform_owner((select platform_id from issues where id = issue_id)))
  with check (public.is_platform_owner((select platform_id from issues where id = issue_id)));

drop policy if exists issueitems_public_read on issue_items;
create policy issueitems_public_read on issue_items
  for select to anon, authenticated
  using (public.is_issue_public(issue_id));

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
  using (public.is_platform_owner(platform_id)) with check (public.is_platform_owner(platform_id));

drop policy if exists adcreatives_owner on ad_creatives;
create policy adcreatives_owner on ad_creatives
  for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

drop policy if exists adplacements_owner on ad_placements;
create policy adplacements_owner on ad_placements
  for all to authenticated
  using (public.is_platform_owner(platform_id)) with check (public.is_platform_owner(platform_id));

-- 公开页可看已生效的广告位与素材（用于引流位渲染）
drop policy if exists adslots_public_read on ad_slots;
create policy adslots_public_read on ad_slots
  for select to anon, authenticated
  using (status = 'active' and public.is_platform_public(platform_id));

drop policy if exists reader_events_owner on reader_events;
create policy reader_events_owner on reader_events
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists ai_runs_owner on ai_runs;
create policy ai_runs_owner on ai_runs
  for all to authenticated
  using (public.is_platform_owner(platform_id)) with check (public.is_platform_owner(platform_id));

drop policy if exists complaints_own on rights_complaints;
create policy complaints_own on rights_complaints
  for all to authenticated
  using (
    complainant_user_id = auth.uid()
    or public.is_platform_owner(target_id)
  )
  with check (complainant_user_id = auth.uid());

drop policy if exists audit_owner on audit_logs;
drop policy if exists audit_select_own on audit_logs;
drop policy if exists audit_insert_own on audit_logs;
create policy audit_select_own on audit_logs
  for select to authenticated
  using (
    actor_user_id = auth.uid()
    or (platform_id is not null and public.is_platform_owner(platform_id))
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
