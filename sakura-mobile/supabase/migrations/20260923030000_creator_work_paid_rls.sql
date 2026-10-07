-- Apply after signed creator writes and paid reader functions are deployed.
-- Wallet identity is proved in Edge functions, not by Supabase Auth. Public
-- table reads must never reveal drafts or the body of a paid release.
drop policy if exists creator_works_public_insert on public.creator_works;
drop policy if exists work_releases_public_insert on public.work_releases;
drop policy if exists creator_works_public_read on public.creator_works;
drop policy if exists work_releases_public_read on public.work_releases;
drop policy if exists creator_works_published_read on public.creator_works;
drop policy if exists work_releases_published_read on public.work_releases;

revoke insert on public.creator_works from anon, authenticated;
revoke insert on public.work_releases from anon, authenticated;

create policy creator_works_published_read on public.creator_works
  for select to anon, authenticated
  using (publication_status = 'published' and visibility <> 'private');

create policy work_releases_free_published_read on public.work_releases
  for select to anon, authenticated
  using (
    publication_status = 'published' and visibility <> 'private' and
    exists (
      select 1 from public.creator_works w
      where w.id = work_id and w.publication_status = 'published'
        and w.visibility <> 'private' and w.price_sakura = 0
    )
  );
