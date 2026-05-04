-- Sakura AI — chat history (per wallet, cloud-synced).
--
-- Each row is a single message in a conversation thread. We key by wallet so
-- a user who imports their seed phrase on a new device can pull their entire
-- chat history back. Rows are ordered by client-supplied `client_created_at`
-- (millis since epoch) so order is stable across devices/clock skew.
--
-- Apply via Supabase SQL editor or: supabase db push (CLI)

CREATE TABLE IF NOT EXISTS public.sakura_ai_chat_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text NOT NULL,
    thread_id text NOT NULL,
    role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
    content text,
    tool_name text,
    tool_payload jsonb,
    cards jsonb,
    cards_header text,
    client_created_at bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sakura_ai_chat_history_wallet_thread
    ON public.sakura_ai_chat_history (wallet_address, thread_id, client_created_at);

CREATE INDEX IF NOT EXISTS idx_sakura_ai_chat_history_wallet_recent
    ON public.sakura_ai_chat_history (wallet_address, client_created_at DESC);

ALTER TABLE public.sakura_ai_chat_history ENABLE ROW LEVEL SECURITY;

-- The wallet itself is the access key. Anyone with the wallet address can read
-- and write rows for that wallet. This matches the rest of the Sakura RLS model
-- (we treat the address as an opaque token, since it's already public anyway).
DROP POLICY IF EXISTS "sakura_ai_chat_history_select_all" ON public.sakura_ai_chat_history;
CREATE POLICY "sakura_ai_chat_history_select_all"
    ON public.sakura_ai_chat_history
    FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "sakura_ai_chat_history_insert_anon" ON public.sakura_ai_chat_history;
CREATE POLICY "sakura_ai_chat_history_insert_anon"
    ON public.sakura_ai_chat_history
    FOR INSERT
    WITH CHECK (true);

DROP POLICY IF EXISTS "sakura_ai_chat_history_delete_anon" ON public.sakura_ai_chat_history;
CREATE POLICY "sakura_ai_chat_history_delete_anon"
    ON public.sakura_ai_chat_history
    FOR DELETE
    USING (true);
