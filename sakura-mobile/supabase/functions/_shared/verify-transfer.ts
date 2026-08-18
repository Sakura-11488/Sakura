import { fetchConfirmedTransaction } from './solana-rpc.ts';

const DEFAULT_SAKURA_MINT = 'EWiVNxCqNatzV2paBHyfKUwGLnk7WKs9uZTA5jkTpump';
const LAMPORTS_PER_SOL = 1_000_000_000n;

export type TransferAsset = 'sakura' | 'sol';

type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
};

export type TransferFailure =
  | 'unverifiable' // the transaction could not be read at all
  | 'failed' // read it, and it failed on-chain
  | 'payer_mismatch' // real transaction, but somebody else signed it
  | 'no_credit'; // read it, but the receiver was credited nothing

export class TransferVerificationError extends Error {
  readonly failure: TransferFailure;
  constructor(message: string, failure: TransferFailure) {
    super(message);
    this.name = 'TransferVerificationError';
    this.failure = failure;
  }
}

export function sakuraMint(): string {
  return Deno.env.get('SAKURA_MINT')?.trim() || DEFAULT_SAKURA_MINT;
}

function accountKeys(tx: Record<string, unknown>): string[] {
  const message = tx.transaction as
    | { message?: { accountKeys?: Array<{ pubkey?: string } | string> } }
    | undefined;
  return (message?.message?.accountKeys ?? []).map((entry) =>
    typeof entry === 'string' ? entry : entry.pubkey ?? '',
  );
}

/**
 * Balance in RAW BASE UNITS as an exact integer — never `uiAmount`.
 *
 * uiAmount is an IEEE-754 double, and post-minus-pre on two of them does not
 * land on the amount that actually moved. On 2026-08-11 that cost this app
 * three payments across three wallets: 100000 SAKURA into a treasury holding
 * 71655.170417 evaluated to 99999.99999999999 and was rejected as short. The
 * `amount` field is a decimal string of integer base units and is exact.
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

/**
 * What a transaction actually moved to `receiver`, read from the chain.
 *
 * Returns base units as a bigint plus the decimals to scale by, so the caller
 * decides when (and whether) to cross into floating point. Throws rather than
 * returning a zero, because "the chain says nothing arrived" and "I could not
 * reach the chain" must not be collapsed into the same value.
 */
export async function verifyTransfer(input: {
  signature: string;
  expectedSigner: string;
  receiver: string;
  asset: TransferAsset;
}): Promise<{ raw: bigint; decimals: number; amount: number }> {
  /**
   * Retried, because the caller and this function do not share an RPC node.
   *
   * The client confirms at 'confirmed' before it ever calls us, so the
   * transaction is real by the time we look — but the node we ask may not have
   * seen it yet, and a bare 404 here would silently drop the notification for a
   * transfer that genuinely happened. Three attempts over ~1.2s covers ordinary
   * propagation without making a truly missing signature slow to reject.
   */
  let tx: Record<string, unknown> | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600));
    try {
      tx = await fetchConfirmedTransaction(input.signature);
      break;
    } catch (rpcError) {
      lastError = rpcError;
    }
  }
  if (!tx) {
    throw new TransferVerificationError(
      lastError instanceof Error ? lastError.message : 'Transaction not found or not confirmed yet.',
      'unverifiable',
    );
  }

  const meta = tx.meta as
    | {
        err?: unknown;
        preBalances?: number[];
        postBalances?: number[];
        preTokenBalances?: TokenBalance[];
        postTokenBalances?: TokenBalance[];
      }
    | undefined;

  // A failed transaction still exists and is still readable. Its balances are
  // unchanged, so the delta would be zero anyway — but saying "nothing arrived"
  // when the truth is "it reverted" would be a worse answer than the real one.
  if (meta?.err != null) {
    throw new TransferVerificationError('That transaction failed on-chain.', 'failed');
  }

  const keys = accountKeys(tx);
  if (keys[0] !== input.expectedSigner) {
    throw new TransferVerificationError('That transaction was not signed by your wallet.', 'payer_mismatch');
  }

  if (input.asset === 'sol') {
    const pre = meta?.preBalances ?? [];
    const post = meta?.postBalances ?? [];
    let credited = 0n;
    // Summed over every index holding the receiver's key: an address appears
    // once in a well-formed message, but summing costs nothing and cannot
    // undercount.
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== input.receiver) continue;
      const delta = BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);
      if (delta > 0n) credited += delta;
    }
    if (credited <= 0n) {
      throw new TransferVerificationError('That transaction did not send SOL to that wallet.', 'no_credit');
    }
    return { raw: credited, decimals: 9, amount: Number(credited) / Number(LAMPORTS_PER_SOL) };
  }

  const mint = sakuraMint();
  const pre = meta?.preTokenBalances ?? [];
  const post = meta?.postTokenBalances ?? [];

  let credited = 0n;
  let decimals = 6;
  for (const postEntry of post) {
    if (postEntry.mint !== mint) continue;
    if (postEntry.owner !== input.receiver) continue;
    const d = postEntry.uiTokenAmount?.decimals;
    if (typeof d === 'number' && Number.isFinite(d)) decimals = d;
    // Summed across accounts, not assigned: a transfer split over two token
    // accounts owned by the receiver would otherwise be scored on whichever
    // entry happened to come last.
    const preEntry = pre.find((e) => e.accountIndex === postEntry.accountIndex && e.mint === mint);
    const delta = rawAmount(postEntry) - rawAmount(preEntry);
    if (delta > 0n) credited += delta;
  }

  if (credited <= 0n) {
    throw new TransferVerificationError('That transaction did not send SAKURA to that wallet.', 'no_credit');
  }

  return { raw: credited, decimals, amount: Number(credited) / 10 ** decimals };
}
