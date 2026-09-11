import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getConnection } from './connection';
import { base64ToBytes } from './base64';

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
 * THE VALIDATION IS THE POINT. The transaction is built by a service, and the
 * wallet signing it holds real funds. `swap.ts:73` asserts Jupiter's transaction
 * has exactly one signer and that it is us; a pump.fun create legitimately has
 * TWO — the creator and the new mint — so the same rule cannot be reused
 * verbatim. What is asserted instead:
 *
 *   - the fee payer is this wallet, so nobody else's transaction gets signed;
 *   - the signer set is exactly {this wallet, the mint the SERVER declared},
 *     so a compromised builder cannot smuggle in a third signer or a different
 *     mint;
 *   - the mint carries a signature already, since the builder partially signs
 *     as the mint and a transaction missing it can never land.
 *
 * Without those checks this function would sign whatever bytes it was handed.
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

function validate(tx: Transaction, keypair: Keypair, expectedMint: string): void {
  const me = keypair.publicKey.toBase58();

  const feePayer = tx.feePayer?.toBase58();
  if (feePayer !== me) {
    throw new Error('Launch transaction fee payer does not match your wallet.');
  }

  // Signature slots are the required signers, in order, whether or not each is
  // filled in yet — which is what makes this checkable before signing.
  const signers = tx.signatures.map((s) => s.publicKey.toBase58());
  if (signers.length !== 2) {
    throw new Error(`Launch transaction expects ${signers.length} signers, not 2.`);
  }
  if (!signers.includes(me)) {
    throw new Error('Launch transaction does not ask this wallet to sign.');
  }
  if (!signers.includes(expectedMint)) {
    throw new Error('Launch transaction is for a different mint than the one issued.');
  }

  // The builder partially signs as the mint. If that signature is absent the
  // transaction can never land, and submitting it would waste the reservation
  // and leave the creator staring at a failure they cannot act on.
  const mintSlot = tx.signatures.find((s) => s.publicKey.toBase58() === expectedMint);
  if (!mintSlot?.signature) {
    throw new Error('Launch transaction is missing the mint signature.');
  }
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
}): Promise<LaunchSubmitResult> {
  // Reject a malformed mint before it is compared against anything.
  let mint: PublicKey;
  try {
    mint = new PublicKey(input.mintAddress);
  } catch {
    throw new Error('The issued mint address is not valid.');
  }

  const tx = decode(input.unsignedTransaction);
  validate(tx, input.keypair, mint.toBase58());

  // partialSign, not sign: the mint's signature is already present and `sign`
  // would clear it.
  tx.partialSign(input.keypair);

  const raw = tx.serialize({ requireAllSignatures: true, verifySignatures: true });
  const signature = await sendAndConfirm(new Uint8Array(raw), input.lastValidBlockHeight);

  return { signature, mintAddress: mint.toBase58() };
}
