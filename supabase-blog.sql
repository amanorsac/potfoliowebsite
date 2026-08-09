-- =====================================================================
--  THE BLOG  ·  run in Supabase → SQL Editor → New query → Run.
--  Safe to run again: create-or-replace and if-not-exists throughout.
--
--  Posts are written in the portal and read by the public site. There is
--  no build step and no second service: publishing is a row changing
--  state, and the post is live on the next request.
--
--  WHAT IS PROTECTED
--    A draft is nobody's business but yours. The public may read a post
--    only once it is published and its date has arrived; everything else
--    - drafts, scheduled posts, the editing history of any of them - is
--    visible to an admin and to no one else. That rule lives in the two
--    policies below rather than in the pages, so a page that forgets to
--    filter still cannot leak a draft.
-- =====================================================================


-- =====================================================================
--  1 · THE TABLE
-- =====================================================================

create table if not exists public.posts (
  id            bigserial primary key,

  -- the address: amanorsac.studio/blog/<slug>
  slug          text not null unique,

  title         text not null,
  blurb         text,                    -- the card and the meta description
  tag           text,                    -- must match a topic on the blog page
  cover         text,                    -- image url
  cover_alt     text,

  -- what you typed, and what it renders to. Both are kept: the markdown
  -- so a post can be edited as it was written, the html so serving a page
  -- is a lookup rather than a re-render.
  body_md       text not null default '',
  body_html     text not null default '',

  read_minutes  int,
  status        text not null default 'draft'
                check (status in ('draft','published')),

  -- Set this ahead and the post stays private until the moment arrives.
  published_at  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Added after the first version; each is optional so an older row still reads.
alter table public.posts add column if not exists author_name text;
alter table public.posts add column if not exists og_image    text;

create index if not exists posts_live_idx
  on public.posts (published_at desc) where status = 'published';
create index if not exists posts_updated_idx on public.posts (updated_at desc);

create or replace function public.posts_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  -- Publishing without naming a date means now. Going back to draft
  -- deliberately keeps the date, so re-publishing does not reset it.
  if new.status = 'published' and new.published_at is null then
    new.published_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists posts_touch on public.posts;
create trigger posts_touch before insert or update on public.posts
  for each row execute function public.posts_touch();


-- =====================================================================
--  2 · WHO MAY SEE WHAT
-- =====================================================================

alter table public.posts enable row level security;

-- Everyone, signed in or not, may read a post that is published and due.
drop policy if exists posts_public_read on public.posts;
create policy posts_public_read on public.posts
  for select to anon, authenticated
  using (status = 'published' and coalesce(published_at, now()) <= now());

-- The studio may do anything. This is a second SELECT policy rather than
-- a replacement, and policies are OR'd, so an admin sees drafts too.
drop policy if exists posts_admin_all on public.posts;
create policy posts_admin_all on public.posts
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Policies decide which rows; these decide whether the role may reach the
-- table at all. Supabase normally grants this by default, but saying it
-- here means the blog cannot come up empty because a default changed.
-- Write access is granted to every signed-in user and then withheld from
-- all but admins by the policy above.
grant select on public.posts to anon, authenticated;
grant insert, update, delete on public.posts to authenticated;
grant usage, select on sequence public.posts_id_seq to authenticated;


-- =====================================================================
--  3 · IMAGES
--  A public bucket, because a picture in a published post is public by
--  definition and a signed link would expire underneath it. Only an
--  admin may put anything in it or take anything out.
-- =====================================================================

insert into storage.buckets (id, name, public)
values ('blog', 'blog', true)
on conflict (id) do update set public = true;

drop policy if exists "anyone reads blog images" on storage.objects;
create policy "anyone reads blog images" on storage.objects
  for select to anon, authenticated
  using ( bucket_id = 'blog' );

drop policy if exists "admin manages blog images" on storage.objects;
create policy "admin manages blog images" on storage.objects
  for all to authenticated
  using      ( bucket_id = 'blog' and (select public.is_admin()) )
  with check ( bucket_id = 'blog' and (select public.is_admin()) );


-- =====================================================================
--  4 · READING LIST
--  What the blog index and the sitemap ask for. A function rather than a
--  plain select so both get the same columns in the same order, and so
--  the body - which can be long - is never shipped to a page that only
--  needs to draw a card.
-- =====================================================================

create or replace function public.posts_public(p_limit int default 60)
returns table (
  slug text, title text, blurb text, tag text, cover text, cover_alt text,
  read_minutes int, published_at timestamptz, updated_at timestamptz
)
language sql security definer stable set search_path = '' as $$
  select p.slug, p.title, p.blurb, p.tag, p.cover, p.cover_alt,
         p.read_minutes, p.published_at, p.updated_at
  from public.posts p
  where p.status = 'published' and coalesce(p.published_at, now()) <= now()
  order by p.published_at desc
  limit greatest(1, least(p_limit, 200));
$$;

grant execute on function public.posts_public(int) to anon, authenticated;
