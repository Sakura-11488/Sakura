import assert from 'node:assert/strict';
import test from 'node:test';
import { WALLET_RPC_URL, browserFetchThrough, loadTs, loadWalletRpc, webRequire } from './wallet-web-harness.mjs';

const web3 = webRequire('@solana/web3.js');
const { confirmTransactionByPolling, TransactionFailedOnChainError } = loadTs('../lib/wallet/confirm.ts', {
  '@solana/web3.js': web3,
});
const SIGNATURE = '5'.repeat(88);
const LAST_VALID = 1_000;
const fast = { intervalMs: 0 };
const confirmed = (overrides = {}) => ({ slot: 9, confirmations: 1, err: null, confirmationStatus: 'confirmed', ...overrides });

/**
 * A Connection stand-in that answers from scripts. Each entry is a value, or
 * an Error to throw; the last entry repeats.
 */
function chain({ statuses = [null], heights = [LAST_VALID - 100], history = [null] }) {
  const calls = [];
  const next = (list, i) => {
    const entry = list[Math.min(i, list.length - 1)];
    if (entry instanceof Error) throw entry;
    return entry;
  };
  let s = 0, h = 0, past = 0;
  return {
    calls,
    async getSignatureStatus(signature, config) {
      assert.equal(signature, SIGNATURE);
      calls.push(config?.searchTransactionHistory ? 'history' : 'status');
      const value = config?.searchTransactionHistory ? next(history, past++) : next(statuses, s++);
      return { context: { slot: 10 }, value };
    },
    async getBlockHeight(commitment) {
      assert.equal(commitment, 'confirmed');
      calls.push('height');
      return next(heights, h++);
    },
  };
}

test('resolves once the signature is confirmed, from plain status reads', async () => {
  const connection = chain({ statuses: [null, null, confirmed()] });
  const result = await confirmTransactionByPolling(connection, { signature: SIGNATURE, lastValidBlockHeight: LAST_VALID }, fast);
  // Same shape as confirmTransaction, so sendSakura's `value.err` check still reads it.
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { context: { slot: 10 }, value: { err: null } });
  assert.deepEqual(connection.calls, ['status', 'height', 'status', 'height', 'status']);
});

test("'processed' keeps waiting; 'finalized' and a node without confirmationStatus count as confirmed", async () => {
  const processedThenFinal = chain({
    statuses: [confirmed({ confirmationStatus: 'processed' }), confirmed({ confirmationStatus: 'finalized' })],
  });
  await confirmTransactionByPolling(processedThenFinal, { signature: SIGNATURE, lastValidBlockHeight: LAST_VALID }, fast);
  assert.deepEqual(processedThenFinal.calls, ['status', 'height', 'status']);
  const olderNode = chain({ statuses: [confirmed({ confirmationStatus: undefined, confirmations: null })] });
  await confirmTransactionByPolling(olderNode, { signature: SIGNATURE, lastValidBlockHeight: LAST_VALID }, fast);
});

test('a transaction that failed on-chain is reported as failed, never as sent', async () => {
  const err = { InstructionError: [0, { Custom: 1 }] };
  const connection = chain({ statuses: [confirmed({ err })] });
  await assert.rejects(
    confirmTransactionByPolling(connection, { signature: SIGNATURE, lastValidBlockHeight: LAST_VALID }, fast),
    (error) => error instanceof TransactionFailedOnChainError && error.err === err &&
      error.message === 'The transaction failed on-chain.' && error.signature === SIGNATURE,
  );
});

test('an expired blockhash fails only after a last look through history', async () => {
  const connection = chain({ heights: [LAST_VALID, LAST_VALID + 1] });
  await assert.rejects(
    confirmTransactionByPolling(connection, { signature: SIGNATURE, lastValidBlockHeight: LAST_VALID }, fast),
    web3.TransactionExpiredBlockheightExceededError,
  );
  assert.deepEqual(connection.calls, ['status', 'height', 'status', 'height', 'history']);
});

test('a transaction that confirmed as its blockhash expired is still reported as sent', async () => {
  const connection = chain({ heights: [LAST_VALID + 1], history: [confirmed()] });
  const result = await confirmTransactionByPolling(connection, { signature: SIGNATURE, lastValidBlockHeight: LAST_VALID }, fast);
  assert.equal(result.value.err, null);
});

test('a failed RPC read keeps watching rather than calling a landed payment failed', async () => {
  const rateLimited = new Error('429 RPC rate limit reached.');
  const connection = chain({ statuses: [rateLimited, null, confirmed()], heights: [rateLimited, LAST_VALID - 1] });
  const result = await confirmTransactionByPolling(connection, { signature: SIGNATURE, lastValidBlockHeight: LAST_VALID }, fast);
  assert.equal(result.value.err, null);
  // A throwing status read, then a throwing height read, then the answer.
  assert.deepEqual(connection.calls, ['status', 'status', 'height', 'status']);
});

test('an RPC that never answers ends with an explicit unknown outcome, not a hang', async () => {
  const connection = chain({ statuses: [new Error('network down')] });
  await assert.rejects(
    confirmTransactionByPolling(connection, { signature: SIGNATURE, lastValidBlockHeight: LAST_VALID },
      { intervalMs: 1, maxWaitMs: 20 }),
    (error) => error instanceof web3.TransactionExpiredTimeoutError && error.signature === SIGNATURE,
  );
});

test('a slow chain that keeps answering is waited out to confirmation, never called unknown', async () => {
  // Ten rounds of "not yet" with a valid blockhash take longer than maxWaitMs;
  // confirmTransaction has no wall-clock limit here, and neither may this.
  const connection = chain({ statuses: [...Array(10).fill(null), confirmed()] });
  const result = await confirmTransactionByPolling(connection, { signature: SIGNATURE, lastValidBlockHeight: LAST_VALID },
    { intervalMs: 2, maxWaitMs: 5 });
  assert.equal(result.value.err, null);
  assert.equal(connection.calls.filter((c) => c === 'height').length, 10);
});

test('past expiry, a history read that keeps failing still ends as an unknown outcome', { timeout: 5_000 }, async () => {
  // Heights past expiry are not progress: they must not keep resetting the backstop.
  const connection = chain({ heights: [LAST_VALID + 1], history: [new Error('history unavailable')] });
  await assert.rejects(
    confirmTransactionByPolling(connection, { signature: SIGNATURE, lastValidBlockHeight: LAST_VALID },
      { intervalMs: 1, maxWaitMs: 20 }),
    (error) => error instanceof web3.TransactionExpiredTimeoutError && error.signature === SIGNATURE,
  );
});

test('web path: a real Connection confirms through wallet-rpc without opening a websocket', async () => {
  let statusReads = 0;
  const { handler, forwarded } = loadWalletRpc({
    upstream: (body) => {
      const result = body.method === 'getBlockHeight' ? LAST_VALID - 50
        : { context: { slot: 10 }, value: [statusReads++ < 1 ? null : confirmed()] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    },
  });
  const preflights = [];
  const connection = new web3.Connection(WALLET_RPC_URL, {
    commitment: 'confirmed', fetch: browserFetchThrough(handler, { preflights }),
  });
  // confirmTransaction's signatureSubscribe goes to wss://…/wallet-rpc, which
  // the POST-only function can never upgrade. The helper must not need it.
  connection.onSignature = () => assert.fail('opened a signature subscription');
  const result = await confirmTransactionByPolling(connection,
    { signature: SIGNATURE, lastValidBlockHeight: LAST_VALID }, { intervalMs: 1 });
  assert.equal(result.value.err, null);
  assert.deepEqual(forwarded.map((r) => r.body.method), ['getSignatureStatuses', 'getBlockHeight', 'getSignatureStatuses']);
  assert.ok(preflights.length > 0 && preflights.every((p) => p.ok), 'every call passes the browser preflight');
});
