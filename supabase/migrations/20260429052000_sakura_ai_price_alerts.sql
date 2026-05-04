-- Sakura AI — price alerts (per wallet).
--
-- "Tell me when SOL hits $250" / "Ping me if SAKURA drops 20%". The client
-- polls this table while the AI modal is open and fires a toast + marks the
-- alert as triggered. Eventually a server-side worker can deliver these as
-- push notifications.
--
-- Apply via Supabase SQL editor or: supabase db push (CLI)

CREATE TABLE IF NOT EXISTS public.sakura_ai_price_alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text NOT NULL,
    token_mint text NOT NULL,
    token_symbol text,
    direction text NOT NULL CHECK (direction IN ('above', 'below')),
    target_usd numeric NOT NULL CHECK (target_usd > 0),
    note text,
    triggered_at timestamptz,
    cancelled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sakura_ai_price_alerts_wallet_active
    ON public.sakura_ai_price_alerts (wallet_address, created_at DESC)
    WHERE triggered_at IS NULL AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sakura_ai_price_alerts_active
    ON public.sakura_ai_price_alerts (token_mint, direction, target_usd)
    WHERE triggered_at IS NULL AND cancelled_at IS NULL;

ALTER TABLE public.sakura_ai_price_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sakura_ai_price_alerts_select_all" ON public.sakura_ai_price_alerts;
CREATE POLICY "sakura_ai_price_alerts_select_all"
    ON public.sakura_ai_price_alerts
    FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "sakura_ai_price_alerts_insert_anon" ON public.sakura_ai_price_alerts;
CREATE POLICY "sakura_ai_price_alerts_insert_anon"
    ON public.sakura_ai_price_alerts
    FOR INSERT
    WITH CHECK (true);

DROP POLICY IF EXISTS "sakura_ai_price_alerts_update_anon" ON public.sakura_ai_price_alerts;
CREATE POLICY "sakura_ai_price_alerts_update_anon"
    ON public.sakura_ai_price_alerts
    FOR UPDATE
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "sakura_ai_price_alerts_delete_anon" ON public.sakura_ai_price_alerts;
CREATE POLICY "sakura_ai_price_alerts_delete_anon"
    ON public.sakura_ai_price_alerts
    FOR DELETE
    USING (true);
