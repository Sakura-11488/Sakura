import { getPhoenixWsUrl, normalizePhoenixSymbol } from "./client";
import type { PhoenixCandle, PhoenixMarketState, PhoenixOrderBook, PhoenixRecentTrade } from "./types";

type PhoenixWsHandlers = {
    onMarket?: (market: Partial<PhoenixMarketState>) => void;
    onOrderBook?: (book: PhoenixOrderBook) => void;
    onTrades?: (trades: PhoenixRecentTrade[]) => void;
    onCandle?: (candle: PhoenixCandle) => void;
    onTraderState?: (state: unknown) => void;
    onStatus?: (status: "connecting" | "open" | "closed" | "error") => void;
};

type PhoenixSubscription = Record<string, string | number | boolean>;

function toNumber(value: unknown, fallback = 0): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function orderBookFromMessage(message: Record<string, unknown>): PhoenixOrderBook {
    const orderbook = message.orderbook as { bids?: [number, number][]; asks?: [number, number][]; mid?: number } | undefined;
    const toLevels = (levels: [number, number][] = []) => {
        let total = 0;
        return levels.slice(0, 36).map(([price, size]) => {
            total += Math.abs(size);
            return { price, size: Math.abs(size), total };
        });
    };
    return {
        bids: toLevels(orderbook?.bids),
        asks: toLevels(orderbook?.asks),
        midPrice: toNumber(orderbook?.mid),
    };
}

function tradesFromMessage(message: Record<string, unknown>): PhoenixRecentTrade[] {
    const trades = Array.isArray(message.trades) ? message.trades as Array<Record<string, unknown>> : [];
    return trades.map((trade, index) => {
        const size = toNumber(trade.baseAmount ?? trade.baseQty ?? trade.baseLotsFilled);
        const timestamp = toNumber(trade.timestamp, Date.now());
        const quote = Math.abs(toNumber(trade.quoteAmount ?? trade.quoteQty ?? trade.quoteLotsFilled));
        return {
            price: toNumber(trade.price, size !== 0 ? quote / Math.abs(size) : 0),
            size: Math.abs(size),
            side: size >= 0 ? "buy" : "sell",
            time: new Date(timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000).toLocaleTimeString(),
            ts: timestamp + index,
        };
    });
}

export function subscribePhoenixLiveData(params: {
    symbol: string;
    timeframe?: string;
    authority?: string | null;
    handlers: PhoenixWsHandlers;
}): () => void {
    const symbol = normalizePhoenixSymbol(params.symbol);
    const timeframe = params.timeframe || "1m";
    const handlers = params.handlers;
    let socket: WebSocket | null = null;
    let closedByClient = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;

    const subscriptions: PhoenixSubscription[] = [
        { channel: "market", symbol },
        { channel: "orderbook", symbol, bypassExecutionBand: false },
        { channel: "trades", symbol },
        { channel: "candles", symbol, timeframe },
    ];
    if (params.authority) {
        subscriptions.push({ channel: "traderState", authority: params.authority, traderPdaIndex: 0 });
    }

    const connect = () => {
        handlers.onStatus?.("connecting");
        socket = new WebSocket(getPhoenixWsUrl());

        socket.onopen = () => {
            reconnectAttempts = 0;
            handlers.onStatus?.("open");
            subscriptions.forEach(subscription => {
                socket?.send(JSON.stringify({ type: "subscribe", subscription }));
            });
        };

        socket.onmessage = event => {
            try {
                const message = JSON.parse(String(event.data)) as Record<string, unknown>;
                if (message.channel === "market") {
                    const markPrice = toNumber(message.markPx ?? message.midPx);
                    const previous = toNumber(message.prevDayPx, markPrice);
                    handlers.onMarket?.({
                        markPrice,
                        indexPrice: toNumber(message.oraclePx, markPrice),
                        midPrice: toNumber(message.midPx, markPrice),
                        fundingRate: toNumber(message.funding),
                        openInterest: toNumber(message.openInterest),
                        volume24h: toNumber(message.dayNtlVlm),
                        change24h: previous > 0 ? ((markPrice - previous) / previous) * 100 : 0,
                    });
                }
                if (message.channel === "orderbook") handlers.onOrderBook?.(orderBookFromMessage(message));
                if (message.channel === "trades") handlers.onTrades?.(tradesFromMessage(message));
                if (message.channel === "candle" && typeof message.candle === "object" && message.candle) {
                    const candle = message.candle as Record<string, unknown>;
                    handlers.onCandle?.({
                        time: toNumber(candle.time),
                        open: toNumber(candle.open),
                        high: toNumber(candle.high),
                        low: toNumber(candle.low),
                        close: toNumber(candle.close),
                        volume: toNumber(candle.volume),
                    });
                }
                if (message.channel === "traderState") handlers.onTraderState?.(message);
            } catch {
                // Ignore malformed socket frames; the reconnect path handles transport failures.
            }
        };

        socket.onerror = () => handlers.onStatus?.("error");
        socket.onclose = () => {
            handlers.onStatus?.("closed");
            if (closedByClient) return;
            reconnectAttempts += 1;
            reconnectTimer = setTimeout(connect, Math.min(20_000, 1_000 * reconnectAttempts));
        };
    };

    connect();

    return () => {
        closedByClient = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        socket?.close();
    };
}
