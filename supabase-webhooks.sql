-- =====================================================================
--  THE THREE NOTIFICATION WEBHOOKS  ·  SETUP.md §8 step (d)
--
--  A "Database Webhook" in the Supabase dashboard is nothing more than a
--  trigger that POSTs a row to a URL. This builds that directly with
--  pg_net, which means:
--
--    · no hunting for the Webhooks page (it moved out of the Database
--      sidebar and is now under Integrations)
--    · no dependency on the dashboard's supabase_functions schema, which
--      only exists once you have created a hook by hand at least once
--    · the secret appears ONCE, not once per trigger
--
--  BEFORE YOU RUN THIS
--    1. The notify-client function must already be deployed, with its
--       NOTIFY_SECRET set in the function's Secrets.
--    2. Replace PASTE_YOUR_NOTIFY_SECRET_HERE below with that same
--       secret — one spot, in the notify_client_hook function.
--
--       Do the replacing in a TEXT EDITOR, then paste the finished file
--       into the SQL Editor. Do not paste the secret into the SQL Editor
--       on its own and run it — a bare secret is not SQL, and Postgres
--       answers with  syntax error at or near "..."
--
--  Safe to re-run.
-- =====================================================================

-- ------------------------------------------------------ 1. THE PLUMBING
-- pg_net lets Postgres make outbound HTTP calls. It sends them from a
-- background worker, so a trigger never blocks a client's save waiting
-- on the network.
create extension if not exists pg_net;

-- ------------------------------------------------------- 2. THE SENDER
-- One trigger function, shared by all three tables. It builds the same
-- payload shape the dashboard's webhooks send, so the Edge Function
-- cannot tell the difference.
--
-- SECURITY DEFINER matters here. When a CLIENT inserts a message, the
-- trigger runs as that client, who has no business touching pg_net's
-- queue. Running as the owner instead is what lets their action still
-- notify you.
create or replace function public.notify_client_hook()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url     := 'https://kdxckigyhpnwhwgjdgqq.supabase.co/functions/v1/notify-client',
    headers := jsonb_build_object(
                 'Content-Type',    'application/json',
                 'x-notify-secret', 'PASTE_YOUR_NOTIFY_SECRET_HERE'
               ),
    body    := jsonb_build_object(
                 'type',       tg_op,
                 'table',      tg_table_name,
                 'schema',     tg_table_schema,
                 'record',     to_jsonb(new),
                 'old_record', case when tg_op = 'UPDATE' then to_jsonb(old) end
               ),
    timeout_milliseconds := 5000
  );
  return null;   -- ignored on an AFTER trigger
end;
$$;

-- -------------------------------------------------------- 3. THE HOOKS
-- All three fire wide; the Edge Function decides what is actually worth
-- telling a client about. Filtering there rather than here keeps the
-- rules in one readable place.

-- Stage moved. Note-only edits fire too, and are dropped by the function.
drop trigger if exists notify_on_stage_change on public.project_stages;
create trigger notify_on_stage_change
  after update on public.project_stages
  for each row execute function public.notify_client_hook();

-- New file. The client's own uploads are dropped by the function.
drop trigger if exists notify_on_deliverable on public.deliverables;
create trigger notify_on_deliverable
  after insert on public.deliverables
  for each row execute function public.notify_client_hook();

-- New message. A client's own message is dropped by the function, so it
-- never bounces back at them.
drop trigger if exists notify_on_message on public.messages;
create trigger notify_on_message
  after insert on public.messages
  for each row execute function public.notify_client_hook();

-- =====================================================================
--  CHECK YOUR WORK — should return three rows
-- =====================================================================
select tgname as trigger_name, relname as on_table
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
 where tgname like 'notify_on_%'
 order by tgname;

-- =====================================================================
--  DID IT FIRE?  Two places to look, in this order:
--
--    select created, status_code, content
--      from net._http_response order by created desc limit 10;
--        -- the raw HTTP result.
--        -- 200 = the function answered.
--        -- 403 = the secret here does not match the one on the function.
--        -- 404 = the function name is wrong, or it is not deployed.
--
--    select * from public.notifications order by created_at desc limit 10;
--        -- what the function then decided to send, and whether it worked.
-- =====================================================================
