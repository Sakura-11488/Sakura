// Isolated PostgreSQL validation; never connects to Supabase.
// npm install --prefix /tmp/sakura-sol-validation --no-audit --no-fund @electric-sql/pglite
// PGLITE_MODULE_PATH=/tmp/sakura-sol-validation/node_modules/@electric-sql/pglite node --test sakura-mobile/test/xp-sol-migration.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const pglite = process.env.PGLITE_MODULE_PATH ? require(process.env.PGLITE_MODULE_PATH) : null;
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260927122023_xp_sol_rewards.sql'), 'utf8');

test('SOL migration preserves legacy promises and constrains native payouts', {
  skip: pglite ? false : 'Set PGLITE_MODULE_PATH to an isolated @electric-sql/pglite installation (see file header).',
}, async (t) => {
  const db = new pglite.PGlite();
  t.after(() => db.close());
  // Matches the existing production table, including its original amount checks.
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.xp_redemptions (
      id uuid primary key default gen_random_uuid(),
      wallet_address text not null,
      xp_spent bigint not null check (xp_spent > 0),
      sakura_amount numeric not null check (sakura_amount > 0),
      rate numeric not null check (rate > 0),
      status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed')),
      tx_signature text,
      error text,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    grant all on public.xp_redemptions to public, anon, authenticated;
    insert into public.xp_redemptions (wallet_address, xp_spent, sakura_amount, rate, status, tx_signature, error)
      values ('wallet-a', 1000, 3190, 3.19, 'sent', 'old-signature', null),
             ('wallet-b', 250, 797.5, 3.19, 'pending', null, null),
             ('wallet-c', 100, 319, 3.19, 'processing', null, null),
             ('wallet-d', 123, 392.37, 3.19, 'failed', null, 'old-error');
  `);
  const before = (await db.query('select * from public.xp_redemptions order by wallet_address')).rows;
  await db.exec(migration);

  await t.test('existing SAKURA rows retain every original value and status', async () => {
    const after = (await db.query('select * from public.xp_redemptions order by wallet_address')).rows;
    assert.deepEqual(after, before.map((row) => ({ ...row, payout_asset: 'SAKURA', sol_lamports: null })));
  });

  const insert = async ({ wallet = 'native-wallet', xp = 1000, asset = 'SOL', lamports = 3120000, sakura = null, rate = '0.00000312' } = {}) => db.query(`
    insert into public.xp_redemptions (wallet_address, xp_spent, payout_asset, sol_lamports, sakura_amount, rate)
    values ($1, $2, $3, $4, $5, $6)
    returning payout_asset, sol_lamports::text, sakura_amount::text, rate::text, status
  `, [wallet, xp, asset, lamports, sakura, rate]);

  await t.test('1,000 XP records exactly 3,120,000 lamports with no SAKURA amount', async () => {
    const result = await insert();
    assert.deepEqual(result.rows, [{ payout_asset: 'SOL', sol_lamports: '3120000', sakura_amount: null, rate: '0.00000312', status: 'pending' }]);
  });

  await t.test('minimum and irregular XP amounts preserve exact numeric equality', async () => {
    await insert({ wallet: 'min-wallet', xp: 100, lamports: 312000 });
    await insert({ wallet: 'odd-wallet', xp: 123, lamports: 383760 });
  });

  await t.test('old insert shape remains SAKURA during deployment transition', async () => {
    const result = await db.query(`
      insert into public.xp_redemptions (wallet_address, xp_spent, sakura_amount, rate)
      values ('legacy-shape', 1000, 3190, 3.19)
      returning payout_asset, sol_lamports, sakura_amount::text
    `);
    assert.deepEqual(result.rows, [{ payout_asset: 'SAKURA', sol_lamports: null, sakura_amount: '3190' }]);
  });

  await t.test('mixed currencies, missing amounts, and inexact or unsafe native amounts fail', async (t) => {
    for (const [name, values] of [
      ['SOL with SAKURA amount', { sakura: 3190 }],
      ['SOL missing lamports', { lamports: null }],
      ['zero SOL', { lamports: 0 }],
      ['negative SOL', { lamports: -3120000 }],
      ['wrong lamports for rate', { lamports: 3120001 }],
      ['wrong XP for payout', { xp: 999 }],
      ['old SAKURA rate for native payout', { rate: '3.19' }],
      ['lamports outside JavaScript safe range', { xp: 1, lamports: '9007199254740992', rate: '9007199.254740992' }],
      ['SAKURA with lamports', { asset: 'SAKURA', sakura: 3190 }],
      ['SAKURA missing token amount', { asset: 'SAKURA', lamports: null }],
      ['zero SAKURA', { asset: 'SAKURA', lamports: null, sakura: 0 }],
      ['unknown currency', { asset: 'USDC' }],
    ]) {
      await t.test(name, async () => assert.rejects(insert(values), { code: '23514' }));
    }
  });

  await t.test('RLS is enabled and inherited PUBLIC/client grants are revoked', async () => {
    const enabled = await db.query("select relrowsecurity from pg_class where oid = 'public.xp_redemptions'::regclass");
    assert.equal(enabled.rows[0].relrowsecurity, true);
    const grants = await db.query(`
      select grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'xp_redemptions'
        and grantee in ('PUBLIC', 'anon', 'authenticated')
    `);
    assert.deepEqual(grants.rows, []);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      try {
        await assert.rejects(db.query('select * from public.xp_redemptions'), { code: '42501' });
        await assert.rejects(insert(), { code: '42501' });
        await assert.rejects(db.query("update public.xp_redemptions set status = 'sent'"), { code: '42501' });
        await assert.rejects(db.query('delete from public.xp_redemptions'), { code: '42501' });
      } finally {
        await db.exec('reset role');
      }
    }
  });

  await t.test('service role can read, insert, and settle with RLS enabled', async () => {
    const grants = await db.query(`
      select privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'xp_redemptions' and grantee = 'service_role'
      order by privilege_type
    `);
    assert.deepEqual(grants.rows.map((row) => row.privilege_type), ['INSERT', 'SELECT', 'UPDATE']);
    await db.exec('set role service_role');
    try {
      assert.ok((await db.query('select * from public.xp_redemptions')).rows.length >= 4);
      await insert({ wallet: 'service-wallet' });
      const settled = await db.query("update public.xp_redemptions set status = 'sent', tx_signature = 'sol-signature' where wallet_address = 'service-wallet' returning status");
      assert.deepEqual(settled.rows, [{ status: 'sent' }]);
    } finally {
      await db.exec('reset role');
    }
  });
});
