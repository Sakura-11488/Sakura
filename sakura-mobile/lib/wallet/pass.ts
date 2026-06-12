import { Buffer } from 'buffer';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { getConnection, sendSakura } from './connection';
import {
  SAKURA_MINT,
  SAKURA_DECIMALS,
  FEE_ROUTER_PROGRAM_ID,
  SAKURA_TREASURY_ADMIN,
  MONTHLY_PASS_PRICE,
  PASS_DURATION_DAYS,
} from './config';
import { getCachedValue, setCachedValue } from '@/lib/cache';

export interface PassStatus {
  valid: boolean;
  expiresAt?: Date;
  /** Where the entitlement came from — useful for UI copy. */
  source?: 'whale' | 'receipt' | 'pda';
}

// Public-beta early access: holding a large $SAKURA bag grants the pass.
const WHALE_THRESHOLD = 1_000_000;

const receiptKey = (wallet: string) => `pass:receipt:${wallet}`;

/** Read a signed little-endian 64-bit integer without relying on Buffer.readBigInt64LE. */
function readI64LE(data: Uint8Array, offset: number): number {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result |= BigInt(data[offset + i]) << (8n * BigInt(i));
  }
  if (result >= 1n << 63n) result -= 1n << 64n;
  return Number(result);
}

/**
 * Check whether a wallet currently holds a valid Sakura monthly pass.
 *
 * Mirrors the legacy web app: a wallet is entitled if it (1) holds >= 1M
 * $SAKURA, (2) has an unexpired local purchase receipt, or (3) owns an
 * unexpired on-chain subscription PDA under the FeeRouter program.
 */
export async function checkPassStatus(walletAddress: string): Promise<PassStatus> {
  try {
    const connection = getConnection();
    const userPubkey = new PublicKey(walletAddress);

    // 1. $SAKURA whale bypass.
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(userPubkey, {
        mint: SAKURA_MINT,
      });
      let total = 0;
      for (const acc of accounts.value) {
        const amount = acc.account.data.parsed?.info?.tokenAmount?.amount;
        if (amount != null) total += Number(amount) / 10 ** SAKURA_DECIMALS;
      }
      if (total >= WHALE_THRESHOLD) {
        return { valid: true, expiresAt: new Date('2099-12-31'), source: 'whale' };
      }
    } catch {
      // Fall through to other checks.
    }

    // 2. Local purchase receipt (FeeRouter program isn't deployed everywhere yet).
    const expiryMs = await getCachedValue<number>(receiptKey(walletAddress));
    if (typeof expiryMs === 'number' && expiryMs > Date.now()) {
      return { valid: true, expiresAt: new Date(expiryMs), source: 'receipt' };
    }

    // 3. On-chain subscription PDA: discriminator(8) + owner(32) + expires_at i64(8).
    try {
      const [subscriptionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('subscription'), userPubkey.toBuffer()],
        FEE_ROUTER_PROGRAM_ID,
      );
      const info = await connection.getAccountInfo(subscriptionPda);
      if (info && info.data.length >= 48) {
        const expiresAtSeconds = readI64LE(info.data, 40);
        const ms = expiresAtSeconds * 1000;
        if (ms > Date.now()) {
          return { valid: true, expiresAt: new Date(ms), source: 'pda' };
        }
      }
    } catch {
      // No PDA / RPC issue — treat as no pass.
    }

    return { valid: false };
  } catch {
    return { valid: false };
  }
}

/** Expiry for a freshly purchased pass (used for previews and receipts). */
export function getPassExpiryDate(from: Date = new Date()): Date {
  const expiry = new Date(from);
  expiry.setDate(expiry.getDate() + PASS_DURATION_DAYS);
  return expiry;
}

/** Persist a local receipt so the pass survives until it naturally expires. */
export async function recordLocalPassReceipt(wallet: string, expiresAt: Date): Promise<void> {
  const ms = expiresAt.getTime();
  const ttl = ms - Date.now();
  if (ttl <= 0) return;
  await setCachedValue(receiptKey(wallet), ms, ttl);
}

export interface PurchaseResult {
  success: boolean;
  signature?: string;
  expiresAt?: Date;
  error?: string;
}

/**
 * Purchase a 30-day monthly pass by transferring $SAKURA to the treasury, then
 * writing a local receipt. The keypair is obtained via biometric unlock.
 */
export async function purchaseMonthlyPass(keypair: Keypair): Promise<PurchaseResult> {
  try {
    const signature = await sendSakura(
      keypair,
      SAKURA_TREASURY_ADMIN.toBase58(),
      MONTHLY_PASS_PRICE,
    );
    const expiresAt = getPassExpiryDate();
    await recordLocalPassReceipt(keypair.publicKey.toBase58(), expiresAt);
    return { success: true, signature, expiresAt };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Payment failed',
    };
  }
}

/** Human-readable countdown for a pass expiry. */
export function formatPassTimeRemaining(expiresAt: Date): string {
  const diff = expiresAt.getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 365) return 'Lifetime access';
  if (days > 0) return `${days}d ${hours}h remaining`;
  return `${hours}h remaining`;
}
