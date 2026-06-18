-- F-01 Fix: Perp trading tables with deposit replay protection
-- Creates the four perp_* tables that exist only in backend/src/db.ts
-- and were never formally migrated. The critical security addition is
-- the UNIQUE constraint on perp_deposits.tx_signature which closes the
-- deposit replay attack (F-01).

-- perp_users 
CREATE TABLE IF NOT EXISTS public.perp_users (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet      text        NOT NULL UNIQUE,
    drift_sub_account_id integer NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_perp_users_wallet
    ON public.perp_users (wallet);

-- perp_balances 
CREATE TABLE IF NOT EXISTS public.perp_balances (
    wallet          text            PRIMARY KEY,
    deposited_sol   numeric         NOT NULL DEFAULT 0 CHECK (deposited_sol >= 0),
    available_margin numeric        NOT NULL DEFAULT 0 CHECK (available_margin >= 0),
    locked_margin   numeric         NOT NULL DEFAULT 0 CHECK (locked_margin >= 0),
    updated_at      timestamptz     NOT NULL DEFAULT now()
);

-- perp_trades 
CREATE TABLE IF NOT EXISTS public.perp_trades (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet          text        NOT NULL,
    market          text        NOT NULL DEFAULT 'SOL-PERP',
    side            text        NOT NULL CHECK (side IN ('long', 'short')),
    size            numeric     NOT NULL CHECK (size > 0),
    leverage        numeric     NOT NULL CHECK (leverage >= 1),
    entry_price     numeric     NOT NULL DEFAULT 0,
    exit_price      numeric,
    pnl             numeric,
    fee_signature   text        NOT NULL DEFAULT '',
    drift_tx_sig    text        NOT NULL DEFAULT '',
    status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'liquidated')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    closed_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_perp_trades_wallet_status
    ON public.perp_trades (wallet, status, created_at DESC);

-- perp_deposits 
-- tx_signature UNIQUE constraint is the core F-01 fix.
-- A confirmed on-chain transaction can only be credited once.
CREATE TABLE IF NOT EXISTS public.perp_deposits (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet          text        NOT NULL,
    amount_sol      numeric     NOT NULL CHECK (amount_sol > 0),
    direction       text        NOT NULL CHECK (direction IN ('deposit', 'withdraw')),

    -- SECURITY: unique constraint prevents replay attacks.
    -- Submitting the same txSignature twice will fail with a unique violation.
    tx_signature    text        NOT NULL UNIQUE,

    status          text        NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'failed')),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_perp_deposits_wallet
    ON public.perp_deposits (wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_perp_deposits_tx_signature
    ON public.perp_deposits (tx_signature);