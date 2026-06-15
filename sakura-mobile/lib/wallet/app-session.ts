import type { Keypair } from '@solana/web3.js';
import { getWalletWithBiometrics } from './storage';

let cachedKeypair: Keypair | null = null;
let unlockPromise: Promise<Keypair | null> | null = null;

/** Clears in-memory session keypair (e.g. on wallet disconnect). */
export function clearAppSessionKeypair(): void {
  cachedKeypair = null;
  unlockPromise = null;
}

/**
 * Unlocks the wallet once per app process for non-payment actions (chat, realtime).
 * Payment and transfer flows should call getWalletWithBiometrics directly.
 */
export async function unlockForAppSession(): Promise<Keypair | null> {
  if (cachedKeypair) return cachedKeypair;
  if (unlockPromise) return unlockPromise;

  unlockPromise = (async () => {
    const keypair = await getWalletWithBiometrics();
    if (keypair) cachedKeypair = keypair;
    return keypair;
  })();

  try {
    return await unlockPromise;
  } finally {
    unlockPromise = null;
  }
}
