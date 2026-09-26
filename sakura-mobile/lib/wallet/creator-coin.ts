import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { getConnection } from './connection';
import { base64ToBytes } from './base64';
import { validateCreatorCoinTransaction, type ExpectedCreatorCoinLaunch } from './creator-coin-validation';

/**
 * Sign and submit a creator coin launch.
 *
 * THE MISSING MIDDLE. `creator-coin-launch` has always returned an
 * `unsigned_transaction` and the launch screen has always thrown it away in an
 * alert, so no coin could ever be created. This is the step between: validate
 * what the server sent, add the creator's signature, submit, confirm.
 *
 * Modelled on `executeSakuraSwap` in ./swap.ts, including its submit loop —
 * skipPreflight with manual rebroadcast, because a launch that silently expires
 * is worse than one that fails loudly.
 *
 * The builder's bytes are checked against the requested create_v2 instruction
 * and bounded compute budget before this wallet signs them.
 */

export interface LaunchSubmitResult {
  signature: string;
  mintAddress: string;
}

/** Decoded transactions are legacy, not versioned — the builder uses `Transaction`. */
function decode(unsignedTransactionBase64: string): Transaction {
  let tx: Transaction;
  try {
    tx = Transaction.from(base64ToBytes(unsignedTransactionBase64));
  } catch {
    throw new Error('The launch transaction could not be decoded.');
  }
  return tx;
}

/**
 * A confirmation loop of its own rather than swap.ts's, because that one's
 * messages all say "swap" and a creator watching a coin launch fail should not
 * be told a swap expired.
 */
async function sendAndConfirm(raw: Uint8Array, lastValidBlockHeight: number): Promise<string> {
  const connection = getConnection();
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  const startedAt = Date.now();
  let lastRebroadcastAt = startedAt;

  for (;;) {
    const { value } = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: false,
    });
    if (value && (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized')) {
      if (value.err) throw new Error(`Launch failed on-chain: ${JSON.stringify(value.err)}`);
      return signature;
    }

    if ((await connection.getBlockHeight('confirmed')) > lastValidBlockHeight) {
      throw new Error('The launch expired before confirming. Please try again.');
    }

    if (Date.now() - lastRebroadcastAt > 1500) {
      try {
        await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
      } catch {
        // A leader may already hold it; rebroadcasting a known transaction is
        // not an error worth surfacing.
      }
      lastRebroadcastAt = Date.now();
    }

    if (Date.now() - startedAt > 90_000) {
      throw new Error('Launch confirmation timed out after 90s.');
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export async function executeCreatorCoinLaunch(input: {
  unsignedTransaction: string;
  /** The mint the SERVER said it reserved. Never taken from the transaction. */
  mintAddress: string;
  /**
   * The builder's own expiry for the blockhash it baked in.
   *
   * Fetching a fresh one here would be wrong: it would sit later than the
   * transaction's real deadline, so the loop would keep rebroadcasting
   * something that can no longer land and fail on the 90s timeout instead of
   * saying plainly that it expired.
   */
  lastValidBlockHeight: number;
  keypair: Keypair;
  intent: ExpectedCreatorCoinLaunch;
  onSigned?: (signature: string) => Promise<void>;
}): Promise<LaunchSubmitResult> {
  if (!Number.isSafeInteger(input.lastValidBlockHeight) || input.lastValidBlockHeight <= 0) {
    throw new Error('The launch transaction has no valid block height.');
  }
  // Reject a malformed mint before it is compared against anything.
  let mint: PublicKey;
  try {
    mint = new PublicKey(input.mintAddress);
  } catch {
    throw new Error('The issued mint address is not valid.');
  }

  const tx = decode(input.unsignedTransaction);
  validateCreatorCoinTransaction(tx, input.keypair, mint, input.intent);

  // partialSign, not sign: the mint's signature is already present and `sign`
  // would clear it.
  tx.partialSign(input.keypair);

  const raw = tx.serialize({ requireAllSignatures: true, verifySignatures: true });
  if (!tx.signature) throw new Error('Launch transaction has no creator signature.');
  await input.onSigned?.(bs58.encode(Uint8Array.from(tx.signature)));
  const signature = await sendAndConfirm(new Uint8Array(raw), input.lastValidBlockHeight);

  return { signature, mintAddress: mint.toBase58() };
}
