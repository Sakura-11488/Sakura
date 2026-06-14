-- Paid avatar NFT mints: server-verified SAKURA payment + on-chain mint address.

alter table if exists public.user_profiles
  add column if not exists avatar_mint_address text;

alter table if exists public.user_avatar_generations
  add column if not exists payment_tx_signature text,
  add column if not exists payment_amount_sakura numeric not null default 100000,
  add column if not exists mint_address text,
  add column if not exists mint_tx_signature text,
  add column if not exists metadata_uri text;

create unique index if not exists user_avatar_generations_payment_tx_unique
  on public.user_avatar_generations (payment_tx_signature)
  where payment_tx_signature is not null;

create unique index if not exists user_avatar_generations_mint_address_unique
  on public.user_avatar_generations (mint_address)
  where mint_address is not null;

create index if not exists user_profiles_avatar_mint_idx
  on public.user_profiles (avatar_mint_address)
  where avatar_mint_address is not null;

update storage.buckets
set allowed_mime_types = array['image/webp', 'image/png', 'image/jpeg', 'application/json']
where id = 'user-avatars';
