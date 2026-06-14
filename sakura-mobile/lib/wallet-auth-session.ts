import { Keypair } from '@solana/web3.js';
import {
  buildWalletAuthHeaders,
  generateWalletAuthMessage,
  type WalletAuthHeaders,
} from './wallet-auth';

const SESSION_TTL_MS = 4 * 60 * 1000; // under server 300s window

type CachedSession = {
  walletAddress: string;
  headers: WalletAuthHeaders;
  expiresAt: number;
};

const sessionCache = new Map<string, CachedSession>();

function cacheKey(walletAddress: string, action: string): string {
  return `${walletAddress}:${action}`;
}

import { clearRealtimeSession } from './wallet-realtime-session';

export function clearWalletAuthSession(): void {
  sessionCache.clear();
  clearRealtimeSession();
}

export async function getWalletAuthSession(
  keypair: Keypair,
  action: string,
  options?: { forceRefresh?: boolean },
): Promise<WalletAuthHeaders> {
  const walletAddress = keypair.publicKey.toBase58();
  const key = cacheKey(walletAddress, action);
  const now = Date.now();
  const cached = sessionCache.get(key);

  if (!options?.forceRefresh && cached && cached.expiresAt > now) {
    return cached.headers;
  }

  const headers = buildWalletAuthHeaders(keypair, action);
  sessionCache.set(key, {
    walletAddress,
    headers,
    expiresAt: now + SESSION_TTL_MS,
  });
  return headers;
}

export async function getOrRefreshWalletAuthSession(
  unlock: () => Promise<Keypair | null>,
  action: string,
): Promise<WalletAuthHeaders> {
  const cached = peekWalletAuthSession(action);
  if (cached) return cached;

  const keypair = await unlock();
  if (!keypair) throw new Error('Wallet approval is required.');
  return getWalletAuthSession(keypair, action, { forceRefresh: true });
}

export function peekWalletAuthSession(action: string): WalletAuthHeaders | null {
  const now = Date.now();
  for (const [key, cached] of sessionCache.entries()) {
    if (key.endsWith(`:${action}`) && cached.expiresAt > now) {
      return cached.headers;
    }
  }
  return null;
}

export { generateWalletAuthMessage };
