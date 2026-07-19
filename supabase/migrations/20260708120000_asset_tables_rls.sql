-- Lock down the creator asset registry before the upload UI ships.
-- All writes go through the service-role `upload-work-media` edge function
-- (which bypasses RLS after verifying wallet ownership); anon/authed clients
-- get read-only access to public, ready assets.

ALTER TABLE public.asset_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_assets ENABLE ROW LEVEL SECURITY;

-- Public read: only ready + public assets (covers, posters, droplet video refs).
DROP POLICY IF EXISTS asset_files_public_read ON public.asset_files;
CREATE POLICY asset_files_public_read ON public.asset_files
    FOR SELECT
    USING (is_public = true AND status = 'ready');

DROP POLICY IF EXISTS asset_variants_public_read ON public.asset_variants;
CREATE POLICY asset_variants_public_read ON public.asset_variants
    FOR SELECT
    USING (
        status = 'ready'
        AND EXISTS (
            SELECT 1 FROM public.asset_files af
            WHERE af.id = asset_variants.asset_file_id
              AND af.is_public = true
              AND af.status = 'ready'
        )
    );

-- work_assets rows are visible when they point at a readable asset. Private
-- assets (manga pages) stay hidden from anon; the reader flow fetches them
-- via signed URLs issued server-side.
DROP POLICY IF EXISTS work_assets_public_read ON public.work_assets;
CREATE POLICY work_assets_public_read ON public.work_assets
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.asset_files af
            WHERE af.id = work_assets.asset_file_id
              AND af.is_public = true
              AND af.status = 'ready'
        )
    );

-- No INSERT/UPDATE/DELETE policies: anon clients cannot write these tables.
-- The service-role edge function is the only write path.
