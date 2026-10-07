// Run from the repository root: node --test sakura-mobile/test/redeem-xp.test.cjs
// Uses installed mobile or web dependencies; no Deno or live Supabase is required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const dependencyPaths = [path.join(__dirname, '..'), path.join(__dirname, '../../web')];
const dependency = (name) => require(require.resolve(name, { paths: dependencyPaths }));
const ts = dependency('typescript');
const nacl = dependency('tweetnacl');
const bs58Module = dependency('bs58');
const bs58 = bs58Module.default ?? bs58Module;
const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const wallet = bs58.encode(keypair.publicKey);
const rate = 0.00000312;

function loadTs(relativePath, imports, globals = {}) {
  const filename = path.join(__dirname, '../supabase/functions', relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, Error, Date, TextEncoder, Headers, Response, Request, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
      return imports[name];
    },
  }, { filename });
  return exports;
}

const auth = loadTs('_shared/wallet-auth.ts', {
  'https://esm.sh/bs58@6.0.0': bs58Module,
  'https://esm.sh/tweetnacl@1.0.3': nacl,
});

function signedHeaders(action = 'redeem-xp', timestamp = Math.floor(Date.now() / 1000)) {
  const message = `sakura:${action}:ts:${timestamp}`;
  return {
    'content-type': 'application/json',
    'x-wallet-address': wallet,
    'x-message': message,
    'x-signature': bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey)),
  };
}

function endpoint(options = {}) {
  const calls = { queries: [], rpcs: [] };
  const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-only', XP_SOL_REDEMPTIONS_ENABLED: 'true', ...options.env };
  const supabase = {
    from(table) {
      assert.equal(table, 'xp_redemptions');
      const query = { filters: [] };
      calls.queries.push(query);
      const result = () => {
        return options.historyResult ?? { data: [], error: null };
      };
      const builder = {
        select(columns, selectionOptions) { query.columns = columns; query.selectionOptions = selectionOptions; return builder; },
        eq(column, value) { query.filters.push([column, value]); return builder; },
        order(column, orderOptions) { query.order = [column, orderOptions.ascending]; return builder; },
        limit(limit) { query.limit = limit; return builder; },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return builder;
    },
    async rpc(name, args) {
      calls.rpcs.push({ name, args: JSON.parse(JSON.stringify(args)) });
      return options.queueResult ?? { data: [{ id: 'new-redemption', remaining_xp: 4000, queued_at: '2026-09-27T12:00:00Z' }], error: null };
    },
  };
  let handler;
  loadTs('redeem-xp/index.ts', {
    'https://esm.sh/@supabase/supabase-js@2': { createClient: () => supabase },
    '../_shared/wallet-auth.ts': auth,
  }, { Deno: { env: { get: (name) => env[name] }, serve: (fn) => { handler = fn; } } });
  return {
    calls,
    async request(body = { xp: 1000, payout_asset: 'SOL', rate }, headers = signedHeaders(), method = 'POST') {
      const response = await handler(new Request('https://example.test/redeem-xp', {
        method, headers,
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      }));
      return { status: response.status, body: await response.text().then((text) => { try { return JSON.parse(text); } catch { return text; } }) };
    },
  };
}

test('a signed 1,000 XP swap queues exactly 0.00312 native SOL', async () => {
  const app = endpoint();
  const response = await app.request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true, id: 'new-redemption', xp_spent: 1000, payout_asset: 'SOL', sol: 0.00312,
    sol_lamports: 3120000, rate, status: 'pending', remaining_xp: 4000, queued_at: '2026-09-27T12:00:00Z',
  });
  assert.deepEqual(app.calls.rpcs, [{ name: 'queue_sol_xp_redemption', args: {
    p_wallet: wallet, p_xp: 1000, p_sol_lamports: 3120000, p_rate: rate,
  } }]);
  assert.deepEqual(app.calls.queries, []);
});

test('signed quotes expose the SOL rate and minimum without spending XP', async () => {
  const app = endpoint({ env: { XP_SAKURA_RATE: '3.19' } });
  assert.deepEqual(await app.request({ quote: true }), {
    status: 200, body: { ok: true, payout_asset: 'SOL', rate, min_xp: 100, available: true },
  });
  assert.deepEqual(app.calls, { queries: [], rpcs: [] });
});

test('quotes require a current, valid signature for the redeem-xp action', async (t) => {
  const badSignature = { ...signedHeaders(), 'x-signature': bs58.encode(new Uint8Array(64)) };
  for (const [name, headers] of [
    ['missing auth', {}], ['wrong action', signedHeaders('another-action')],
    ['expired signature', signedHeaders('redeem-xp', 1)], ['invalid signature', badSignature],
  ]) {
    await t.test(name, async () => {
      const app = endpoint();
      assert.equal((await app.request({ quote: true }, headers)).status, 401);
      assert.deepEqual(app.calls, { queries: [], rpcs: [] });
    });
  }
});

test('legacy clients and stale quotes are rejected before any XP debit', async (t) => {
  for (const body of [{ xp: 1000 }, { xp: 1000, payout_asset: 'SAKURA', rate: 3.19 }, { xp: 1000, payout_asset: 'SOL', rate: 0.000004 }]) {
    await t.test(JSON.stringify(body), async () => {
      const app = endpoint();
      assert.equal((await app.request(body)).status, 409);
      assert.deepEqual(app.calls, { queries: [], rpcs: [] });
    });
  }
});

test('the minimum is 100 XP and unsafe payout amounts never debit XP', async (t) => {
  for (const xp of [0, -100, 99, null, 'not a number', Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER]) {
    await t.test(String(xp), async () => {
      const app = endpoint();
      assert.equal((await app.request({ xp, payout_asset: 'SOL', rate })).status, 400);
      assert.deepEqual(app.calls, { queries: [], rpcs: [] });
    });
  }
  const app = endpoint();
  const response = await app.request({ xp: 100, payout_asset: 'SOL', rate });
  assert.equal(response.status, 200);
  assert.equal(response.body.sol_lamports, 312000);
  assert.equal(response.body.sol, 0.000312);
});

test('invalid configured SOL rates fail closed before debit', async (t) => {
  for (const value of ['0', '-1', 'garbage', 'Infinity', '0.0000000001']) {
    await t.test(value, async () => {
      const app = endpoint({ env: { XP_SOL_RATE: value } });
      assert.equal((await app.request({ quote: true })).status, 503);
      assert.deepEqual(app.calls, { queries: [], rpcs: [] });
    });
  }
});

test('atomic queue business errors return the appropriate user response', async (t) => {
  for (const [message, status] of [['XP_QUEUE_FULL', 429], ['XP_INSUFFICIENT', 400]]) {
    await t.test(String(status), async () => {
      const app = endpoint({ queueResult: { data: null, error: { code: 'P0001', message } } });
      assert.equal((await app.request()).status, status);
      assert.equal(app.calls.rpcs.length, 1);
      assert.equal(app.calls.queries.length, 0);
    });
  }
});

test('ambiguous or failed queue responses never compensate with an unsafe XP refund', async (t) => {
  for (const queueResult of [
    { data: [], error: null },
    { data: null, error: { message: 'response lost after commit' } },
    { data: [{ id: 'partial-response' }], error: null },
  ]) {
    await t.test(JSON.stringify(queueResult), async () => {
      const app = endpoint({ queueResult });
      const response = await app.request();
      assert.equal(response.status, 503);
      assert.match(response.body.error, /Check your swap history/);
      assert.equal(app.calls.queries.length, 0);
      assert.equal(app.calls.rpcs.length, 1);
      assert.equal(app.calls.rpcs[0].name, 'queue_sol_xp_redemption');
      assert.equal(app.calls.rpcs[0].args.p_xp, 1000);
    });
  }
});

test('history retains original SAKURA amounts alongside native SOL amounts', async () => {
  const redemptions = [
    { id: 'sol-row', xp_spent: 1000, payout_asset: 'SOL', sol_lamports: 3120000, sakura_amount: null, rate, status: 'pending' },
    { id: 'legacy-row', xp_spent: 1000, payout_asset: 'SAKURA', sol_lamports: null, sakura_amount: 3190, rate: 3.19, status: 'sent' },
  ];
  const app = endpoint({ historyResult: { data: redemptions, error: null }, env: { XP_SOL_RATE: 'invalid' } });
  assert.deepEqual(await app.request({ history: true }), { status: 200, body: { ok: true, redemptions } });
  assert.equal(app.calls.rpcs.length, 0);
  assert.deepEqual(app.calls.queries[0].filters, [['wallet_address', wallet]]);
  assert.deepEqual(app.calls.queries[0].order, ['created_at', false]);
  assert.equal(app.calls.queries[0].limit, 10);
  for (const column of ['payout_asset', 'sol_lamports', 'sakura_amount', 'rate']) assert.ok(app.calls.queries[0].columns.includes(column));
});

test('history errors return an error rather than an empty history', async () => {
  const app = endpoint({ historyResult: { data: null, error: { message: 'offline' } } });
  assert.equal((await app.request({ history: true })).status, 503);
});

test('invalid request bodies and unsupported methods do not debit XP', async () => {
  const app = endpoint();
  assert.equal((await app.request(null)).status, 400);
  assert.equal((await app.request(undefined, {}, 'GET')).status, 405);
  assert.equal((await app.request(undefined, {}, 'OPTIONS')).status, 200);
  assert.deepEqual(app.calls, { queries: [], rpcs: [] });
});

for (const enabled of [undefined, 'false', 'TRUE']) {
  test(`paused or unset redemption flag (${enabled}) never spends XP`, async () => {
    const app = endpoint({ env: { XP_SOL_REDEMPTIONS_ENABLED: enabled } });
    const quote = await app.request({ quote: true });
    assert.equal(quote.body.available, false);
    assert.equal((await app.request()).status, 503);
    assert.deepEqual(app.calls, { queries: [], rpcs: [] });
    assert.equal((await app.request({ history: true })).status, 200);
  });
}
