import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
// Canonical on-chain addresses live in sakura-mobile (single source of truth).
// addresses.ts is dependency-free strings, safe to import across trees.
import {
    SAKURA_MINT_ADDRESS,
    SAKURA_DECIMALS as SAKURA_DECIMALS_CANONICAL,
    INO_PROGRAM_ADDRESS,
    FEE_ROUTER_PROGRAM_ADDRESS,
    PERCOLATOR_INSURANCE_VAULT_ADDRESS,
    INSURANCE_SPLIT,
    BURN_SPLIT,
    SAKURA_TREASURY_PROGRAM_ADDRESS,
    SAKURA_TREASURY_ADMIN_ADDRESS,
    MONTHLY_PASS_PRICE as MONTHLY_PASS_PRICE_CANONICAL,
    PASS_DURATION_DAYS as PASS_DURATION_DAYS_CANONICAL,
} from "../../sakura-mobile/lib/wallet/addresses";

export { INSURANCE_SPLIT, BURN_SPLIT };

// ============ Network Config ============
export const SOLANA_NETWORK = "mainnet-beta";

// Default to Helius if a key is configured (Capacitor build embeds the
// NEXT_PUBLIC_HELIUS_API_KEY env at build-time). Helius is significantly
// faster and more reliable than the public mainnet RPC, which matters for
// time-bounded confirmations like Jupiter swaps where "block height
// exceeded" errors come from public RPC lag.
const HELIUS_KEY = (process.env.NEXT_PUBLIC_HELIUS_API_KEY || "").trim();
export const RPC_ENDPOINT = HELIUS_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
    : "https://api.mainnet-beta.solana.com";

// ============ $SAKURA Token Config (Token-2022) ============
export const SAKURA_MINT = new PublicKey(SAKURA_MINT_ADDRESS);
export const SAKURA_DECIMALS = SAKURA_DECIMALS_CANONICAL;
export const SAKURA_TOKEN_PROGRAM_ID = TOKEN_2022_PROGRAM_ID;

// ============ Ino On-Chain Registry ============
// Core program for chapter unlocks, milestone tracking, and support recording.
// See: https://github.com/millw14/ino-sakura-registry
export const INO_PROGRAM_ID = new PublicKey(INO_PROGRAM_ADDRESS);

// ============ Pass Config ============
// Monthly pass purchase triggers unlock_chapter + claim_milestone on Ino
export const MONTHLY_PASS_PRICE = MONTHLY_PASS_PRICE_CANONICAL;
export const PASS_DURATION_DAYS = PASS_DURATION_DAYS_CANONICAL;
export const PASS_COLLECTION_NAME = "Sakura Monthly Pass";

// ============ Fee Router (Ino-integrated split) ============
// Payments are routed through the Ino registry for milestone recording,
// then the FeeRouter handles the token split: 50% insurance vault, 50% burn.
export const FEE_ROUTER_PROGRAM_ID = new PublicKey(FEE_ROUTER_PROGRAM_ADDRESS);

export const PERCOLATOR_INSURANCE_VAULT = new PublicKey(
    PERCOLATOR_INSURANCE_VAULT_ADDRESS
);

// ============ Sakura Treasury ============
// Ino record_support PDA authority. Tips and donations are recorded via
// the Ino registry before the SPL transfer settles to this admin wallet.
export const SAKURA_TREASURY_PROGRAM_ID = new PublicKey(
    SAKURA_TREASURY_PROGRAM_ADDRESS
);
export const SAKURA_TREASURY_ADMIN = new PublicKey(SAKURA_TREASURY_ADMIN_ADDRESS);

// ============ Jupiter API Config ============
// Free key from https://portal.jup.ag — required for swap functionality.
// Set NEXT_PUBLIC_JUPITER_API_KEY in .env; never commit the key.
export const JUPITER_API_KEY = process.env.NEXT_PUBLIC_JUPITER_API_KEY?.trim() || "";


// ============ Connection ============
let connectionInstance: Connection | null = null;

export function getConnection(): Connection {
    if (!connectionInstance) {
        connectionInstance = new Connection(RPC_ENDPOINT, "confirmed");
    }
    return connectionInstance;
}

// ============ Helpers ============
export function truncateAddress(address: string): string {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export function lamportsToSol(lamports: number): number {
    return lamports / 1e9;
}

export function sakuraToSmallestUnit(amount: number): number {
    return Math.round(amount * 10 ** SAKURA_DECIMALS);
}
