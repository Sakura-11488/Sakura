-- Sakura AI — long-term memories (per wallet).
--
-- Free-form notes Sakura should remember about the user across sessions
-- ("I prefer dub over sub", "Don't recommend horror manga", "I'm a creator
-- on Sakura"). We inject up to N most recent / most relevant rows into the
-- system prompt at the start of every chat turn.
--
-- Apply via Supabase SQL editor or: supabase db push (CLI)

CREATE TABLE IF NOT EXISTS public.sakura_ai_memories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text NOT NULL,
    note text NOT NULL,
    tag text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sakura_ai_memories_wallet
    ON public.sakura_ai_memories (wallet_address, created_at DESC);

ALTER TABLE public.sakura_ai_memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sakura_ai_memories_select_all" ON public.sakura_ai_memories;
CREATE POLICY "sakura_ai_memories_select_all"
    ON public.sakura_ai_memories
    FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "sakura_ai_memories_insert_anon" ON public.sakura_ai_memories;
CREATE POLICY "sakura_ai_memories_insert_anon"
    ON public.sakura_ai_memories
    FOR INSERT
    WITH CHECK (true);

DROP POLICY IF EXISTS "sakura_ai_memories_update_anon" ON public.sakura_ai_memories;
CREATE POLICY "sakura_ai_memories_update_anon"
    ON public.sakura_ai_memories
    FOR UPDATE
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "sakura_ai_memories_delete_anon" ON public.sakura_ai_memories;
CREATE POLICY "sakura_ai_memories_delete_anon"
    ON public.sakura_ai_memories
    FOR DELETE
    USING (true);

CREATE OR REPLACE FUNCTION public.touch_sakura_ai_memories_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sakura_ai_memories_set_updated_at ON public.sakura_ai_memories;
CREATE TRIGGER sakura_ai_memories_set_updated_at
    BEFORE UPDATE ON public.sakura_ai_memories
    FOR EACH ROW EXECUTE FUNCTION public.touch_sakura_ai_memories_updated_at();
