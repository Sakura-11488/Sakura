import { solanaRpc } from './solana-rpc.ts';
import { sakuraMint } from './verify-sakura-payment.ts';

/**
 * Server-side $SAKURA balance for a wallet.
 *
 * Two things this deliberately does NOT do:
 *
 *  1. It never derives an associated token address. $SAKURA is a Token-2022
 *     mint (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb), so the classic SPL
 *     ATA derivation points at an account that does not exist and silently
 *     reads zero. The mint filter on getTokenAccountsByOwner resolves the
 *     owning program itself and returns Token-2022 accounts correctly.
 *  2. It never reads `uiAmount`. That is an IEEE-754 double and it has already
 *     cost this app real money once (a 100,000 SAKURA payment that arrived as
 *     99999.99999999999 and was refused). All arithmetic here is BigInt over
 *     the raw base-unit string; the float conversion happens once, at the end,
 *     against a threshold that is itself an integer.
 *
 * A wallet may legitimately hold several token accounts for one mint, so the
 * balance is the sum of all of them.
 */

type ParsedTokenAccount = {
  account?: {
    data?: {
      parsed?: {
        info?: {
          tokenAmount?: { amount?: string; decimals?: number };
        };
      };
    };
  };
};

export type SakuraHolding = {
  /** Raw base units, exact. */
  raw: bigint;
  decimals: number;
  /** Whole tokens, floored. Safe to compare against integer thresholds. */
  whole: number;
};

export async function getSakuraHolding(walletAddress: string): Promise<SakuraHolding> {
  const result = await solanaRpc<{ value?: ParsedTokenAccount[] }>('getTokenAccountsByOwner', [
    walletAddress,
    { mint: sakuraMint() },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);

  let raw = 0n;
  let decimals = 6;

  for (const entry of result?.value ?? []) {
    const tokenAmount = entry?.account?.data?.parsed?.info?.tokenAmount;
    const amount = tokenAmount?.amount;
    if (typeof tokenAmount?.decimals === 'number') decimals = tokenAmount.decimals;
    if (!amount) continue;
    try {
      raw += BigInt(amount);
    } catch {
      // Non-numeric amount from a malformed account; ignore it rather than
      // throwing away the whole balance.
    }
  }

  const divisor = 10n ** BigInt(decimals);
  return { raw, decimals, whole: Number(raw / divisor) };
}
