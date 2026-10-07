-- Install before deploying redeem-xp and process-xp-redemptions.
-- One transaction must reserve XP and record its payout promise. Separate
-- HTTP writes could lose XP on interruption or refund an ambiguous insert.
begin;

create function public.queue_sol_xp_redemption(
  p_wallet text,
  p_xp bigint,
  p_sol_lamports bigint,
  p_rate numeric
)
returns table (id uuid, remaining_xp bigint, queued_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_available bigint;
  v_pending bigint;
  v_id uuid;
  v_queued_at timestamptz;
begin
  if p_wallet is null or pg_catalog.btrim(p_wallet) = ''
    or p_xp is null or p_xp <= 0 or p_xp > 9007199254740991
    or p_sol_lamports is null or p_sol_lamports <= 0 or p_sol_lamports > 9007199254740991
    or p_rate is null or p_rate <= 0
    or p_rate * 1000000000 <> pg_catalog.trunc(p_rate * 1000000000)
    or p_sol_lamports::numeric <> p_xp::numeric * p_rate * 1000000000
  then
    raise exception using errcode = '22023', message = 'Invalid SOL redemption amount.';
  end if;

  -- Serializes all queue requests for the same wallet, including the pending
  -- cap check. Other wallets can proceed independently. Lifetime XP and level
  -- are never reduced; only the spent counter changes.
  select s.xp - s.xp_spent into v_available
    from public.user_xp_state as s
    where s.wallet_address = p_wallet
    for update;
  if not found or v_available < p_xp then
    raise exception using errcode = 'P0001', message = 'XP_INSUFFICIENT';
  end if;

  select count(*) into v_pending
    from public.xp_redemptions as r
    where r.wallet_address = p_wallet and r.status in ('pending', 'processing');
  if v_pending >= 3 then
    raise exception using errcode = 'P0001', message = 'XP_QUEUE_FULL';
  end if;

  update public.user_xp_state as s
    set xp_spent = s.xp_spent + p_xp, updated_at = now()
    where s.wallet_address = p_wallet;

  insert into public.xp_redemptions as r
    (wallet_address, xp_spent, payout_asset, sol_lamports, sakura_amount, rate, status)
    values (p_wallet, p_xp, 'SOL', p_sol_lamports, null, p_rate, 'pending')
    returning r.id, r.created_at into v_id, v_queued_at;

  return query select v_id, v_available - p_xp, v_queued_at;
end;
$$;

comment on function public.queue_sol_xp_redemption(text, bigint, bigint, numeric) is
  'Atomically reserves spendable XP and queues native SOL. Only the signed, enabled redemption endpoint may call this service-role RPC.';
revoke all on function public.queue_sol_xp_redemption(text, bigint, bigint, numeric) from public, anon, authenticated;
grant execute on function public.queue_sol_xp_redemption(text, bigint, bigint, numeric) to service_role;
grant select, update on public.user_xp_state to service_role;

-- The processor only invokes this after proving no payout occurred. The row
-- status/signature lock fences stale reconcilers and makes refunding at most
-- once, even when a successful RPC response is lost and retried.
create function public.fail_xp_redemption(
  p_id uuid,
  p_expected_signature text,
  p_reason text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_wallet text;
  v_xp bigint;
begin
  select r.wallet_address, r.xp_spent into v_wallet, v_xp
    from public.xp_redemptions as r
    where r.id = p_id and r.status = 'processing'
      and r.tx_signature is not distinct from p_expected_signature
    for update;
  if not found then
    return false;
  end if;

  -- Refuse inconsistent historical state rather than underflow the counter.
  -- No failed marker may commit unless the full refund also commits.
  update public.user_xp_state as s
    set xp_spent = s.xp_spent - v_xp, updated_at = now()
    where s.wallet_address = v_wallet and v_xp > 0 and s.xp_spent >= v_xp;
  if not found then
    raise exception using errcode = 'P0001', message = 'XP_REFUND_INCONSISTENT';
  end if;

  update public.xp_redemptions as r
    set status = 'failed', error = pg_catalog.left(coalesce(p_reason, 'Payout failed.'), 300), updated_at = now()
    where r.id = p_id;
  return true;
end;
$$;

comment on function public.fail_xp_redemption(uuid, text, text) is
  'Atomically marks a processing payout failed and refunds its XP, only if its recorded signature still matches. Processor must first prove non-delivery.';
revoke all on function public.fail_xp_redemption(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fail_xp_redemption(uuid, text, text) to service_role;

commit;
