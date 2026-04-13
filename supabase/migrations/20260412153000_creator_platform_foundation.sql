-- Sakura creator platform foundation
-- Adds shared publishing, asset, review, and minting tables without changing
-- the current novel, manga, or anime consumption flows.

-- ============ Shared creator works ============
CREATE TABLE IF NOT EXISTS public.creator_works (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_wallet text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('novel', 'manga', 'anime')),
    title text NOT NULL DEFAULT '',
    slug text,
    description text NOT NULL DEFAULT '',
    genres text[] NOT NULL DEFAULT '{}',
    language text NOT NULL DEFAULT 'en',
    series_status text NOT NULL DEFAULT 'ongoing'
        CHECK (series_status IN ('ongoing', 'completed', 'hiatus')),
    publication_status text NOT NULL DEFAULT 'draft'
        CHECK (publication_status IN ('draft', 'processing', 'submitted', 'changes_requested', 'approved', 'published', 'rejected', 'archived')),
    visibility text NOT NULL DEFAULT 'private'
        CHECK (visibility IN ('private', 'unlisted', 'public')),
    minting_enabled boolean NOT NULL DEFAULT false,
    published_at timestamptz,
    release_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT creator_works_slug_unique UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS idx_creator_works_creator_wallet
    ON public.creator_works (creator_wallet);

CREATE INDEX IF NOT EXISTS idx_creator_works_kind_status
    ON public.creator_works (kind, publication_status);

CREATE INDEX IF NOT EXISTS idx_creator_works_visibility
    ON public.creator_works (visibility, published_at DESC);

-- ============ Shared releases ============
CREATE TABLE IF NOT EXISTS public.work_releases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id uuid NOT NULL REFERENCES public.creator_works (id) ON DELETE CASCADE,
    sequence_number integer NOT NULL DEFAULT 1,
    title text NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '',
    content_type text NOT NULL DEFAULT 'novel_chapter'
        CHECK (content_type IN ('novel_chapter', 'manga_chapter', 'anime_episode', 'anime_trailer', 'bonus')),
    publication_status text NOT NULL DEFAULT 'draft'
        CHECK (publication_status IN ('draft', 'processing', 'submitted', 'changes_requested', 'approved', 'published', 'rejected', 'archived')),
    visibility text NOT NULL DEFAULT 'private'
        CHECK (visibility IN ('private', 'unlisted', 'public')),
    body_text text NOT NULL DEFAULT '',
    scheduled_at timestamptz,
    published_at timestamptz,
    duration_ms integer,
    release_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (work_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_work_releases_work_id
    ON public.work_releases (work_id, sequence_number);

CREATE INDEX IF NOT EXISTS idx_work_releases_status
    ON public.work_releases (publication_status, published_at DESC);

-- ============ Asset registry ============
CREATE TABLE IF NOT EXISTS public.asset_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_wallet text NOT NULL,
    storage_provider text NOT NULL DEFAULT 'supabase'
        CHECK (storage_provider IN ('supabase', 's3', 'r2', 'b2', 'spaces', 'local')),
    bucket text NOT NULL
        CHECK (bucket IN ('creator-covers', 'creator-thumbnails', 'manga-pages', 'anime-posters', 'anime-media', 'subtitles', 'release-attachments', 'staging')),
    object_path text NOT NULL,
    kind text NOT NULL
        CHECK (kind IN ('cover', 'thumbnail', 'poster', 'manga_page', 'subtitle', 'video_manifest', 'video_source', 'video_transcode', 'attachment', 'placeholder', 'other')),
    mime_type text NOT NULL,
    original_filename text NOT NULL DEFAULT '',
    size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    checksum_sha256 text NOT NULL DEFAULT '',
    width integer,
    height integer,
    duration_ms integer,
    status text NOT NULL DEFAULT 'uploaded'
        CHECK (status IN ('staged', 'uploaded', 'processing', 'ready', 'failed', 'archived')),
    is_public boolean NOT NULL DEFAULT false,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (storage_provider, bucket, object_path)
);

CREATE INDEX IF NOT EXISTS idx_asset_files_owner_wallet
    ON public.asset_files (owner_wallet);

CREATE INDEX IF NOT EXISTS idx_asset_files_kind_status
    ON public.asset_files (kind, status);

CREATE INDEX IF NOT EXISTS idx_asset_files_public_ready
    ON public.asset_files (is_public, status);

CREATE TABLE IF NOT EXISTS public.asset_variants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_file_id uuid NOT NULL REFERENCES public.asset_files (id) ON DELETE CASCADE,
    variant_key text NOT NULL,
    bucket text NOT NULL
        CHECK (bucket IN ('creator-covers', 'creator-thumbnails', 'manga-pages', 'anime-posters', 'anime-media', 'subtitles', 'release-attachments', 'staging')),
    object_path text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    width integer,
    height integer,
    duration_ms integer,
    status text NOT NULL DEFAULT 'ready'
        CHECK (status IN ('processing', 'ready', 'failed', 'archived')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (asset_file_id, variant_key),
    UNIQUE (bucket, object_path)
);

CREATE INDEX IF NOT EXISTS idx_asset_variants_asset_file_id
    ON public.asset_variants (asset_file_id);

-- ============ Asset associations ============
CREATE TABLE IF NOT EXISTS public.work_assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id uuid REFERENCES public.creator_works (id) ON DELETE CASCADE,
    release_id uuid REFERENCES public.work_releases (id) ON DELETE CASCADE,
    asset_file_id uuid NOT NULL REFERENCES public.asset_files (id) ON DELETE CASCADE,
    role text NOT NULL
        CHECK (role IN ('cover', 'thumbnail', 'poster', 'gallery', 'manga_page', 'subtitle', 'video_manifest', 'video_source', 'video_transcode', 'attachment', 'preview')),
    sort_order integer NOT NULL DEFAULT 0,
    is_primary boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT work_assets_target_required CHECK (work_id IS NOT NULL OR release_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_work_assets_work_id
    ON public.work_assets (work_id, role, sort_order);

CREATE INDEX IF NOT EXISTS idx_work_assets_release_id
    ON public.work_assets (release_id, role, sort_order);

-- ============ Review notes ============
CREATE TABLE IF NOT EXISTS public.work_review_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id uuid REFERENCES public.creator_works (id) ON DELETE CASCADE,
    release_id uuid REFERENCES public.work_releases (id) ON DELETE CASCADE,
    reviewer_wallet text NOT NULL DEFAULT '',
    status text NOT NULL
        CHECK (status IN ('changes_requested', 'approved', 'rejected', 'info')),
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT work_review_notes_target_required CHECK (work_id IS NOT NULL OR release_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_work_review_notes_work_id
    ON public.work_review_notes (work_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_review_notes_release_id
    ON public.work_review_notes (release_id, created_at DESC);

-- ============ Mint configuration ============
CREATE TABLE IF NOT EXISTS public.work_mints (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id uuid REFERENCES public.creator_works (id) ON DELETE CASCADE,
    release_id uuid REFERENCES public.work_releases (id) ON DELETE CASCADE,
    creator_wallet text NOT NULL,
    mint_scope text NOT NULL
        CHECK (mint_scope IN ('work', 'release')),
    mint_type text NOT NULL
        CHECK (mint_type IN ('collectible', 'supporter', 'limited_edition', 'access_pass')),
    status text NOT NULL DEFAULT 'disabled'
        CHECK (status IN ('disabled', 'draft', 'pending_review', 'approved', 'live', 'paused', 'sold_out', 'ended')),
    collection_address text,
    tree_address text,
    mint_address text,
    metadata_uri text NOT NULL DEFAULT '',
    max_supply integer,
    minted_count integer NOT NULL DEFAULT 0,
    mint_price numeric NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'SAKURA',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT work_mints_target_required CHECK (work_id IS NOT NULL OR release_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_work_mints_work_id
    ON public.work_mints (work_id, status);

CREATE INDEX IF NOT EXISTS idx_work_mints_release_id
    ON public.work_mints (release_id, status);

-- ============ Initial storage buckets ============
INSERT INTO storage.buckets (id, name, public)
VALUES
    ('creator-covers', 'creator-covers', true),
    ('creator-thumbnails', 'creator-thumbnails', true),
    ('manga-pages', 'manga-pages', false),
    ('anime-posters', 'anime-posters', true),
    ('anime-media', 'anime-media', false),
    ('subtitles', 'subtitles', false),
    ('release-attachments', 'release-attachments', false),
    ('staging', 'staging', false)
ON CONFLICT (id) DO NOTHING;

-- ============ Access control note ============
-- This repo keeps committed Supabase migrations schema-focused.
-- Configure production RLS and storage policies in the Supabase dashboard
-- once the creator platform routes and service-role flows are in place.
