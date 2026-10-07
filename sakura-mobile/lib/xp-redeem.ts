import type { Keypair } from '@solana/web3.js';
import { supabase } from '@/lib/supabase';
import { buildWalletAuthHeaders } from '@/lib/wallet-auth';

/**
 * Swapping reading XP for native SOL.
 *
 * Queue-and-settle rather than instant: redeem-xp only records the request and
 * debits the XP, and a separate operator-run processor transfers SOL. Two
 * reasons — the payout key is never reachable from a user-facing endpoint, and
 * a swap can be offered without waiting on chain confirmation in the UI.
 *
 * A signed server quote confirms the rate before submitting. Redemption sends
 * the displayed rate and asset, so the server rejects stale quotes before
 * spending XP.
 */

export { XP_SOL_RATE, XP_REDEEM_MIN, previewSol, formatSol, formatRedemptionAmount } from './xp-reward-amounts';

/**
 * Whether to surface the swap in the UI.
 *
 * On. Swaps are queued, not settled inline: the XP is spent when the request is
 * recorded and the SOL is sent by process-xp-redemptions afterwards. The server
 * pauses new requests until the operator has verified payout readiness.
 */
export const XP_SWAP_ENABLED = true;

export type RedemptionStatus = 'pending' | 'processing' | 'sent' | 'failed';

export interface XpRedemption {
  id: string;
  xp_spent: number;
  sakura_amount: number | null;
  sol_lamports: number | null;
  payout_asset: 'SAKURA' | 'SOL';
  rate: number;
  status: RedemptionStatus;
  tx_signature: string | null;
  created_at: string;
}

export interface RedeemResult {
  ok: true;
  id: string;
  xp_spent: number;
  sol: number;
  sol_lamports: number;
  payout_asset: 'SOL';
  rate: number;
  status: 'pending';
  remaining_xp: number;
  queued_at: string;
}

export interface XpRedemptionQuote {
  ok: true;
  payout_asset: 'SOL';
  rate: number;
  min_xp: number;
  available: boolean;
}

async function invokeRedemption(keypair: Keypair, body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('redeem-xp', {
    body,
    headers: buildWalletAuthHeaders(keypair, 'redeem-xp'),
  });

  if (error) {
    // Edge-function errors carry the useful message in the response body.
    let message = error.message || 'Swap failed.';
    try {
      const body = await (error as { context?: Response }).context?.json();
      if (body?.error) message = String(body.error);
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(String(data.error));
  return data;
}

export async function fetchRedemptionQuote(
  keypair: Keypair,
  options: { includePaused?: boolean } = {},
): Promise<XpRedemptionQuote> {
  const data = await invokeRedemption(keypair, { quote: true });
  if (data?.ok !== true || data.payout_asset !== 'SOL' ||
      !Number.isFinite(data.rate) || data.rate <= 0 ||
      !Number.isSafeInteger(data.min_xp) || data.min_xp <= 0) {
    throw new Error('SOL rewards are unavailable right now. Try again later.');
  }
  if (data.available !== true && !options.includePaused) {
    throw new Error('SOL rewards are temporarily paused. Your XP has not been spent.');
  }
  // Older deployments omit this field; their availability is never assumed.
  if (typeof data.available !== 'boolean') {
    throw new Error('SOL rewards are unavailable right now. Try again later.');
  }
  return data as XpRedemptionQuote;
}

export async function redeemXp(keypair: Keypair, xp: number, rate: number): Promise<RedeemResult> {
  return await invokeRedemption(keypair, {
    xp: Math.floor(xp),
    payout_asset: 'SOL',
    rate,
  }) as RedeemResult;
}

/**
 * A wallet's swap history, newest first.
 *
 * Goes through the signed endpoint rather than querying the table: a wallet
 * address is not a Supabase auth identity, so no RLS policy could tell "my
 * rows" from "anyone's rows". The table is deny-all and this is the way in.
 */
export async function fetchRedemptions(keypair: Keypair): Promise<XpRedemption[]> {
  const { data, error } = await supabase.functions.invoke('redeem-xp', {
    body: { history: true },
    headers: buildWalletAuthHeaders(keypair, 'redeem-xp'),
  });
  if (error || !data?.redemptions) return [];
  return data.redemptions as XpRedemption[];
}
