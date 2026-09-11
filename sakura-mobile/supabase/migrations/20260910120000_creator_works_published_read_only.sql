-- Stop the anon key reading every creator's unpublished drafts.
--
-- WHAT WAS OPEN. Both tables carried a SELECT policy of `USING (true)` with no
-- role restriction:
--
--   creator_works_public_read    SELECT  USING (true)
--   work_releases_public_read    SELECT  USING (true)
--
-- The anon key ships in the web bundle, so anyone could read every row of both
-- tables — including `work_releases.body_text`, which stores novel prose
-- inline. At the time of writing that is 25 unpublished works and 23
-- unpublished releases across 11 creators, 3 of them carrying real prose.
--
-- This is a different hole from the INSERT one closed in
-- 20260905120000_creator_works_signed_insert_only.sql. That one let anybody
-- forge a work; this one let anybody read one before its author published it.
--
-- WHY IT COULD NOT SIMPLY BE TIGHTENED IN PLACE. RLS cannot express "my own
-- drafts" here: wallets are not Supabase auth users, there is no session for a
-- policy to key on, and `auth.uid()` is null for every request this app makes.
-- So the owner-scoped read had to move behind a signature first — it now lives
-- in `manage-creator-work` as `list_works` / `list_releases`, which check the
-- ed25519 signature and scope every query to the signer. Applying this
-- migration before that shipped would have emptied the creator dashboard.
--
-- WHY `publication_status`, NOT `visibility`. Two rows in each table are
-- `draft` with `visibility = 'public'`, so a policy keyed on visibility alone
-- would still have exposed them. And `visibility <> 'private'` rather than
-- `= 'public'` because the four Sakura Originals are deliberately `unlisted`:
-- keying on 'public' would hide them from the catalog and from the creator-coin
-- eligibility card, which is exactly the group that card exists for.

begin;

drop policy if exists creator_works_public_read on public.creator_works;
drop policy if exists work_releases_public_read on public.work_releases;

create policy creator_works_published_read
  on public.creator_works
  for select
  using (publication_status = 'published' and visibility <> 'private');

create policy work_releases_published_read
  on public.work_releases
  for select
  using (publication_status = 'published' and visibility <> 'private');

commit;
