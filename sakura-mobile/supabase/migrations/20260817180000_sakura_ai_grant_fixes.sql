-- Sakura AI — fixing a REVOKE that silently did nothing, and finishing the
-- lockdown that 20260817120000_sakura_ai_hardening.sql started.
--
-- Apply in the Supabase SQL editor, alone. Never `supabase db push`.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The previous migration's REVOKE was a no-op. This is the important one.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 20260817120000 ended with:
--
--     REVOKE ALL ON FUNCTION public.bump_sakura_ai_daily_usage(bigint) FROM PUBLIC;
--
-- which looks right and does nothing. `REVOKE ... FROM PUBLIC` removes only the
-- implicit PUBLIC grant; Supabase's default privileges hand EXECUTE *directly*
-- to the `anon` and `authenticated` roles, and a role-specific grant is not
-- touched by revoking from PUBLIC. The live ACL after that migration was:
--
--     postgres=X | anon=X | authenticated=X | service_role=X
--
-- The function is SECURITY DEFINER and writes `sakura_ai_daily_usage`, which is
-- the table the AI kill-switch reads. So anyone holding the anon key — it ships
-- inside every APK and the PWA bundle — could:
--
--     POST /rest/v1/rpc/bump_sakura_ai_daily_usage  {"p_tokens": 999999999}
--
-- and push the counter past SAKURA_AI_DAILY_TOKEN_BUDGET, giving every user a
-- friendly 503 for the rest of the UTC day. One request, no wallet, no
-- signature, repeatable daily. It also permanently corrupts the token ledger
-- that the whole metering effort exists to produce.
--
-- Verified exploitable before the fix (called with p_tokens=0, which returned
-- the live counter), and verified refused after.

REVOKE EXECUTE ON FUNCTION public.bump_sakura_ai_daily_usage(bigint) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.bump_sakura_ai_daily_usage(bigint) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Same shape, pre-existing, and this one destroys real money.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `debit_xp_for_redemption` carried a PUBLIC grant (`=X/postgres`). It is
-- SECURITY DEFINER, so it reaches through the service-role-only RLS on
-- `user_xp_state`, and it takes the victim wallet as a *parameter*:
--
--     update user_xp_state set xp_spent = xp_spent + p_xp where wallet_address = p_wallet
--
-- Any anon caller could burn any wallet's entire XP balance. No `xp_redemptions`
-- row is written and no SAKURA is paid out, so it is pure destruction against a
-- ledger with 60 settled redemptions across 16 wallets — not recoverable without
-- manual repair. `redeem-xp` already calls this through the service role, so
-- nothing legitimate loses access.

REVOKE EXECUTE ON FUNCTION public.debit_xp_for_redemption(text, bigint) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.debit_xp_for_redemption(text, bigint) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. sakura_ai_price_alerts — the blocker I wrote down was not real
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 20260817120000 left this table world-writable and explained why:
--
--     "lib/ai-alerts.ts reads and writes it with the anon key today, so
--      revoking would break price alerts outright."
--
-- That is false. `lib/ai-alerts.ts` imports `expo-notifications`, `lib/cache`
-- and `lib/wallet/token-price` — there is no `supabase` import in the file, and
-- no reference to this table anywhere in the repo outside the migrations. Alerts
-- are entirely local storage under the `sakura_price_alerts_v1` cache key.
--
-- The two rows in the table are from 2026-05 and 2026-06, written by a build
-- that no longer exists, never triggered and never cancelled. Locking this down
-- costs nothing and closes the last USING(true) table in the AI surface.
--
-- The lesson worth keeping: the reason a thing was left undone is itself a
-- claim, and it deserves the same checking as the code.

DROP POLICY IF EXISTS "sakura_ai_price_alerts_select_all" ON public.sakura_ai_price_alerts;
DROP POLICY IF EXISTS "sakura_ai_price_alerts_insert_anon" ON public.sakura_ai_price_alerts;
DROP POLICY IF EXISTS "sakura_ai_price_alerts_update_anon" ON public.sakura_ai_price_alerts;
DROP POLICY IF EXISTS "sakura_ai_price_alerts_delete_anon" ON public.sakura_ai_price_alerts;

DROP POLICY IF EXISTS "svc_sakura_ai_price_alerts" ON public.sakura_ai_price_alerts;
CREATE POLICY "svc_sakura_ai_price_alerts"
    ON public.sakura_ai_price_alerts
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);

REVOKE ALL ON public.sakura_ai_price_alerts FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Check your work: no sakura_ai_* function or table should name anon.
-- ─────────────────────────────────────────────────────────────────────────────
--
--   select p.proname, array_to_string(p.proacl, ' | ')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('bump_sakura_ai_daily_usage', 'debit_xp_for_redemption');
--
--   select tablename, policyname, roles::text
--     from pg_policies where tablename like 'sakura_ai%';
--
-- NOT fixed here, and still open (outside the AI surface, tracked separately):
--   * user_profiles is cmd=ALL / qual=true to public — 85 rows, and
--     creator-coin-launch reads creator_verification_state from it as an
--     authorization gate, so this is privilege escalation, not defacement.
--   * sakura_usernames, novels/novel_chapters/novel_unlocks, and the perp_*
--     tables (whose policies are *named* "Service role full access" but are
--     granted to public) have the same permissive shape.
--   * notify-sakura-transfer has no auth at all — anyone can push a fake
--     "you received 50,000 SAKURA" notification to any wallet.
