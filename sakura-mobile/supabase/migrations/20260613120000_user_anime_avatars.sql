-- Anime avatar generations (Flux / BFL) — server-mediated writes only.

alter table if exists public.user_profiles
  add column if not exists avatar_url text,
  add column if not exists avatar_generation_id uuid;

create table if not exists public.user_avatar_generations (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  mode text not null check (mode in ('tastes', 'general')),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'ready', 'failed', 'rejected')),
  taste_snapshot jsonb not null default '{}'::jsonb,
  prompt_snapshot text,
  storage_path text,
  public_url text,
  model text not null default 'flux-pro-1.1',
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists user_avatar_generations_wallet_idx
  on public.user_avatar_generations (wallet_address, created_at desc);

create index if not exists user_avatar_generations_status_idx
  on public.user_avatar_generations (status, created_at desc);

alter table public.user_avatar_generations enable row level security;

-- Generations are not directly readable by clients; Edge Functions use service role.
drop policy if exists user_avatar_generations_no_client on public.user_avatar_generations;
create policy user_avatar_generations_no_client on public.user_avatar_generations
  for select using (false);

drop policy if exists user_avatar_generations_service on public.user_avatar_generations;
create policy user_avatar_generations_service on public.user_avatar_generations
  for all to service_role using (true) with check (true);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'user-avatars',
  'user-avatars',
  true,
  6291456,
  array['image/webp', 'image/png', 'image/jpeg']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists user_avatars_public_read on storage.objects;
create policy user_avatars_public_read on storage.objects
  for select
  using (bucket_id = 'user-avatars');

drop policy if exists user_avatars_service_write on storage.objects;
create policy user_avatars_service_write on storage.objects
  for all to service_role
  using (bucket_id = 'user-avatars')
  with check (bucket_id = 'user-avatars');
