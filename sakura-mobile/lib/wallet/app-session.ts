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
 * Returns the already-unlocked session keypair without ever prompting. Used by
 * passive background flows (e.g. reading-XP ingest) that must never trigger a
 * biometric prompt on their own — they sign only if the wallet was already
 * unlocked this session by some other action.
 */
export function getCachedSessionKeypair(): Keypair | null {
  return cachedKeypair;
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
