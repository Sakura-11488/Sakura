import { getDefaultPhoenixSymbol, getPhoenixHttpClient, normalizePhoenixSymbol } from "./client";
import type { PhoenixOrderBook, PhoenixOrderBookLevel, PhoenixRecentTrade } from "./types";

type RawLevel = [number, number];
type RawOrderBook = {
    bids?: RawLevel[];
    asks?: RawLevel[];
    orderbook?: {
        bids?: RawLevel[];
        asks?: RawLevel[];
        mid?: number;
    };
    mid?: number;
};

type RawFill = {
    price?: string | number;
    baseQty?: string | number;
    baseAmount?: string | number;
    quoteQty?: string | number;
    timestamp?: string | number;
    side?: string;
    transactionSignature?: string;
};

function toNumber(value: unknown, fallback = 0): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function levelsFromTuples(levels: RawLevel[] = []): PhoenixOrderBookLevel[] {
    let runningTotal = 0;
    return levels.slice(0, 36).map(([price, size]) => {
        runningTotal += Math.abs(toNumber(size));
        return {
            price: toNumber(price),
            size: Math.abs(toNumber(size)),
            total: runningTotal,
        };
    });
}

export async function fetchPhoenixOrderBook(inputSymbol = getDefaultPhoenixSymbol()): Promise<PhoenixOrderBook> {
    const symbol = normalizePhoenixSymbol(inputSymbol);
    const raw = await getPhoenixHttpClient().orderbook().getOrderbook(symbol) as RawOrderBook;
    const bids = raw.orderbook?.bids ?? raw.bids ?? [];
    const asks = raw.orderbook?.asks ?? raw.asks ?? [];

    return {
        bids: levelsFromTuples(bids),
        asks: levelsFromTuples(asks),
        midPrice: toNumber(raw.orderbook?.mid ?? raw.mid),
    };
}

export async function fetchPhoenixRecentTrades(
    inputSymbol = getDefaultPhoenixSymbol(),
    limit = 30
): Promise<PhoenixRecentTrade[]> {
    const symbol = normalizePhoenixSymbol(inputSymbol);
    const response = await getPhoenixHttpClient().trades().getMarketFills(symbol, { limit }) as { data?: RawFill[] };

    return (response.data || []).map((fill, index) => {
        const size = toNumber(fill.baseQty ?? fill.baseAmount);
        const timestamp = toNumber(fill.timestamp, Date.now());
        return {
            price: toNumber(fill.price),
            size: Math.abs(size),
            side: size >= 0 ? "buy" : "sell",
            time: new Date(timestamp).toLocaleTimeString(),
            ts: timestamp + index,
        };
    });
}
