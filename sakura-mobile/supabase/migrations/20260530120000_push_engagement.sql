-- Activity tracking, marketing prefs, manga chapter state, delivery dedup
alter table public.push_tokens
  add column if not exists last_opened_at timestamptz,
  add column if not exists notify_marketing boolean not null default true;

create index if not exists push_tokens_last_opened_idx
  on public.push_tokens (last_opened_at)
  where enabled = true;

create index if not exists push_tokens_marketing_idx
  on public.push_tokens (notify_marketing)
  where enabled = true and notify_marketing = true;

-- Latest known chapter snapshot per tracked manga (trending/popular feed)
create table if not exists public.push_manga_state (
  manga_id text primary key,
  title text not null,
  latest_chapter_number numeric not null default 0,
  latest_chapter_id text,
  chapter_count int not null default 0,
  seeded boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Prevent spamming the same user with the same campaign too often
create table if not exists public.push_delivery_log (
  id uuid primary key default gen_random_uuid(),
  expo_push_token text not null,
  kind text not null check (kind in ('manga_update', 're_engagement', 'marketing', 'pass_reminder')),
  ref_key text not null,
  sent_at timestamptz not null default now()
);

create index if not exists push_delivery_log_token_kind_sent_idx
  on public.push_delivery_log (expo_push_token, kind, sent_at desc);

create unique index if not exists push_delivery_log_dedup_idx
  on public.push_delivery_log (expo_push_token, kind, ref_key);

alter table public.push_manga_state enable row level security;
alter table public.push_delivery_log enable row level security;

create policy "push_manga_state_service"
  on public.push_manga_state for all to anon, authenticated
  using (true) with check (true);

create policy "push_delivery_log_service"
  on public.push_delivery_log for all to anon, authenticated
  using (true) with check (true);

grant all on public.push_manga_state to anon, authenticated;
grant all on public.push_delivery_log to anon, authenticated;
