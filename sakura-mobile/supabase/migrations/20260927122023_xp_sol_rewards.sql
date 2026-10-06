-- Keep the currency and amount promised by every existing SAKURA redemption.
-- Apply before deploying the SOL-aware processor, then deploy redeem-xp last.
-- The old processor must be stopped before SOL rows can enter the queue.
begin;

alter table public.xp_redemptions
  add column payout_asset text not null default 'SAKURA',
  add column sol_lamports bigint,
  alter column sakura_amount drop not null;

alter table public.xp_redemptions
  add constraint xp_redemptions_payout_asset_check
    check (payout_asset in ('SAKURA', 'SOL')),
  add constraint xp_redemptions_payout_amount_check
    check (
      (payout_asset = 'SAKURA' and sakura_amount is not null
        and sakura_amount > 0 and sol_lamports is null)
      or
      (payout_asset = 'SOL' and sakura_amount is null
        and sol_lamports is not null and sol_lamports > 0
        and sol_lamports <= 9007199254740991
        and sol_lamports::numeric = xp_spent::numeric * rate * 1000000000)
    );

comment on column public.xp_redemptions.payout_asset is
  'Currency fixed at queue time. Historical SAKURA rewards are never converted to SOL.';
comment on column public.xp_redemptions.sol_lamports is
  'Native SOL payout in integer lamports; only present for SOL redemptions.';

-- Preserve the signed endpoint as the only client access path.
alter table public.xp_redemptions enable row level security;
revoke all on public.xp_redemptions from public, anon, authenticated;
grant select, insert, update on public.xp_redemptions to service_role;

commit;
