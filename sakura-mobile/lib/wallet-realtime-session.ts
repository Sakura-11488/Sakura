import type { Keypair } from '@solana/web3.js';
import { supabase } from './supabase';
import { buildWalletAuthHeaders } from './wallet-auth';

type CachedRealtimeSession = {
  walletAddress: string;
  token: string;
  expiresAt: number;
};

let cachedSession: CachedRealtimeSession | null = null;

export function clearRealtimeSession(): void {
  cachedSession = null;
  supabase.realtime.setAuth(null);
}

export function peekRealtimeSession(walletAddress?: string | null): string | null {
  if (!cachedSession) return null;
  if (walletAddress && cachedSession.walletAddress !== walletAddress) return null;
  if (cachedSession.expiresAt <= Date.now() + 60_000) return null;
  return cachedSession.token;
}

export async function ensureRealtimeAuth(
  unlock: () => Promise<Keypair | null>,
  walletAddress?: string | null,
): Promise<string> {
  const cached = peekRealtimeSession(walletAddress);
  if (cached) {
    supabase.realtime.setAuth(cached);
    return cached;
  }

  const keypair = await unlock();
  if (!keypair) throw new Error('Wallet approval is required.');

  const address = keypair.publicKey.toBase58();
  const headers = buildWalletAuthHeaders(keypair, 'realtime-session');
  const { data, error } = await supabase.functions.invoke('wallet-realtime-session', {
    body: {},
    headers,
  });

  if (error) throw new Error(error.message || 'Realtime session failed.');
  if (data?.error) throw new Error(String(data.error));

  const token = String(data.access_token ?? '');
  if (!token) throw new Error('Realtime session token missing.');

  const expiresAt = Number(data.expires_at ?? Date.now() + 30 * 60_000);
  cachedSession = { walletAddress: address, token, expiresAt };
  supabase.realtime.setAuth(token);
  return token;
}
