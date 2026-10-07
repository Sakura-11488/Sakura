-- Seed tables are used by the private sakura-seed-tools workers with a
-- service-role key. The app, web, and perps clients do not use them.
-- No anon or authenticated policy is intentional: these tables are internal.
alter table public._seed_wallets enable row level security;
alter table public._seed_manga enable row level security;

revoke all on table public._seed_wallets, public._seed_manga
  from anon, authenticated;