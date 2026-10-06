import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const web3 = require('@solana/web3.js');
const bs58 = require('bs58').default;
const { Keypair, PublicKey, SystemInstruction, Transaction } = web3;
const source = readFileSync(new URL('../supabase/functions/process-xp-redemptions/index.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const solKey = Keypair.generate();
const legacyKey = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const mint = 'EWiVNxCqNatzV2paBHyfKUwGLnk7WKs9uZTA5jkTpump';
const tokenProgram = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const redemption = (overrides = {}) => ({
  id: 'reward-1', wallet_address: recipient.toBase58(), xp_spent: 100,
  payout_asset: 'SOL', sol_lamports: 312000, sakura_amount: null,
  status: 'pending', tx_signature: null, updated_at: new Date().toISOString(),
  ...overrides,
});

/** Execute the real handler with in-memory PostgREST/RPC adapters and real wire transactions. */
function harness(options = {}) {
  const rows = structuredClone(options.rows ?? [redemption()]);
  const events = [];
  const wires = [];
  const refunds = [];
  const env = {
    XP_PAYOUT_ADMIN_SECRET: 'test-admin',
    SOL_PAYOUT_SECRET: bs58.encode(solKey.secretKey),
    ...options.env,
  };
  class Query {
    filters = [];
    maximum = Infinity;
    select(_columns, opts = {}) { this.countOnly = opts.head; return this; }
    eq(key, value) { this.filters.push((r) => r[key] === value); return this; }
    is(key, value) { return this.eq(key, value); }
    in(key, values) { this.filters.push((r) => values.includes(r[key])); return this; }
    order() { return this; }
    limit(n) { this.maximum = n; return this; }
    update(values) { this.change = values; return this; }
    async execute() {
      options.beforeQuery?.(this, rows);
      const matching = rows.filter((r) => this.filters.every((f) => f(r))).slice(0, this.maximum);
      if (this.change?.tx_signature && options.stampFails) {
        return { data: [], error: { message: 'simulated stamp failure' } };
      }
      if (this.change) {
        for (const row of matching) {
          Object.assign(row, this.change);
          events.push({ type: 'update', id: row.id, ...this.change });
        }
      }
      return { data: matching.map((r) => ({ ...r })), error: null, count: matching.length };
    }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
  }
  const supabase = {
    from(name) { assert.equal(name, 'xp_redemptions'); return new Query(); },
    async rpc(name, args) {
      if (name === 'xp_payout_gate_secret') return { data: null, error: null };
      assert.equal(name, 'debit_xp_for_redemption');
      refunds.push(args);
      return { data: null, error: null };
    },
  };
  class Connection {
    async getBalance(key) { events.push({ type: 'balance', key: key.toBase58() }); return options.balance ?? 1e9; }
    async getFeeForMessage(message) {
      assert.ok(message.accountKeys.length >= 2);
      return { value: options.fee === undefined ? 5000 : options.fee };
    }
    async getLatestBlockhash() { return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 500 }; }
    async getAccountInfo(key) {
      events.push({ type: 'account', key: key.toBase58() });
      if (options.mintFails && key.toBase58() === mint) throw new Error('SAKURA mint unavailable.');
      if (!options.legacy) throw new Error('Unexpected token account access in SOL flow.');
      return key.toBase58() === mint ? { owner: tokenProgram } : null;
    }
    async getTokenAccountBalance() {
      events.push({ type: 'token-balance' });
      if (!options.legacy) throw new Error('Unexpected token balance access in SOL flow.');
      return { value: { amount: '1000000000', uiAmountString: '1000' } };
    }
    async getSignatureStatus(signature) {
      events.push({ type: 'reconcile', signature });
      return options.signatureStatus ?? { value: { confirmationStatus: 'confirmed', err: null } };
    }
    async sendRawTransaction(wire) {
      events.push({ type: 'send' });
      wires.push(wire);
      if (options.sendFails) throw new Error('simulated transport timeout');
      return bs58.encode(Transaction.from(wire).signature);
    }
    async confirmTransaction() {
      if (options.confirmFails) throw new Error('simulated confirmation timeout');
      return { value: { err: options.onChainError ?? null } };
    }
  }
  let handler;
  vm.runInNewContext(compiled, {
    exports: {}, Buffer, Uint8Array, DataView, TextEncoder, Response, Error,
    crypto: webcrypto,
    Deno: { env: { get: (name) => env[name] }, serve: (callback) => { handler = callback; } },
    require(specifier) {
      if (specifier.includes('@solana/web3.js')) return { ...web3, Connection };
      if (specifier.includes('@supabase/supabase-js')) return { createClient: () => supabase };
      if (specifier.includes('bs58')) return { default: bs58, __esModule: true };
      if (specifier.endsWith('wallet-auth.ts')) return {
        corsHeaders: () => ({}),
        jsonResponse: (status, body) => new Response(JSON.stringify(body), { status }),
      };
      if (specifier.endsWith('solana-rpc.ts')) return { getSolanaRpcUrl: () => 'https://unused.invalid' };
      return require(specifier);
    },
  });
  return {
    rows, events, wires, refunds,
    async run(body = {}, authorized = true) {
      const response = await handler(new Request('https://unused.invalid', {
        method: 'POST', headers: authorized ? { 'x-admin-secret': 'test-admin' } : {},
        body: JSON.stringify(body),
      }));
      return { status: response.status, body: await response.json() };
    },
  };
}

test('SOL uses exact stored lamports, its own key, and a persisted signature before broadcast', async () => {
  const h = harness({ balance: 317000 });
  const response = await h.run();
  assert.equal(response.status, 200);
  assert.equal(h.rows[0].status, 'sent');
  assert.equal(h.wires.length, 1);
  const tx = Transaction.from(h.wires[0]);
  assert.equal(tx.instructions.length, 1);
  const transfer = SystemInstruction.decodeTransfer(tx.instructions[0]);
  assert.equal(transfer.lamports, 312000n);
  assert.ok(transfer.fromPubkey.equals(solKey.publicKey));
  assert.ok(transfer.toPubkey.equals(recipient));
  assert.ok(tx.verifySignatures());
  const stamp = h.events.findIndex((e) => e.tx_signature);
  assert.ok(stamp >= 0 && stamp < h.events.findIndex((e) => e.type === 'send'));
  assert.equal(h.events.filter((e) => e.type === 'account' || e.type === 'token-balance').length, 0);
});

test('SOL balance must cover the entire reward plus the estimated fee', async () => {
  const h = harness({ balance: 316999, rows: [redemption(), redemption({ id: 'reward-2' })] });
  await h.run();
  assert.equal(h.wires.length, 0);
  assert.equal(h.rows[0].status, 'failed');
  assert.equal(h.rows[1].status, 'pending');
  assert.equal(h.refunds.length, 1);
  assert.equal(h.refunds[0].p_xp, -100);
});

test('unknown fee prevents a transfer', async () => {
  const h = harness({ fee: null });
  await h.run();
  assert.equal(h.wires.length, 0);
  assert.equal(h.rows[0].status, 'failed');
  assert.equal(h.refunds.length, 1);
});

for (const amount of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid stored SOL amount ${amount} never broadcasts`, async () => {
    const h = harness({ rows: [redemption({ sol_lamports: amount })] });
    await h.run();
    assert.equal(h.wires.length, 0);
    assert.equal(h.rows[0].status, 'failed');
    assert.equal(h.refunds.length, 1);
  });
}

test('missing SOL key does not silently reuse the SAKURA key', async () => {
  const h = harness({ env: { SOL_PAYOUT_SECRET: undefined, SAKURA_PAYOUT_SECRET: bs58.encode(legacyKey.secretKey) } });
  const response = await h.run();
  assert.equal(h.rows[0].status, 'pending');
  assert.equal(h.wires.length, 0);
  assert.match(response.body.asset_errors.SOL, /SOL_PAYOUT_SECRET/);
  assert.equal(h.events.length, 0);
});

test('probe defaults to SOL and does not query the token mint or queue', async () => {
  const h = harness();
  const response = await h.run({ probe: true });
  assert.equal(response.body.payout_asset, 'SOL');
  assert.equal(response.body.authority, solKey.publicKey.toBase58());
  assert.equal(h.rows[0].status, 'pending');
  assert.deepEqual(h.events.map((e) => e.type), ['balance']);
});

test('confirmed signatures reconcile without either treasury key or token access', async () => {
  const h = harness({
    env: { SOL_PAYOUT_SECRET: undefined },
    rows: [redemption({ status: 'processing', tx_signature: 'already-sent' })],
  });
  await h.run();
  assert.equal(h.rows[0].status, 'sent');
  assert.equal(h.wires.length, 0);
  assert.deepEqual(h.events.map((e) => e.type), ['reconcile', 'update']);
});

test('ambiguous broadcast failure keeps the signature and never refunds XP', async () => {
  const h = harness({ sendFails: true });
  await h.run();
  assert.equal(h.rows[0].status, 'processing');
  assert.ok(h.rows[0].tx_signature);
  assert.equal(h.refunds.length, 0);
});

test('failed signature persistence prevents broadcast and refund', async () => {
  const h = harness({ stampFails: true });
  await h.run();
  assert.equal(h.rows[0].status, 'processing');
  assert.equal(h.wires.length, 0);
  assert.equal(h.refunds.length, 0);
});

test('confirmed on-chain failure refunds XP once', async () => {
  const h = harness({ onChainError: { InstructionError: [0, 'InsufficientFunds'] } });
  await h.run();
  assert.equal(h.rows[0].status, 'failed');
  assert.equal(h.refunds.length, 1);
  await h.run();
  assert.equal(h.refunds.length, 1);
});

test('legacy SAKURA rows retain Token-2022 transfer amounts and treasury key', async () => {
  const h = harness({
    legacy: true,
    env: { SOL_PAYOUT_SECRET: undefined, SAKURA_PAYOUT_SECRET: bs58.encode(legacyKey.secretKey) },
    rows: [redemption({ payout_asset: 'SAKURA', sol_lamports: null, sakura_amount: 319 })],
  });
  await h.run();
  assert.equal(h.rows[0].status, 'sent');
  const tx = Transaction.from(h.wires[0]);
  assert.ok(tx.feePayer.equals(legacyKey.publicKey));
  assert.equal(tx.instructions.length, 2);
  const transfer = tx.instructions[1];
  assert.ok(transfer.programId.equals(tokenProgram));
  assert.equal(transfer.data[0], 12);
  assert.equal(transfer.data.readBigUInt64LE(1), 319000000n);
  assert.equal(transfer.data[9], 6);
});

test('unauthorized caller cannot probe or start payout processing', async () => {
  const h = harness();
  const response = await h.run({ probe: true }, false);
  assert.equal(response.status, 401);
  assert.equal(h.events.length, 0);
  assert.equal(h.wires.length, 0);
});


test('probe accepts an explicit legacy payout_asset', async () => {
  const h = harness({ legacy: true, env: { SAKURA_PAYOUT_SECRET: bs58.encode(legacyKey.secretKey) } });
  const response = await h.run({ probe: true, payout_asset: 'SAKURA' });
  assert.equal(response.status, 200);
  assert.equal(response.body.payout_asset, 'SAKURA');
  assert.equal(response.body.authority, legacyKey.publicKey.toBase58());
  assert.equal(response.body.sakura_balance, '1000');
  assert.equal(h.wires.length, 0);
  assert.equal(h.rows[0].status, 'pending');
});

test('unknown probe payout_asset fails closed', async () => {
  const h = harness();
  const response = await h.run({ probe: true, payout_asset: 'USDC' });
  assert.equal(response.status, 400);
  assert.equal(h.events.length, 0);
});

test('a null request body does not crash processing', async () => {
  const h = harness({ rows: [] });
  const response = await h.run(null);
  assert.equal(response.status, 200);
});

test('stale reconciliation cannot refund a row with a newer signature', async () => {
  let replaced = false;
  const h = harness({
    env: { SOL_PAYOUT_SECRET: undefined },
    rows: [redemption({ status: 'processing', tx_signature: 'old-signature' })],
    signatureStatus: { value: { confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Failure'] } } },
    beforeQuery(query, rows) {
      if (query.change?.status === 'failed' && !replaced) {
        rows[0].tx_signature = 'new-signature';
        replaced = true;
      }
    },
  });
  await h.run();
  assert.equal(h.rows[0].status, 'processing');
  assert.equal(h.rows[0].tx_signature, 'new-signature');
  assert.equal(h.refunds.length, 0);
});


test('a legacy backlog with an unavailable mint cannot starve newer SOL rewards', async () => {
  const legacyRows = Array.from({ length: 15 }, (_, i) => redemption({
    id: `legacy-${i}`, payout_asset: 'SAKURA', sol_lamports: null, sakura_amount: 319,
  }));
  const h = harness({
    legacy: true, mintFails: true,
    env: { SAKURA_PAYOUT_SECRET: bs58.encode(legacyKey.secretKey) },
    rows: [...legacyRows, redemption({ id: 'new-sol-reward' })],
  });
  const response = await h.run();
  assert.equal(h.rows.at(-1).status, 'sent');
  assert.ok(h.rows.slice(0, -1).every((row) => row.status === 'pending'));
  assert.equal(h.wires.length, 1);
  assert.match(response.body.asset_errors.SAKURA, /mint unavailable/);
});

test('per-asset batches keep the total payouts bounded at ten', async () => {
  const rows = ['SAKURA', 'SOL'].flatMap((asset) => Array.from({ length: 15 }, (_, i) => redemption({
    id: `${asset}-${i}`, payout_asset: asset,
    sol_lamports: asset === 'SOL' ? 312000 : null,
    sakura_amount: asset === 'SAKURA' ? 319 : null,
  })));
  const h = harness({ legacy: true, env: { SAKURA_PAYOUT_SECRET: bs58.encode(legacyKey.secretKey) }, rows });
  await h.run();
  assert.equal(h.wires.length, 10);
  assert.equal(h.rows.filter((row) => row.status === 'sent' && row.payout_asset === 'SOL').length, 5);
  assert.equal(h.rows.filter((row) => row.status === 'sent' && row.payout_asset === 'SAKURA').length, 5);
});
