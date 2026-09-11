-- Replay protection for perp deposits.
--
-- `perp_deposits.tx_signature` carried no uniqueness, so the same on-chain
-- signature could be submitted and credited any number of times. That is the
-- finding from PR #8 (fix/f02-deposit-replay-attack).
--
-- WHY THIS EXISTS SEPARATELY FROM THAT PR. #8 was closed as superseded: it also
-- rewrote `programs/sakura-treasury`, a program that has never been deployed to
-- either network, and the whole Drift-based perps prototype it belongs to was
-- replaced by the standalone `sakura-perps` repo (its own Anchor program and
-- LiteSVM suite, deployed as devnet-v0.7.0). Merging #8 would have shipped dead
-- on-chain code into a branch nothing deploys from. This one line is the part
-- worth keeping, so it is carried forward on its own.
--
-- NOT NULL IS HALF THE FIX. A bare UNIQUE permits unlimited NULLs in Postgres,
-- so without it a caller inserting rows with no signature could still
-- double-credit — the guard would be satisfied while the hole stayed open.
--
-- Safe when applied: all four perp_* tables hold 0 rows and nothing in the
-- mobile app references them, so there were no duplicates or NULLs to conflict
-- with. Already applied to production on 2026-09-11; this file is the record,
-- since an applied change with no migration is how the ledger drifts from the
-- repo in the first place.
--
-- Verified by exercising the constraint rather than reading the catalog, inside
-- a rolled-back transaction: the same signature twice is refused, a NULL
-- signature is refused, and a distinct signature still inserts — that last one
-- being what shows the guard blocks replays without breaking writes.

begin;

alter table public.perp_deposits
  alter column tx_signature set not null;

alter table public.perp_deposits
  add constraint perp_deposits_tx_signature_key unique (tx_signature);

commit;
