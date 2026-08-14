-- Credit-based apology grants: the USER mints, and the charge is waived.
--
-- WHY THIS REPLACES THE PRE-MINT SCRIPT
-- scripts/issue-avatar-apology-grants.mjs minted four avatars per wallet from
-- the server side, which required AVATAR_ADMIN_TEST_SECRET to be set on the
-- deployed function. While that variable is set, resolveMintContext
-- (generate-user-avatar/index.ts) returns BEFORE verifyWalletHeaders, so anyone
-- holding the secret can mint unlimited NFTs to ANY wallet with no signature at
-- all. It was left set once already -- J4oXmhjZk9YR3wERQUiHPdMBbXeQqfRFVKq57GsMeWVa
-- still carries the dev-bypass row it produced on 2026-06-14.
--
-- A credit inverts that. The grant row says this wallet is owed N free avatars;
-- the ordinary SIGNED generate path sees an unspent credit and waives the
-- payment. Every mint is then authorised by the recipient's own ed25519
-- signature over sakura:generate-avatar:ts:<unix>, the admin secret is never
-- set, and nothing is pasted into a transcript.
--
-- THE LOCK, AND WHY THERE IS NO COUNTER HERE
-- A credit must be spendable EXACTLY ONCE, including by two concurrent
-- requests. A `credits_spent` counter cannot do that: two edge isolates would
-- both read it, both increment it, and both mint -- two NFTs and two lots of SOL
-- for one credit. So each credit is instead a DETERMINISTIC slot signature
--
--     apology:<wallet_address>:<credit_series>:<slot 1..avatar_count>
--
-- written into user_avatar_generations.payment_tx_signature, which already
-- carries a partial UNIQUE index (user_avatar_generations_payment_tx_unique).
-- Postgres decides the winner, at the INSERT, before the function calls FLUX and
-- before it mints. The loser gets 23505 -> HTTP 409 and has spent nothing. That
-- index IS the lock; no second scheme was invented.
--
-- Base58 has no ':', so a slot signature can never collide with, be mistaken
-- for, or squat the UNIQUE slot of a real Solana signature -- the same attack
-- the 20260813120000 comment documents against avatar_payment_rejections.
--
-- WHY ACCOUNTING MUST NOT KEY ON payment_amount_sakura = 0
-- Two rows platform-wide already have payment_amount_sakura = 0, and one belongs
-- to a grant wallet:
--   J4oXmhjZk9YR3wERQUiHPdMBbXeQqfRFVKq57GsMeWVa  dev-bypass-0a6468a4-...  2026-06-14
--   86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY  dev-bypass-289be9bb-...  2026-07-06
-- issue-avatar-apology-grants.mjs counted comped avatars that way and would have
-- given J4oXm three instead of four. Credit accounting keys on the slot prefix
-- only.
--
-- APPLY THIS FILE ON ITS OWN (dashboard SQL editor), exactly like
-- 20260813120000_avatar_apology_grants.sql, and apply it BEFORE deploying the
-- function. Do NOT `supabase db push` -- the applied-migration ledger does not
-- match this directory in either direction, and a blanket push would replay
-- 20260617130400_chat_realtime_upstream.sql, which 20260727010000 documents as
-- deliberately never applied. Idempotent: safe to re-run.
--
-- ROLLBACK is at the bottom of this file.

-- === credit tracking on the grant ===========================================

alter table if exists public.avatar_apology_grants
  -- The slot namespace. Bump it to re-grant the SAME wallet: the row is PK'd on
  -- wallet_address, so a re-grant reuses it, and without a new series the
  -- already-spent slots would make the new grant instantly empty. A
  -- merge-duplicates upsert that omits this column leaves it unchanged, which is
  -- the safe direction -- reissuing must be deliberate.
  add column if not exists credit_series  integer not null default 1,
  -- Operator off switch. Stops further free mints without deleting the grant or
  -- touching anything already forged. Surfaced to the user as "paused" rather
  -- than silently removing the offer.
  add column if not exists credits_locked boolean not null default false;

do $$ begin
  alter table public.avatar_apology_grants
    add constraint avatar_apology_grants_credit_series_check
    check (credit_series >= 1);
exception when duplicate_object then null;
end $$;

-- avatar_count is now spendable, not decorative: it is the number of free NFTs
-- the platform will mint and pay the SOL for. Bound it so a fat-fingered UPDATE
-- cannot authorise thousands.
do $$ begin
  alter table public.avatar_apology_grants
    add constraint avatar_apology_grants_avatar_count_bounds_check
    check (avatar_count >= 0 and avatar_count <= 20);
exception when duplicate_object then null;
end $$;

comment on column public.avatar_apology_grants.credit_series is
  'Namespace for this grant''s credit slots. Slot signature is apology:<wallet>:<credit_series>:<n>, written to user_avatar_generations.payment_tx_signature, whose partial UNIQUE index is what makes a credit spendable exactly once. Bump to reissue credits to a wallet that has already spent them.';

comment on column public.avatar_apology_grants.credits_locked is
  'Operator kill switch: true stops further free mints on this grant without deleting it. Does not affect avatars already forged; the client shows them as paused.';

-- === the one thing that stops a credit paying for two NFTs ==================

-- mintAvatarNft ends in sendAndConfirm, whose routine failure mode is
-- "transaction landed, confirmation timed out" -- it throws with the NFT already
-- in the user's wallet and the SOL already spent. The function used to mark that
-- row `failed`, and `failed` is exactly what hands a credit back: the retry
-- would mint a SECOND NFT for the same credit and leave the first invisible to
-- every query in the app.
--
-- This column is written immediately BEFORE the mint call. A row carrying it is
-- never marked failed and never reclaimed, at any age. It is also how a genuinely
-- dead isolate (killed mid-generation, before any mint) is told apart from one
-- that may have minted, so the first can be safely handed back and the second
-- cannot.
alter table if exists public.user_avatar_generations
  add column if not exists mint_submitted_at timestamptz;

comment on column public.user_avatar_generations.mint_submitted_at is
  'Set immediately before the mint transaction is submitted. A row with this set may own an NFT even if it never reached status=ready, so it is never auto-retried and never returns its apology credit. Rows with this set and status <> ''ready'' need manual review.';

-- The credit allocator reads exactly this shape: every slot row for one wallet.
create index if not exists user_avatar_generations_apology_credit_idx
  on public.user_avatar_generations (wallet_address, payment_tx_signature)
  where payment_tx_signature like 'apology:%';

-- === atomic append of a landed mint =========================================

-- Mints now arrive one at a time, so generation_ids has to grow one element at a
-- time. A read-modify-write from the edge function would lose ids outright when
-- two slots land at once: both isolates read the array, both write, one id
-- vanishes. One UPDATE statement takes one row lock and serialises instead.
--
-- Idempotent via @>, so a retried append cannot duplicate an id. SECURITY
-- INVOKER on purpose (the default): service_role already bypasses RLS, and if
-- execute were ever granted more widely the RLS policy would refuse the write
-- rather than a definer context quietly performing it.
create or replace function public.avatar_grant_append_generation(
  p_wallet     text,
  p_generation uuid
)
returns void
language sql
set search_path = public
as $$
  update public.avatar_apology_grants
     set generation_ids = case
           when generation_ids @> array[p_generation] then generation_ids
           else array_append(generation_ids, p_generation)
         end,
         minted_at  = coalesce(minted_at, now()),
         updated_at = now()
   where wallet_address = p_wallet;
$$;

-- Functions are EXECUTE-to-PUBLIC by default, so this revoke is not optional.
revoke all on function public.avatar_grant_append_generation(text, uuid) from public;
revoke all on function public.avatar_grant_append_generation(text, uuid) from anon;
revoke all on function public.avatar_grant_append_generation(text, uuid) from authenticated;
grant execute on function public.avatar_grant_append_generation(text, uuid) to service_role;

comment on function public.avatar_grant_append_generation(text, uuid) is
  'Appends one landed generation id to a wallet''s apology grant in a single statement, idempotently. Audit convenience only: the read paths derive the granted set from the apology: slot prefix on user_avatar_generations.payment_tx_signature, which cannot disagree with what was actually minted.';

-- === ROLLBACK ===============================================================
-- Deploy the previous function revision FIRST -- the new one selects
-- credit_series/credits_locked/mint_submitted_at and will 500 without them.
--
--   drop function if exists public.avatar_grant_append_generation(text, uuid);
--   drop index if exists public.user_avatar_generations_apology_credit_idx;
--   alter table public.user_avatar_generations drop column if exists mint_submitted_at;
--   alter table public.avatar_apology_grants
--     drop constraint if exists avatar_apology_grants_credit_series_check,
--     drop constraint if exists avatar_apology_grants_avatar_count_bounds_check,
--     drop column if exists credit_series,
--     drop column if exists credits_locked;
--
-- Nothing a user owns is destroyed by that: the avatars are NFTs in his wallet
-- plus rows in user_avatar_generations. It only stops further free mints.
-- Prefer `update public.avatar_apology_grants set credits_locked = true;` --
-- same effect, no deploy, reversible in one statement.
