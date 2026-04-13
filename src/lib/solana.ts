import { Connection, PublicKey } from "@solana/web3.js";

// ============ Network Config ============
export const SOLANA_NETWORK = "mainnet-beta";
export const RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";

// ============ $SAKURA Token Config (Token-2022) ============
export const SAKURA_MINT = new PublicKey(
    "EWiVNxCqNatzV2paBHyfKUwGLnk7WKs9uZTA5jkTpump"
);
export const SAKURA_DECIMALS = 9;

// ============ Ino On-Chain Registry ============
// Core program for chapter unlocks, milestone tracking, and support recording.
// See: https://github.com/millw14/ino-sakura-registry
export const INO_PROGRAM_ID = new PublicKey(
    "E9ju12He2mnBRaneM4xdtUXECDPXdpQQbU6HtSKb6Hpf"
);

// ============ Pass Config ============
// Monthly pass purchase triggers unlock_chapter + claim_milestone on Ino
export const MONTHLY_PASS_PRICE = 100;
export const PASS_DURATION_DAYS = 30;
export const PASS_COLLECTION_NAME = "Sakura Monthly Pass";

// ============ Fee Router (Ino-integrated split) ============
// Payments are routed through the Ino registry for milestone recording,
// then the FeeRouter handles the token split: 50% insurance vault, 50% burn.
export const FEE_ROUTER_PROGRAM_ID = new PublicKey(
    "FNoE2JUhn981hBDyBMvWJYkw9DThhtYwWoPbw6wgz1rg"
);

export const PERCOLATOR_INSURANCE_VAULT = new PublicKey(
    "63juJmvm1XHCHveWv9WdanxqJX6tD6DLFTZD7dvH12dc"
);

export const INSURANCE_SPLIT = 50;
export const BURN_SPLIT = 50;

// ============ Sakura Treasury ============
// Ino record_support PDA authority. Tips and donations are recorded via
// the Ino registry before the SPL transfer settles to this admin wallet.
export const SAKURA_TREASURY_PROGRAM_ID = new PublicKey(
    "5GBAvcfjpj5XU9Y1wkubdvear2VHk6r55Bf1WjehVuV6"
);
export const SAKURA_TREASURY_ADMIN = new PublicKey(
    "5NcWtvtQ48QJcizEs9i8H7Ef3YmtmybnSkPQxA2fxFiF"
);

// ============ Jupiter API Config ============
// Free key from https://portal.jup.ag — required for swap functionality
export const JUPITER_API_KEY = "36bac653-fbd8-481d-aa0d-2c91530f8ae3";


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
