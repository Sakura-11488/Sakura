-- Publish all ready draft chapters on a creator's existing series in one
-- transaction. The Edge Function verifies the wallet signature before calling
-- this service-role-only RPC; the function also checks the owner itself.
create or replace function public.publish_creator_work_checked(
  p_work_id uuid,
  p_wallet text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_work public.creator_works%rowtype;
  v_release public.work_releases%rowtype;
  v_ids uuid[] := array[]::uuid[];
  v_first_id uuid;
  v_asset_count integer;
  v_first_order integer;
  v_last_order integer;
  v_expected_count integer;
  v_was_published boolean;
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
  if v_work.publication_status not in ('draft', 'published') then
    raise exception 'This work cannot be published from its current status.';
  end if;
  v_was_published := v_work.publication_status = 'published';

  for v_release in
    select * from public.work_releases
    where work_id = p_work_id and publication_status = 'draft'
    order by sequence_number for update
  loop
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
    v_ids := array_append(v_ids, v_release.id);
    if v_first_id is null then v_first_id := v_release.id; end if;
  end loop;

  if cardinality(v_ids) = 0 then
    if v_was_published then
      return jsonb_build_object('already_published', true,
        'releases_published', 0);
    end if;
    raise exception 'Add a chapter or episode before publishing.';
  end if;

  -- Restrict the update to the rows validated above. A concurrent new draft
  -- must stay private until it has also passed validation.
  update public.work_releases set publication_status = 'published',
    visibility = 'public', published_at = v_now, updated_at = v_now
    where id = any(v_ids);
  if v_was_published then
    update public.creator_works set updated_at = v_now where id = p_work_id;
  else
    update public.creator_works set publication_status = 'published',
      visibility = 'public', published_at = v_now, updated_at = v_now
      where id = p_work_id;
  end if;

  return jsonb_build_object('already_published', false,
    'new_release', v_was_published,
    'first_release_id', v_first_id,
    'releases_published', cardinality(v_ids));
end;
$$;

revoke all on function public.publish_creator_work_checked(uuid, text)
  from public, anon, authenticated;
grant execute on function public.publish_creator_work_checked(uuid, text)
  to service_role;
