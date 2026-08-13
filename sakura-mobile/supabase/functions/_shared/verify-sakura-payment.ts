import { fetchConfirmedTransaction } from './solana-rpc.ts';

const DEFAULT_SAKURA_MINT = 'EWiVNxCqNatzV2paBHyfKUwGLnk7WKs9uZTA5jkTpump';
const DEFAULT_PAYMENT_WALLET = 'G8tc69u9PVjAjaL4h8iD3t845dJrvnTKusrLrjv89EZ1';
const DEFAULT_DECIMALS = 6;

type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: {
    amount?: string;
    decimals?: number;
    uiAmount?: number | null;
    uiAmountString?: string;
  };
};

/**
 * Why a payment was refused, and — critically — whether the refusal can be
 * pinned on a real, on-chain transaction paid by the caller.
 *
 * `attributable` is false unless we actually read the transaction AND its fee
 * payer equals the wallet that signed the request. Only attributable failures
 * may be written to avatar_payment_rejections: anything else would let a caller
 * with a throwaway keypair fabricate "this wallet was charged 100,000 and
 * refused" records for signatures that are not theirs, or do not exist.
 */
export type AvatarPaymentFailure =
  | 'unverifiable' // transaction could not be read at all
  | 'payer_mismatch' // real transaction, but somebody else paid for it
  | 'amount_short' // paid by the caller, but under the price
  | 'treasury_missing'; // paid by the caller, but not to us

export class AvatarPaymentError extends Error {
  readonly failure: AvatarPaymentFailure;
  /** What actually reached the treasury, when it could be established. */
  readonly creditedSakura: number | null;
  /** True only when the transaction was read and its fee payer is the caller. */
  readonly attributable: boolean;

  constructor(
    message: string,
    failure: AvatarPaymentFailure,
    creditedSakura: number | null = null,
  ) {
    super(message);
    this.name = 'AvatarPaymentError';
    this.failure = failure;
    this.creditedSakura = creditedSakura;
    this.attributable = failure === 'amount_short' || failure === 'treasury_missing';
  }
}

function sakuraMint(): string {
  return Deno.env.get('SAKURA_MINT')?.trim() || DEFAULT_SAKURA_MINT;
}

export function avatarPaymentWallet(): string {
  return Deno.env.get('AVATAR_PAYMENT_WALLET')?.trim() || DEFAULT_PAYMENT_WALLET;
}

export function avatarMintPriceSakura(): number {
  const raw = Deno.env.get('AVATAR_MINT_PRICE_SAKURA')?.trim();
  const parsed = raw ? Number(raw) : 100_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100_000;
}

function accountKeyAt(tx: Record<string, unknown>, index: number): string | null {
  const message = tx.transaction as { message?: { accountKeys?: Array<{ pubkey?: string } | string> } } | undefined;
  const keys = message?.message?.accountKeys ?? [];
  const entry = keys[index];
  if (!entry) return null;
  return typeof entry === 'string' ? entry : entry.pubkey ?? null;
}

/**
 * Balance in RAW BASE UNITS as an exact integer.
 *
 * Never read `uiAmount` for arithmetic. It is an IEEE-754 double, and a
 * post-minus-pre subtraction of two such values does not land on the amount
 * that was actually transferred. This is not theoretical: on 2026-08-11 a user
 * paid exactly 100000 SAKURA into a treasury holding 71655.170417, and
 * 171655.170417 - 71655.170417 evaluated to 99999.99999999999 — 1.5e-11 short
 * of the price. The payment was rejected, the SAKURA was gone, and no row was
 * ever written because verification runs before the insert. Three payments
 * across three wallets were lost this way before it was found.
 *
 * The `amount` field is a decimal string of integer base units and is exact.
 */
function rawAmount(balance?: TokenBalance): bigint {
  const raw = balance?.uiTokenAmount?.amount;
  if (!raw) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

function decimalsOf(balance: TokenBalance | undefined, fallback: number): number {
  const decimals = balance?.uiTokenAmount?.decimals;
  return typeof decimals === 'number' && Number.isFinite(decimals) ? decimals : fallback;
}

/** Convert a human SAKURA amount to base units without going through a float. */
function toBaseUnits(amount: number, decimals: number): bigint {
  const [whole, frac = ''] = amount.toFixed(decimals).split('.');
  const padded = frac.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(`${whole}${padded}`);
}

export async function verifyAvatarSakuraPayment(input: {
  signature: string;
  expectedPayer: string;
  minAmountSakura?: number;
  recipientWallet?: string;
}): Promise<{ amount: number; recipient: string }> {
  const minAmount = input.minAmountSakura ?? avatarMintPriceSakura();
  const recipient = input.recipientWallet ?? avatarPaymentWallet();
  const mint = sakuraMint();

  let tx: Record<string, unknown>;
  try {
    tx = await fetchConfirmedTransaction(input.signature);
  } catch (rpcError) {
    // We could not read the chain, so we know nothing about this signature and
    // must not record anything against the caller's wallet.
    throw new AvatarPaymentError(
      rpcError instanceof Error ? rpcError.message : 'Payment transaction not found or not confirmed yet.',
      'unverifiable',
    );
  }

  const feePayer = accountKeyAt(tx, 0);
  if (feePayer !== input.expectedPayer) {
    throw new AvatarPaymentError('Payment signer does not match your wallet.', 'payer_mismatch');
  }

  const meta = tx.meta as {
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | undefined;

  const pre = meta?.preTokenBalances ?? [];
  const post = meta?.postTokenBalances ?? [];

  // Sum every account the recipient owns for this mint, in exact integer base
  // units. Summed rather than assigned: the old code overwrote `credited` each
  // iteration, so a transfer split across two recipient accounts was scored on
  // whichever happened to come last.
  let creditedRaw = 0n;
  let decimals = DEFAULT_DECIMALS;
  for (const postEntry of post) {
    if (postEntry.mint !== mint) continue;
    if (postEntry.owner !== recipient) continue;
    decimals = decimalsOf(postEntry, decimals);
    const preEntry = pre.find(
      (entry) => entry.accountIndex === postEntry.accountIndex && entry.mint === mint,
    );
    const delta = rawAmount(postEntry) - rawAmount(preEntry);
    if (delta > 0n) creditedRaw += delta;
  }

  const minRaw = toBaseUnits(minAmount, decimals);
  const creditedSakura = Number(creditedRaw) / 10 ** decimals;
  if (creditedRaw < minRaw) {
    throw new AvatarPaymentError(
      `Payment must include at least ${minAmount.toLocaleString()} SAKURA to ${recipient}.`,
      'amount_short',
      creditedSakura,
    );
  }

  const raw = JSON.stringify(tx);
  if (!raw.includes(input.expectedPayer)) {
    throw new AvatarPaymentError(
      'Payment transaction does not include your wallet.',
      'treasury_missing',
      creditedSakura,
    );
  }
  if (!raw.includes(recipient) && !raw.includes(mint)) {
    throw new AvatarPaymentError(
      'Payment transaction does not include the Sakura treasury wallet.',
      'treasury_missing',
      creditedSakura,
    );
  }

  return { amount: creditedSakura, recipient };
}
