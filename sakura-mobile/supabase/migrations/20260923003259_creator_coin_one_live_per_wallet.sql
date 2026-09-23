-- The edge function checks for an existing coin before inserting, but two
-- concurrent requests can both pass that read. Enforce the permanent rule in
-- the database. Failed and disabled attempts remain available for retry.
-- If this migration encounters pre-existing duplicate live rows, resolve them
-- after checking their mint addresses on chain; never discard a launched coin.
create unique index if not exists creator_coins_one_live_per_wallet
  on public.creator_coins (creator_wallet)
  where status in ('requested', 'pending_signature', 'launched');
