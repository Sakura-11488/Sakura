-- Novels get a public address, so the reader can stop being a hardcoded map.
--
-- Apply in the Supabase SQL editor, alone. Never `supabase db push`.
--
-- Background: `/app/novel/ext?path=<slug>` was resolved against
-- `new Set(['humour-me'])` in lib/sakura-novels.ts, next to a hand-written
-- object literal holding that novel's title, author, rating, genres, summary and
-- cover URL. Exactly one novel was ever readable, and adding a second meant
-- editing source and shipping a build. The reader now resolves slugs against
-- this table instead.
--
-- HUMOR ME keeps the slug `humour-me` deliberately. The spelling does not match
-- its title, but /app/novel/ext?path=humour-me is a URL people already hold, and
-- breaking it to tidy that would be a poor trade.

ALTER TABLE public.novels ADD COLUMN IF NOT EXISTS slug text;

UPDATE public.novels SET slug = 'humour-me'
 WHERE id = '2e395c49-5e36-4405-99a1-62b01b4e0476' AND slug IS NULL;

UPDATE public.novels
   SET slug = trim(both '-' from regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g'))
 WHERE slug IS NULL;

-- Two titles can slugify identically; keep the oldest and suffix the rest.
UPDATE public.novels n
   SET slug = n.slug || '-' || left(replace(n.id::text, '-', ''), 6)
  FROM (
    SELECT slug, min(created_at) AS keep
      FROM public.novels GROUP BY slug HAVING count(*) > 1
  ) d
 WHERE n.slug = d.slug AND n.created_at <> d.keep;

-- Case-insensitive, because a slug is a URL. This index is also what settles the
-- race when two creators publish the same title at the same moment — the loser
-- gets 23505, which manage-novel turns into a 409 rather than a 500.
CREATE UNIQUE INDEX IF NOT EXISTS idx_novels_slug_unique ON public.novels (lower(slug));

-- ─────────────────────────────────────────────────────────────────────────────
-- Check your work
-- ─────────────────────────────────────────────────────────────────────────────
--
--   select id, title, slug, published from novels order by created_at;
--
-- Verified 2026-08-18:
--   Heroes Of The Sky      -> heroes-of-the-sky
--   HUMOR ME               -> humour-me            (live URL preserved)
--   Time to Rescue Solana  -> time-to-rescue-solana
--
-- All three now resolve in the reader; before this, only humour-me did, and only
-- because it was written into the bundle.
