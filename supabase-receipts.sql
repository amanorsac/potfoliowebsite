-- =====================================================================
--  PAID-ANOTHER-WAY RECEIPTS  ·  run ONCE in Supabase → SQL Editor
--  Safe to re-run.
--
--  Not everyone pays through the Stripe link — bank transfer, mobile
--  money, cash at a session. This lets the client say so and attach
--  proof. The invoice goes to 'review' until the admin confirms it,
--  because "I sent it" and "it arrived" are different events.
-- =====================================================================

-- ------------------------------------------------ 1. ROOM ON THE ROW
alter table public.invoices add column if not exists receipt_path text;
alter table public.invoices add column if not exists receipt_note text;
alter table public.invoices add column if not exists receipt_at   timestamptz;

-- status gains one value: pending | review | paid | void

-- --------------------------------------------------- 2. THE RECEIPTS
-- Private bucket, foldered by client id. The first folder segment is
-- what the policies trust — never the browser.
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do update set public = false;

-- A client may add receipts to their own folder. Not change or delete
-- them: a receipt is evidence, and evidence should not be editable.
drop policy if exists "client uploads own receipts" on storage.objects;
create policy "client uploads own receipts" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "receipts readable by owner and admin" on storage.objects;
create policy "receipts readable by owner and admin" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'receipts'
    and ( (storage.foldername(name))[1] = (select auth.uid())::text
          or (select public.is_admin()) )
  );

drop policy if exists "admin manages receipts" on storage.objects;
create policy "admin manages receipts" on storage.objects
  for all to authenticated
  using      ( bucket_id = 'receipts' and (select public.is_admin()) )
  with check ( bucket_id = 'receipts' and (select public.is_admin()) );

-- ------------------------------------------------- 3. THE ONE DOOR IN
-- Clients have no UPDATE rights on invoices at all — and should not,
-- or the amount would be editable too. This function is the single
-- narrow thing they CAN do: attach proof to their own unpaid invoice.
create or replace function public.attach_receipt(
  p_invoice uuid, p_path text, p_note text default null
) returns void language plpgsql security definer
set search_path = '' as $$
begin
  -- The path must sit in the caller's own folder. The storage policy
  -- already enforces this for the upload; checking again here stops a
  -- mischievous client pointing their invoice at someone else's file.
  if split_part(p_path, '/', 1) <> auth.uid()::text then
    raise exception 'That is not your receipt.';
  end if;

  update public.invoices
     set receipt_path = p_path,
         receipt_note = nullif(trim(coalesce(p_note,'')), ''),
         receipt_at   = now(),
         status       = 'review'
   where id = p_invoice
     and client_id = auth.uid()
     and status in ('pending','review');   -- paid and void stay closed

  if not found then
    raise exception 'That invoice cannot take a receipt.';
  end if;
end;
$$;

-- =====================================================================
--  CHECK YOUR WORK
-- =====================================================================
select 'receipt columns' as thing, count(*)::text as result
  from information_schema.columns
 where table_schema='public' and table_name='invoices'
   and column_name in ('receipt_path','receipt_note','receipt_at')
union all
select 'receipts bucket', count(*)::text from storage.buckets where id='receipts'
union all
select 'attach_receipt()', count(*)::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname='attach_receipt';
