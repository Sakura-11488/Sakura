-- Give the four Sakura Originals a row in creator_works.
--
-- WHY. The Originals are the flagship case for "recognize your work and launch
-- a coin" — and they are the one group that could not qualify. They exist only
-- as TypeScript constants in `lib/sakura-originals.ts`: `SAKURA_ORIGINAL_IDS`
-- plus a `SAKURA_ORIGINAL_AUTHORS` map of producer wallets, with the episodes
-- served from droplet manifests. There is no row anywhere binding those wallets
-- to those works, so a rule of "you must have published a work on Sakura" locked
-- out exactly the creators it was written for.
--
-- Measured before writing this: all four wallets have 0 works, 0 coins, and no
-- user_profiles or sakura_usernames row. PsyopAnime has 8 followers — the most
-- of any creator in the database — so it already clears the ≥5 follower gate and
-- was blocked solely by this missing row. 2heAnime (1) and the shared
-- Degegen/Burnie wallet (3) remain below the threshold, which is the gate
-- working, not a bug.
--
-- WHY THIS IS NOT FABRICATION. The wallet↔work bindings are already asserted in
-- shipped client code and rendered on the Authors tab of each Original. This
-- moves them out of a constant that needs an app release to change, and into the
-- data model the rest of the platform can actually read.
--
-- WHY `unlisted` RATHER THAN `public`. `listPublishedWorks('anime')` powers the
-- "From Sakura Creators" row and filters on `visibility = 'public'`. Publishing
-- these as public would add a second card beside the existing Originals hero,
-- and tapping it opens `work/[id]`, which would be empty — the episodes live in
-- droplet manifests, not in `work_releases`. `unlisted` keeps the binding and
-- the eligibility (`publication_status = 'published'`) without shipping a card
-- that leads nowhere. Revisit when the work detail screen can redirect an
-- Original to its real player route.
--
-- `burnie-senders` and `degegen-files` deliberately share a wallet, exactly as
-- the source map does. With one coin per creator that is one coin covering both.
--
-- Idempotent: re-running inserts nothing, keyed on release_metadata.original_id.

begin;

insert into public.creator_works (
  creator_wallet, kind, title, slug, description, genres, language,
  series_status, publication_status, visibility, minting_enabled,
  release_metadata, published_at, created_at, updated_at
)
select v.wallet, 'anime', v.title, v.slug, v.description,
       array['Anime']::text[], 'en', 'ongoing', 'published', 'unlisted', false,
       jsonb_build_object('original_id', v.slug, 'source', 'sakura-original'),
       now(), now(), now()
from (values
  ('4YSEhnFVxnoC3Xa2NXCs4G7CPM9GsLGwhoNzCqfRJMpi', 'psyopanime',     'PsyopAnime: The Series', 'Sakura Original anime. Episodes are served from the media host; this row is the canonical record of the work and its producer.'),
  ('AYTey4uWERPEc4LyTM7mkPbs5XSjTCbF3hmM6jWoJgA6', '2heanime',       '2heAnime',               'Sakura Original anime. Episodes are served from the media host; this row is the canonical record of the work and its producer.'),
  ('8qQJTKRbiSmqbX1uVMztiogw1KUchfKCKWN2cwdNQMJb', 'degegen-files',  'Degegen Files',          'Sakura Original anime. Episodes are served from the media host; this row is the canonical record of the work and its producer.'),
  ('8qQJTKRbiSmqbX1uVMztiogw1KUchfKCKWN2cwdNQMJb', 'burnie-senders', 'Burnie Senders',         'Sakura Original anime. Episodes are served from the media host; this row is the canonical record of the work and its producer.')
) as v(wallet, slug, title, description)
where not exists (
  select 1 from public.creator_works cw
  where cw.release_metadata ->> 'original_id' = v.slug
);

commit;
