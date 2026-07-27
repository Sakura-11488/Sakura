-- Close anon read access to private chat.
--
-- Symptom: every direct message on the platform was readable by anyone holding
-- the anon key — which ships inside the Android bundle and in the web app's
-- JavaScript. Message bodies, sender wallets, thread membership and typing
-- state, all of it, with no authentication beyond a key that is public by
-- construction.
--
-- This was not a dashboard edit. It is the v1 design, applied as migration
-- 20260616104410 `chat_realtime`, whose own comment states the intent: "Read
-- access uses thread UUID as capability (edge functions still gate writes)."
-- Treating an unguessable thread id as a bearer token is a defensible v1 idea;
-- it stopped being defensible once the ids travel through realtime payloads and
-- push notifications.
--
-- Two later migrations were written to replace that model with a real
-- membership check, and BOTH failed to land properly:
--
--   20260616120000_chat_messages_realtime.sql — applied off-ledger. It created
--   "thread members read messages" but never dropped the permissive
--   chat_messages_realtime_select. Both policies are PERMISSIVE, and permissive
--   policies OR together, so the strict one has never had any effect whatsoever.
--   It has been dead code in the database since the day it was applied.
--
--   20260617130400_chat_realtime_upstream.sql — never applied at all. Absent
--   from supabase_migrations.schema_migrations in any form. Its chat_members and
--   chat_typing bodies are reproduced below.
--
-- Neither of them revoked anon. So this migration finishes the job: it drops the
-- permissive policy, scopes the rest to thread members, and takes away the anon
-- grants so RLS is not even consulted for that role.
--
-- Verified safe before writing: there are ZERO direct PostgREST reads or writes
-- of any chat table from client code — sakura-mobile, the shipped sakura-web
-- bundle, and src/ were all checked. Chat history and every write go through the
-- creator-chat edge function under service role, which bypasses RLS entirely.
-- The only client-side touch is Supabase Realtime, which authenticates with a
-- wallet-bound JWT minted by wallet-realtime-session (role: authenticated, with
-- a wallet_address claim that jwt_wallet_address() reads). anon is never the
-- role a chat channel actually uses.
--
-- Also verified: that realtime token is not currently being issued at all.
-- wallet-realtime-session returns 500 "JWT secret unavailable." on every call
-- because SUPABASE_JWT_SECRET is not present in the edge runtime — Supabase
-- reserves the SUPABASE_ prefix, so it cannot be set as a custom secret either.
-- Realtime chat has therefore never worked and the client has been silently
-- falling back to polling. That is fixed separately; it is noted here because it
-- is the reason this migration cannot regress anything. There is no live
-- consumer of the permissive policies to break.
--
-- ROLLBACK, if chat misbehaves after this lands:
--   create policy "chat_messages_realtime_select" on public.chat_messages
--     for select to anon, authenticated
--     using (coalesce(moderation_state, 'visible') <> 'removed');
--   grant select on public.chat_messages, public.chat_members to anon;
--   grant all on public.chat_typing to anon;
-- (and re-run 20260616100000_chat_realtime.sql from the .gh-tools snapshot for
-- the chat_members / chat_typing halves.)

-- ── chat_messages ───────────────────────────────────────────────────────────
-- Dropping this is the single most important statement in the file. It is what
-- has been exposing message bodies, and removing it finally lets the strict
-- "thread members read messages" policy created in 20260616120000 take effect.

drop policy if exists "chat_messages_realtime_select" on public.chat_messages;

revoke all on public.chat_messages from anon;

-- ── chat_members ────────────────────────────────────────────────────────────
-- Body reproduced from the never-applied 20260617130400_chat_realtime_upstream.sql.

alter table if exists public.chat_members enable row level security;

drop policy if exists "chat_members_realtime_select" on public.chat_members;
create policy "chat_members_realtime_select"
  on public.chat_members
  for select
  to authenticated
  using (public.is_chat_thread_member(thread_id));

revoke all on public.chat_members from anon;
grant select on public.chat_members to authenticated;

-- ── chat_typing ─────────────────────────────────────────────────────────────
-- Same source. Note the extra revoke from `authenticated`: chat_typing carried
-- INSERT/UPDATE/DELETE for both anon and authenticated, inherited from Supabase's
-- stock ALTER DEFAULT PRIVILEGES rather than granted deliberately. No policy
-- permitted those commands, so they were already blocked — but the grant should
-- not be there, and writes go through the edge function under service role.

alter table if exists public.chat_typing enable row level security;

drop policy if exists "chat_typing_read" on public.chat_typing;
create policy "chat_typing_read"
  on public.chat_typing
  for select
  to authenticated
  using (public.is_chat_thread_member(thread_id));

revoke all on public.chat_typing from anon;
revoke all on public.chat_typing from authenticated;
grant select on public.chat_typing to authenticated;

-- ── chat_threads ────────────────────────────────────────────────────────────
-- Already unreachable: no grant to anon or authenticated, so RLS is never
-- consulted. Restated as an assertion so a future default-privileges change
-- cannot quietly open it.

revoke all on public.chat_threads from anon;
revoke all on public.chat_threads from authenticated;

-- ── Realtime publication ────────────────────────────────────────────────────
-- Also from the never-applied migration. Harmless if already present, and
-- required for the membership-scoped subscriptions to deliver anything once the
-- realtime JWT starts being issued.

alter table if exists public.chat_members replica identity full;
alter table if exists public.chat_typing  replica identity full;

do $$ begin
  alter publication supabase_realtime add table public.chat_members;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.chat_typing;
exception when duplicate_object then null;
end $$;
