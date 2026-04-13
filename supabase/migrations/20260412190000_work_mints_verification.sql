-- Add verification fields for creator mint intent submissions.
ALTER TABLE public.work_mints
    ADD COLUMN IF NOT EXISTS setup_tx_signature text,
    ADD COLUMN IF NOT EXISTS verified_at timestamptz,
    ADD COLUMN IF NOT EXISTS verification_state jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_mints_setup_tx_signature
    ON public.work_mints (setup_tx_signature)
    WHERE setup_tx_signature IS NOT NULL;
