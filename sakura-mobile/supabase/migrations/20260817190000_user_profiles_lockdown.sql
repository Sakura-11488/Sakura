-- user_profiles — closing a privilege escalation, not a defacement bug.
--
-- Apply in the Supabase SQL editor, alone. Never `supabase db push`.
--
-- DEPLOY ORDER MATTERS. The `upsert-profile` edge function must be live before
-- this runs, or profile edits have nowhere to go:
--
--   npx supabase functions deploy upsert-profile --project-ref aofzomovaozcwcozokll
--   <this migration>
--   ship the client (web build + sakura-web push)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- What was wrong
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The table's only policy was:
--
--     "Public Access Profiles"  FOR ALL  TO public  USING (true) WITH CHECK (true)
--
-- so anyone holding the anon key — it ships inside every APK and the PWA bundle
-- — could write any of the 85 rows. The damage is not "someone edits your bio",
-- because `creator-coin-launch/index.ts:39-51` reads this table as its
-- authorization gate:
--
--     const verified = profile?.creator_verification_state === 'verified';
--     const eligible = eligibility?.eligible === true || profile?.revenue_enabled_at;
--
-- An attacker could set their own row to `verified`, stamp `revenue_enabled_at`,
-- and pass it. `request-creator-verification` — the intended path, which only
-- ever writes `'pending'` — was fully bypassable. `has_pass` (paid access),
-- `follower_count`, and `avatar_mint_address` (an NFT ownership claim) were all
-- self-grantable on the same row.
--
-- Checked before locking: 0 rows had creator_verification_state = 'verified',
-- so as far as the data shows this was never exploited.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- The shape of the fix
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Reads stay public. That is deliberate and load-bearing: display names and
-- avatars render in other users' comment threads, follower lists and creator
-- pages, and nine separate client call sites SELECT this table with the anon
-- key. Revoking SELECT would break all of them for no security gain — the data
-- is public by design.
--
-- Writes go to service_role only, and the one legitimate user-facing write goes
-- through `upsert-profile`, which takes the wallet from an Ed25519 signature and
-- builds its payload from an allowlist of exactly three fields (display_name,
-- bio, avatar_seed). Everything else the caller sends is never read. Verified
-- against the deployed function: a request carrying creator_verification_state
-- 'verified', revenue_enabled_at, has_pass true, follower_count 99999 and a
-- different wallet_address returned 200 and changed none of them.

DROP POLICY IF EXISTS "Public Access Profiles" ON public.user_profiles;

DROP POLICY IF EXISTS "user_profiles_public_read" ON public.user_profiles;
CREATE POLICY "user_profiles_public_read"
    ON public.user_profiles
    FOR SELECT TO anon, authenticated
    USING (true);

DROP POLICY IF EXISTS "svc_user_profiles" ON public.user_profiles;
CREATE POLICY "svc_user_profiles"
    ON public.user_profiles
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- Table-level grants, not just policies. A policy alone would not have helped:
-- the grant is what PostgREST checks first, and the previous state had both.
REVOKE ALL    ON public.user_profiles FROM anon, authenticated;
GRANT  SELECT ON public.user_profiles TO   anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Check your work
-- ─────────────────────────────────────────────────────────────────────────────
--
--   select policyname, cmd, roles::text from pg_policies where tablename='user_profiles';
--     -> svc_user_profiles (ALL, service_role) + user_profiles_public_read (SELECT, anon+authenticated)
--
-- With the anon key:
--   GET    /rest/v1/user_profiles?select=display_name  -> 200
--   PATCH  /rest/v1/user_profiles?wallet_address=eq... -> 401 permission denied
--   DELETE /rest/v1/user_profiles?wallet_address=eq... -> 401 permission denied
--
-- Still open, same permissive shape, tracked separately:
--   sakura_usernames (31 rows, username takeover -> redirects a creator's public
--     profile URL), novels / novel_chapters / novel_unlocks (paid content and
--     the paywall columns are anon-writable), and the perp_* tables, whose
--     policies are NAMED "Service role full access" while being granted to
--     public — currently 0 rows, so fix before that feature ships, not after.
--   notify-sakura-transfer has no auth at all: anyone can push a fake
--     "you received 50,000 SAKURA" notification to any wallet.
