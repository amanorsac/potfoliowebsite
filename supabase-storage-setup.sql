-- =====================================================================
--  DELIVERABLES STORAGE  ·  run ONCE in Supabase → SQL Editor
--  Safe to re-run.
--
--  Files live in a PRIVATE bucket. Nothing is readable by URL guessing;
--  the portal hands out short-lived signed links instead. Files are laid
--  out as  <project_id>/<filename>  and access is decided by that first
--  folder segment, so a client can only reach their own project's files.
-- =====================================================================

insert into storage.buckets (id, name, public)
values ('deliverables', 'deliverables', false)
on conflict (id) do update set public = false;

-- Admin may do anything in the bucket -----------------------------------
drop policy if exists "admin manages deliverable files" on storage.objects;
create policy "admin manages deliverable files" on storage.objects
  for all to authenticated
  using      ( bucket_id = 'deliverables' and (select public.is_admin()) )
  with check ( bucket_id = 'deliverables' and (select public.is_admin()) );

-- A client may READ files that sit under one of their own projects ------
-- (owns_project already returns true for admins as well.)
drop policy if exists "client reads own project files" on storage.objects;
create policy "client reads own project files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'deliverables'
    and (select public.owns_project( ((storage.foldername(name))[1])::uuid ))
  );

-- A client may UPLOAD into their own project's folder (reference tracks,
-- stems they owe you). They cannot overwrite or delete anything.
drop policy if exists "client uploads to own project" on storage.objects;
create policy "client uploads to own project" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'deliverables'
    and (select public.owns_project( ((storage.foldername(name))[1])::uuid ))
  );
