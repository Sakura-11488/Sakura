-- Publish a creator work in one transaction after checking every release.
-- Only the wallet-authenticated Edge Function calls this service-role RPC.
create or replace function public.publish_creator_work_checked(
  p_work_id uuid,
  p_wallet text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_work public.creator_works%rowtype;
  v_release public.work_releases%rowtype;
  v_release_count integer := 0;
  v_published_count integer := 0;
  v_asset_count integer;
  v_first_order integer;
  v_last_order integer;
  v_expected_count integer;
  v_now timestamptz := now();
begin
  select * into v_work from public.creator_works
    where id = p_work_id for update;
  if not found then
    raise exception 'Work not found.';
  end if;
  if v_work.creator_wallet <> p_wallet then
    raise exception 'Not your work.';
  end if;
  if v_work.publication_status = 'published' then
    return jsonb_build_object('already_published', true, 'releases_published', 0);
  end if;
  if v_work.publication_status <> 'draft' then
    raise exception 'This work cannot be published from its current status.';
  end if;

  for v_release in
    select * from public.work_releases
    where work_id = p_work_id order by sequence_number for update
  loop
    v_release_count := v_release_count + 1;
    if v_release.publication_status <> 'draft' then
      continue;
    end if;
    if v_work.kind = 'novel' and length(btrim(v_release.body_text)) = 0 then
      raise exception 'Chapter "%" needs text before publishing.', v_release.title;
    elsif v_work.kind = 'manga' then
      select count(distinct wa.sort_order), min(wa.sort_order), max(wa.sort_order)
        into v_asset_count, v_first_order, v_last_order
      from public.work_assets wa
      join public.asset_files af on af.id = wa.asset_file_id
      where wa.release_id = v_release.id and wa.work_id = p_work_id
        and wa.role = 'manga_page' and af.status = 'ready'
        and af.owner_wallet = p_wallet;
      v_expected_count := case
        when (v_release.release_metadata->>'expected_page_count') ~ '^[0-9]{1,2}$'
        then (v_release.release_metadata->>'expected_page_count')::integer
        else null
      end;
      if v_asset_count = 0 or v_first_order <> 1 or
         v_last_order <> v_asset_count or
         (v_expected_count is not null and v_asset_count <> v_expected_count) then
        raise exception 'Chapter "%" is missing pages. Upload every page before publishing.', v_release.title;
      end if;
    elsif v_work.kind = 'anime' then
      select count(*) into v_asset_count
      from public.work_assets wa
      join public.asset_files af on af.id = wa.asset_file_id
      where wa.release_id = v_release.id and wa.work_id = p_work_id
        and wa.role = 'video_source' and af.status = 'ready'
        and af.owner_wallet = p_wallet;
      if v_asset_count = 0 then
        raise exception 'Episode "%" needs a video before publishing.', v_release.title;
      end if;
    end if;
    v_published_count := v_published_count + 1;
  end loop;
  if v_release_count = 0 then
    raise exception 'Add a chapter or episode before publishing.';
  end if;

  update public.work_releases set publication_status = 'published',
    visibility = 'public', published_at = v_now, updated_at = v_now
    where work_id = p_work_id and publication_status = 'draft';
  update public.creator_works set publication_status = 'published',
    visibility = 'public', published_at = v_now, updated_at = v_now
    where id = p_work_id;

  return jsonb_build_object('already_published', false,
    'releases_published', v_published_count);
end;
$$;

revoke all on function public.publish_creator_work_checked(uuid, text) from public, anon, authenticated;
grant execute on function public.publish_creator_work_checked(uuid, text) to service_role;
