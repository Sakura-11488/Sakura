import type { Keypair } from '@solana/web3.js';
import { supabase } from '@/lib/supabase';
import { buildWalletAuthHeaders } from '@/lib/wallet-auth';

/**
 * Swapping reading XP for SAKURA.
 *
 * Queue-and-settle rather than instant: redeem-xp only records the request and
 * debits the XP, and a separate operator-run processor moves the tokens. Two
 * reasons — the payout key is never reachable from a user-facing endpoint, and
 * a swap can be offered without waiting on chain confirmation in the UI.
 *
 * The rate is authoritative server-side. RATE here is only used to preview the
 * amount before submitting; the value that gets paid is whatever the server
 * stamps onto the row.
 */

export const XP_SAKURA_RATE = 3.19;
export const XP_REDEEM_MIN = 100;

/**
 * Whether to surface the swap in the UI.
 *
 * Off until a funded payout wallet exists (SAKURA_PAYOUT_SECRET). Swaps queue
 * correctly without one, but they would never settle — the XP would be spent
 * against a promise nothing can keep. The screen and the whole path stay built
 * and reachable by URL; this only controls whether it is advertised.
 *
 * Flip to true once a swap has been settled end to end.
 */
export const XP_SWAP_ENABLED = false;

export type RedemptionStatus = 'pending' | 'sent' | 'failed';

export interface XpRedemption {
  id: string;
  xp_spent: number;
  sakura_amount: number;
  rate: number;
  status: RedemptionStatus;
  tx_signature: string | null;
  created_at: string;
}

export interface RedeemResult {
  ok: true;
  id: string;
  xp_spent: number;
  sakura: number;
  rate: number;
  remaining_xp: number;
}

/** Preview only — the server recomputes this at its own rate. */
export function previewSakura(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 0;
  return Number((Math.floor(xp) * XP_SAKURA_RATE).toFixed(2));
}

export async function redeemXp(keypair: Keypair, xp: number): Promise<RedeemResult> {
  const { data, error } = await supabase.functions.invoke('redeem-xp', {
    body: { xp: Math.floor(xp) },
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
  return data as RedeemResult;
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
