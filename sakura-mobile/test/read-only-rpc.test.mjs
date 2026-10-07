import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../lib/wallet/read-only-rpc.ts', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module, exports: module.exports, URL, Response, Headers, AbortController, setTimeout, clearTimeout, fetch });
const { createReadOnlyRpcFetch, publicRpcForConfiguredUrl } = module.exports;
const primary = 'https://mainnet.helius-rpc.com/?api-key=test-public-client-key';
const publicMainnet = 'https://api.mainnet-beta.solana.com';
const requestBody = (method = 'getBalance') => ({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) });
const success = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: 0 } }));

test('an exhausted primary falls back for reads and cools down across subsequent calls', async () => {
  const calls = [];
  const rpc = createReadOnlyRpcFetch(primary, async (url) => {
    calls.push(url);
    return url === primary ? new Response('max usage reached', { status: 429 }) : success();
  });
  assert.equal((await (await rpc(primary, requestBody())).json()).result.value, 0);
  await rpc(primary, requestBody());
  assert.deepEqual(calls, [primary, publicMainnet, publicMainnet]);
});

test('RPC quota errors carried in HTTP200 receive read-only fallback', async () => {
  const calls = [];
  const rpc = createReadOnlyRpcFetch(primary, async (url) => {
    calls.push(url);
    return url === primary ? new Response(JSON.stringify({ error: { code: -32000, message: 'max usage reached' } })) : success();
  });
  await rpc(primary, requestBody('getTokenAccountsByOwner'));
  assert.equal(calls.length, 2);
});

test('a missing token account stays a genuine account error, not a provider failover', async () => {
  let calls = 0;
  const rpc = createReadOnlyRpcFetch(primary, async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: -32602, message: 'Account could not be found' } }));
  });
  const response = await rpc(primary, requestBody('getTokenAccountBalance'));
  assert.equal((await response.json()).error.code, -32602);
  assert.equal(calls, 1);
});

for (const method of ['sendTransaction', 'simulateTransaction', 'requestAirdrop']) {
  test(`${method} never switches endpoints or retries after a response`, async () => {
    const calls = [];
    const rpc = createReadOnlyRpcFetch(primary, async (url) => { calls.push(url); return new Response('quota', { status: 429 }); });
    assert.equal((await rpc(primary, requestBody(method))).status, 429);
    assert.deepEqual(calls, [primary]);
  });
  test(`${method} never retries an ambiguous network failure`, async () => {
    let calls = 0;
    const rpc = createReadOnlyRpcFetch(primary, async () => { calls++; throw new Error('connection reset'); });
    await assert.rejects(rpc(primary, requestBody(method)), /connection reset/);
    assert.equal(calls, 1);
  });
}

test('stalled response bodies abort and fall back within the deadline', async () => {
  let aborted = false;
  const rpc = createReadOnlyRpcFetch(primary, async (url, options) => {
    if (url !== primary) return success();
    options.signal.addEventListener('abort', () => { aborted = true; });
    return { text: () => new Promise(() => {}) };
  }, 5);
  const result = await (await rpc(primary, requestBody())).json();
  assert.equal(result.result.value, 0);
  assert.equal(aborted, true);
});

test('devnet remains devnet and unknown/local/proxy clusters never guess mainnet', () => {
  assert.equal(publicRpcForConfiguredUrl('https://devnet.helius-rpc.com/?api-key=x'), 'https://api.devnet.solana.com');
  assert.equal(publicRpcForConfiguredUrl('http://127.0.0.1:8899'), null);
  assert.equal(publicRpcForConfiguredUrl('https://custom-rpc.example.test'), null);
  assert.equal(publicRpcForConfiguredUrl('https://project.supabase.co/functions/v1/wallet-rpc'), null);
});

test('an already-cancelled read does not start an RPC request', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  const rpc = createReadOnlyRpcFetch(primary, async () => { calls++; return success(); });
  await assert.rejects(rpc(primary, { ...requestBody(), signal: controller.signal }), /cancelled/);
  assert.equal(calls, 0);
});


test('fallback does not forward provider authentication headers', async () => {
  const rpc = createReadOnlyRpcFetch(primary, async (url, options) => {
    if (url === primary) return new Response('quota', { status: 429 });
    assert.equal(options.headers.get('authorization'), null);
    assert.equal(options.headers.get('x-api-key'), null);
    assert.equal(options.headers.get('apikey'), null);
    assert.equal(options.headers.get('content-type'), 'application/json');
    return success();
  });
  await rpc(primary, { ...requestBody(), headers: {
    Authorization: 'Bearer test-only', apikey: 'test-only', 'X-API-Key': 'test-only', 'Content-Type': 'application/json',
  } });
});

test('unavailable providers remain an error rather than reporting an empty wallet', async () => {
  const rpc = createReadOnlyRpcFetch(primary, async () => new Response('quota', { status: 429 }));
  await assert.rejects(rpc(primary, requestBody()), /temporarily unavailable/);
});
