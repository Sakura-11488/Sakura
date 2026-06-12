-- Creator social graph, notification inbox, feed/chat, verification, and coin-launch records.
-- Writes are expected to be server-mediated through Edge Functions using signed wallet auth.

create extension if not exists pgcrypto;

alter table if exists public.user_profiles
  add column if not exists creator_verified_at timestamptz,
  add column if not exists creator_verified_by text,
  add column if not exists creator_verification_state text not null default 'unverified'
    check (creator_verification_state in ('unverified', 'pending', 'verified', 'rejected', 'revoked')),
  add column if not exists follower_count integer not null default 0,
  add column if not exists following_count integer not null default 0,
  add column if not exists revenue_enabled_at timestamptz;

create table if not exists public.creator_follows (
  follower_wallet text not null,
  creator_wallet text not null,
  notify_new_works boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (follower_wallet, creator_wallet),
  check (follower_wallet <> creator_wallet)
);

create index if not exists creator_follows_creator_idx on public.creator_follows (creator_wallet, created_at desc);
create index if not exists creator_follows_follower_idx on public.creator_follows (follower_wallet, created_at desc);

create table if not exists public.creator_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_wallet text not null,
  actor_wallet text,
  creator_wallet text,
  notification_type text not null check (
    notification_type in (
      'creator_new_work',
      'creator_new_release',
      'creator_post',
      'creator_verified',
      'creator_coin_launched',
      'chat_message',
      'system'
    )
  ),
  title text not null,
  body text not null default '',
  route text,
  work_id uuid,
  release_id uuid,
  post_id uuid,
  chat_thread_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists creator_notifications_recipient_idx
  on public.creator_notifications (recipient_wallet, created_at desc);
create index if not exists creator_notifications_unread_idx
  on public.creator_notifications (recipient_wallet, read_at)
  where read_at is null;

create table if not exists public.creator_verification_requests (
  id uuid primary key default gen_random_uuid(),
  creator_wallet text not null,
  status text not null default 'submitted'
    check (status in ('submitted', 'in_review', 'approved', 'rejected', 'cancelled')),
  follower_count_at_request integer not null default 0,
  published_work_count_at_request integer not null default 0,
  reason text not null default '',
  social_links jsonb not null default '{}'::jsonb,
  reviewer_wallet text,
  reviewer_notes text,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists creator_verification_requests_creator_idx
  on public.creator_verification_requests (creator_wallet, submitted_at desc);
create index if not exists creator_verification_requests_status_idx
  on public.creator_verification_requests (status, submitted_at desc);

create table if not exists public.creator_revenue_eligibility (
  creator_wallet text primary key,
  eligible boolean not null default false,
  eligibility_state text not null default 'not_eligible'
    check (eligibility_state in ('not_eligible', 'eligible', 'suspended')),
  follower_threshold integer not null default 1000,
  follower_count integer not null default 0,
  verified_at timestamptz,
  enabled_at timestamptz,
  disabled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.creator_posts (
  id uuid primary key default gen_random_uuid(),
  creator_wallet text not null,
  post_type text not null default 'text'
    check (post_type in ('text', 'image', 'video', 'work_update', 'coin_update')),
  caption text not null default '',
  visibility text not null default 'public'
    check (visibility in ('public', 'followers', 'private', 'removed')),
  moderation_state text not null default 'approved'
    check (moderation_state in ('pending', 'approved', 'rejected', 'removed')),
  linked_work_id uuid,
  linked_release_id uuid,
  linked_coin_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  like_count integer not null default 0,
  comment_count integer not null default 0,
  view_count integer not null default 0,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists creator_posts_feed_idx
  on public.creator_posts (visibility, moderation_state, published_at desc);
create index if not exists creator_posts_creator_idx
  on public.creator_posts (creator_wallet, published_at desc);

create table if not exists public.creator_post_media (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.creator_posts(id) on delete cascade,
  media_type text not null check (media_type in ('image', 'video')),
  url text not null,
  thumbnail_url text,
  width integer,
  height integer,
  duration_seconds numeric,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.creator_post_likes (
  post_id uuid not null references public.creator_posts(id) on delete cascade,
  wallet_address text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, wallet_address)
);

create table if not exists public.creator_post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.creator_posts(id) on delete cascade,
  wallet_address text not null,
  content text not null check (char_length(content) between 1 and 500),
  moderation_state text not null default 'approved'
    check (moderation_state in ('pending', 'approved', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.creator_post_views (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.creator_posts(id) on delete cascade,
  wallet_address text,
  view_token text,
  viewed_at timestamptz not null default now(),
  watch_ms integer not null default 0
);

create unique index if not exists creator_post_views_wallet_idx
  on public.creator_post_views (post_id, wallet_address)
  where wallet_address is not null;
create unique index if not exists creator_post_views_token_idx
  on public.creator_post_views (post_id, view_token)
  where view_token is not null;

create table if not exists public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  thread_type text not null default 'direct' check (thread_type in ('direct', 'creator_broadcast')),
  created_by_wallet text not null,
  related_creator_wallet text,
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_members (
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  wallet_address text not null,
  role text not null default 'member' check (role in ('member', 'creator', 'admin')),
  last_read_at timestamptz,
  muted_until timestamptz,
  joined_at timestamptz not null default now(),
  primary key (thread_id, wallet_address)
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  sender_wallet text not null,
  content text not null check (char_length(content) between 1 and 2000),
  message_type text not null default 'text' check (message_type in ('text', 'image', 'system')),
  metadata jsonb not null default '{}'::jsonb,
  moderation_state text not null default 'approved'
    check (moderation_state in ('pending', 'approved', 'removed')),
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_thread_idx on public.chat_messages (thread_id, created_at desc);

create table if not exists public.message_blocks (
  blocker_wallet text not null,
  blocked_wallet text not null,
  created_at timestamptz not null default now(),
  primary key (blocker_wallet, blocked_wallet),
  check (blocker_wallet <> blocked_wallet)
);

create table if not exists public.message_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_wallet text not null,
  reported_wallet text,
  thread_id uuid,
  message_id uuid,
  reason text not null,
  status text not null default 'submitted' check (status in ('submitted', 'reviewed', 'dismissed', 'actioned')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists public.creator_coins (
  id uuid primary key default gen_random_uuid(),
  creator_wallet text not null,
  mint_address text unique,
  name text not null,
  symbol text not null,
  description text not null default '',
  image_url text,
  metadata_uri text,
  provider text not null default 'pumpfun',
  provider_pool text not null default 'pump',
  status text not null default 'draft'
    check (status in ('draft', 'requested', 'pending_signature', 'launched', 'failed', 'disabled')),
  launch_signature text unique,
  launched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists creator_coins_creator_idx on public.creator_coins (creator_wallet, created_at desc);

create table if not exists public.creator_coin_launch_requests (
  id uuid primary key default gen_random_uuid(),
  creator_wallet text not null,
  creator_coin_id uuid references public.creator_coins(id) on delete set null,
  status text not null default 'submitted'
    check (status in ('submitted', 'approved', 'rejected', 'built', 'signed', 'verified', 'failed', 'cancelled')),
  requested_payload jsonb not null default '{}'::jsonb,
  unsigned_transaction text,
  provider_response jsonb not null default '{}'::jsonb,
  reviewer_wallet text,
  reviewer_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.creator_coin_launch_transactions (
  id uuid primary key default gen_random_uuid(),
  creator_coin_id uuid references public.creator_coins(id) on delete cascade,
  creator_wallet text not null,
  signature text not null unique,
  transaction_type text not null check (transaction_type in ('launch', 'dev_buy', 'fee_claim', 'buyback')),
  status text not null default 'submitted' check (status in ('submitted', 'confirmed', 'failed', 'rejected')),
  verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.creator_coin_fee_claims (
  id uuid primary key default gen_random_uuid(),
  creator_coin_id uuid references public.creator_coins(id) on delete cascade,
  creator_wallet text not null,
  claim_signature text unique,
  amount_sol numeric,
  status text not null default 'pending' check (status in ('pending', 'claimed', 'converted', 'failed')),
  claimed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.sakura_buyback_records (
  id uuid primary key default gen_random_uuid(),
  creator_coin_id uuid references public.creator_coins(id) on delete set null,
  source_claim_id uuid references public.creator_coin_fee_claims(id) on delete set null,
  source_asset text not null default 'SOL',
  source_amount numeric not null default 0,
  sakura_amount numeric,
  buyback_signature text unique,
  status text not null default 'submitted' check (status in ('submitted', 'confirmed', 'failed', 'rejected')),
  verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.refresh_creator_follow_counts() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    update public.user_profiles
      set follower_count = follower_count + 1, updated_at = now()
      where wallet_address = new.creator_wallet;
    update public.user_profiles
      set following_count = following_count + 1, updated_at = now()
      where wallet_address = new.follower_wallet;
    return new;
  elsif tg_op = 'DELETE' then
    update public.user_profiles
      set follower_count = greatest(follower_count - 1, 0), updated_at = now()
      where wallet_address = old.creator_wallet;
    update public.user_profiles
      set following_count = greatest(following_count - 1, 0), updated_at = now()
      where wallet_address = old.follower_wallet;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists creator_follows_count_insert on public.creator_follows;
create trigger creator_follows_count_insert
after insert on public.creator_follows
for each row execute function public.refresh_creator_follow_counts();

drop trigger if exists creator_follows_count_delete on public.creator_follows;
create trigger creator_follows_count_delete
after delete on public.creator_follows
for each row execute function public.refresh_creator_follow_counts();

alter table public.creator_follows enable row level security;
alter table public.creator_notifications enable row level security;
alter table public.creator_verification_requests enable row level security;
alter table public.creator_revenue_eligibility enable row level security;
alter table public.creator_posts enable row level security;
alter table public.creator_post_media enable row level security;
alter table public.creator_post_likes enable row level security;
alter table public.creator_post_comments enable row level security;
alter table public.creator_post_views enable row level security;
alter table public.chat_threads enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_messages enable row level security;
alter table public.message_blocks enable row level security;
alter table public.message_reports enable row level security;
alter table public.creator_coins enable row level security;
alter table public.creator_coin_launch_requests enable row level security;
alter table public.creator_coin_launch_transactions enable row level security;
alter table public.creator_coin_fee_claims enable row level security;
alter table public.sakura_buyback_records enable row level security;

revoke all on public.creator_follows from anon, authenticated;
revoke all on public.creator_notifications from anon, authenticated;
revoke all on public.creator_verification_requests from anon, authenticated;
revoke all on public.creator_revenue_eligibility from anon, authenticated;
revoke all on public.creator_posts from anon, authenticated;
revoke all on public.creator_post_media from anon, authenticated;
revoke all on public.creator_post_likes from anon, authenticated;
revoke all on public.creator_post_comments from anon, authenticated;
revoke all on public.creator_post_views from anon, authenticated;
revoke all on public.chat_threads from anon, authenticated;
revoke all on public.chat_members from anon, authenticated;
revoke all on public.chat_messages from anon, authenticated;
revoke all on public.message_blocks from anon, authenticated;
revoke all on public.message_reports from anon, authenticated;
revoke all on public.creator_coins from anon, authenticated;
revoke all on public.creator_coin_launch_requests from anon, authenticated;
revoke all on public.creator_coin_launch_transactions from anon, authenticated;
revoke all on public.creator_coin_fee_claims from anon, authenticated;
revoke all on public.sakura_buyback_records from anon, authenticated;

grant select on public.creator_follows to anon, authenticated;
grant select on public.creator_revenue_eligibility to anon, authenticated;
grant select on public.creator_posts to anon, authenticated;
grant select on public.creator_post_media to anon, authenticated;
grant select on public.creator_post_likes to anon, authenticated;
grant select on public.creator_post_comments to anon, authenticated;
grant select on public.creator_coins to anon, authenticated;
grant all on public.creator_follows to service_role;
grant all on public.creator_notifications to service_role;
grant all on public.creator_verification_requests to service_role;
grant all on public.creator_revenue_eligibility to service_role;
grant all on public.creator_posts to service_role;
grant all on public.creator_post_media to service_role;
grant all on public.creator_post_likes to service_role;
grant all on public.creator_post_comments to service_role;
grant all on public.creator_post_views to service_role;
grant all on public.chat_threads to service_role;
grant all on public.chat_members to service_role;
grant all on public.chat_messages to service_role;
grant all on public.message_blocks to service_role;
grant all on public.message_reports to service_role;
grant all on public.creator_coins to service_role;
grant all on public.creator_coin_launch_requests to service_role;
grant all on public.creator_coin_launch_transactions to service_role;
grant all on public.creator_coin_fee_claims to service_role;
grant all on public.sakura_buyback_records to service_role;

drop policy if exists "public read follows" on public.creator_follows;
create policy "public read follows" on public.creator_follows for select using (true);

drop policy if exists "public read creator revenue eligibility" on public.creator_revenue_eligibility;
create policy "public read creator revenue eligibility" on public.creator_revenue_eligibility for select using (true);

drop policy if exists "public read approved creator posts" on public.creator_posts;
create policy "public read approved creator posts" on public.creator_posts
for select using (visibility = 'public' and moderation_state = 'approved');

drop policy if exists "public read creator post media" on public.creator_post_media;
create policy "public read creator post media" on public.creator_post_media
for select using (
  exists (
    select 1 from public.creator_posts p
    where p.id = post_id and p.visibility = 'public' and p.moderation_state = 'approved'
  )
);

drop policy if exists "public read creator post likes" on public.creator_post_likes;
create policy "public read creator post likes" on public.creator_post_likes for select using (true);

drop policy if exists "public read creator post comments" on public.creator_post_comments;
create policy "public read creator post comments" on public.creator_post_comments
for select using (moderation_state = 'approved');

drop policy if exists "public read launched creator coins" on public.creator_coins;
create policy "public read launched creator coins" on public.creator_coins
for select using (status = 'launched');

drop policy if exists "service role manages creator social" on public.creator_follows;
create policy "service role manages creator social" on public.creator_follows for all to service_role using (true) with check (true);

drop policy if exists "service role manages creator notifications" on public.creator_notifications;
create policy "service role manages creator notifications" on public.creator_notifications for all to service_role using (true) with check (true);

drop policy if exists "service role manages verification" on public.creator_verification_requests;
create policy "service role manages verification" on public.creator_verification_requests for all to service_role using (true) with check (true);

drop policy if exists "service role manages revenue eligibility" on public.creator_revenue_eligibility;
create policy "service role manages revenue eligibility" on public.creator_revenue_eligibility for all to service_role using (true) with check (true);

drop policy if exists "service role manages posts" on public.creator_posts;
create policy "service role manages posts" on public.creator_posts for all to service_role using (true) with check (true);

drop policy if exists "service role manages post media" on public.creator_post_media;
create policy "service role manages post media" on public.creator_post_media for all to service_role using (true) with check (true);

drop policy if exists "service role manages post likes" on public.creator_post_likes;
create policy "service role manages post likes" on public.creator_post_likes for all to service_role using (true) with check (true);

drop policy if exists "service role manages post comments" on public.creator_post_comments;
create policy "service role manages post comments" on public.creator_post_comments for all to service_role using (true) with check (true);

drop policy if exists "service role manages post views" on public.creator_post_views;
create policy "service role manages post views" on public.creator_post_views for all to service_role using (true) with check (true);

drop policy if exists "service role manages chat threads" on public.chat_threads;
create policy "service role manages chat threads" on public.chat_threads for all to service_role using (true) with check (true);

drop policy if exists "service role manages chat members" on public.chat_members;
create policy "service role manages chat members" on public.chat_members for all to service_role using (true) with check (true);

drop policy if exists "service role manages chat messages" on public.chat_messages;
create policy "service role manages chat messages" on public.chat_messages for all to service_role using (true) with check (true);

drop policy if exists "service role manages message blocks" on public.message_blocks;
create policy "service role manages message blocks" on public.message_blocks for all to service_role using (true) with check (true);

drop policy if exists "service role manages message reports" on public.message_reports;
create policy "service role manages message reports" on public.message_reports for all to service_role using (true) with check (true);

drop policy if exists "service role manages creator coins" on public.creator_coins;
create policy "service role manages creator coins" on public.creator_coins for all to service_role using (true) with check (true);

drop policy if exists "service role manages coin requests" on public.creator_coin_launch_requests;
create policy "service role manages coin requests" on public.creator_coin_launch_requests for all to service_role using (true) with check (true);

drop policy if exists "service role manages coin txs" on public.creator_coin_launch_transactions;
create policy "service role manages coin txs" on public.creator_coin_launch_transactions for all to service_role using (true) with check (true);

drop policy if exists "service role manages fee claims" on public.creator_coin_fee_claims;
create policy "service role manages fee claims" on public.creator_coin_fee_claims for all to service_role using (true) with check (true);

drop policy if exists "service role manages buybacks" on public.sakura_buyback_records;
create policy "service role manages buybacks" on public.sakura_buyback_records for all to service_role using (true) with check (true);
