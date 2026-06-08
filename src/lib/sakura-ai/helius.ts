/**
 * Thin Helius wrapper for wallet analytics that Sakura AI can call via tool
 * use. We only expose READ-ONLY portfolio / activity functions here; signed
 * transactions still go through the user's Sakura wallet via the standard
 * wallet-adapter signTransaction flow.
 */

const HELIUS_KEY = process.env.NEXT_PUBLIC_HELIUS_API_KEY || "";
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;

export interface FungibleHolding {
    mint: string;
    symbol: string;
    name: string;
    amountUi: number;
    decimals: number;
    priceUsd: number | null;
    valueUsd: number | null;
    logo?: string;
}

export interface WalletPortfolio {
    address: string;
    solBalance: number;
    solValueUsd: number | null;
    fungibles: FungibleHolding[];
    totalValueUsd: number;
}

export interface WalletActivityItem {
    signature: string;
    timestamp: number;
    description: string;
    type: string;
    fee: number;
    source?: string;
}

function ensureKey(): void {
    if (!HELIUS_KEY) {
        throw new Error("Helius API key not configured (NEXT_PUBLIC_HELIUS_API_KEY).");
    }
}

async function rpcCall<T = any>(method: string, params: any): Promise<T> {
    ensureKey();
    const res = await fetch(HELIUS_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "sakura-ai", method, params }),
    });
    if (!res.ok) {
        throw new Error(`Helius ${method} HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data.error) {
        throw new Error(`Helius ${method}: ${data.error?.message || "unknown error"}`);
    }
    return data.result as T;
}

/**
 * Pulls every fungible token + native SOL via the Helius Asset API and
 * lets the API attach USD prices when available. We sort holdings by USD
 * value desc so the AI can naturally describe "your top holdings".
 */
export async function getWalletPortfolio(address: string): Promise<WalletPortfolio> {
    if (!address) throw new Error("address required");
    const result: any = await rpcCall("getAssetsByOwner", {
        ownerAddress: address,
        page: 1,
        limit: 1000,
        displayOptions: { showFungible: true, showNativeBalance: true },
    });

    const fungibles: FungibleHolding[] = [];
    const items: any[] = result?.items || [];
    for (const item of items) {
        if (item.interface !== "FungibleToken" && item.interface !== "FungibleAsset") continue;
        const tokenInfo = item.token_info || {};
        const balance: number = tokenInfo.balance ?? 0;
        const decimals: number = tokenInfo.decimals ?? 0;
        const amountUi = decimals > 0 ? balance / 10 ** decimals : balance;
        if (!amountUi) continue;
        const priceInfo = tokenInfo.price_info || {};
        const priceUsd: number | null = typeof priceInfo.price_per_token === "number" ? priceInfo.price_per_token : null;
        const valueUsd: number | null = priceUsd != null ? amountUi * priceUsd : null;
        fungibles.push({
            mint: item.id,
            symbol: tokenInfo.symbol || item.content?.metadata?.symbol || "",
            name: item.content?.metadata?.name || tokenInfo.symbol || item.id.slice(0, 8),
            amountUi,
            decimals,
            priceUsd,
            valueUsd,
            logo: item.content?.links?.image,
        });
    }
    fungibles.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

    const lamports: number = result?.nativeBalance?.lamports ?? 0;
    const solBalance = lamports / 1e9;
    const solPriceUsd: number | null = typeof result?.nativeBalance?.price_per_sol === "number"
        ? result.nativeBalance.price_per_sol
        : null;
    const solValueUsd = solPriceUsd != null ? solBalance * solPriceUsd : null;

    const totalValueUsd =
        (solValueUsd ?? 0) +
        fungibles.reduce((sum, f) => sum + (f.valueUsd ?? 0), 0);

    return { address, solBalance, solValueUsd, fungibles, totalValueUsd };
}

/**
 * Recent enriched transactions for the wallet. Each entry has a
 * pre-formatted human-readable `description` from Helius which the AI can
 * relay verbatim.
 */
export async function getRecentActivity(address: string, limit = 10): Promise<WalletActivityItem[]> {
    if (!address) throw new Error("address required");
    ensureKey();
    const url = `${HELIUS_API}/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=${Math.min(limit, 100)}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Helius activity HTTP ${res.status}`);
    }
    const data: any[] = await res.json();
    return (data || []).map((tx) => ({
        signature: tx.signature,
        timestamp: tx.timestamp,
        description: tx.description || tx.type || "",
        type: tx.type || "UNKNOWN",
        fee: tx.fee || 0,
        source: tx.source,
    }));
}

/**
 * Fetch a single token's metadata and current USD price (when known). Used
 * when the AI is asked "what's the price of $X?" and we don't already
 * have it in the user's portfolio.
 */
export async function getTokenSummary(mint: string): Promise<{
    mint: string;
    symbol: string;
    name: string;
    decimals: number;
    priceUsd: number | null;
} | null> {
    try {
        const result: any = await rpcCall("getAsset", { id: mint });
        const tokenInfo = result?.token_info || {};
        return {
            mint,
            symbol: tokenInfo.symbol || result?.content?.metadata?.symbol || "",
            name: result?.content?.metadata?.name || tokenInfo.symbol || mint.slice(0, 8),
            decimals: tokenInfo.decimals ?? 0,
            priceUsd: typeof tokenInfo.price_info?.price_per_token === "number"
                ? tokenInfo.price_info.price_per_token
                : null,
        };
    } catch {
        return null;
    }
}
