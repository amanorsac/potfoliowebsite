-- =====================================================================
--  THE THREE NOTIFICATION WEBHOOKS  ·  SETUP.md §8 step (d)
--
--  A "Database Webhook" in the Supabase dashboard is just a trigger that
--  calls supabase_functions.http_request(). Creating them here does the
--  same thing as filling the dashboard form three times, and the secret
--  only has to be typed once.
--
--  BEFORE YOU RUN THIS
--    1. The notify-client function must already be deployed
--    2. Replace PASTE_YOUR_NOTIFY_SECRET_HERE below — twice per trigger is
--       handled for you; it appears once per block, three times total.
--       It must match the NOTIFY_SECRET secret on the function EXACTLY.
--
--  IF IT ERRORS with  schema "supabase_functions" does not exist
--    Your project has never had a webhook. Go to the dashboard, create
--    ONE hook through the UI (that switches the machinery on), then come
--    back and run this — it will create the rest.
--
--  Safe to re-run: each trigger is dropped first.
-- =====================================================================

-- ------------------------------------------------------------ 1. STAGES
-- Every stage edit fires this. The function itself throws away the ones
-- where the state did not actually move, so note-only edits stay silent.
drop trigger if exists notify_on_stage_change on public.project_stages;
create trigger notify_on_stage_change
  after update on public.project_stages
  for each row execute function supabase_functions.http_request(
    'https://kdxckigyhpnwhwgjdgqq.supabase.co/functions/v1/notify-client',
    'POST',
    '{"Content-Type":"application/json","x-notify-secret":"PASTE_YOUR_NOTIFY_SECRET_HERE"}',
    '{}',
    '5000'
  );

-- -------------------------------------------------------------- 2. FILES
-- Fires on any new deliverable; the function drops the ones the client
-- uploaded themselves.
drop trigger if exists notify_on_deliverable on public.deliverables;
create trigger notify_on_deliverable
  after insert on public.deliverables
  for each row execute function supabase_functions.http_request(
    'https://kdxckigyhpnwhwgjdgqq.supabase.co/functions/v1/notify-client',
    'POST',
    '{"Content-Type":"application/json","x-notify-secret":"PASTE_YOUR_NOTIFY_SECRET_HERE"}',
    '{}',
    '5000'
  );

-- ----------------------------------------------------------- 3. MESSAGES
-- Fires on every message; the function only notifies when the sender is
-- you, so a client's own message never bounces back at them.
drop trigger if exists notify_on_message on public.messages;
create trigger notify_on_message
  after insert on public.messages
  for each row execute function supabase_functions.http_request(
    'https://kdxckigyhpnwhwgjdgqq.supabase.co/functions/v1/notify-client',
    'POST',
    '{"Content-Type":"application/json","x-notify-secret":"PASTE_YOUR_NOTIFY_SECRET_HERE"}',
    '{}',
    '5000'
  );

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
--    select * from net._http_response order by created desc limit 10;
--      -- the raw HTTP result. status_code 200 = the function answered.
--      -- 403 = your secret does not match. 404 = wrong function name.
--
--    select * from public.notifications order by created_at desc limit 10;
--      -- what the function decided to send, and whether it worked.
-- =====================================================================
