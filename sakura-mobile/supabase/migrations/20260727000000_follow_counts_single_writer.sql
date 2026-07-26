-- Follow counters: collapse three racing writers into one absolute recount.
--
-- Production symptom: user_profiles.following_count is wrong. Wallet
-- GYvEXG2bruEtEfbn6t9LaJ4RP6NvTbvmQkvFSYGh83cx has two rows in creator_follows
-- as follower_wallet and following_count = 0. follower_count happened to look
-- correct, but only by accident -- see below.
--
-- Three writers ran on every follow/unfollow:
--   1. creator_follows_count_insert / creator_follows_count_delete
--      -> refresh_creator_follow_counts(): delta arithmetic (+1/-1) on BOTH
--         follower_count and following_count.
--   2. creator_follows_count_trigger
--      -> sync_creator_follower_count(): absolute recount of follower_count ONLY.
--   3. The follow-creator edge function, a manual UPDATE issued from a separate
--      round trip after the transaction had already committed. Removed in the
--      same commit as this migration.
--
-- Postgres fires same-timing AFTER ROW triggers in alphabetical name order, so
-- (2) always ran after (1) -- 'creator_follows_count_i/d...' sorts before
-- 'creator_follows_count_t...' -- and silently overwrote (1)'s arithmetic.
-- That masking is the whole story: follower_count stayed correct because the
-- recount kept repairing it, while following_count, which the recount never
-- touches, drifted unnoticed for as long as the delta writer has existed.
--
-- It also made the obvious cleanups both wrong. Dropping (1) would have killed
-- the only writer of following_count and frozen it at today's wrong values.
-- Dropping (2) would have exposed every increment (1) ever miscounted.
--
-- One writer now, recounting both sides absolutely, so neither column can drift.
--
-- Trigger naming is deliberate: 'creator_follows_sync_counts' still sorts after
-- every 'creator_follows_count_*' name dropped below. This project's applied-
-- migration ledger does not match the files on disk (this migration's
-- predecessor is recorded under a different version string entirely), so an
-- older migration can be replayed and resurrect those triggers. If that
-- happens, the absolute recount still runs last and the counts stay correct.
--
-- Not addressed here, on purpose: both counter columns live on user_profiles
-- and are updated by wallet_address, so a follow aimed at a wallet with no
-- profile row updates zero rows and is silently lost. Three of the four
-- followed creators in production are in that state, one of them with seven
-- real followers. Creating profile rows as a side effect of somebody else
-- following you is a product decision, not a bug fix, so callers that need a
-- trustworthy number must count creator_follows directly -- which is what the
-- creator-coin-launch eligibility gate now does.

-- ── One writer ──────────────────────────────────────────────────────────────

create or replace function public.sync_follow_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  creator_target  text;
  follower_target text;
begin
  creator_target  := coalesce(new.creator_wallet,  old.creator_wallet);
  follower_target := coalesce(new.follower_wallet, old.follower_wallet);

  update public.user_profiles
     set follower_count = (
           select count(*)::int
             from public.creator_follows
            where creator_wallet = creator_target
         ),
         updated_at = now()
   where wallet_address = creator_target;

  update public.user_profiles
     set following_count = (
           select count(*)::int
             from public.creator_follows
            where follower_wallet = follower_target
         ),
         updated_at = now()
   where wallet_address = follower_target;

  return coalesce(new, old);
end;
$$;

-- ── Retire the old writers ──────────────────────────────────────────────────
-- Triggers first, so the functions have no dependents when they are dropped.

drop trigger if exists creator_follows_count_insert  on public.creator_follows;
drop trigger if exists creator_follows_count_delete  on public.creator_follows;
drop trigger if exists creator_follows_count_trigger on public.creator_follows;

drop trigger if exists creator_follows_sync_counts on public.creator_follows;
create trigger creator_follows_sync_counts
after insert or delete on public.creator_follows
for each row execute function public.sync_follow_counts();

drop function if exists public.refresh_creator_follow_counts();
drop function if exists public.sync_creator_follower_count();

-- ── Reconcile what the old writers left behind ──────────────────────────────
-- Both columns, every profile, including the ones that should be zero. The
-- earlier backfill in 20260617130100_sync_follower_count.sql joined against a
-- GROUP BY over creator_follows, so it could only ever raise a count -- a
-- profile whose real count had fallen to zero was never corrected. The WHERE
-- clause keeps this idempotent and stops it touching updated_at on rows that
-- were already right.

update public.user_profiles up
   set follower_count = (
         select count(*)::int
           from public.creator_follows cf
          where cf.creator_wallet = up.wallet_address
       ),
       following_count = (
         select count(*)::int
           from public.creator_follows cf
          where cf.follower_wallet = up.wallet_address
       ),
       updated_at = now()
 where up.follower_count is distinct from (
         select count(*)::int
           from public.creator_follows cf
          where cf.creator_wallet = up.wallet_address
       )
    or up.following_count is distinct from (
         select count(*)::int
           from public.creator_follows cf
          where cf.follower_wallet = up.wallet_address
       );
