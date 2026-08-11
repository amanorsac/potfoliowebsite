-- =====================================================================
--  APP DOWNLOADS AND THE MAILING LIST
--  Run in Supabase → SQL Editor → New query → Run. Safe to re-run.
--
--  The installers live in a PRIVATE bucket. Nothing in it is reachable by
--  address, guessed or shared: the only way to a file is a signed link
--  that the site mints after an email is given, and which expires in
--  minutes. That is what makes asking for the email meaningful rather
--  than a form anyone can walk around.
--
--  The list itself is nobody's business but the studio's. Visitors can
--  add themselves - that is the whole point - and can never read the
--  table back, so an address given here cannot be harvested from here.
-- =====================================================================


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
--  Nothing writes here from a browser - the Worker does it with a key
--  the browser never sees - so no visitor needs any access at all.
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
--  3 · THE FILES
--  Private, and staying that way. No select policy for anon or for
--  authenticated: not even a signed-in client can list or fetch these.
--  Only the service key, which lives in Cloudflare and never reaches a
--  browser, can sign a link.
-- =====================================================================

insert into storage.buckets (id, name, public)
values ('downloads', 'downloads', false)
on conflict (id) do update set public = false;

drop policy if exists "admin manages downloads" on storage.objects;
create policy "admin manages downloads" on storage.objects
  for all to authenticated
  using      ( bucket_id = 'downloads' and (select public.is_admin()) )
  with check ( bucket_id = 'downloads' and (select public.is_admin()) );


-- =====================================================================
--  4 · WHAT THE STUDIO SEES
-- =====================================================================

create or replace function public.subscriber_stats()
returns table (
  total bigint, this_week bigint, consented bigint,
  downloads bigint, downloads_week bigint
)
language sql security definer stable set search_path = '' as $$
  select
    (select count(*) from public.subscribers where unsubscribed_at is null),
    (select count(*) from public.subscribers
       where unsubscribed_at is null and created_at > now() - interval '7 days'),
    (select count(*) from public.subscribers
       where unsubscribed_at is null and consented),
    (select count(*) from public.download_events),
    (select count(*) from public.download_events where at > now() - interval '7 days')
  where public.is_admin();
$$;

grant execute on function public.subscriber_stats() to authenticated;
