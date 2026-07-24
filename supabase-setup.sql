-- =====================================================================
--  STUDIO CLIENT PORTAL  ·  Supabase setup
--  Run this ONCE in Supabase → SQL Editor → New query → Run.
--  Safe to re-run: everything uses "if not exists" / "or replace".
-- =====================================================================

-- ---------------------------------------------------------------- 1. PROFILES
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text,
  email        text,
  company      text,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

-- Auto-create a profile row whenever you add a user in the Dashboard
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Admin check. SECURITY DEFINER + reads a real table (never user_metadata,
-- which the user can edit themselves).
create or replace function public.is_admin()
returns boolean language sql security definer stable
set search_path = '' as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------- 2. PROJECTS
do $$ begin
  create type project_status as enum ('active','on_hold','delivered','archived');
exception when duplicate_object then null; end $$;

create table if not exists public.projects (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.profiles(id) on delete cascade,
  title             text not null,
  artist            text,
  service           text default 'Mixing & Mastering',
  status            project_status not null default 'active',
  current_stage     int not null default 1,
  revisions_used    int not null default 0,
  revisions_allowed int not null default 3,
  due_date          date,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ------------------------------------------------------------- 3. STAGES
do $$ begin
  create type stage_state as enum ('pending','active','done','blocked');
exception when duplicate_object then null; end $$;

create table if not exists public.project_stages (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  sort_order  int not null,
  name        text not null,
  state       stage_state not null default 'pending',
  note        text,
  updated_at  timestamptz not null default now(),
  unique (project_id, sort_order)
);

-- Seed the seven standard stages whenever a project is created
create or replace function public.seed_stages()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.project_stages (project_id, sort_order, name, state) values
    (new.id, 1, 'Files received',  'active'),
    (new.id, 2, 'Editing & prep',  'pending'),
    (new.id, 3, 'Mix v1 sent',     'pending'),
    (new.id, 4, 'Revisions',       'pending'),
    (new.id, 5, 'Mix approved',    'pending'),
    (new.id, 6, 'Mastering',       'pending'),
    (new.id, 7, 'Delivered',       'pending');
  return new;
end; $$;

drop trigger if exists on_project_created on public.projects;
create trigger on_project_created
  after insert on public.projects
  for each row execute function public.seed_stages();

-- ------------------------------------------------------------ 4. DELIVERABLES
create table if not exists public.deliverables (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  label        text not null,
  url          text,
  storage_path text,
  direction    text not null default 'to_client',  -- 'to_client' | 'from_client'
  uploaded_by  uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  -- only http/https links ever get stored
  constraint deliverable_url_scheme check (
    url is null or url ~* '^https?://'
  )
);

-- --------------------------------------------------------- 5. REVISION REQUESTS
create table if not exists public.revision_requests (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  round_no      int not null default 1,
  submitted_by  uuid references public.profiles(id),
  status        text not null default 'open',   -- open | in_progress | done
  created_at    timestamptz not null default now()
);

create table if not exists public.revision_notes (
  id            uuid primary key default gen_random_uuid(),
  revision_id   uuid not null references public.revision_requests(id) on delete cascade,
  timecode      text,          -- "1:32"
  element       text,          -- vocal / kick / bass / overall ...
  hearing       text,          -- what they're hearing now
  wanted        text,          -- what they want instead
  reference_url text,
  priority      text default 'nice',   -- 'must' | 'nice'
  created_at    timestamptz not null default now(),
  constraint reference_url_scheme check (
    reference_url is null or reference_url ~* '^https?://'
  )
);

-- HARD revision cap, enforced in the database. The UI also shows the count,
-- but this is what actually stops a 4th round.
create or replace function public.enforce_revision_cap()
returns trigger language plpgsql security definer set search_path = '' as $$
declare used int; allowed int;
begin
  select count(*) into used   from public.revision_requests where project_id = new.project_id;
  select revisions_allowed into allowed from public.projects where id = new.project_id;
  if used >= allowed then
    raise exception 'REVISION_LIMIT_REACHED';
  end if;
  new.round_no := used + 1;
  return new;
end; $$;

drop trigger if exists trg_revision_cap on public.revision_requests;
create trigger trg_revision_cap
  before insert on public.revision_requests
  for each row execute function public.enforce_revision_cap();

-- Keep projects.revisions_used in sync
create or replace function public.bump_revision_count()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.projects
     set revisions_used = (select count(*) from public.revision_requests where project_id = new.project_id),
         updated_at = now()
   where id = new.project_id;
  return new;
end; $$;

drop trigger if exists trg_bump_revisions on public.revision_requests;
create trigger trg_bump_revisions
  after insert on public.revision_requests
  for each row execute function public.bump_revision_count();

-- ---------------------------------------------------------------- 6. MESSAGES
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  sender_id   uuid references public.profiles(id),
  body        text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- 7. INVOICES
create table if not exists public.invoices (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  client_id     uuid not null references public.profiles(id) on delete cascade,
  label         text not null,                 -- "Deposit (50%)"
  amount_cents  int not null,
  currency      text not null default 'usd',
  status        text not null default 'pending', -- pending | paid | void
  pay_url       text,                          -- Stripe Payment Link
  stripe_session_id text,
  paid_at       timestamptz,
  created_at    timestamptz not null default now(),
  constraint pay_url_scheme check ( pay_url is null or pay_url ~* '^https?://' )
);

-- =====================================================================
--  ROW LEVEL SECURITY
--  Clients see ONLY their own rows. Admin sees everything.
-- =====================================================================
alter table public.profiles          enable row level security;
alter table public.projects          enable row level security;
alter table public.project_stages    enable row level security;
alter table public.deliverables      enable row level security;
alter table public.revision_requests enable row level security;
alter table public.revision_notes    enable row level security;
alter table public.messages          enable row level security;
alter table public.invoices          enable row level security;

-- PROFILES ------------------------------------------------------------
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles for select to authenticated
  using ( id = (select auth.uid()) or (select public.is_admin()) );

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles for update to authenticated
  using ( id = (select auth.uid()) or (select public.is_admin()) )
  with check ( id = (select auth.uid()) or (select public.is_admin()) );

-- PROJECTS ------------------------------------------------------------
drop policy if exists "read own projects" on public.projects;
create policy "read own projects" on public.projects for select to authenticated
  using ( client_id = (select auth.uid()) or (select public.is_admin()) );

drop policy if exists "admin writes projects" on public.projects;
create policy "admin writes projects" on public.projects for all to authenticated
  using ( (select public.is_admin()) ) with check ( (select public.is_admin()) );

-- Helper: does the current user own this project?
create or replace function public.owns_project(p uuid)
returns boolean language sql security definer stable
set search_path = '' as $$
  select exists (
    select 1 from public.projects
     where id = p and (client_id = auth.uid() or public.is_admin())
  );
$$;

-- STAGES --------------------------------------------------------------
drop policy if exists "read own stages" on public.project_stages;
create policy "read own stages" on public.project_stages for select to authenticated
  using ( (select public.owns_project(project_id)) );

drop policy if exists "admin writes stages" on public.project_stages;
create policy "admin writes stages" on public.project_stages for all to authenticated
  using ( (select public.is_admin()) ) with check ( (select public.is_admin()) );

-- DELIVERABLES --------------------------------------------------------
drop policy if exists "read own deliverables" on public.deliverables;
create policy "read own deliverables" on public.deliverables for select to authenticated
  using ( (select public.owns_project(project_id)) );

drop policy if exists "client adds own deliverables" on public.deliverables;
create policy "client adds own deliverables" on public.deliverables for insert to authenticated
  with check ( (select public.owns_project(project_id)) );

drop policy if exists "admin manages deliverables" on public.deliverables;
create policy "admin manages deliverables" on public.deliverables for all to authenticated
  using ( (select public.is_admin()) ) with check ( (select public.is_admin()) );

-- REVISIONS -----------------------------------------------------------
drop policy if exists "read own revisions" on public.revision_requests;
create policy "read own revisions" on public.revision_requests for select to authenticated
  using ( (select public.owns_project(project_id)) );

drop policy if exists "client creates revisions" on public.revision_requests;
create policy "client creates revisions" on public.revision_requests for insert to authenticated
  with check ( (select public.owns_project(project_id)) );

drop policy if exists "admin manages revisions" on public.revision_requests;
create policy "admin manages revisions" on public.revision_requests for all to authenticated
  using ( (select public.is_admin()) ) with check ( (select public.is_admin()) );

drop policy if exists "read own notes" on public.revision_notes;
create policy "read own notes" on public.revision_notes for select to authenticated
  using ( exists (select 1 from public.revision_requests r
                   where r.id = revision_id and (select public.owns_project(r.project_id))) );

drop policy if exists "client adds notes" on public.revision_notes;
create policy "client adds notes" on public.revision_notes for insert to authenticated
  with check ( exists (select 1 from public.revision_requests r
                        where r.id = revision_id and (select public.owns_project(r.project_id))) );

-- MESSAGES ------------------------------------------------------------
drop policy if exists "read own messages" on public.messages;
create policy "read own messages" on public.messages for select to authenticated
  using ( (select public.owns_project(project_id)) );

drop policy if exists "send messages" on public.messages;
create policy "send messages" on public.messages for insert to authenticated
  with check ( (select public.owns_project(project_id)) and sender_id = (select auth.uid()) );

-- INVOICES ------------------------------------------------------------
drop policy if exists "read own invoices" on public.invoices;
create policy "read own invoices" on public.invoices for select to authenticated
  using ( client_id = (select auth.uid()) or (select public.is_admin()) );

drop policy if exists "admin manages invoices" on public.invoices;
create policy "admin manages invoices" on public.invoices for all to authenticated
  using ( (select public.is_admin()) ) with check ( (select public.is_admin()) );

-- =====================================================================
--  REALTIME  (live progress bar)
-- =====================================================================
do $$ begin
  alter publication supabase_realtime add table public.project_stages;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.projects;
exception when duplicate_object then null; end $$;

-- =====================================================================
--  MAKE YOURSELF ADMIN
--  Create your own user first (Authentication → Users → Add user),
--  then run this with your email:
--
--    update public.profiles set is_admin = true where email = 'amanorsac@gmail.com';
-- =====================================================================
