"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface CandleData {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

interface PerpChartProps {
    markPrice: number;
    change24h: number;
}

type Timeframe = "1m" | "5m" | "15m" | "1H" | "4H" | "1D";

const TF_MAP: Record<Timeframe, { cgDays: string; cgInterval: string }> = {
    "1m":  { cgDays: "1",  cgInterval: "" },
    "5m":  { cgDays: "1",  cgInterval: "" },
    "15m": { cgDays: "1",  cgInterval: "" },
    "1H":  { cgDays: "7",  cgInterval: "" },
    "4H":  { cgDays: "30", cgInterval: "hourly" },
    "1D":  { cgDays: "90", cgInterval: "daily" },
};

/**
 * Build OHLC candles from CoinGecko price array.
 * CG returns [timestamp, price] pairs; we group into candle intervals.
 */
function buildCandles(prices: [number, number][], tf: Timeframe): CandleData[] {
    if (!prices || prices.length === 0) return [];

    const intervalMs: Record<Timeframe, number> = {
        "1m": 60_000,
        "5m": 300_000,
        "15m": 900_000,
        "1H": 3_600_000,
        "4H": 14_400_000,
        "1D": 86_400_000,
    };

    const interval = intervalMs[tf];
    const candles: CandleData[] = [];
    let currentBucket = Math.floor(prices[0][0] / interval) * interval;
    let open = prices[0][1];
    let high = prices[0][1];
    let low = prices[0][1];
    let close = prices[0][1];

    for (let i = 1; i < prices.length; i++) {
        const [ts, price] = prices[i];
        const bucket = Math.floor(ts / interval) * interval;

        if (bucket !== currentBucket) {
            candles.push({
                time: Math.floor(currentBucket / 1000),
                open, high, low, close,
            });
            currentBucket = bucket;
            open = price;
            high = price;
            low = price;
            close = price;
        } else {
            if (price > high) high = price;
            if (price < low) low = price;
            close = price;
        }
    }

    candles.push({ time: Math.floor(currentBucket / 1000), open, high, low, close });
    return candles;
}

export default function PerpChart({ markPrice, change24h }: PerpChartProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<any>(null);
    const seriesRef = useRef<any>(null);
    const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>("15m");
    const [loading, setLoading] = useState(true);

    const fetchAndRender = useCallback(async (tf: Timeframe) => {
        setLoading(true);
        try {
            const { cgDays } = TF_MAP[tf];
            const url = `https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=${cgDays}&precision=2`;
            const res = await fetch(url);
            if (!res.ok) return;
            const data = await res.json();
            const candles = buildCandles(data.prices, tf);

            if (!containerRef.current) return;

            const { createChart, ColorType, CrosshairMode, CandlestickSeries } = await import("lightweight-charts");

            if (chartRef.current) {
                chartRef.current.remove();
                chartRef.current = null;
                seriesRef.current = null;
            }

            const chart = createChart(containerRef.current, {
                width: containerRef.current.clientWidth,
                height: containerRef.current.clientHeight,
                layout: {
                    background: { type: ColorType.Solid, color: "transparent" },
                    textColor: "rgba(255,255,255,0.5)",
                    fontSize: 10,
                },
                grid: {
                    vertLines: { color: "rgba(255,255,255,0.04)" },
                    horzLines: { color: "rgba(255,255,255,0.04)" },
                },
                crosshair: { mode: CrosshairMode.Normal },
                rightPriceScale: {
                    borderColor: "rgba(255,255,255,0.1)",
                    scaleMargins: { top: 0.1, bottom: 0.1 },
                },
                timeScale: {
                    borderColor: "rgba(255,255,255,0.1)",
                    timeVisible: true,
                },
            });

            const series = chart.addSeries(CandlestickSeries, {
                upColor: "#4ade80",
                downColor: "#f87171",
                borderUpColor: "#4ade80",
                borderDownColor: "#f87171",
                wickUpColor: "#4ade80",
                wickDownColor: "#f87171",
            });

            series.setData(candles as any);
            chart.timeScale().fitContent();

            chartRef.current = chart;
            seriesRef.current = series;

            // Handle resize
            const resizeObs = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    chart.applyOptions({
                        width: entry.contentRect.width,
                        height: entry.contentRect.height,
                    });
                }
            });
            resizeObs.observe(containerRef.current);
        } catch (err) {
            console.error("[PerpChart] Error:", err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchAndRender(activeTimeframe);
        return () => {
            if (chartRef.current) {
                chartRef.current.remove();
                chartRef.current = null;
            }
        };
    }, [activeTimeframe, fetchAndRender]);

    // Update last candle with live price
    useEffect(() => {
        if (!seriesRef.current || markPrice <= 0) return;
        const now = Math.floor(Date.now() / 1000);
        seriesRef.current.update({
            time: now,
            open: markPrice,
            high: markPrice,
            low: markPrice,
            close: markPrice,
        });
    }, [markPrice]);

    return (
        <div className="perp-chart">
            <div className="perp-chart-toolbar">
                <div className="perp-chart-tf-group">
                    {(Object.keys(TF_MAP) as Timeframe[]).map((tf) => (
                        <button
                            key={tf}
                            className={`perp-chart-tf ${activeTimeframe === tf ? "active" : ""}`}
                            onClick={() => setActiveTimeframe(tf)}
                        >
                            {tf}
                        </button>
                    ))}
                </div>
                <div className="perp-chart-indicators">
                    <span style={{ fontSize: 10, opacity: 0.5 }}>Drift SOL-PERP</span>
                </div>
            </div>
            <div className="perp-chart-body" style={{ position: "relative" }}>
                {loading && (
                    <div className="perp-chart-price-overlay">
                        <span className="perp-chart-big">Loading chart...</span>
                    </div>
                )}
                <div
                    ref={containerRef}
                    style={{ width: "100%", height: "100%", position: "absolute", top: 0, left: 0 }}
                />
            </div>
        </div>
    );
}
