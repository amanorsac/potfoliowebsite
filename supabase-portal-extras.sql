-- =====================================================================
--  PORTAL EXTRAS  ·  run ONCE in Supabase → SQL Editor
--  Safe to re-run.
--
--  Three things the portal grew and the original schema did not have:
--    1. a profile picture
--    2. live refresh on messages, files and reviews
--       (only the progress tracker had it before)
--    3. a note about who can edit whom
-- =====================================================================

-- ------------------------------------------------------ 1. THE PICTURE
-- Stored as a path into the avatars bucket, not a URL, so the bucket can
-- stay private and the portal signs a link on demand.
alter table public.profiles add column if not exists avatar_path text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', false)
on conflict (id) do update set public = false;

-- Files are laid out as  <user_id>/<filename>  and the first folder
-- segment decides who may touch them. Same shape as deliverables.
drop policy if exists "own avatar write" on storage.objects;
create policy "own avatar write" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'avatars'
    and ( (storage.foldername(name))[1] = (select auth.uid())::text
          or (select public.is_admin()) )
  )
  with check (
    bucket_id = 'avatars'
    and ( (storage.foldername(name))[1] = (select auth.uid())::text
          or (select public.is_admin()) )
  );

-- Anyone signed in may LOOK at an avatar. A studio of this size has one
-- admin and a handful of clients; hiding faces from each other buys
-- nothing and would stop the message thread showing who is talking.
drop policy if exists "signed-in reads avatars" on storage.objects;
create policy "signed-in reads avatars" on storage.objects
  for select to authenticated
  using ( bucket_id = 'avatars' );

-- ------------------------------------------------- 2. LIVE REFRESH
-- Realtime only pushes changes for tables in this publication. The
-- original setup added projects and project_stages, which is why the
-- progress tracker updated by itself and the message thread did not.
do $$
begin
  begin alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null; end;

  begin alter publication supabase_realtime add table public.deliverables;
  exception when duplicate_object then null; end;

  begin alter publication supabase_realtime add table public.revision_requests;
  exception when duplicate_object then null; end;

  begin alter publication supabase_realtime add table public.revision_notes;
  exception when duplicate_object then null; end;
end $$;

-- Realtime respects RLS, so a client still only receives rows for their
-- own project. Adding a table here does not widen who can see what.

-- ===================================================== 3. WHO EDITS WHOM
-- No change needed — the existing policy already reads:
--
--   create policy "update own profile" on public.profiles for update
--     using ( id = auth.uid() or public.is_admin() )
--
-- so an admin can already edit any client's name, email, phone and
-- notification switches, and a client can edit their own. This block is
-- here so that fact is written down somewhere.

-- =====================================================================
--  CHECK YOUR WORK
-- =====================================================================
select 'avatar_path column' as thing,
       count(*)::text as result
  from information_schema.columns
 where table_schema='public' and table_name='profiles' and column_name='avatar_path'
union all
select 'avatars bucket', count(*)::text from storage.buckets where id='avatars'
union all
select 'realtime tables', string_agg(tablename, ', ' order by tablename)
  from pg_publication_tables where pubname='supabase_realtime' and schemaname='public';
