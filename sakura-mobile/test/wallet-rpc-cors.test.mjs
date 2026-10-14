import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WALLET_RPC_URL, browserFetchThrough, browserPreflight, headersMissingFrom, loadTs, loadWalletRpc, webRequire,
} from './wallet-web-harness.mjs';

const web3 = webRequire('@solana/web3.js');
const { createClient } = webRequire('@supabase/supabase-js');
const nacl = webRequire('tweetnacl');
const bs58Module = webRequire('bs58');
const bs58 = bs58Module.default ?? bs58Module;
const PUBLIC_VAULT = '63juJmvm1XHCHveWv9WdanxqJX6tD6DLFTZD7dvH12dc';
const PREVIOUS_WALLET_RPC_HEADERS = 'authorization, x-client-info, apikey, content-type';

/** The headers a real web3.js Connection puts on a JSON-RPC call, captured before any network. */
async function web3RequestHeaders() {
  let headers;
  const connection = new web3.Connection(WALLET_RPC_URL, {
    commitment: 'confirmed',
    fetch: async (_url, init) => { headers = init.headers; throw new Error('captured'); },
  });
  await connection.getBalance(new web3.PublicKey(PUBLIC_VAULT)).catch(() => {});
  assert.ok(headers, 'web3.js made a request');
  return headers;
}

test('a browser preflight for the headers web3.js sends to wallet-rpc is accepted and cached', async () => {
  const headers = await web3RequestHeaders();
  const { handler } = loadWalletRpc();
  const preflight = await browserPreflight(handler, WALLET_RPC_URL, { headers });
  // web3.js appends solana-client after any caller headers; it is what the old list refused.
  assert.ok(preflight.requested.includes('solana-client'), `web3.js headers: ${preflight.requested}`);
  assert.deepEqual(headersMissingFrom(PREVIOUS_WALLET_RPC_HEADERS, preflight.requested), ['solana-client']);
  assert.deepEqual(preflight.missing, []);
  assert.equal(preflight.ok, true);
  assert.equal(preflight.status, 200);
  assert.equal(preflight.maxAge, '86400');
});

test('a real Connection reads a balance through wallet-rpc the way the browser does', async () => {
  const { handler, forwarded } = loadWalletRpc({
    upstream: (body) => new Response(JSON.stringify({
      jsonrpc: '2.0', id: body.id, result: { context: { slot: 7 }, value: 42 },
    })),
  });
  const preflights = [];
  const connection = new web3.Connection(WALLET_RPC_URL, {
    commitment: 'confirmed', fetch: browserFetchThrough(handler, { preflights }),
  });
  assert.equal(await connection.getBalance(new web3.PublicKey(PUBLIC_VAULT)), 42);
  assert.equal(preflights.length, 1);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].body.method, 'getBalance');
  // Browser headers stop at the proxy; upstream sees only what the function sets.
  assert.deepEqual([...forwarded[0].headers.keys()], ['content-type']);
});

test('only headers were widened: wallet-rpc still refuses everything else, readably', async () => {
  const post = (body, init = {}) => new Request(WALLET_RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body), ...init,
  });
  const { handler, cors, forwarded } = loadWalletRpc();
  const refusals = [
    [new Request(WALLET_RPC_URL), 405],
    [post({ jsonrpc: '2.0', id: 1, method: 'requestAirdrop', params: [PUBLIC_VAULT, 1] }), 400],
    [post([{ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }]), 400],
    [post({ jsonrpc: '2.0', id: 1, method: 'getHealth' }), 400],
    [post('x'.repeat(100_001)), 413],
  ];
  for (const [request, status] of refusals) {
    const response = await handler(request);
    assert.equal(response.status, status, `${request.method} → ${status}`);
    // An error the page cannot read looks like a network failure; keep it readable.
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  }
  const limited = loadWalletRpc({ rateLimited: true });
  const response = await limited.handler(post({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(forwarded.length + limited.forwarded.length, 0);
  assert.equal(cors['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.equal(cors['Access-Control-Allow-Origin'], '*');
});

// ─── notify-sakura-transfer ────────────────────────────────────────────────

const NOTIFY_URL = 'https://project.supabase.test/functions/v1/notify-sakura-transfer';
const sender = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
const senderWallet = bs58.encode(sender.publicKey);
const receiverWallet = PUBLIC_VAULT;

function signedWalletHeaders() {
  const message = `sakura:transfer-notify:ts:${Math.floor(Date.now() / 1000)}`;
  return {
    'x-wallet-address': senderWallet,
    'x-signature': bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), sender.secretKey)),
    'x-message': message,
  };
}

function loadNotify() {
  const verified = [];
  const auth = loadTs('../supabase/functions/_shared/wallet-auth.ts', {
    'https://esm.sh/bs58@6.0.0': bs58Module,
    'https://esm.sh/tweetnacl@1.0.3': nacl,
  });
  const pushTokens = { select: () => pushTokens, eq: () => pushTokens, in: async () => ({ data: [], error: null }) };
  let handler;
  loadTs('../supabase/functions/notify-sakura-transfer/index.ts', {
    'https://esm.sh/@supabase/supabase-js@2.49.1': { createClient: () => ({ from: () => pushTokens }) },
    '../_shared/expo-push.ts': { sendExpoPushBatch: async () => assert.fail('no devices are registered') },
    '../_shared/wallet-auth.ts': auth,
    '../_shared/verify-transfer.ts': {
      TransferVerificationError: class TransferVerificationError extends Error {},
      verifyTransfer: async (input) => { verified.push(input); return { amount: 5 }; },
    },
  }, {
    Deno: { serve(fn) { handler = fn; }, env: { get: () => 'test-only' } },
  });
  return { handler, verified };
}

/** The exact request supabase-js's functions.invoke builds, as lib/wallet-transfer-notify.ts calls it. */
async function invokeRequest() {
  let captured;
  const supabase = createClient('https://project.supabase.test', 'sb_publishable_test-only', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url, init) => { captured = { url: String(url), init }; return new Response('{}'); } },
  });
  await supabase.functions.invoke('notify-sakura-transfer', {
    body: { asset: 'sakura', senderWallet, receiverWallet, amount: 5, txid: 'test-signature' },
    headers: signedWalletHeaders(),
  });
  assert.equal(captured.url, NOTIFY_URL);
  return captured.init;
}

test('notify-sakura-transfer accepts the browser preflight for a signed functions.invoke', async () => {
  const init = await invokeRequest();
  const { handler, verified } = loadNotify();
  const preflight = await browserPreflight(handler, NOTIFY_URL, { method: 'POST', headers: init.headers });
  for (const header of ['authorization', 'apikey', 'x-client-info', 'x-wallet-address', 'x-signature', 'x-message']) {
    assert.ok(preflight.requested.includes(header), `invoke sends ${header}`);
  }
  assert.deepEqual(preflight.missing, []);
  assert.equal(preflight.ok, true);
  assert.equal(preflight.maxAge, '86400');
  assert.equal(verified.length, 0, 'a preflight verifies nothing and sends nothing');
});

test('notify-sakura-transfer still verifies the signed POST, and the browser can read every answer', async () => {
  const init = await invokeRequest();
  const { handler, verified } = loadNotify();
  const ok = await handler(new Request(NOTIFY_URL, { method: 'POST', headers: init.headers, body: init.body }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await ok.json(), { sent: 0, message: 'No push tokens for these wallets' });
  assert.equal(verified.length, 1);
  assert.equal(verified[0].expectedSigner, senderWallet);

  const unsigned = new Headers(init.headers);
  for (const name of ['x-wallet-address', 'x-signature', 'x-message']) unsigned.delete(name);
  const rejected = await handler(new Request(NOTIFY_URL, { method: 'POST', headers: unsigned, body: init.body }));
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get('access-control-allow-origin'), '*');
  const wrongMethod = await handler(new Request(NOTIFY_URL));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('access-control-allow-origin'), '*');
  assert.equal(verified.length, 1, 'unsigned and non-POST calls never reach transfer verification');
});
