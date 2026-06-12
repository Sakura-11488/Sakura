-- Expo push tokens keyed by wallet + device token
create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  expo_push_token text not null,
  platform text not null check (platform in ('ios', 'android', 'web', 'unknown')),
  notify_episodes boolean not null default true,
  notify_chapters boolean not null default true,
  notify_pass boolean not null default true,
  pass_expires_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_tokens_expo_push_token_key unique (expo_push_token)
);

create index if not exists push_tokens_wallet_enabled_idx
  on public.push_tokens (wallet_address)
  where enabled = true;

create index if not exists push_tokens_pass_expiry_idx
  on public.push_tokens (pass_expires_at)
  where enabled = true and notify_pass = true and pass_expires_at is not null;

alter table public.push_tokens enable row level security;

-- Wallet-address identity (same model as favorites/profiles)
create policy "push_tokens_public_all"
  on public.push_tokens
  for all
  to anon, authenticated
  using (true)
  with check (true);

grant all on public.push_tokens to anon, authenticated;
