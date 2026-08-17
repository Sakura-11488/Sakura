-- Push notifications: the secret moves to Vault, and the cron jobs start working.
--
-- Apply in the Supabase SQL editor, alone. Never `supabase db push`.
-- The six push-related edge functions must be deployed alongside this — they
-- change from reading PUSH_SEND_SECRET out of the environment to reading it
-- through push_send_secret().
--
-- ─────────────────────────────────────────────────────────────────────────────
-- What was actually wrong
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The three push cron jobs carried a 64-hex-character shared secret as plaintext
-- inside `cron.job.command`. That was the reported problem. Reading the commands
-- to fix it turned up two more, and they had been hiding each other:
--
--   1. The header was built as   'Authorization': '<secret>'
--      but the functions check   header === `Bearer ${secret}`
--      No "Bearer " prefix, so the check could never pass.
--
--   2. timeout_milliseconds := 1000. A push broadcast queries subscribers and
--      calls Expo; one second is not enough. Job 5, written later, uses 120000.
--
-- So every push cron run either aborted on timeout or would have 401'd. Push
-- notifications — manga updates every 2h, re-engagement daily, pass reminders
-- hourly — had never once fired. `cron.job_run_details` reported "succeeded"
-- throughout, because the SQL statement ran fine; the HTTP status lives in
-- `net._http_response`, where nobody was looking.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why Vault rather than a rotated env var
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The leaked value was the same one the functions held in PUSH_SEND_SECRET, so
-- rotating meant getting a new value into both cron and the function
-- environment — which means carrying it through a terminal, a CLI argument and
-- a transcript. That is the same exposure again, just fresher.
--
-- Instead the secret lives in Vault and nothing copies it: cron composes its
-- header with a subquery, and the functions verify against the same row through
-- push_send_secret(). The value never exists outside the database. `creator-post`,
-- which SENDS the header when it fans out to notify-creator-followers, reads it
-- the same way.
--
-- The secret itself was rotated as part of this (generated with
-- gen_random_bytes inside Postgres, never selected back out), so the exposed
-- value is dead.

-- 1. The secret. Run once; skip if 'push-send-secret' already exists.
--    select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'push-send-secret', '...');

-- 2. The accessor. SECURITY DEFINER so callers need no rights on the vault
--    schema; execute is service_role only, which is what edge functions run as.
create or replace function public.push_send_secret()
returns text
language sql
security definer
set search_path = ''
as $fn$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'push-send-secret'
  limit 1;
$fn$;

revoke all on function public.push_send_secret() from public, anon, authenticated;
grant execute on function public.push_send_secret() to service_role;

-- 3. Rewrite the three broken jobs. cron.schedule() upserts by name, so this
--    replaces the command and leaves the schedule alone.
do $do$
declare
  j record;
begin
  for j in select jobname, schedule from cron.job where jobname in
           ('push-manga-updates', 'push-re-engagement', 'push-pass-reminders') loop
    perform cron.schedule(j.jobname, j.schedule, format($cmd$
  select net.http_post(
    url := %L,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'push-send-secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
    $cmd$, 'https://aofzomovaozcwcozokll.supabase.co/functions/v1/' || j.jobname));
  end loop;
end
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Check your work — and check the HTTP status, not the cron status
-- ─────────────────────────────────────────────────────────────────────────────
--
--   select jobname,
--          command like '%Bearer%'                as has_bearer,
--          command like '%vault.decrypted_secrets%' as uses_vault,
--          command ~ '[a-f0-9]{64}'               as still_plaintext
--   from cron.job;
--
-- Fire one by hand and read the response:
--
--   select net.http_post(
--     url := 'https://aofzomovaozcwcozokll.supabase.co/functions/v1/push-pass-reminders',
--     headers := jsonb_build_object('Content-Type','application/json',
--       'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='push-send-secret')),
--     body := '{}'::jsonb, timeout_milliseconds := 60000);
--   -- then: select status_code, content from net._http_response where id = <returned id>;
--
-- Verified 2026-08-17:
--   correct secret with Bearer          -> 200 {"sent":0,"message":"No pass reminders due"}
--   wrong secret                        -> 401
--   correct secret, no Bearer prefix    -> 401   (the shape the old jobs used)
--   no Authorization header             -> 401
