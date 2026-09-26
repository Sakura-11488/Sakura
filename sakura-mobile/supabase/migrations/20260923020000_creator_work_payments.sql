-- One-time, direct SAKURA purchase of a complete creator work. The creator
-- receives the token transfer on-chain; this database only records access.
alter table public.creator_works
  add column if not exists price_sakura numeric(20, 6) not null default 0;

alter table public.creator_works
  add constraint creator_works_price_sakura_range
  check (price_sakura >= 0 and price_sakura <= 1000000000);

create table if not exists public.creator_work_entitlements (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.creator_works(id) on delete cascade,
  buyer_wallet text not null,
  creator_wallet text not null,
  price_sakura numeric(20, 6) not null check (price_sakura > 0),
  payment_signature text not null unique,
  purchased_at timestamptz not null default now(),
  unique (work_id, buyer_wallet)
);

create index if not exists creator_work_entitlements_buyer_idx
  on public.creator_work_entitlements (buyer_wallet, work_id);

alter table public.creator_work_entitlements enable row level security;
revoke all on public.creator_work_entitlements from anon, authenticated;

-- Bearer grants for private anime streams. Only a hash is stored; the raw
-- token appears in a short-lived URL returned after owner/purchase checks.
create table if not exists public.creator_video_access (
  token_hash text primary key,
  work_id uuid not null references public.creator_works(id) on delete cascade,
  video_path text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists creator_video_access_expiry_idx
  on public.creator_video_access (expires_at);

alter table public.creator_video_access enable row level security;
revoke all on public.creator_video_access from anon, authenticated;
