// Isolated PostgreSQL validation; never connects to Supabase.
// PGLITE_MODULE_PATH=/tmp/sakura-sol-validation/node_modules/@electric-sql/pglite node --test sakura-mobile/test/xp-sol-queue-migration.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const pglite = process.env.PGLITE_MODULE_PATH ? require(process.env.PGLITE_MODULE_PATH) : null;
const migration = (name) => fs.readFileSync(path.join(__dirname, '../supabase/migrations', name), 'utf8');

test('SOL queuing reserves XP and records the payout in one service-only transaction', {
  skip: pglite ? false : 'Set PGLITE_MODULE_PATH to an isolated @electric-sql/pglite installation.',
}, async (t) => {
  const db = new pglite.PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.user_xp_state (
      wallet_address text primary key,
      xp bigint not null default 0,
      xp_spent bigint not null default 0,
      level integer not null default 1,
      updated_at timestamptz not null default now()
    );
    alter table public.user_xp_state enable row level security;
    create table public.xp_redemptions (
      id uuid primary key default gen_random_uuid(),
      wallet_address text not null,
      xp_spent bigint not null check (xp_spent > 0),
      sakura_amount numeric not null check (sakura_amount > 0),
      rate numeric not null check (rate > 0),
      status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed')),
      tx_signature text,
      error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    insert into public.user_xp_state (wallet_address, xp, xp_spent, level)
      values ('legacy', 10000, 1000, 9);
    insert into public.xp_redemptions (wallet_address, xp_spent, sakura_amount, rate, status, tx_signature)
      values ('legacy', 1000, 3190, 3.19, 'sent', 'old-signature');
  `);
  await db.exec(migration('20260927122023_xp_sol_rewards.sql'));
  const legacyBefore = (await db.query("select * from public.xp_redemptions where wallet_address = 'legacy'")).rows;
  await db.exec(migration('20261007211316_atomic_sol_xp_redemption.sql'));
  const addWallet = (wallet, xp = 5000, spent = 0) => db.query(
    'insert into public.user_xp_state (wallet_address, xp, xp_spent, level) values ($1, $2, $3, 9)', [wallet, xp, spent],
  );
  const queue = (wallet, xp = 1000, lamports = xp * 3120, rate = '0.00000312') => db.query(
    'select * from public.queue_sol_xp_redemption($1, $2, $3, $4)', [wallet, xp, lamports, rate],
  );
  const state = async (wallet) => (await db.query(
    'select xp::text, xp_spent::text, level from public.user_xp_state where wallet_address = $1', [wallet],
  )).rows[0];
  const rows = async (wallet) => (await db.query(
    'select * from public.xp_redemptions where wallet_address = $1', [wallet],
  )).rows;
  const fail = async (id, signature = null, reason = 'Proven payout failure.') => (await db.query(
    'select public.fail_xp_redemption($1, $2, $3) as refunded', [id, signature, reason],
  )).rows[0].refunded;
  const processing = async (wallet, signature = null) => {
    await addWallet(wallet);
    const id = (await queue(wallet)).rows[0].id;
    await db.query("update public.xp_redemptions set status = 'processing', tx_signature = $2 where id = $1", [id, signature]);
    return id;
  };

  await t.test('legacy promises, status, signature, XP and level remain intact', async () => {
    assert.deepEqual(await rows('legacy'), legacyBefore);
    assert.deepEqual(await state('legacy'), { xp: '10000', xp_spent: '1000', level: 9 });
  });

  await t.test('service role queues exact SOL while preserving lifetime XP and level', async () => {
    await addWallet('success', 10000, 123);
    await db.exec('set role service_role');
    let result;
    try { result = await queue('success'); } finally { await db.exec('reset role'); }
    assert.equal(result.rows.length, 1);
    assert.equal(Number(result.rows[0].remaining_xp), 8877);
    assert.ok(result.rows[0].queued_at);
    const queued = await rows('success');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].id, result.rows[0].id);
    assert.equal(queued[0].payout_asset, 'SOL');
    assert.equal(Number(queued[0].sol_lamports), 3120000);
    assert.equal(queued[0].sakura_amount, null);
    assert.equal(queued[0].status, 'pending');
    assert.deepEqual(await state('success'), { xp: '10000', xp_spent: '1123', level: 9 });
  });

  await t.test('unknown and insufficient wallets cannot reserve XP or create a payout', async () => {
    await addWallet('poor', 1000, 999);
    for (const wallet of ['unknown', 'poor']) {
      await assert.rejects(queue(wallet), { code: 'P0001', message: 'XP_INSUFFICIENT' });
      assert.deepEqual(await rows(wallet), []);
    }
    assert.deepEqual(await state('poor'), { xp: '1000', xp_spent: '999', level: 9 });
  });

  await t.test('a failed insert rolls back the XP debit with no compensating refund', async () => {
    await addWallet('insert-fail');
    await db.exec("alter table public.xp_redemptions add constraint simulate_insert_failure check (wallet_address <> 'insert-fail')");
    await assert.rejects(queue('insert-fail'), { code: '23514' });
    assert.deepEqual(await state('insert-fail'), { xp: '5000', xp_spent: '0', level: 9 });
    assert.deepEqual(await rows('insert-fail'), []);
  });

  await t.test('queue limit includes pending and processing promises of either currency', async () => {
    await addWallet('full', 10000, 300);
    await db.query(`
      insert into public.xp_redemptions (wallet_address, xp_spent, sakura_amount, rate, status)
      values ('full', 100, 319, 3.19, 'pending'), ('full', 100, 319, 3.19, 'processing')
    `);
    await queue('full', 100);
    await assert.rejects(queue('full', 100), { code: 'P0001', message: 'XP_QUEUE_FULL' });
    assert.equal((await rows('full')).length, 3);
    assert.deepEqual(await state('full'), { xp: '10000', xp_spent: '400', level: 9 });
    await db.exec("update public.xp_redemptions set status = 'sent' where wallet_address = 'full' and payout_asset = 'SAKURA'");
    await queue('full', 100);
    assert.equal((await rows('full')).length, 4);
  });

  await t.test('competing requests cannot reserve the same spendable XP', async () => {
    await addWallet('competing', 1500);
    // PGlite schedules both submitted statements on one connection. The real
    // function also holds a row lock across its balance/cap check and writes.
    const attempts = await Promise.allSettled([queue('competing'), queue('competing')]);
    assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
    const failure = attempts.find((item) => item.status === 'rejected');
    assert.equal(failure.reason.message, 'XP_INSUFFICIENT');
    assert.equal((await rows('competing')).length, 1);
    assert.deepEqual(await state('competing'), { xp: '1500', xp_spent: '1000', level: 9 });
  });

  await t.test('invalid amounts and inexact rates fail before XP changes', async (t) => {
    await addWallet('invalid');
    for (const [name, args] of [
      ['zero XP', [0, 0]], ['negative XP', [-100, -312000]], ['null XP', [null, 3120000]],
      ['wrong lamports', [1000, 3120001]], ['old token rate', [1000, 3120000, '3.19']],
      ['fractional lamport per XP', [1000, 100, '0.0000000001']],
      ['unsafe lamports', [1, '9007199254740992', '9007199.254740992']],
      ['NaN rate', [1000, 3120000, 'NaN']], ['missing rate', [1000, 3120000, null]],
    ]) await t.test(name, async () => assert.rejects(queue('invalid', ...args), { code: '22023' }));
    assert.deepEqual(await state('invalid'), { xp: '5000', xp_spent: '0', level: 9 });
    assert.deepEqual(await rows('invalid'), []);
  });

  await t.test('service role refunds failure once and preserves lifetime XP and level', async () => {
    const id = await processing('refund-success', 'failed-signature');
    await db.exec('set role service_role');
    try {
      assert.equal(await fail(id, 'failed-signature'), true);
      assert.equal(await fail(id, 'failed-signature'), false);
    } finally { await db.exec('reset role'); }
    assert.deepEqual(await state('refund-success'), { xp: '5000', xp_spent: '0', level: 9 });
    const refunded = (await rows('refund-success'))[0];
    assert.equal(refunded.status, 'failed');
    assert.equal(refunded.tx_signature, 'failed-signature');
    assert.equal(Number(refunded.sol_lamports), 3120000);
    assert.equal(refunded.error, 'Proven payout failure.');
  });

  await t.test('competing refunds commit once and cannot make XP spent negative', async () => {
    const id = await processing('refund-race');
    const attempts = await Promise.all([fail(id), fail(id), fail(id)]);
    assert.deepEqual(attempts.sort(), [false, false, true]);
    assert.deepEqual(await state('refund-race'), { xp: '5000', xp_spent: '0', level: 9 });
    assert.equal((await rows('refund-race'))[0].status, 'failed');
  });

  await t.test('newer signatures and changed statuses fence stale refund attempts', async () => {
    const id = await processing('refund-fence', 'new-signature');
    assert.equal(await fail(id, 'old-signature'), false);
    assert.equal(await fail(id, null), false);
    for (const status of ['pending', 'sent', 'failed']) {
      await db.query('update public.xp_redemptions set status = $2 where id = $1', [id, status]);
      assert.equal(await fail(id, 'new-signature'), false);
    }
    assert.deepEqual(await state('refund-fence'), { xp: '5000', xp_spent: '1000', level: 9 });
    assert.equal(await fail('00000000-0000-0000-0000-000000000000'), false);
  });

  await t.test('insufficient spent XP leaves the payout processing with no underflow', async () => {
    const id = await processing('refund-inconsistent');
    await db.query("update public.user_xp_state set xp_spent = 999 where wallet_address = 'refund-inconsistent'");
    await assert.rejects(fail(id), { code: 'P0001', message: 'XP_REFUND_INCONSISTENT' });
    assert.deepEqual(await state('refund-inconsistent'), { xp: '5000', xp_spent: '999', level: 9 });
    assert.equal((await rows('refund-inconsistent'))[0].status, 'processing');
  });

  await t.test('missing XP state cannot mark the payout failed without refunding', async () => {
    const id = await processing('refund-missing');
    await db.query("delete from public.user_xp_state where wallet_address = 'refund-missing'");
    await assert.rejects(fail(id), { code: 'P0001', message: 'XP_REFUND_INCONSISTENT' });
    assert.equal((await rows('refund-missing'))[0].status, 'processing');
  });

  await t.test('failure-marker write errors roll back the refund too', async () => {
    const id = await processing('refund-marker-fail');
    await db.exec("alter table public.xp_redemptions add constraint simulate_failed_marker_error check (wallet_address <> 'refund-marker-fail' or status <> 'failed')");
    await assert.rejects(fail(id), { code: '23514' });
    assert.deepEqual(await state('refund-marker-fail'), { xp: '5000', xp_spent: '1000', level: 9 });
    assert.equal((await rows('refund-marker-fail'))[0].status, 'processing');
  });

  await t.test('legacy SAKURA failures refund recorded XP without changing the promise', async () => {
    await addWallet('refund-legacy', 10000, 1250);
    const prior = (await db.query(`
      insert into public.xp_redemptions (wallet_address, xp_spent, sakura_amount, rate, status, tx_signature)
      values ('refund-legacy', 250, 797.5, 3.19, 'processing', 'legacy-failed-signature') returning *
    `)).rows[0];
    assert.equal(await fail(prior.id, prior.tx_signature), true);
    assert.equal(await fail(prior.id, prior.tx_signature), false);
    assert.deepEqual(await state('refund-legacy'), { xp: '10000', xp_spent: '1000', level: 9 });
    const after = (await rows('refund-legacy'))[0];
    for (const field of ['xp_spent', 'payout_asset', 'sakura_amount', 'sol_lamports', 'rate', 'tx_signature']) {
      assert.equal(after[field], prior[field]);
    }
    assert.equal(after.status, 'failed');
  });

  await t.test('client roles cannot invoke the wallet-parameter RPC', async () => {
    const definition = await db.query("select prosecdef, proconfig from pg_proc where oid = 'public.queue_sol_xp_redemption(text,bigint,bigint,numeric)'::regprocedure");
    assert.equal(definition.rows[0].prosecdef, false);
    assert.deepEqual(definition.rows[0].proconfig, ['search_path=""']);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      try {
        await assert.rejects(queue('success'), { code: '42501' });
        await assert.rejects(fail(legacyBefore[0].id), { code: '42501' });
      } finally { await db.exec('reset role'); }
    }
    const grants = await db.query(`
      select has_function_privilege('anon', 'public.queue_sol_xp_redemption(text,bigint,bigint,numeric)', 'EXECUTE') as anon,
             has_function_privilege('authenticated', 'public.queue_sol_xp_redemption(text,bigint,bigint,numeric)', 'EXECUTE') as authenticated
    `);
    assert.deepEqual(grants.rows, [{ anon: false, authenticated: false }]);
    const refundDefinition = await db.query("select prosecdef, proconfig from pg_proc where oid = 'public.fail_xp_redemption(uuid,text,text)'::regprocedure");
    assert.equal(refundDefinition.rows[0].prosecdef, false);
    assert.deepEqual(refundDefinition.rows[0].proconfig, ['search_path=""']);
  });
});
