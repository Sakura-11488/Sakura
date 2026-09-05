-- Close the forged-ownership hole on creator_works / work_releases.
--
-- WHAT WAS OPEN. Both tables carried an INSERT policy with `WITH CHECK (true)`
-- and no role restriction:
--
--   creator_works_public_insert    INSERT  WITH CHECK (true)
--   work_releases_public_insert    INSERT  WITH CHECK (true)
--
-- and `lib/creator.ts` inserted straight from the client with the anon key,
-- taking `creator_wallet` from a function argument. The anon key ships in the
-- web bundle. So anyone could create a work attributed to any wallet.
--
-- WHY IT MATTERS NOW. A work used to be a shelf listing. Once published works
-- gate a creator coin, forging a work under someone else's wallet forges the
-- eligibility to launch a token as them. `20260818000000_lock_writable_tables.sql`
-- already listed both INSERTs as knowingly open (lines 120-125); this closes
-- them now that there is a signed write path to replace them.
--
-- THE REPLACEMENT is the `manage-creator-work` edge function, which sets
-- `creator_wallet` from a verified ed25519 signature and never from the request
-- body — the same invariant `manage-novel` states for `novels`. It runs with the
-- service role, which the policies below leave untouched.
--
-- STILL OPEN, DELIBERATELY, and tracked separately: the SELECT policies on both
-- tables are `USING (true)`, so every draft and private row is readable with the
-- anon key — including `work_releases.body_text`, which stores novel prose
-- inline. At the time of writing that is 24 unpublished works and 23 unpublished
-- releases across 11 creators. Closing it requires moving the two dashboard
-- reads (`getCreatorWorks`, `getWorkReleases`) behind a signed function first,
-- because wallets are not Supabase auth users and RLS cannot express "my own
-- drafts" for `anon`. Doing that inside this migration would break the creator
-- dashboard the moment it applied.

begin;

drop policy if exists creator_works_public_insert on public.creator_works;
drop policy if exists work_releases_public_insert on public.work_releases;

-- Belt and braces: the policies above were the only thing granting the write,
-- but revoke the table privilege too so a future permissive policy cannot
-- silently re-open it.
revoke insert on public.creator_works from anon, authenticated;
revoke insert on public.work_releases from anon, authenticated;

commit;
