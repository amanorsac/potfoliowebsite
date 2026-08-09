-- =====================================================================
--  SITE ANALYTICS
--  Run this once in Supabase → SQL Editor → New query → Run.
--
--  What it does: gives the site somewhere to record page views, and
--  gives the admin portal four read-only reports over them.
--
--  The shape matters. Visitors are anonymous - they have no login - so
--  they cannot be allowed to read or change anything. They get exactly
--  one narrow door: a function that writes a row and returns nothing.
--  Reading is admin-only, through functions that return summaries
--  rather than raw rows.
--
--  No cookies. A visit is tied to a random id that lives in the tab's
--  sessionStorage and dies when the tab closes, so there is nothing to
--  consent to and nothing that follows anyone around.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. the table
-- ---------------------------------------------------------------------
create table if not exists public.page_views (
  id          bigserial primary key,
  at          timestamptz  not null default now(),
  path        text         not null,
  title       text,
  ref_host    text,                    -- google.com, instagram.com, or null
  device      text,                    -- phone | tablet | desktop
  country     text,                    -- two-letter code, from the CDN
  session_id  text         not null,   -- random per tab, not per person
  is_new      boolean      not null default true
);

create index if not exists page_views_at_idx      on public.page_views (at desc);
create index if not exists page_views_path_idx    on public.page_views (path);
create index if not exists page_views_session_idx on public.page_views (session_id);

alter table public.page_views enable row level security;

-- No policies for anon on purpose: with RLS on and no policy, nobody
-- can select, insert, update or delete directly. The only way in is the
-- function below, and the only way out is the reports further down.

-- ---------------------------------------------------------------------
-- 2. the one door in
-- ---------------------------------------------------------------------
create or replace function public.track_view(
  p_path       text,
  p_title      text default null,
  p_ref_host   text default null,
  p_device     text default null,
  p_session    text default null,
  p_is_new     boolean default true
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Never trust the caller's strings. Anything oversized is a mistake or
  -- an attack; either way it gets trimmed rather than stored.
  insert into public.page_views (path, title, ref_host, device, country, session_id, is_new)
  values (
    left(coalesce(nullif(trim(p_path),''), '/'), 200),
    left(nullif(trim(coalesce(p_title,'')),''), 200),
    left(nullif(trim(coalesce(p_ref_host,'')),''), 120),
    case when p_device in ('phone','tablet','desktop') then p_device else null end,
    -- Cloudflare puts the visitor's country on the request; Supabase
    -- passes the headers through, so this costs nothing and cannot be
    -- spoofed by the page.
    nullif(left(coalesce(current_setting('request.headers', true)::json ->> 'cf-ipcountry', ''), 2), ''),
    left(coalesce(nullif(trim(coalesce(p_session,'')),''), gen_random_uuid()::text), 64),
    coalesce(p_is_new, true)
  );
end;
$$;

revoke all on function public.track_view(text,text,text,text,text,boolean) from public;
grant execute on function public.track_view(text,text,text,text,text,boolean) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. the reports (admin only)
--    Each one checks is_admin() first, so even if someone found the
--    endpoint they would get an empty result.
-- ---------------------------------------------------------------------

-- headline numbers, plus the same window immediately before it so the
-- portal can show whether things are going up or down
create or replace function public.analytics_summary(p_days int default 30)
returns table (views bigint, visits bigint, prev_views bigint, prev_visits bigint)
language sql security definer stable set search_path = '' as $$
  select
    count(*) filter (where at > now() - make_interval(days => p_days)),
    count(distinct session_id) filter (where at > now() - make_interval(days => p_days)),
    count(*) filter (where at <= now() - make_interval(days => p_days)
                       and at >  now() - make_interval(days => p_days * 2)),
    count(distinct session_id) filter (where at <= now() - make_interval(days => p_days)
                       and at >  now() - make_interval(days => p_days * 2))
  from public.page_views
  where public.is_admin() and at > now() - make_interval(days => p_days * 2);
$$;

create or replace function public.analytics_daily(p_days int default 30)
returns table (day date, views bigint, visits bigint)
language sql security definer stable set search_path = '' as $$
  select (at at time zone 'UTC')::date as day,
         count(*),
         count(distinct session_id)
  from public.page_views
  where public.is_admin() and at > now() - make_interval(days => p_days)
  group by 1 order by 1;
$$;

create or replace function public.analytics_top_pages(p_days int default 30, p_limit int default 12)
returns table (path text, title text, views bigint, visits bigint)
language sql security definer stable set search_path = '' as $$
  select path,
         (array_agg(title order by at desc) filter (where title is not null))[1],
         count(*),
         count(distinct session_id)
  from public.page_views
  where public.is_admin() and at > now() - make_interval(days => p_days)
  group by path order by 3 desc limit p_limit;
$$;

-- where people came from, what they were on, and where they are
create or replace function public.analytics_breakdown(p_days int default 30)
returns table (kind text, label text, visits bigint)
language sql security definer stable set search_path = '' as $$
  with w as (
    select * from public.page_views
    where public.is_admin() and at > now() - make_interval(days => p_days)
  )
  select 'source', coalesce(ref_host,'Direct'), count(distinct session_id)
    from w group by 2
  union all
  select 'device', coalesce(device,'unknown'), count(distinct session_id)
    from w group by 2
  union all
  select 'country', coalesce(country,'??'), count(distinct session_id)
    from w group by 2
  order by 1, 3 desc;
$$;

grant execute on function public.analytics_summary(int)          to authenticated;
grant execute on function public.analytics_daily(int)            to authenticated;
grant execute on function public.analytics_top_pages(int,int)    to authenticated;
grant execute on function public.analytics_breakdown(int)        to authenticated;

-- ---------------------------------------------------------------------
-- 4. housekeeping
--    Twelve months is plenty for a studio site and keeps the table from
--    growing forever. Run it whenever, or forget about it.
-- ---------------------------------------------------------------------
create or replace function public.analytics_prune()
returns void language sql security definer set search_path = '' as $$
  delete from public.page_views where at < now() - interval '12 months';
$$;
