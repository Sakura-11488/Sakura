import { Keypair } from '@solana/web3.js';
import {
  buildWalletAuthHeaders,
  generateWalletAuthMessage,
  type WalletAuthHeaders,
} from './wallet-auth';
import { clearRealtimeSession } from './wallet-realtime-session';

const SESSION_TTL_MS = 4 * 60 * 1000; // under server 300s window

type CachedSession = {
  walletAddress: string;
  headers: WalletAuthHeaders;
  expiresAt: number;
};

const sessionCache = new Map<string, CachedSession>();
const inflightAuth = new Map<string, Promise<WalletAuthHeaders>>();

function cacheKey(walletAddress: string, action: string): string {
  return `${walletAddress}:${action}`;
}

export function clearWalletAuthSession(): void {
  sessionCache.clear();
  inflightAuth.clear();
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

  const inflightKey = `auth:${action}`;
  const existing = inflightAuth.get(inflightKey);
  if (existing) return existing;

  const promise = (async () => {
    const keypair = await unlock();
    if (!keypair) throw new Error('Could not verify your identity. Try again.');
    return getWalletAuthSession(keypair, action, { forceRefresh: true });
  })();

  inflightAuth.set(inflightKey, promise);
  try {
    return await promise;
  } finally {
    inflightAuth.delete(inflightKey);
  }
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
