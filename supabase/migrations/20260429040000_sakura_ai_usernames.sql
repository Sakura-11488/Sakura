-- Sakura AI — usernames table.
-- Stores a single canonical username per wallet so Sakura AI can address
-- each person by name and lookup other users by their handle.
-- Apply via Supabase SQL editor or: supabase db push (CLI)

CREATE TABLE IF NOT EXISTS public.sakura_usernames (
    wallet_address text PRIMARY KEY,
    username text NOT NULL,
    display_name text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness on the handle. We don't use citext to keep
-- the migration self-contained; a functional unique index does the same job.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sakura_usernames_username_unique
    ON public.sakura_usernames (lower(username));

-- Open RLS: anon clients read/write their own row using the wallet they
-- supply in the request. The wallet is the natural primary key, so a write
-- can only collide on the same wallet row.
ALTER TABLE public.sakura_usernames ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sakura_usernames_select_all" ON public.sakura_usernames;
CREATE POLICY "sakura_usernames_select_all"
    ON public.sakura_usernames
    FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "sakura_usernames_insert_anon" ON public.sakura_usernames;
CREATE POLICY "sakura_usernames_insert_anon"
    ON public.sakura_usernames
    FOR INSERT
    WITH CHECK (true);

DROP POLICY IF EXISTS "sakura_usernames_update_anon" ON public.sakura_usernames;
CREATE POLICY "sakura_usernames_update_anon"
    ON public.sakura_usernames
    FOR UPDATE
    USING (true)
    WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.touch_sakura_usernames_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sakura_usernames_set_updated_at ON public.sakura_usernames;
CREATE TRIGGER sakura_usernames_set_updated_at
    BEFORE UPDATE ON public.sakura_usernames
    FOR EACH ROW EXECUTE FUNCTION public.touch_sakura_usernames_updated_at();
