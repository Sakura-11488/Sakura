# SOL XP rewards

New redemptions pay native SOL at **1,000 XP = 0.00312 SOL** (3,120 lamports per XP).
The existing minimum is 100 XP, worth 0.000312 SOL. Lifetime XP and earned badges
are preserved; spending still increments `xp_spent`.

`XP_SOL_RATE` can override the SOL-per-XP rate on `redeem-xp`. It must represent
a positive whole number of lamports per XP. The default is `0.00000312`.
`XP_SAKURA_RATE` no longer controls new rewards. The client refreshes the signed
quote before queuing a swap, and the server rejects outdated currencies/rates
before debiting XP.

New ledger rows store `payout_asset = 'SOL'` and integer `sol_lamports`, with
`sakura_amount = null`. Existing rows retain `payout_asset = 'SAKURA'`, their
original amounts, and their original settlement path. History displays each
row's recorded currency. No historical rewards are repriced.

## Release order

1. Pause the payout schedule and let any running old processor finish. Check
   in-flight transactions before replacing the processor.
2. Apply `20260927122023_xp_sol_rewards.sql` to the database that already has
   `xp_redemptions`. This is an additive migration; it is not a database reset.
3. Configure `SOL_PAYOUT_SECRET` on the payout processor with the intended SOL
   treasury key (base58 or a JSON secret-key byte array). Fund that address with
   enough SOL for rewards and transaction fees. Keep `SAKURA_PAYOUT_SECRET` and
   `SAKURA_MINT` for any remaining legacy SAKURA payouts. The operator gate remains
   `XP_PAYOUT_ADMIN_SECRET` or the existing Vault gate.
4. Deploy the updated `process-xp-redemptions` first. Its authenticated
   `{ "probe": true, "payout_asset": "SOL" }` request can inspect the configured
   SOL treasury without paying rewards. Keep the schedule paused until verified.
5. Deploy `redeem-xp`, then release the mobile app / rebuild the shared Expo web
   app. Older clients can read history but cannot submit a SAKURA-priced swap to
   the SOL endpoint.
6. Resume the payout schedule after the SOL treasury and release are ready.

Do not roll back to the old processor while SOL rows exist: it only understands
`sakura_amount`. Stop new requests and drain/reconcile the SOL queue using this
processor before considering a rollback.

Native SOL transfers use the stored lamports, include a fee balance check, and
keep the existing signature-before-broadcast and reconciliation safeguards.
An ambiguous broadcast remains in processing until its chain outcome is known.

## Regression checks

Install the existing locked web dependencies with `npm ci --ignore-scripts` in
`web`, then run from the repository root:

```sh
node --test sakura-mobile/test/*.test.mjs sakura-mobile/test/*.test.cjs
```

These tests use generated test wallets and mocked RPC/database calls. They check
the reward quote, exact payout and display amounts, wallet authentication,
legacy SAKURA history/settlement, fee coverage, and retry/reconciliation behavior
without sending funds.

The migration suite uses an isolated PGlite database built from the existing
table schema. It is explicitly skipped unless `PGLITE_MODULE_PATH` is set:

```sh
npm install --prefix /tmp/sakura-sol-validation --no-audit --no-fund @electric-sql/pglite
PGLITE_MODULE_PATH=/tmp/sakura-sol-validation/node_modules/@electric-sql/pglite node --test sakura-mobile/test/*.test.*
```
