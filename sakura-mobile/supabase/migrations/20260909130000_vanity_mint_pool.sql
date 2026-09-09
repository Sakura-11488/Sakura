-- The pool of pre-ground mint keypairs whose public key ends in `sakura`.
--
-- WHY A POOL. A creator coin's contract address is its mint's public key, so
-- making every Sakura coin end in `sakura` means grinding a keypair until it
-- does. Exact lowercase `sakura` is 58^6 = 38,068,692,544 expected attempts —
-- minutes on a GPU, hours on a CPU, and far too slow to do while a creator
-- waits. So they are ground ahead of time, offline, and handed out one per
-- launch.
--
-- Grinding is a batch job, not a service: no uptime requirement, no inbound
-- requests, nothing to host. `scripts/grind-vanity-mints.mjs` runs on an
-- operator machine and uploads only ciphertext.
--
-- WHY THE SECRET IS ENCRYPTED HERE. The builder service must co-sign the
-- pump.fun create instruction as the mint, so somebody has to hold that key
-- until it is used. Storing it in plaintext would mean a database read is
-- enough to take it. Instead the row holds AES-256-GCM ciphertext and the key
-- lives only in the builder's environment, so Postgres never has what it would
-- need to decrypt.
--
-- The blast radius if one leaked anyway is bounded and worth stating plainly:
-- these are single-use throwaway keys that only ever sign one create
-- instruction. An attacker who obtained one could create a token at that
-- address first, burning a pool slot. They could not touch a creator's wallet,
-- their coin, or their fees — the creator is the fee payer and signs
-- separately.
--
-- STATE MACHINE
--   available -> reserved   reserve_vanity_mint(), atomic, one winner
--   reserved  -> consumed   mark_vanity_mint_consumed(), after verify confirms
--   reserved  -> available  release_stale_vanity_reservations(), see the trap

begin;

create table if not exists public.vanity_mints (
  public_key          text primary key,
  secret_encrypted    text not null,
  state               text not null default 'available'
                        check (state in ('available', 'reserved', 'consumed')),
  reserved_for_wallet text,
  reserved_at         timestamptz,
  consumed_signature  text unique,
  consumed_at         timestamptz,
  created_at          timestamptz not null default now(),

  -- The whole point of the table. A row that does not end in `sakura` is a bug
  -- upstream, and it must not be possible to hand one out. Case-sensitive: the
  -- brand is lowercase, and `sAKurA` reads as an accident.
  constraint vanity_mints_suffix check (public_key like '%sakura'),
  -- base58 excludes 0, O, I and l; a key containing them was never a Solana
  -- address and would fail at decode time instead of here.
  constraint vanity_mints_base58 check (public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);

-- Reservation reads only available rows, so keep that index small.
create index if not exists vanity_mints_available_idx
  on public.vanity_mints (created_at)
  where state = 'available';

alter table public.vanity_mints enable row level security;
revoke all on public.vanity_mints from anon, authenticated;
-- No policy for anon/authenticated on purpose: this table holds key material,
-- even encrypted, and nothing client-side has any reason to read it. The
-- service role bypasses RLS, which is how the builder reaches it.

-- ── Reserve one, atomically ─────────────────────────────────────────────────
-- FOR UPDATE SKIP LOCKED is what makes two simultaneous launches take two
-- different addresses instead of racing for the same one. A plain
-- `select ... limit 1` followed by an update would hand both the same key, and
-- the loser's create instruction would fail on an address already in use.
create or replace function public.reserve_vanity_mint(p_wallet text)
returns table (public_key text, secret_encrypted text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.vanity_mints vm
     set state = 'reserved',
         reserved_for_wallet = p_wallet,
         reserved_at = now()
   where vm.public_key = (
           select v.public_key
             from public.vanity_mints v
            where v.state = 'available'
            order by v.created_at
            for update skip locked
            limit 1
         )
  returning vm.public_key, vm.secret_encrypted;
end;
$$;

-- ── Mark one spent ──────────────────────────────────────────────────────────
-- Called after the launch transaction is verified on chain. Idempotent: a
-- second call with the same signature changes nothing.
create or replace function public.mark_vanity_mint_consumed(
  p_public_key text,
  p_signature  text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated int;
begin
  update public.vanity_mints
     set state = 'consumed',
         consumed_signature = p_signature,
         consumed_at = now()
   where public_key = p_public_key
     and state <> 'consumed';
  get diagnostics updated = row_count;
  return updated > 0;
end;
$$;

-- ── Return abandoned reservations ───────────────────────────────────────────
-- THE TRAP, and it is the same shape as the creator_coins reclaim: if a builder
-- reserves a mint, the creator signs, the transaction lands, and verify never
-- runs, then a naive release would hand that address to somebody else — whose
-- create would fail, because the mint already exists on chain.
--
-- So this refuses to release a mint that any creator_coins row still points at
-- in a live state. A stuck row is better than a poisoned one: the pool loses a
-- slot, which is cheap, instead of handing out an address that cannot work.
create or replace function public.release_stale_vanity_reservations(p_minutes int default 30)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  released int;
begin
  update public.vanity_mints vm
     set state = 'available',
         reserved_for_wallet = null,
         reserved_at = null
   where vm.state = 'reserved'
     and vm.reserved_at < now() - make_interval(mins => p_minutes)
     and not exists (
           select 1 from public.creator_coins cc
            where cc.mint_address = vm.public_key
              and cc.status in ('requested', 'pending_signature', 'launched')
         );
  get diagnostics released = row_count;
  return released;
end;
$$;

revoke all on function public.reserve_vanity_mint(text) from public, anon, authenticated;
revoke all on function public.mark_vanity_mint_consumed(text, text) from public, anon, authenticated;
revoke all on function public.release_stale_vanity_reservations(int) from public, anon, authenticated;

commit;
