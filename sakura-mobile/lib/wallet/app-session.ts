import type { Keypair } from '@solana/web3.js';
import { getWalletWithBiometrics, getWalletKeypairPassive } from './storage';

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
 * Keypair for passive background signing (reading-XP ingest). Returns the warm
 * session cache on any platform; on web it falls back to a no-prompt storage
 * read so XP/badges still accrue when the user is just reading and hasn't done
 * an explicit wallet action this session (the web unlock is an interactive
 * modal, unlike native's frictionless biometric). Native never prompts here.
 */
export async function getPassiveSessionKeypair(): Promise<Keypair | null> {
  if (cachedKeypair) return cachedKeypair;
  const kp = await getWalletKeypairPassive();
  if (kp) cachedKeypair = kp;
  return kp;
}

/**
 * Unlocks the wallet once per app process for non-payment actions (chat,
 * realtime, fan-art, profile). Payment and transfer flows call
 * getWalletWithBiometrics directly and always confirm.
 *
 * On web this tries the no-prompt read first, so opening a chat no longer
 * raises a modal captioned "Confirm transaction" when no transaction exists —
 * the single biggest reason users saw that dialog constantly. It costs nothing
 * in practice: the same passive read already backs background XP ingest on web,
 * so the key is reachable without the modal regardless, and the modal's real
 * job is confirming things that move money.
 *
 * Native keeps prompting here, where it is a frictionless biometric rather than
 * an interactive dialog, and where the passive read deliberately returns null.
 */
export async function unlockForAppSession(): Promise<Keypair | null> {
  if (cachedKeypair) return cachedKeypair;
  if (unlockPromise) return unlockPromise;

  unlockPromise = (async () => {
    const passive = await getWalletKeypairPassive();
    if (passive) {
      cachedKeypair = passive;
      return passive;
    }
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
