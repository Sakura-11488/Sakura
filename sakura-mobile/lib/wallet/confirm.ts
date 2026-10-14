import {
  TransactionExpiredBlockheightExceededError,
  TransactionExpiredTimeoutError,
  type Connection,
  type RpcResponseAndContext,
  type SignatureResult,
  type SignatureStatus,
  type TransactionError,
} from '@solana/web3.js';

/** Same cadence as the swap and creator-coin loops: at most two RPC reads per round. */
const POLL_INTERVAL_MS = 1_500;

/**
 * Backstop for an RPC that keeps failing, when neither the status nor the
 * block height can be read. It counts from the last block height the RPC
 * answered that still left the blockhash valid, not from the start: while
 * such heights keep arriving, the blockhash
 * expiry (~150 blocks, about 60-90 s, longer when blocks are slow) ends the
 * wait, exactly as in confirmTransaction, which has no wall-clock limit. A
 * fixed limit would call a still-valid, possibly landing transaction
 * "unknown" on a slow network and invite a second payment.
 */
const MAX_WAIT_MS = 120_000;

export class TransactionFailedOnChainError extends Error {
  constructor(public readonly signature: string, public readonly err: TransactionError) {
    super('The transaction failed on-chain.');
    this.name = 'TransactionFailedOnChainError';
  }
}

/**
 * Settled the way `confirmTransaction(…, 'confirmed')` treats a status: anything
 * past 'processed'. A status without `confirmationStatus` comes from an older
 * node that only reports it once rooted.
 */
function isSettled(status: SignatureStatus | null): status is SignatureStatus {
  return !!status && status.confirmationStatus !== 'processed';
}

/**
 * Wait for a submitted transaction by asking over HTTP, never a websocket.
 *
 * `Connection.confirmTransaction` subscribes to `signatureSubscribe` and only
 * asks `getSignatureStatuses` once that subscription is live. Web, and any
 * build whose EXPO_PUBLIC_SOLANA_RPC is the wallet-rpc edge function, cannot
 * open that socket: web3.js derives wss://…/functions/v1/wallet-rpc from the
 * HTTP URL, and the function only serves POST. The status is then never asked
 * for, and the only race confirmTransaction can finish is block-height expiry,
 * so a payment that landed was reported as "block height exceeded" a minute
 * later. A monthly pass was charged but never recorded, and a retry paid
 * twice.
 *
 * This asks the same two questions with plain reads that wallet-rpc allows
 * (getSignatureStatuses, getBlockHeight), like swap.ts and creator-coin.ts. It
 * only watches: it never resends, re-signs or alters the transaction, so the
 * amount, recipient and submission stay exactly as the caller built them.
 *
 * Resolves with confirmTransaction's shape. A confirmed transaction that failed
 * throws TransactionFailedOnChainError, as web3.js does when it learns the
 * outcome from a status read, so no caller reports a failed payment as sent.
 */
export async function confirmTransactionByPolling(
  connection: Pick<Connection, 'getSignatureStatus' | 'getBlockHeight'>,
  { signature, lastValidBlockHeight }: { signature: string; lastValidBlockHeight: number },
  { intervalMs = POLL_INTERVAL_MS, maxWaitMs = MAX_WAIT_MS } = {},
): Promise<RpcResponseAndContext<SignatureResult>> {
  const startedAt = Date.now();
  let lastHeightAt = startedAt;
  for (;;) {
    let settled: RpcResponseAndContext<SignatureStatus> | null = null;
    let expired = false;
    try {
      const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: false });
      if (isSettled(status.value)) {
        settled = { context: status.context, value: status.value };
      } else {
        const height = await connection.getBlockHeight('confirmed');
        if (height > lastValidBlockHeight) {
          // The blockhash can no longer land anything. One last look, through
          // history, covers it confirming between the two reads above. Not
          // progress: if that look keeps failing, the backstop must still end
          // the wait instead of polling (and spending the rate limit) forever.
          const last = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
          if (isSettled(last.value)) settled = { context: last.context, value: last.value };
          else expired = true;
        } else {
          lastHeightAt = Date.now();
        }
      }
    } catch {
      // A failed read (rate limit, 5xx, network) says nothing about the
      // transaction, which may well have landed. Calling it failed here is what
      // invites a second payment, so keep watching.
    }
    if (settled) {
      if (settled.value.err) throw new TransactionFailedOnChainError(signature, settled.value.err);
      return { context: settled.context, value: { err: null } };
    }
    if (expired) throw new TransactionExpiredBlockheightExceededError(signature);
    if (Date.now() - lastHeightAt >= maxWaitMs) {
      throw new TransactionExpiredTimeoutError(signature, (Date.now() - startedAt) / 1000);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
