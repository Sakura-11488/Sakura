import { PublicKey } from '@solana/web3.js';
import { supabase } from './supabase';

const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function normalizeUserQuery(input: string): string {
  return (input || '').trim().replace(/^@/, '');
}

export function isValidWalletAddress(value: string): boolean {
  if (!WALLET_RE.test(value)) return false;
  try {
    // eslint-disable-next-line no-new
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/** Resolve @handle or wallet string to a wallet address. */
export async function resolveUserWallet(input: string): Promise<string | null> {
  const trimmed = normalizeUserQuery(input);
  if (!trimmed) return null;

  if (isValidWalletAddress(trimmed)) return trimmed;

  const { data } = await supabase
    .from('sakura_usernames')
    .select('wallet_address')
    .ilike('username', trimmed)
    .maybeSingle();

  return data?.wallet_address ?? null;
}

/** Prefix search for autocomplete (client-side via edge function preferred for full search). */
export async function lookupUsernamePrefix(prefix: string, limit = 8): Promise<string[]> {
  const q = normalizeUserQuery(prefix);
  if (q.length < 2) return [];

  const { data } = await supabase
    .from('sakura_usernames')
    .select('username')
    .ilike('username', `${q}%`)
    .limit(limit);

  return (data ?? []).map((row) => row.username as string);
}
