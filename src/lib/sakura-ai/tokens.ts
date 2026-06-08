import { SAKURA_MINT } from "@/lib/solana";

/**
 * Token registry for Sakura AI.
 *
 * Maps user-friendly symbols to mainnet mint addresses so the AI can call
 * `swap("SOL", "USDC", 0.5)` without ever inventing addresses. Anything
 * outside this list goes through Jupiter's lite token-list resolver.
 */

export interface KnownToken {
    symbol: string;
    name: string;
    mint: string;
    decimals: number;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
export const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
export const WIF_MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
export const PYUSD_MINT = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";

export const KNOWN_TOKENS: KnownToken[] = [
    { symbol: "SOL", name: "Solana", mint: SOL_MINT, decimals: 9 },
    { symbol: "USDC", name: "USD Coin", mint: USDC_MINT, decimals: 6 },
    { symbol: "USDT", name: "Tether", mint: USDT_MINT, decimals: 6 },
    { symbol: "BONK", name: "Bonk", mint: BONK_MINT, decimals: 5 },
    { symbol: "JUP", name: "Jupiter", mint: JUP_MINT, decimals: 6 },
    { symbol: "WIF", name: "dogwifhat", mint: WIF_MINT, decimals: 6 },
    { symbol: "PYUSD", name: "PayPal USD", mint: PYUSD_MINT, decimals: 6 },
    { symbol: "SAKURA", name: "Sakura", mint: SAKURA_MINT.toBase58(), decimals: 6 },
];

const SYMBOL_INDEX = new Map<string, KnownToken>();
const MINT_INDEX = new Map<string, KnownToken>();
for (const t of KNOWN_TOKENS) {
    SYMBOL_INDEX.set(t.symbol.toUpperCase(), t);
    MINT_INDEX.set(t.mint, t);
}

export function findKnownToken(symbolOrMint: string): KnownToken | null {
    if (!symbolOrMint) return null;
    const trimmed = symbolOrMint.trim();
    const upper = trimmed.toUpperCase().replace(/^\$/, "");
    return SYMBOL_INDEX.get(upper) || MINT_INDEX.get(trimmed) || null;
}

/**
 * Looks up a token by symbol/name/mint. First tries our local registry,
 * then falls back to Jupiter's strict token list. Returns null if no
 * match — the caller should ask the user for the mint address.
 */
export async function resolveToken(symbolOrMint: string): Promise<KnownToken | null> {
    const local = findKnownToken(symbolOrMint);
    if (local) return local;

    // Fallback: Jupiter strict token list (mainnet, ~250 tokens).
    try {
        const res = await fetch("https://lite-api.jup.ag/tokens/v1/all", { cache: "no-store" });
        if (!res.ok) return null;
        const all: any[] = await res.json();
        const upper = symbolOrMint.trim().toUpperCase().replace(/^\$/, "");
        const hit = all.find(
            (t) => t.symbol?.toUpperCase() === upper || t.address === symbolOrMint,
        );
        if (!hit) return null;
        return {
            symbol: hit.symbol,
            name: hit.name,
            mint: hit.address,
            decimals: hit.decimals,
        };
    } catch {
        return null;
    }
}
