-- =====================================================================
--  APP DOWNLOADS AND THE MAILING LIST
--  Run in Supabase → SQL Editor → New query → Run. Safe to re-run.
--
--  This file is the mailing list. The installers themselves are not here
--  - they live in Cloudflare R2, because they are 78 MB and 171 MB and
--  Supabase's free plan refuses anything over 50 MB. The Worker hands
--  them out; see worker.js.
--
--  The list is nobody's business but the studio's. Visitors can add
--  themselves - that is the whole point - and can never read the table
--  back, so an address given here cannot be harvested from here.
-- =====================================================================


-- =====================================================================
--  0 · CLEAR OUT ANY EARLIER VERSION OF THE FUNCTIONS
--
--  create-or-replace can change what a function does but not the shape
--  of what it returns. subscriber_stats gained a "confirmed" column when
--  confirming an address became part of the arrangement, so the older
--  one has to be dropped rather than replaced - which is exactly what
--  "42P13: cannot change return type of existing function" is saying.
--
--  A changed argument list has the opposite problem: it makes a second
--  overload instead of replacing the first, and then every call is
--  ambiguous. Dropping by name, whatever the arguments, avoids both.
--
--  The tables and everything in them are untouched. Only the functions
--  go, and the rest of this file puts them straight back.
-- =====================================================================

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'record_subscriber', 'confirm_subscriber', 'subscriber_stats')
  loop
    execute 'drop function if exists ' || f.sig;
  end loop;
end $$;


-- =====================================================================
--  1 · WHO ASKED FOR WHAT
-- =====================================================================

create table if not exists public.subscribers (
  id           bigserial primary key,
  email        text not null,
  app          text,                     -- which download brought them
  source       text,                     -- the page they were on
  country      text,
  -- Consent is a fact with a date, not a checkbox that got ticked once.
  -- If anyone ever asks how this address was obtained, this is the answer.
  consented    boolean not null default false,
  consented_at timestamptz,
  unsubscribed_at timestamptz,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- One row per address. Downloading a second app updates the row rather
-- than making a duplicate, so the list is a list of people.
create unique index if not exists subscribers_email_key
  on public.subscribers (lower(email));
create index if not exists subscribers_created_idx
  on public.subscribers (created_at desc);

-- Every download, including repeats. Kept apart from the list so the
-- question "how many downloads" and the question "how many people" have
-- different answers, which they do.
create table if not exists public.download_events (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  app        text not null,
  platform   text,
  email      text,
  country    text
);
create index if not exists download_events_at_idx on public.download_events (at desc);


-- =====================================================================
--  2 · WHO MAY SEE IT
--  Both tables: RLS on, and no policy for anon. That denies everything.
--  Adding yourself happens through the one write-only function in part 4,
--  which runs as its owner - so a visitor needs no access to the tables
--  themselves, and has none.
-- =====================================================================

alter table public.subscribers     enable row level security;
alter table public.download_events enable row level security;

drop policy if exists subs_admin on public.subscribers;
create policy subs_admin on public.subscribers
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists dl_admin on public.download_events;
create policy dl_admin on public.download_events
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

grant select, insert, update, delete on public.subscribers     to authenticated;
grant select, insert, update, delete on public.download_events to authenticated;
grant usage, select on sequence public.subscribers_id_seq      to authenticated;
grant usage, select on sequence public.download_events_id_seq  to authenticated;


-- =====================================================================
--  3 · THE FILES ARE NOT HERE
--
--  The installers are 78 MB and 171 MB. Supabase's free plan caps an
--  upload at 50 MB, so they live in Cloudflare R2 instead: 10 GB free,
--  no egress charges, and the Worker reaches the bucket through a
--  binding rather than a key - so there is no credential to leak,
--  rotate, or accidentally commit.
--
--  Nothing to run here. The bucket is made in the Cloudflare dashboard.
-- =====================================================================


-- =====================================================================
--  4 · THE ONLY DOOR IN
--
--  The site has to be able to add someone to the list without holding a
--  key that could do anything else. Same arrangement as the analytics:
--  one function that can only write, callable with the publishable key,
--  and no read access of any kind behind it. An address can be given
--  here and never read back out.
-- =====================================================================

create or replace function public.record_subscriber(
  p_email   text,
  p_app     text default null,
  p_source  text default null,
  p_consent boolean default false
) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_email text;
begin
  v_email := lower(trim(coalesce(p_email, '')));
  -- loose on purpose: catching a typo, not adjudicating what an address is
  if v_email !~ '^[^@[:space:]]+@[^@[:space:].]+\.[^@[:space:]]+$' then return; end if;
  if length(v_email) > 254 then return; end if;

  insert into public.subscribers
    (email, app, source, consented, consented_at, last_seen_at)
  values
    (v_email,
     left(nullif(trim(coalesce(p_app,'')),''), 40),
     left(nullif(trim(coalesce(p_source,'')),''), 200),
     coalesce(p_consent, false),
     case when p_consent then now() end,
     now())
  on conflict (lower(email)) do update
    set last_seen_at = now(),
        app          = coalesce(excluded.app, public.subscribers.app),
        -- consent, once given, keeps its original date rather than being
        -- restamped every time somebody downloads something
        consented    = public.subscribers.consented or excluded.consented,
        consented_at = coalesce(public.subscribers.consented_at, excluded.consented_at),
        -- coming back is as good as re-subscribing
        unsubscribed_at = null;

  -- No download is logged here. Asking for one is not getting one; the
  -- event is written when the link in the email is used.
end;
$$;

revoke all on function public.record_subscriber(text,text,text,boolean) from public;
grant execute on function public.record_subscriber(text,text,text,boolean)
  to anon, authenticated;


-- =====================================================================
--  5 · CONFIRMING AN ADDRESS
--
--  Nobody gets the file until they have clicked the link in their inbox,
--  so an address on this list is one that exists and whose owner asked
--  for it. That is what makes it worth writing to: made-up addresses
--  bounce, and bounces are what stop the real ones arriving.
-- =====================================================================

alter table public.subscribers add column if not exists confirmed_at timestamptz;
create index if not exists subscribers_confirmed_idx
  on public.subscribers (confirmed_at) where confirmed_at is not null;

create or replace function public.confirm_subscriber(
  p_email text, p_app text default null, p_platform text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_email text;
begin
  v_email := lower(trim(coalesce(p_email, '')));
  if v_email = '' then return; end if;

  update public.subscribers
     set confirmed_at   = coalesce(confirmed_at, now()),   -- the first time counts
         last_seen_at   = now(),
         unsubscribed_at = null
   where lower(email) = v_email;

  -- a download only counts once it has actually been handed over
  insert into public.download_events (app, platform, email)
  values (left(nullif(trim(coalesce(p_app,'')),''), 40),
          left(nullif(trim(coalesce(p_platform,'')),''), 20),
          v_email);
end;
$$;

revoke all on function public.confirm_subscriber(text,text,text) from public;
grant execute on function public.confirm_subscriber(text,text,text) to anon, authenticated;


-- =====================================================================
--  6 · WHAT THE STUDIO SEES
-- =====================================================================

create or replace function public.subscriber_stats()
returns table (
  total bigint, this_week bigint, confirmed bigint,
  downloads bigint, downloads_week bigint
)
language sql security definer stable set search_path = '' as $$
  select
    (select count(*) from public.subscribers where unsubscribed_at is null),
    (select count(*) from public.subscribers
       where unsubscribed_at is null and created_at > now() - interval '7 days'),
    (select count(*) from public.subscribers
       where unsubscribed_at is null and confirmed_at is not null),
    (select count(*) from public.download_events),
    (select count(*) from public.download_events where at > now() - interval '7 days')
  where public.is_admin();
$$;

grant execute on function public.subscriber_stats() to authenticated;
