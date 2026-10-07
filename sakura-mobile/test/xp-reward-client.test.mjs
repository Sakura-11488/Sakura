import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

// The web app consumes the mobile sources and supplies their test dependencies.
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');

function compile(path) {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const amounts = {};
vm.runInNewContext(compile('../lib/xp-reward-amounts.ts'), { exports: amounts });
const compiledClient = compile('../lib/xp-redeem.ts');

/** Exercise the real client using an in-memory signed Edge Function adapter. */
function harness(reply) {
  const requests = [];
  const keypair = {};
  const client = {};
  vm.runInNewContext(compiledClient, {
    exports: client,
    require(id) {
      if (id === './xp-reward-amounts') return amounts;
      if (id === '@/lib/supabase') return {
        supabase: { functions: { invoke: async (endpoint, request) => {
          requests.push({ endpoint, ...request });
          return reply;
        } } },
      };
      if (id === '@/lib/wallet-auth') return {
        buildWalletAuthHeaders(receivedKeypair, action) {
          assert.equal(receivedKeypair, keypair);
          assert.equal(action, 'redeem-xp');
          return { 'x-signature': 'signed-wallet-request' };
        },
      };
      throw new Error(`Unexpected client import: ${id}`);
    },
  });
  return { client, requests, keypair };
}

test('confirmed SOL rate retains exact lamports for minimum and small rewards', () => {
  assert.equal(amounts.XP_SOL_RATE, 0.00000312);
  assert.equal(amounts.XP_REDEEM_MIN, 100);
  assert.equal(amounts.previewSol(1000), 0.00312);
  assert.equal(amounts.previewSol(100), 0.000312);
  assert.equal(amounts.previewSol(1), 0.00000312);
  assert.equal(amounts.previewSol(101), 0.00031512);
  assert.equal(amounts.previewSol(1000.9), 0.00312);
});

test('preview uses the quoted rate and supports one-lamport precision', () => {
  assert.equal(amounts.previewSol(1000, 0.000004), 0.004);
  assert.equal(amounts.previewSol(100, 0.000000001), 0.0000001);
  assert.equal(amounts.formatSol(0.000000001), '0.000000001');
  assert.equal(amounts.formatSol(0.000312), '0.000312');
});

test('preview excludes invalid XP, rates, and unsafe lamport totals', () => {
  for (const xp of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(amounts.previewSol(xp), 0);
  }
  for (const rate of [0, -1, NaN, Infinity]) {
    assert.equal(amounts.previewSol(1000, rate), 0);
  }
});

test('mixed history formats SOL from lamports and preserves legacy SAKURA units', () => {
  assert.equal(amounts.formatRedemptionAmount({
    payout_asset: 'SOL', sol_lamports: 3120000, sakura_amount: null,
  }), '0.00312 SOL');
  assert.equal(amounts.formatRedemptionAmount({
    payout_asset: 'SOL', sol_lamports: 1, sakura_amount: null,
  }), '0.000000001 SOL');
  assert.equal(amounts.formatRedemptionAmount({
    payout_asset: 'SAKURA', sol_lamports: null, sakura_amount: 319,
  }), '319 SAKURA');
});

test('server quote is authenticated and exposes the authoritative rate/minimum', async () => {
  const quote = { ok: true, payout_asset: 'SOL', rate: 0.000004, min_xp: 200, available: true };
  const h = harness({ data: quote, error: null });
  assert.equal(await h.client.fetchRedemptionQuote(h.keypair), quote);
  assert.equal(h.requests[0].endpoint, 'redeem-xp');
  assert.equal(h.requests[0].body.quote, true);
  assert.equal(h.requests[0].headers['x-signature'], 'signed-wallet-request');
});

test('invalid or old SAKURA quotes cannot authorize a SOL redemption', async () => {
  const valid = { ok: true, payout_asset: 'SOL', rate: 0.00000312, min_xp: 100 };
  for (const quote of [null, { ...valid, payout_asset: 'SAKURA' },
    { ...valid, rate: 0 }, { ...valid, rate: '0.00000312' },
    { ...valid, min_xp: 0 }, { ...valid, min_xp: 1.5 }]) {
    const h = harness({ data: quote, error: null });
    await assert.rejects(h.client.fetchRedemptionQuote(h.keypair), /SOL rewards are unavailable/);
    assert.equal(h.requests.length, 1);
  }
});

test('redemption explicitly submits the displayed SOL rate and whole XP', async () => {
  const result = { ok: true, payout_asset: 'SOL', xp_spent: 1000, sol: 0.00312, sol_lamports: 3120000 };
  const h = harness({ data: result, error: null });
  assert.equal(await h.client.redeemXp(h.keypair, 1000.9, 0.00000312), result);
  assert.equal(JSON.stringify(h.requests[0].body), JSON.stringify({
    xp: 1000, payout_asset: 'SOL', rate: 0.00000312,
  }));
  assert.equal(h.requests[0].headers['x-signature'], 'signed-wallet-request');
});

test('rate mismatch from the server surfaces without retrying redemption', async () => {
  const h = harness({ data: null, error: {
    message: 'Edge Function returned a non-2xx status',
    context: { json: async () => ({ error: 'The SOL reward rate changed. Refresh your quote and try again.' }) },
  } });
  await assert.rejects(h.client.redeemXp(h.keypair, 1000, 0.00000312), /SOL reward rate changed/);
  assert.equal(h.requests.length, 1);
});

test('history request retains amounts and asset tags supplied by the server', async () => {
  const redemptions = [
    { payout_asset: 'SAKURA', sakura_amount: 319, sol_lamports: null },
    { payout_asset: 'SOL', sakura_amount: null, sol_lamports: 312000 },
  ];
  const h = harness({ data: { ok: true, redemptions }, error: null });
  assert.equal(await h.client.fetchRedemptions(h.keypair), redemptions);
  assert.equal(h.requests[0].body.history, true);
  assert.equal(h.requests[0].headers['x-signature'], 'signed-wallet-request');
});

test('paused quotes stop the client before it submits a swap', async () => {
  const h = harness({ data: { ok: true, payout_asset: 'SOL', rate: 0.00000312, min_xp: 100, available: false }, error: null });
  await assert.rejects(h.client.fetchRedemptionQuote(h.keypair), /temporarily paused/);
  assert.equal(h.requests.length, 1);
});

test('passive quotes expose paused availability so the screen can disable swaps', async () => {
  const quote = { ok: true, payout_asset: 'SOL', rate: 0.00000312, min_xp: 100, available: false };
  const h = harness({ data: quote, error: null });
  assert.deepEqual(await h.client.fetchRedemptionQuote(h.keypair, { includePaused: true }), quote);
  assert.equal(h.requests.length, 1);
  assert.equal(JSON.stringify(h.requests[0].body), JSON.stringify({ quote: true }));
});

test('older quotes without availability never make rewards appear available', async () => {
  const h = harness({ data: { ok: true, payout_asset: 'SOL', rate: 0.00000312, min_xp: 100 }, error: null });
  await assert.rejects(h.client.fetchRedemptionQuote(h.keypair, { includePaused: true }), /unavailable/);
});
