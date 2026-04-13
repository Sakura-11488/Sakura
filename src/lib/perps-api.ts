/**
 * Frontend API client for the Sakura Perps backend.
 * All trade execution goes through the backend; market data is fetched via REST.
 */

const API_BASE = process.env.NEXT_PUBLIC_PERPS_API_URL || "http://localhost:4000/api";

// ============ Types ============

export interface MarketState {
    markPrice: number;
    indexPrice: number;
    fundingRate: number;
    nextFundingTs: number;
    openInterest: number;
    volume24h: number;
    high24h: number;
    low24h: number;
    change24h: number;
}

export interface OrderBookLevel {
    price: number;
    size: number;
    total: number;
}

export interface OrderBook {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
}

export interface RecentTrade {
    price: number;
    size: number;
    side: "buy" | "sell";
    time: string;
    ts: number;
}

export interface PositionInfo {
    hasPosition: boolean;
    side: "long" | "short" | "none";
    size: number;
    notional: number;
    entryPrice: number;
    markPrice: number;
    pnl: number;
    pnlPercent: number;
    margin: number;
    leverage: number;
    liquidationPrice: number;
}

export interface UserBalance {
    wallet: string;
    deposited_sol: number;
    available_margin: number;
    locked_margin: number;
}

export interface TradeRecord {
    id: string;
    wallet: string;
    market: string;
    side: string;
    size: number;
    leverage: number;
    entry_price: number;
    exit_price: number | null;
    pnl: number | null;
    status: string;
    created_at: string;
    closed_at: string | null;
}

export interface TradeResponse {
    success: boolean;
    trade?: TradeRecord;
    txSig?: string;
    entryPrice?: number;
    error?: string;
}

export interface CloseResponse {
    success: boolean;
    txSig?: string;
    pnl?: number;
    exitPrice?: number;
    error?: string;
}

// ============ Auth helpers ============

export type AuthHeaders = Record<string, string>;

/**
 * Build auth headers for write operations.
 * The caller must sign the message with the wallet adapter first.
 */
export function buildAuthHeaders(
    wallet: string,
    signature: string,
    message: string
): AuthHeaders {
    return {
        "x-wallet-address": wallet,
        "x-signature": signature,
        "x-message": message,
        "Content-Type": "application/json",
    };
}

/**
 * Generate a timestamped message for wallet signing.
 */
export function generateAuthMessage(action: string): string {
    const ts = Math.floor(Date.now() / 1000);
    return `sakura-perps:${action}:ts:${ts}`;
}

// ============ Market Data (public, no auth) ============

export async function fetchMarketState(): Promise<MarketState> {
    const res = await fetch(`${API_BASE}/trade/market`);
    if (!res.ok) throw new Error("Failed to fetch market state");
    return res.json();
}

export async function fetchOrderBook(): Promise<OrderBook> {
    const res = await fetch(`${API_BASE}/trade/orderbook`);
    if (!res.ok) throw new Error("Failed to fetch order book");
    return res.json();
}

export async function fetchRecentTrades(): Promise<RecentTrade[]> {
    const res = await fetch(`${API_BASE}/trade/recent-trades`);
    if (!res.ok) throw new Error("Failed to fetch recent trades");
    return res.json();
}

export async function fetchFundingRate(): Promise<{ rate: number; nextTs: number }> {
    const res = await fetch(`${API_BASE}/trade/funding`);
    if (!res.ok) throw new Error("Failed to fetch funding rate");
    return res.json();
}

export async function fetchServerWallet(): Promise<string> {
    const res = await fetch(`${API_BASE}/trade/server-wallet`);
    if (!res.ok) throw new Error("Failed to fetch server wallet");
    const data = await res.json();
    return data.address;
}

// ============ User Data (lightweight auth) ============

export async function fetchPositions(
    wallet: string
): Promise<{ position: PositionInfo | null; trades: TradeRecord[] }> {
    const res = await fetch(`${API_BASE}/trade/positions/${wallet}`, {
        headers: { "x-wallet-address": wallet },
    });
    if (!res.ok) throw new Error("Failed to fetch positions");
    return res.json();
}

export async function fetchTradeHistory(wallet: string): Promise<TradeRecord[]> {
    const res = await fetch(`${API_BASE}/trade/history/${wallet}`, {
        headers: { "x-wallet-address": wallet },
    });
    if (!res.ok) throw new Error("Failed to fetch trade history");
    const data = await res.json();
    return data.trades;
}

export async function fetchBalance(wallet: string): Promise<UserBalance> {
    const res = await fetch(`${API_BASE}/balance/${wallet}`, {
        headers: { "x-wallet-address": wallet },
    });
    if (!res.ok) throw new Error("Failed to fetch balance");
    return res.json();
}

// ============ Write Operations (full auth) ============

export async function openTrade(
    params: { side: "long" | "short"; size: number; leverage: number; feeSignature: string },
    authHeaders: AuthHeaders
): Promise<TradeResponse> {
    const res = await fetch(`${API_BASE}/trade/open`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(params),
    });

    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error };
    return data;
}

export async function closeTrade(authHeaders: AuthHeaders): Promise<CloseResponse> {
    const res = await fetch(`${API_BASE}/trade/close`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({}),
    });

    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error };
    return data;
}

export async function confirmDeposit(
    txSignature: string,
    authHeaders: AuthHeaders
): Promise<{ success: boolean; deposited?: number; error?: string }> {
    const res = await fetch(`${API_BASE}/balance/deposit-confirm`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ txSignature }),
    });

    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error };
    return data;
}

export async function requestWithdraw(
    amount: number,
    authHeaders: AuthHeaders
): Promise<{ success: boolean; withdrawn?: number; error?: string }> {
    const res = await fetch(`${API_BASE}/balance/withdraw`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ amount }),
    });

    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error };
    return data;
}
