-- Realtime for creator follow/subscribe updates.

alter table if exists public.creator_follows replica identity full;

do $$ begin
  alter publication supabase_realtime add table public.creator_follows;
exception when duplicate_object then null;
end $$;

alter table if exists public.creator_follows enable row level security;

drop policy if exists "creator_follows_public_select" on public.creator_follows;
create policy "creator_follows_public_select"
  on public.creator_follows
  for select
  to anon, authenticated
  using (true);

grant select on public.creator_follows to anon, authenticated;

-- follower_count column stays in sync via trigger; expose profile updates too.
alter table if exists public.user_profiles replica identity full;

do $$ begin
  alter publication supabase_realtime add table public.user_profiles;
exception when duplicate_object then null;
end $$;
