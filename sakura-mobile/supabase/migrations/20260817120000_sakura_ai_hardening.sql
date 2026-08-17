-- Sakura AI hardening — entitlement cache, token ledger, and the memories RLS fix.
--
-- Apply in the Supabase SQL editor, alone. Do NOT use `supabase db push`: the
-- applied-migration ledger on this project does not match the repo directory in
-- either direction, so a push will try to replay history that already ran.
--
-- Four things happen here:
--
--   1. sakura_ai_memories stops being world-readable. Its original policies were
--      USING(true) on SELECT/INSERT/UPDATE/DELETE, which meant any holder of the
--      anon key — and that key ships inside the APK and the PWA bundle — could
--      read or delete any wallet's memories. The edge function now reaches this
--      table with the service role and the *verified* wallet from an Ed25519
--      signature, so anon/authenticated need no access at all.
--
--   2. sakura_ai_entitlement caches the "may this wallet use the AI" answer for
--      a few minutes, so entitlement costs one Solana RPC per wallet per window
--      rather than one per message.
--
--   3. sakura_ai_usage + sakura_ai_daily_usage record what Groq actually
--      charged us, fed from the provider's own `usage` field. The old function
--      threw that away, so there was no way to know what the AI cost.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Memories: service-role only
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.sakura_ai_memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sakura_ai_memories_select_all" ON public.sakura_ai_memories;
DROP POLICY IF EXISTS "sakura_ai_memories_insert_anon" ON public.sakura_ai_memories;
DROP POLICY IF EXISTS "sakura_ai_memories_update_anon" ON public.sakura_ai_memories;
DROP POLICY IF EXISTS "sakura_ai_memories_delete_anon" ON public.sakura_ai_memories;

DROP POLICY IF EXISTS "svc_sakura_ai_memories" ON public.sakura_ai_memories;
CREATE POLICY "svc_sakura_ai_memories"
    ON public.sakura_ai_memories
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON public.sakura_ai_memories FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Entitlement cache
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sakura_ai_entitlement (
    wallet_address text PRIMARY KEY,
    entitled       boolean     NOT NULL DEFAULT false,
    -- Whole $SAKURA, floored. Kept as bigint because the balance is read as
    -- BigInt base units and only divided down at the very end; nothing here is
    -- ever a float.
    sakura_balance bigint      NOT NULL DEFAULT 0,
    lifetime_xp    integer     NOT NULL DEFAULT 0,
    reason         text        NOT NULL DEFAULT 'none',
    checked_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sakura_ai_entitlement ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "svc_sakura_ai_entitlement" ON public.sakura_ai_entitlement;
CREATE POLICY "svc_sakura_ai_entitlement"
    ON public.sakura_ai_entitlement
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON public.sakura_ai_entitlement FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Token ledger
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sakura_ai_usage (
    id                bigserial PRIMARY KEY,
    wallet_address    text        NOT NULL,
    model             text        NOT NULL,
    surface           text,
    prompt_tokens     integer     NOT NULL DEFAULT 0,
    completion_tokens integer     NOT NULL DEFAULT 0,
    total_tokens      integer     NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sakura_ai_usage_wallet
    ON public.sakura_ai_usage (wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sakura_ai_usage_created
    ON public.sakura_ai_usage (created_at DESC);

ALTER TABLE public.sakura_ai_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "svc_sakura_ai_usage" ON public.sakura_ai_usage;
CREATE POLICY "svc_sakura_ai_usage"
    ON public.sakura_ai_usage
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON public.sakura_ai_usage FROM anon, authenticated;

-- Rolled-up daily counter. The kill-switch reads this instead of aggregating
-- sakura_ai_usage on every request — one primary-key read, not a scan that gets
-- slower exactly as usage rises.
CREATE TABLE IF NOT EXISTS public.sakura_ai_daily_usage (
    day          date   PRIMARY KEY,
    total_tokens bigint NOT NULL DEFAULT 0,
    requests     bigint NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sakura_ai_daily_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "svc_sakura_ai_daily_usage" ON public.sakura_ai_daily_usage;
CREATE POLICY "svc_sakura_ai_daily_usage"
    ON public.sakura_ai_daily_usage
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON public.sakura_ai_daily_usage FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.bump_sakura_ai_daily_usage(p_tokens bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total bigint;
BEGIN
    INSERT INTO public.sakura_ai_daily_usage AS d (day, total_tokens, requests, updated_at)
    VALUES ((now() AT TIME ZONE 'utc')::date, GREATEST(p_tokens, 0), 1, now())
    ON CONFLICT (day) DO UPDATE
       SET total_tokens = d.total_tokens + GREATEST(p_tokens, 0),
           requests     = d.requests + 1,
           updated_at   = now()
    RETURNING d.total_tokens INTO v_total;

    RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_sakura_ai_daily_usage(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bump_sakura_ai_daily_usage(bigint) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Chat history: the same defect, on a table with far more in it
-- ─────────────────────────────────────────────────────────────────────────────
--
-- sakura_ai_chat_history shipped with the identical USING(true) policies and
-- holds 251 real conversations across 8 wallets — readable and deletable by
-- anyone with the anon key, which is in every APK and the PWA bundle. Nothing
-- in the repo reads it: `lib/ai-history.ts` and its `.web.ts` twin both store
-- threads locally (expo-file-system on native, localStorage on web). Rows are
-- still arriving, so an older shipped build is writing to it — write-only, and
-- those writes already swallow their errors.
--
-- Locking it down loses nothing anyone can currently see, and stops a log of
-- private conversations accumulating in public.
--
-- SUPERSEDED — see 20260817180000_sakura_ai_grant_fixes.sql. This paragraph
-- claimed sakura_ai_price_alerts could not be locked down because
-- lib/ai-alerts.ts read it with the anon key. That was wrong: the file has no
-- supabase import at all and alerts are pure local storage. The table was
-- revoked in the follow-up migration at no cost. Also note the REVOKE on
-- bump_sakura_ai_daily_usage below did NOT take effect.

DROP POLICY IF EXISTS "sakura_ai_chat_history_select_all" ON public.sakura_ai_chat_history;
DROP POLICY IF EXISTS "sakura_ai_chat_history_insert_anon" ON public.sakura_ai_chat_history;
DROP POLICY IF EXISTS "sakura_ai_chat_history_update_anon" ON public.sakura_ai_chat_history;
DROP POLICY IF EXISTS "sakura_ai_chat_history_delete_anon" ON public.sakura_ai_chat_history;

DROP POLICY IF EXISTS "svc_sakura_ai_chat_history" ON public.sakura_ai_chat_history;
CREATE POLICY "svc_sakura_ai_chat_history"
    ON public.sakura_ai_chat_history
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON public.sakura_ai_chat_history FROM anon, authenticated;
