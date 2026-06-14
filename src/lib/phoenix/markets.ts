import { getDefaultPhoenixSymbol, getPhoenixHttpClient, normalizePhoenixSymbol } from "./client";
import type { PhoenixCandle, PhoenixMarketState } from "./types";

type MarketStatsLike = {
    markPx?: number;
    midPx?: number;
    oraclePx?: number;
    prevDayPx?: number;
    dayNtlVlm?: number;
    openInterest?: number;
    funding?: number;
    high24h?: number;
    low24h?: number;
};

type MarketConfigLike = {
    symbol?: string;
    marketStatus?: string;
    takerFee?: number;
    makerFee?: number;
    fundingIntervalSeconds?: number;
    leverageTiers?: Array<{ maxLeverage?: number }>;
};

function toNumber(value: unknown, fallback = 0): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function buildMarketState(
    symbol: string,
    config: MarketConfigLike,
    latestStats: MarketStatsLike | null
): PhoenixMarketState {
    const markPrice = toNumber(latestStats?.markPx ?? latestStats?.midPx ?? latestStats?.oraclePx);
    const indexPrice = toNumber(latestStats?.oraclePx, markPrice);
    const previous = toNumber(latestStats?.prevDayPx, markPrice);
    const change24h = previous > 0 ? ((markPrice - previous) / previous) * 100 : 0;
    const maxLeverage = Math.max(
        1,
        ...(config.leverageTiers || []).map(tier => toNumber(tier.maxLeverage, 1))
    );

    return {
        symbol,
        displaySymbol: `${symbol}-PERP`,
        markPrice,
        indexPrice,
        midPrice: toNumber(latestStats?.midPx, markPrice),
        fundingRate: toNumber(latestStats?.funding),
        nextFundingTs: Math.floor(Date.now() / 1000) + toNumber(config.fundingIntervalSeconds, 3600),
        openInterest: toNumber(latestStats?.openInterest),
        volume24h: toNumber(latestStats?.dayNtlVlm),
        high24h: toNumber(latestStats?.high24h, Math.max(markPrice, previous)),
        low24h: toNumber(latestStats?.low24h, Math.min(markPrice, previous || markPrice)),
        change24h,
        maxLeverage,
        takerFee: toNumber(config.takerFee),
        makerFee: toNumber(config.makerFee),
        active: config.marketStatus === "active",
    };
}

export async function fetchPhoenixMarketState(inputSymbol = getDefaultPhoenixSymbol()): Promise<PhoenixMarketState> {
    const symbol = normalizePhoenixSymbol(inputSymbol);
    const client = getPhoenixHttpClient();
    const [config, stats] = await Promise.all([
        client.exchange().getMarket(symbol) as Promise<MarketConfigLike>,
        client.markets().getMarketStatsHistory(symbol, { limit: 1 }).catch(() => null) as Promise<unknown>,
    ]);

    const statsData = (stats && typeof stats === "object" && "data" in stats)
        ? (stats as { data?: MarketStatsLike[] }).data?.[0] ?? null
        : null;

    return buildMarketState(symbol, config, statsData);
}

export async function fetchPhoenixCandles(
    inputSymbol = getDefaultPhoenixSymbol(),
    timeframe = "15m",
    limit = 120
): Promise<PhoenixCandle[]> {
    const symbol = normalizePhoenixSymbol(inputSymbol);
    const candles = await getPhoenixHttpClient().candles().getCandles(symbol, { timeframe, limit });
    const normalized = candles.map(candle => {
        const rawTime = toNumber(candle.time);
        return {
            time: rawTime > 1_000_000_000_000 ? Math.floor(rawTime / 1000) : Math.floor(rawTime),
            open: toNumber(candle.open),
            high: toNumber(candle.high),
            low: toNumber(candle.low),
            close: toNumber(candle.close),
            volume: toNumber(candle.volume),
        };
    });

    const byTime = new Map<number, PhoenixCandle>();
    normalized
        .filter(candle => candle.time > 0 && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0)
        .forEach(candle => byTime.set(candle.time, candle));

    return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}
