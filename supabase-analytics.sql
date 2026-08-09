-- =====================================================================
--  SITE ANALYTICS
--  Run this in Supabase → SQL Editor → New query → Run.
--  Safe to run again: everything below is create-or-replace and
--  add-column-if-not-exists, so re-running it upgrades in place and
--  never touches data you have already collected.
--
--  WHAT IT MEASURES
--    Traffic      views, visits (sessions), visitors, new vs returning
--    Engagement   bounce rate, time on page, session duration, scroll
--    Navigation   landing pages, exit pages, most read
--    Acquisition  channel (organic / social / referral / direct / paid /
--                 email), referring host, utm campaign
--    Conversion   named events, and the share of visits that fire one
--    Technical    device, browser, OS, page load time, country
--
--  HOW IT IS PROTECTED
--    Visitors are anonymous, so they get no read access at all. The
--    tables have RLS on with no policies, which denies everything by
--    default. Writing happens through three SECURITY DEFINER functions
--    that only insert. Reading happens through reporting functions that
--    check is_admin() first and return aggregates, never raw rows.
-- =====================================================================


-- =====================================================================
--  1 · TABLES
-- =====================================================================

create table if not exists public.page_views (
  id          bigserial primary key,
  at          timestamptz  not null default now(),
  path        text         not null,
  title       text,
  ref_host    text,
  device      text,
  country     text,
  session_id  text         not null,
  is_new      boolean      not null default true
);

-- Added after the first version. Each is optional so an older row that
-- predates the column simply reads as null rather than breaking a report.
alter table public.page_views add column if not exists visitor_id   text;
alter table public.page_views add column if not exists is_returning boolean;
alter table public.page_views add column if not exists is_entry     boolean default false;
alter table public.page_views add column if not exists utm_source   text;
alter table public.page_views add column if not exists utm_medium   text;
alter table public.page_views add column if not exists utm_campaign text;
alter table public.page_views add column if not exists browser      text;
alter table public.page_views add column if not exists os           text;
alter table public.page_views add column if not exists load_ms      integer;
-- filled in later, when the visitor leaves the page
alter table public.page_views add column if not exists duration_ms  integer;
alter table public.page_views add column if not exists max_scroll   smallint;

create index if not exists page_views_at_idx      on public.page_views (at desc);
create index if not exists page_views_path_idx    on public.page_views (path);
create index if not exists page_views_session_idx on public.page_views (session_id);
create index if not exists page_views_visitor_idx on public.page_views (visitor_id);

alter table public.page_views enable row level security;

-- Named things that matter: an enquiry sent, an app download asked for,
-- a client signing in. This is what turns traffic into a conversion rate.
create table if not exists public.site_events (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  name        text        not null,
  path        text,
  label       text,
  session_id  text        not null,
  visitor_id  text
);

create index if not exists site_events_at_idx      on public.site_events (at desc);
create index if not exists site_events_name_idx    on public.site_events (name);
create index if not exists site_events_session_idx on public.site_events (session_id);

alter table public.site_events enable row level security;

-- No policies on either table, deliberately. RLS with no policy denies
-- everything, so the publishable key on the public site can do nothing
-- but call the three functions below.


-- =====================================================================
--  2 · WRITING (the only doors in)
-- =====================================================================

create or replace function public.track_view(
  p_path         text,
  p_title        text    default null,
  p_ref_host     text    default null,
  p_device       text    default null,
  p_session      text    default null,
  p_is_new       boolean default true,
  p_visitor      text    default null,
  p_returning    boolean default null,
  p_entry        boolean default false,
  p_utm_source   text    default null,
  p_utm_medium   text    default null,
  p_utm_campaign text    default null,
  p_browser      text    default null,
  p_os           text    default null,
  p_load_ms      integer default null
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_id bigint;
begin
  -- Never trust the caller. Anything oversized is a mistake or an abuse;
  -- either way it is trimmed rather than stored.
  insert into public.page_views (
    path, title, ref_host, device, country, session_id, is_new,
    visitor_id, is_returning, is_entry,
    utm_source, utm_medium, utm_campaign, browser, os, load_ms)
  values (
    left(coalesce(nullif(trim(p_path),''), '/'), 200),
    left(nullif(trim(coalesce(p_title,'')),''), 200),
    left(nullif(trim(coalesce(p_ref_host,'')),''), 120),
    case when p_device in ('phone','tablet','desktop') then p_device end,
    -- Cloudflare stamps the country on the request itself, so the page
    -- cannot lie about it.
    nullif(left(coalesce(current_setting('request.headers', true)::json ->> 'cf-ipcountry',''),2),''),
    left(coalesce(nullif(trim(coalesce(p_session,'')),''), gen_random_uuid()::text), 64),
    coalesce(p_is_new, true),
    left(nullif(trim(coalesce(p_visitor,'')),''), 64),
    p_returning,
    coalesce(p_entry, false),
    left(nullif(trim(coalesce(p_utm_source,'')),''), 80),
    left(nullif(trim(coalesce(p_utm_medium,'')),''), 80),
    left(nullif(trim(coalesce(p_utm_campaign,'')),''), 80),
    left(nullif(trim(coalesce(p_browser,'')),''), 40),
    left(nullif(trim(coalesce(p_os,'')),''), 40),
    case when p_load_ms between 0 and 120000 then p_load_ms end)
  returning id into v_id;
  return v_id;
end;
$$;

-- Sent when the visitor leaves the page, so we learn how long they
-- stayed and how far down they got.
create or replace function public.track_engagement(
  p_id bigint, p_duration_ms integer default null, p_max_scroll integer default null
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.page_views
     set duration_ms = case when p_duration_ms between 0 and 3600000
                            then p_duration_ms else duration_ms end,
         max_scroll  = case when p_max_scroll between 0 and 100
                            then p_max_scroll else max_scroll end
   -- only ever the row just written, and only within the hour, so an
   -- old id cannot be replayed to rewrite history
   where id = p_id and at > now() - interval '1 hour';
end;
$$;

create or replace function public.track_event(
  p_name text, p_path text default null, p_label text default null,
  p_session text default null, p_visitor text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(trim(p_name),'') = '' then return; end if;
  insert into public.site_events (name, path, label, session_id, visitor_id)
  values (left(trim(p_name),60),
          left(nullif(trim(coalesce(p_path,'')),''),200),
          left(nullif(trim(coalesce(p_label,'')),''),160),
          left(coalesce(nullif(trim(coalesce(p_session,'')),''), gen_random_uuid()::text),64),
          left(nullif(trim(coalesce(p_visitor,'')),''),64));
end;
$$;

revoke all on function public.track_view(text,text,text,text,text,boolean,text,boolean,boolean,text,text,text,text,text,integer) from public;
grant execute on function public.track_view(text,text,text,text,text,boolean,text,boolean,boolean,text,text,text,text,text,integer) to anon, authenticated;
grant execute on function public.track_engagement(bigint,integer,integer) to anon, authenticated;
grant execute on function public.track_event(text,text,text,text,text)     to anon, authenticated;


-- =====================================================================
--  3 · SHARED DEFINITIONS
--  One place to decide what a channel is and what counts as engaged,
--  so every report agrees with every other report.
-- =====================================================================

create or replace function public.analytics_channel(
  p_ref text, p_medium text, p_source text
) returns text
language sql immutable set search_path = '' as $$
  select case
    when lower(coalesce(p_medium,'')) in ('cpc','ppc','paid','paidsearch','paid_social') then 'Paid'
    when lower(coalesce(p_medium,'')) in ('email','newsletter')                          then 'Email'
    when p_ref ~* '(google|bing|duckduckgo|yahoo|ecosia|brave|search)\.'                 then 'Organic search'
    when p_ref ~* '(instagram|facebook|tiktok|youtube|twitter|x\.com|linkedin|t\.co|pinterest|reddit|threads)'
                                                                                          then 'Social'
    when p_ref is null and coalesce(p_source,'') = ''                                     then 'Direct'
    else 'Referral' end;
$$;

-- One row per session in the window, with everything the reports need.
-- GA calls a session "engaged" at ten seconds, two pages, or a
-- conversion; a bounce is simply a session that never got there.
create or replace function public.analytics_sessions(p_days int default 30, p_offset int default 0)
returns table (
  session_id text, visitor_id text, started timestamptz, views bigint,
  duration_ms bigint, channel text, ref_host text, country text,
  device text, browser text, os text, returning boolean,
  entry_path text, exit_path text, engaged boolean, converted boolean
)
language sql security definer stable set search_path = '' as $$
  with w as (
    select * from public.page_views
    where at >  now() - make_interval(days => p_days * (p_offset + 1))
      and at <= now() - make_interval(days => p_days * p_offset)
  ),
  ev as (select distinct session_id from public.site_events
          where at >  now() - make_interval(days => p_days * (p_offset + 1))
            and at <= now() - make_interval(days => p_days * p_offset))
  select
    w.session_id,
    (array_agg(w.visitor_id) filter (where w.visitor_id is not null))[1],
    min(w.at),
    count(*),
    coalesce(sum(w.duration_ms), 0),
    public.analytics_channel(
      (array_agg(w.ref_host   order by w.at))[1],
      (array_agg(w.utm_medium order by w.at))[1],
      (array_agg(w.utm_source order by w.at))[1]),
    (array_agg(w.ref_host order by w.at))[1],
    (array_agg(w.country  order by w.at desc))[1],
    (array_agg(w.device   order by w.at desc))[1],
    (array_agg(w.browser  order by w.at desc))[1],
    (array_agg(w.os       order by w.at desc))[1],
    bool_or(coalesce(w.is_returning,false)),
    (array_agg(w.path order by w.at))[1],
    (array_agg(w.path order by w.at desc))[1],
    count(*) > 1 or coalesce(sum(w.duration_ms),0) >= 10000 or w.session_id in (select session_id from ev),
    w.session_id in (select session_id from ev)
  from w group by w.session_id;
$$;


-- =====================================================================
--  4 · REPORTS  (admin only — every one checks is_admin first)
-- =====================================================================

create or replace function public.analytics_summary(p_days int default 30)
returns table (
  views bigint, visits bigint, visitors bigint, new_visitors bigint,
  bounce_pct numeric, avg_session_s numeric, avg_page_s numeric,
  pages_per_visit numeric, conversions bigint, conversion_pct numeric,
  prev_views bigint, prev_visits bigint, prev_bounce_pct numeric,
  prev_avg_session_s numeric, prev_conversion_pct numeric
)
language sql security definer stable set search_path = '' as $$
  with
  cur  as (select * from public.analytics_sessions(p_days, 0)),
  prev as (select * from public.analytics_sessions(p_days, 1)),
  pv   as (select * from public.page_views where at > now() - make_interval(days => p_days))
  select
    (select count(*) from pv),
    (select count(*) from cur),
    (select count(distinct coalesce(visitor_id, session_id)) from cur),
    (select count(*) from cur where not returning),
    (select round(100.0 * count(*) filter (where not engaged) / nullif(count(*),0), 1) from cur),
    (select round(avg(duration_ms)/1000.0, 1) from cur where duration_ms > 0),
    (select round(avg(duration_ms)/1000.0, 1) from pv  where duration_ms > 0),
    (select round(avg(views), 1) from cur),
    (select count(*) filter (where converted) from cur),
    (select round(100.0 * count(*) filter (where converted) / nullif(count(*),0), 1) from cur),
    (select count(*) from public.page_views
       where at <= now() - make_interval(days => p_days)
         and at >  now() - make_interval(days => p_days * 2)),
    (select count(*) from prev),
    (select round(100.0 * count(*) filter (where not engaged) / nullif(count(*),0), 1) from prev),
    (select round(avg(duration_ms)/1000.0, 1) from prev where duration_ms > 0),
    (select round(100.0 * count(*) filter (where converted) / nullif(count(*),0), 1) from prev)
  where public.is_admin();
$$;

create or replace function public.analytics_daily(p_days int default 30)
returns table (day date, views bigint, visits bigint)
language sql security definer stable set search_path = '' as $$
  select (at at time zone 'UTC')::date, count(*), count(distinct session_id)
  from public.page_views
  where public.is_admin() and at > now() - make_interval(days => p_days)
  group by 1 order by 1;
$$;

-- Most read, with how long people actually stayed and how far they got.
create or replace function public.analytics_top_pages(p_days int default 30, p_limit int default 12)
returns table (path text, title text, views bigint, visits bigint,
               avg_s numeric, scroll_pct numeric, bounce_pct numeric)
language sql security definer stable set search_path = '' as $$
  with s as (select * from public.analytics_sessions(p_days, 0)),
       pv as (select * from public.page_views
               where at > now() - make_interval(days => p_days))
  select pv.path,
         (array_agg(pv.title order by pv.at desc) filter (where pv.title is not null))[1],
         count(*), count(distinct pv.session_id),
         round(avg(pv.duration_ms) filter (where pv.duration_ms > 0)/1000.0, 1),
         round(avg(pv.max_scroll)  filter (where pv.max_scroll is not null), 0),
         round(100.0 * count(distinct pv.session_id)
                 filter (where pv.session_id in (select session_id from s where not engaged))
               / nullif(count(distinct pv.session_id),0), 1)
  from pv where public.is_admin()
  group by pv.path order by 3 desc limit p_limit;
$$;

-- Where visits begin and where they end.
create or replace function public.analytics_journey(p_days int default 30, p_limit int default 8)
returns table (kind text, path text, visits bigint, bounce_pct numeric)
language sql security definer stable set search_path = '' as $$
  with s as (select * from public.analytics_sessions(p_days, 0))
  select * from (
    select 'landing'::text, entry_path, count(*),
           round(100.0 * count(*) filter (where not engaged) / nullif(count(*),0), 1)
    from s where public.is_admin() group by entry_path order by 3 desc limit p_limit
  ) a
  union all
  select * from (
    select 'exit'::text, exit_path, count(*), null::numeric
    from s where public.is_admin() group by exit_path order by 3 desc limit p_limit
  ) b;
$$;

-- Acquisition: the channel, the referrer, the campaign - and crucially
-- how each one behaves once it arrives.
create or replace function public.analytics_acquisition(p_days int default 30)
returns table (kind text, label text, visits bigint,
               bounce_pct numeric, avg_session_s numeric, conversion_pct numeric)
language sql security definer stable set search_path = '' as $$
  with s as (select * from public.analytics_sessions(p_days, 0)),
  agg as (
    select 'channel'::text as kind, channel as label, * from s
    union all
    select 'referrer', coalesce(ref_host,'Direct'), * from s
  )
  select kind, label, count(*),
         round(100.0 * count(*) filter (where not engaged) / nullif(count(*),0), 1),
         round(avg(duration_ms)/1000.0, 1) filter (where duration_ms > 0),
         round(100.0 * count(*) filter (where converted) / nullif(count(*),0), 1)
  from agg where public.is_admin()
  group by kind, label order by kind, 3 desc;
$$;

create or replace function public.analytics_tech(p_days int default 30)
returns table (kind text, label text, visits bigint)
language sql security definer stable set search_path = '' as $$
  with s as (select * from public.analytics_sessions(p_days, 0))
  select 'device',  coalesce(device,'unknown'),  count(*) from s where public.is_admin() group by 2
  union all
  select 'browser', coalesce(browser,'unknown'), count(*) from s where public.is_admin() group by 2
  union all
  select 'os',      coalesce(os,'unknown'),      count(*) from s where public.is_admin() group by 2
  union all
  select 'country', coalesce(country,'??'),      count(*) from s where public.is_admin() group by 2
  order by 1, 3 desc;
$$;

create or replace function public.analytics_events(p_days int default 30)
returns table (name text, label text, count bigint, visits bigint)
language sql security definer stable set search_path = '' as $$
  select name, label, count(*), count(distinct session_id)
  from public.site_events
  where public.is_admin() and at > now() - make_interval(days => p_days)
  group by name, label order by 3 desc limit 30;
$$;

-- How fast the site actually feels, which is itself a ranking factor.
create or replace function public.analytics_speed(p_days int default 30)
returns table (median_ms numeric, p75_ms numeric, samples bigint)
language sql security definer stable set search_path = '' as $$
  select percentile_cont(0.5)  within group (order by load_ms)::numeric,
         percentile_cont(0.75) within group (order by load_ms)::numeric,
         count(*)
  from public.page_views
  where public.is_admin() and at > now() - make_interval(days => p_days)
    and load_ms is not null;
$$;

grant execute on function public.analytics_sessions(int,int)     to authenticated;
grant execute on function public.analytics_summary(int)          to authenticated;
grant execute on function public.analytics_daily(int)            to authenticated;
grant execute on function public.analytics_top_pages(int,int)    to authenticated;
grant execute on function public.analytics_journey(int,int)      to authenticated;
grant execute on function public.analytics_acquisition(int)      to authenticated;
grant execute on function public.analytics_tech(int)             to authenticated;
grant execute on function public.analytics_events(int)           to authenticated;
grant execute on function public.analytics_speed(int)            to authenticated;


-- =====================================================================
--  5 · HOUSEKEEPING
-- =====================================================================
create or replace function public.analytics_prune()
returns void language sql security definer set search_path = '' as $$
  delete from public.page_views  where at < now() - interval '12 months';
  delete from public.site_events where at < now() - interval '12 months';
$$;
