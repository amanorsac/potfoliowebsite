-- =====================================================================
--  CLIENT NOTIFICATIONS  ·  run ONCE in Supabase → SQL Editor
--  Safe to re-run.
--
--  Adds the contact details and preferences the notifier needs, plus a
--  log of everything that was sent. The sending itself happens in the
--  `notify-client` Edge Function, triggered by Database Webhooks
--  (set those up in the dashboard — see SETUP.md §8).
-- =====================================================================

-- ------------------------------------------------- 1. CONTACT + PREFS
alter table public.profiles add column if not exists phone            text;
alter table public.profiles add column if not exists notify_email     boolean not null default true;
alter table public.profiles add column if not exists notify_whatsapp  boolean not null default false;

comment on column public.profiles.phone is
  'E.164 format, e.g. +14155552671. Required for WhatsApp/SMS.';

-- --------------------------------------------------------- 2. THE LOG
-- Every send attempt lands here: what, to whom, which channel, did it
-- work. This is what you read when a client says "I never got that".
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects(id) on delete cascade,
  client_id   uuid references public.profiles(id) on delete cascade,
  event       text not null,               -- stage | file | message | revision
  channel     text not null,               -- email | whatsapp | sms
  subject     text,
  body        text,
  status      text not null default 'sent',-- sent | failed | skipped
  detail      text,                        -- provider id, or why it failed
  created_at  timestamptz not null default now()
);

create index if not exists notifications_client_idx  on public.notifications (client_id, created_at desc);
create index if not exists notifications_project_idx on public.notifications (project_id, created_at desc);

alter table public.notifications enable row level security;

-- Only the admin reads the log. The Edge Function writes with the
-- service role, which bypasses RLS, so it needs no policy of its own.
drop policy if exists "admin reads notifications" on public.notifications;
create policy "admin reads notifications" on public.notifications for select to authenticated
  using ( (select public.is_admin()) );

-- ------------------------------------------- 3. QUIET-PERIOD HELPER
-- Moving four stages in a row should not send four emails. The function
-- calls this to check whether the same client was already told about the
-- same kind of event in the last few minutes.
create or replace function public.notified_recently(
  p_client uuid, p_event text, p_window interval default interval '3 minutes'
) returns boolean language sql security definer stable
set search_path = '' as $$
  select exists (
    select 1 from public.notifications
     where client_id = p_client
       and event     = p_event
       and status    = 'sent'
       and created_at > now() - p_window
  );
$$;

-- =====================================================================
--  NEXT: create three Database Webhooks (Dashboard → Database →
--  Webhooks), all pointing at the notify-client function, all sending
--  the header  x-notify-secret: <the secret you set on the function>
--
--    1. project_stages  · UPDATE
--    2. deliverables    · INSERT
--    3. messages        · INSERT
--
--  Full walkthrough in SETUP.md §8.
-- =====================================================================
