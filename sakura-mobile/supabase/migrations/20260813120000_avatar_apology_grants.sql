-- Avatar apology grants + a durable record of every charged-but-refused mint.
--
-- SYMPTOM
-- The avatar forge charges 100,000 SAKURA client-side, and the server then
-- rejects in two places BEFORE it inserts anything into user_avatar_generations:
--
--   1. verify-sakura-payment compared IEEE-754 doubles (post uiAmount minus pre
--      uiAmount). A payment of exactly 100000 into a treasury holding
--      71655.170417 evaluated to 99999.99999999999 -- 1.5e-11 short -- and 402'd.
--      Fixed 2026-08-13 (exact BigInt on raw base units, generate-user-avatar v17).
--   2. the 24h rate limit 429's after the client has already broadcast and
--      confirmed the transfer.
--
-- Both returned with zero rows written, so four wallets lost 400,000 SAKURA and
-- the platform had no record of it for seven weeks. scripts/reconcile-avatar-payments.mjs
-- is the detection half (chain vs DB). This migration is the other two halves:
-- a place to record refusals as they happen, and a ledger of who we owe.
--
-- WHY A SEPARATE REJECTION TABLE AND NOT status='rejected' ROWS
-- user_avatar_generations carries a partial UNIQUE index on payment_tx_signature.
-- An audit row written there would permanently occupy that signature's only slot.
-- Since the audit is written precisely when verification FAILED -- including the
-- "signer does not match your wallet" failure -- anyone could POST a stranger's
-- still-unclaimed signature, squat the slot, and permanently brick the real
-- payer's recovery path ("Payment transaction already claimed."). Solana
-- signatures are public the instant they confirm and a fresh keypair costs
-- nothing, so this is a one-line attack. avatar_payment_rejections has no unique
-- constraint on the signature alone and can never block a real mint.
--
-- WHY A GRANT TABLE AND NOT A FLAG ON user_profiles
-- user_profiles carries "Public Access Profiles" (FOR ALL TO public USING true
-- WITH CHECK true) plus stock anon DML grants, i.e. anyone holding the anon key
-- -- which ships inside the Android bundle and the web JS -- can rewrite any row
-- on the platform. A one-time acknowledgement stored there would be forgeable and
-- erasable. Device-local storage (SecureStore / localStorage, as used by
-- app-update.ts and InstallAppBanner.tsx) is also wrong: it is wiped by a
-- reinstall and is not shared between the APK and the web PWA, so the user would
-- be re-prompted. The requirement is explicit -- once he has decided, never ask
-- again, on any device.
--
-- TRUST MODEL mirrors user_avatar_generations: clients cannot read or write
-- either table; everything goes through generate-user-avatar under the service
-- role. The unauthenticated grant-status action returns booleans and public
-- image URLs only -- never generation ids -- and performs no writes. Everything
-- that mutates a grant requires an ed25519 signature over
-- sakura:generate-avatar:ts:<unix> (verifyWalletHeaders).
-- public.jwt_wallet_address() exists but is dead: REALTIME_JWT_SECRET is unset,
-- so wallet-realtime-session never issues a token and no client is ever
-- `authenticated` with a wallet claim. A wallet-scoped RLS policy would grant
-- exactly nothing.
--
-- APPLY THIS FILE ON ITS OWN (dashboard SQL editor). Do NOT `supabase db push`:
-- the ledger does not match this directory in either direction -- 19 applied
-- versions, none matching the 15 repo filenames, both avatar migrations applied
-- off-ledger, and 20260805094021 content_reports applied with no file. A blanket
-- push would replay 20260617130400_chat_realtime_upstream.sql, which
-- 20260727010000 documents as deliberately never applied. Newest applied version
-- is 20260805094021, hence this timestamp. Idempotent: safe to re-run.
--
-- ROLLBACK:
--   drop table if exists public.avatar_apology_grants;
--   drop table if exists public.avatar_payment_rejections;
-- Dropping the grant table only loses the "has been told" latch; the avatars are
-- NFTs in the user's wallet plus rows in user_avatar_generations and are
-- untouched by anything here.

-- === the grant ledger =======================================================

create table if not exists public.avatar_apology_grants (
  wallet_address          text primary key,
  -- Which incident this is, so the copy can be accurate per wallet.
  -- 'charged_without_delivery' -> paid, got nothing at all.
  -- 'charged_twice_delivered_once' -> paid more than once, received fewer.
  incident                text not null default 'charged_without_delivery',
  -- How many avatars were comped.
  avatar_count            integer not null default 4,
  -- What the user actually lost, in SAKURA. Must be the real charged amount,
  -- NOT avatar_count * price. Drives the apology copy.
  charged_sakura          numeric not null default 0,

  -- SAKURA sent back manually by the operator, outside this system. Non-zero
  -- means the copy may say a refund was issued AND must drop the "your original
  -- payment is still claimable" line — otherwise the user is invited to redeem a
  -- payment they have already been reimbursed for, and walks away with the
  -- money, the comped avatars, and one more avatar on top.
  refund_sakura           numeric not null default 0,
  -- How many avatars they DID receive for those payments. 0 for GBwEZYyq;
  -- 1 for 89Jdgt/BNa19q; 2 for J4oXm. The copy branches on this, because
  -- "got nothing back" is false for three of the four wallets.
  received_count          integer not null default 0,
  -- The on-chain transfers that were eaten. Audit only.
  payment_tx_signatures   text[] not null default '{}',
  -- The granted generations, in user_avatar_generations. The apology picker is
  -- scoped to exactly these ids so it can never be confused with the wallet's
  -- ordinary mints.
  generation_ids          uuid[] not null default '{}',
  note                    text,
  granted_at              timestamptz not null default now(),
  minted_at               timestamptz,
  -- Stamped the first time the user is actually SHOWN the avatars. Until this is
  -- set the grant cannot be resolved (see the CHECK below), so picking one of the
  -- granted avatars from the ordinary profile picker before the apology has been
  -- read can never silently burn it.
  shown_at                timestamptz,
  -- THE LATCH. Non-null means the user has decided and must never be prompted
  -- again, on any device, after any reinstall.
  resolved_at             timestamptz,
  resolution              text,
  selected_generation_id  uuid,
  updated_at              timestamptz not null default now()
);

-- Re-run safety for a table left over from a partial apply.
alter table if exists public.avatar_apology_grants
  add column if not exists incident               text not null default 'charged_without_delivery',
  add column if not exists avatar_count           integer not null default 4,
  add column if not exists charged_sakura         numeric not null default 0,
  add column if not exists refund_sakura          numeric not null default 0,
  add column if not exists received_count         integer not null default 0,
  add column if not exists payment_tx_signatures  text[] not null default '{}',
  add column if not exists generation_ids         uuid[] not null default '{}',
  add column if not exists note                   text,
  add column if not exists granted_at             timestamptz not null default now(),
  add column if not exists minted_at              timestamptz,
  add column if not exists shown_at               timestamptz,
  add column if not exists resolved_at            timestamptz,
  add column if not exists resolution             text,
  add column if not exists selected_generation_id uuid,
  add column if not exists updated_at             timestamptz not null default now();

do $$ begin
  alter table public.avatar_apology_grants
    add constraint avatar_apology_grants_incident_check
    check (incident in ('charged_without_delivery', 'charged_twice_delivered_once'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.avatar_apology_grants
    add constraint avatar_apology_grants_resolution_check
    check (resolution is null or resolution in ('selected', 'dismissed'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.avatar_apology_grants
    add constraint avatar_apology_grants_resolution_pairing_check
    check ((resolved_at is null) = (resolution is null));
exception when duplicate_object then null;
end $$;

-- A grant cannot be resolved before it has been shown. This is the DB-level
-- guarantee that he cannot be marked "decided" without ever seeing the apology.
do $$ begin
  alter table public.avatar_apology_grants
    add constraint avatar_apology_grants_seen_before_resolved_check
    check (resolved_at is null or shown_at is not null);
exception when duplicate_object then null;
end $$;

-- Operator query: "who is still owed an apology prompt", and the stale-grant
-- alarm in scripts/reconcile-avatar-payments.mjs.
create index if not exists avatar_apology_grants_unresolved_idx
  on public.avatar_apology_grants (granted_at desc)
  where resolved_at is null;

alter table public.avatar_apology_grants enable row level security;

drop policy if exists avatar_apology_grants_no_client on public.avatar_apology_grants;
create policy avatar_apology_grants_no_client
  on public.avatar_apology_grants
  for select
  using (false);

drop policy if exists avatar_apology_grants_service on public.avatar_apology_grants;
create policy avatar_apology_grants_service
  on public.avatar_apology_grants
  for all
  to service_role
  using (true)
  with check (true);

-- Not optional. Supabase's ALTER DEFAULT PRIVILEGES hands anon and authenticated
-- full DML on every new table in public -- that is how user_profiles,
-- user_settings and user_avatar_generations all ended up with
-- SELECT/INSERT/UPDATE/DELETE grants nobody asked for. Without this revoke, any
-- future permissive policy silently goes live to anon.
revoke all on public.avatar_apology_grants from anon;
revoke all on public.avatar_apology_grants from authenticated;
grant all on public.avatar_apology_grants to service_role;

comment on table public.avatar_apology_grants is
  'One row per wallet owed free avatars after being charged SAKURA without delivery. shown_at gates resolution; resolved_at is the permanent "user has decided, never prompt again" latch. Service role only; reached through generate-user-avatar actions grant-status / grant-detail / grant-ack.';

-- === charged-but-refused audit ==============================================

create table if not exists public.avatar_payment_rejections (
  id                    uuid primary key default gen_random_uuid(),
  -- The ON-CHAIN fee payer of the transaction, which the function has proven
  -- equals the authenticated caller. Never a caller-asserted wallet.
  wallet_address        text not null,
  payment_tx_signature  text not null,
  -- What actually arrived at the treasury, read from the transaction. NULL when
  -- the amount could not be established. Never the list price -- a short payment
  -- must not be recorded as a full one, or the remediation over-pays.
  credited_sakura       numeric,
  expected_sakura       numeric not null,
  -- 'rate_limited'         -> payment verified, refused by the 24h limit.
  -- 'payment_verification' -> transaction confirmed and paid by this wallet, but
  --                           it did not satisfy the price/treasury check.
  stage                 text not null,
  reason                text not null,
  created_at            timestamptz not null default now()
);

do $$ begin
  alter table public.avatar_payment_rejections
    add constraint avatar_payment_rejections_stage_check
    check (stage in ('rate_limited', 'payment_verification'));
exception when duplicate_object then null;
end $$;

-- Dedupes retries of the same refusal. Deliberately NOT unique on the signature
-- alone: a signature must always remain claimable by its real payer, and two
-- different wallets must never be able to collide here.
create unique index if not exists avatar_payment_rejections_unique
  on public.avatar_payment_rejections (wallet_address, payment_tx_signature, stage);

create index if not exists avatar_payment_rejections_sig_idx
  on public.avatar_payment_rejections (payment_tx_signature);

create index if not exists avatar_payment_rejections_wallet_idx
  on public.avatar_payment_rejections (wallet_address, created_at desc);

alter table public.avatar_payment_rejections enable row level security;

drop policy if exists avatar_payment_rejections_no_client on public.avatar_payment_rejections;
create policy avatar_payment_rejections_no_client
  on public.avatar_payment_rejections
  for select
  using (false);

drop policy if exists avatar_payment_rejections_service on public.avatar_payment_rejections;
create policy avatar_payment_rejections_service
  on public.avatar_payment_rejections
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.avatar_payment_rejections from anon;
revoke all on public.avatar_payment_rejections from authenticated;
grant all on public.avatar_payment_rejections to service_role;

comment on table public.avatar_payment_rejections is
  'Every request that carried a real, on-chain-attributable SAKURA payment and was still refused. Written only after the transaction has been read and its fee payer proven to equal the caller, so it cannot be poisoned by a stranger asserting somebody else''s signature.';
