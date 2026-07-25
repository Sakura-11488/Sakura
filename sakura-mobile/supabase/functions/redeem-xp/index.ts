import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

/**
 * Queue a swap of reading XP for SAKURA.
 *
 * This function only ever *records* the request — it holds no key and moves no
 * tokens. Settlement is done separately by process-xp-redemptions. Splitting it
 * this way means the swap can be offered before a payout wallet exists, and
 * more importantly that a hot key is never reachable from a user-facing
 * endpoint: the worst a caller can do here is spend their own XP.
 *
 * The XP is debited immediately even though the tokens arrive later. That is
 * deliberate — the balance must reflect what has been committed, or a user
 * could queue the same XP repeatedly while the first swap was still settling.
 *
 * XP is debited, never subtracted from the lifetime total: `xp` drives level
 * and badge unlocks, so spending it directly would demote people and revoke
 * badges they had already earned. `xp_spent` moves instead, and the spendable
 * balance is (xp - xp_spent).
 */

const cors = corsHeaders('POST, OPTIONS');

function payoutRate(): number {
  const raw = Number(Deno.env.get('XP_SAKURA_RATE') || '3.19');
  return Number.isFinite(raw) && raw > 0 ? raw : 3.19;
}

function minRedeemXp(): number {
  const raw = Number(Deno.env.get('XP_REDEEM_MIN') || '100');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
}

/** Cap on how many swaps can be in flight at once, per wallet. */
const MAX_PENDING_PER_WALLET = 3;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let walletAddress: string;
  try {
    ({ walletAddress } = verifyWalletHeaders(req.headers, 'redeem-xp'));
  } catch (err) {
    return jsonResponse(401, { error: err instanceof Error ? err.message : 'Unauthorized.' }, cors);
  }

  const body = (await req.json().catch(() => ({}))) as { xp?: number; history?: boolean };

  // Swap history is served here rather than read directly from the client,
  // because a wallet address isn't a Supabase auth identity — there is no RLS
  // policy that could distinguish "my rows" from "anyone's rows", so the table
  // stays deny-all and this signed call is the only way in.
  if (body.history) {
    const { data } = await supabase
      .from('xp_redemptions')
      .select('id, xp_spent, sakura_amount, rate, status, tx_signature, created_at')
      .eq('wallet_address', walletAddress)
      .order('created_at', { ascending: false })
      .limit(10);
    return jsonResponse(200, { ok: true, redemptions: data ?? [] }, cors);
  }

  const xp = Math.floor(Number(body.xp) || 0);
  const min = minRedeemXp();

  if (!Number.isFinite(xp) || xp <= 0) {
    return jsonResponse(400, { error: 'Enter how much XP to convert.' }, cors);
  }
  if (xp < min) {
    return jsonResponse(400, { error: `Minimum ${min} XP per swap.` }, cors);
  }

  // Stops a queue of unsettled swaps building up while the first is still
  // being processed, which would be confusing to the user and awkward to pay.
  const { count: pendingCount } = await supabase
    .from('xp_redemptions')
    .select('*', { count: 'exact', head: true })
    .eq('wallet_address', walletAddress)
    .eq('status', 'pending');
  if ((pendingCount ?? 0) >= MAX_PENDING_PER_WALLET) {
    return jsonResponse(
      429,
      { error: 'You already have swaps on the way. Hold on until those land.' },
      cors,
    );
  }

  const rate = payoutRate();
  const sakuraAmount = Number((xp * rate).toFixed(6));

  // Debit first. The balance check and the increment are one statement, so two
  // requests racing cannot both observe the same balance and both succeed. A
  // null result means there wasn't enough, and nothing has been charged.
  const { data: debited, error: debitErr } = await supabase.rpc('debit_xp_for_redemption', {
    p_wallet: walletAddress,
    p_xp: xp,
  });
  if (debitErr) {
    return jsonResponse(500, { error: 'Could not read your XP balance.' }, cors);
  }
  const remainingXp = Array.isArray(debited) ? debited[0]?.remaining_xp : undefined;
  if (remainingXp == null) {
    return jsonResponse(400, { error: 'Not enough XP for that swap.' }, cors);
  }

  const { data: redemption, error: insErr } = await supabase
    .from('xp_redemptions')
    .insert({
      wallet_address: walletAddress,
      xp_spent: xp,
      sakura_amount: sakuraAmount,
      rate,
      status: 'pending',
    })
    .select('id, created_at')
    .single();

  if (insErr || !redemption) {
    // Give the XP back rather than charging for a swap that was never recorded.
    await supabase.rpc('debit_xp_for_redemption', { p_wallet: walletAddress, p_xp: -xp });
    return jsonResponse(500, { error: 'Could not queue that swap. Try again.' }, cors);
  }

  return jsonResponse(
    200,
    {
      ok: true,
      id: redemption.id,
      xp_spent: xp,
      sakura: sakuraAmount,
      rate,
      status: 'pending',
      remaining_xp: remainingXp,
      queued_at: redemption.created_at,
    },
    cors,
  );
});
