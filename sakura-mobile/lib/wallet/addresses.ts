/**
 * Canonical Sakura on-chain addresses & token params — SINGLE SOURCE OF TRUTH.
 *
 * Pure base58 strings / numbers, zero imports, so it can be consumed by:
 *  - sakura-mobile (Metro) via `lib/wallet/config.ts`
 *  - the Expo Web build (symlinked `lib/`)
 *  - legacy Next.js `src/lib/solana.ts` (relative import across trees)
 *
 * Do NOT add imports here (keeps it bundler-agnostic and avoids duplicate
 * @solana/web3.js instances). Wrap in `new PublicKey(...)` at the call site.
 */

// ---- $SAKURA token (Token-2022, pump.fun launch) ----
export const SAKURA_MINT_ADDRESS = 'EWiVNxCqNatzV2paBHyfKUwGLnk7WKs9uZTA5jkTpump';
// On-chain mint reports decimals = 6. A previous value of 9 silently scaled
// balances by 1000x. Verified via getAsset/getAccountInfo on mainnet.
export const SAKURA_DECIMALS = 6;
export const TOKEN_2022_PROGRAM_ADDRESS = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// ---- Ino on-chain registry (chapter unlocks, milestones, support recording) ----
// See: https://github.com/millw14/ino-sakura-registry
export const INO_PROGRAM_ADDRESS = 'E9ju12He2mnBRaneM4xdtUXECDPXdpQQbU6HtSKb6Hpf';

// ---- Fee router (Ino-integrated split: 50% insurance vault, 50% burn) ----
export const FEE_ROUTER_PROGRAM_ADDRESS = 'FNoE2JUhn981hBDyBMvWJYkw9DThhtYwWoPbw6wgz1rg';
export const PERCOLATOR_INSURANCE_VAULT_ADDRESS = '63juJmvm1XHCHveWv9WdanxqJX6tD6DLFTZD7dvH12dc';
export const INSURANCE_SPLIT = 50;
export const BURN_SPLIT = 50;

// ---- Sakura treasury (Ino record_support PDA authority + settlement admin) ----
export const SAKURA_TREASURY_PROGRAM_ADDRESS = '5GBAvcfjpj5XU9Y1wkubdvear2VHk6r55Bf1WjehVuV6';
export const SAKURA_TREASURY_ADMIN_ADDRESS = '5NcWtvtQ48QJcizEs9i8H7Ef3YmtmybnSkPQxA2fxFiF';

// ---- Avatar NFT mint payment default (overridable via env at call sites) ----
export const AVATAR_PAYMENT_WALLET_ADDRESS = 'G8tc69u9PVjAjaL4h8iD3t845dJrvnTKusrLrjv89EZ1';

// ---- Pass config ----
export const MONTHLY_PASS_PRICE = 100; // in SAKURA tokens
export const PASS_DURATION_DAYS = 30;
