"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { fetchPhoenixCandles } from "@/lib/phoenix";

interface PerpChartProps {
    markPrice: number;
    change24h: number;
    symbol?: string;
}

type Timeframe = "1m" | "5m" | "15m" | "1H" | "4H" | "1D";

const TF_MAP: Record<Timeframe, string> = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
};

export default function PerpChart({ markPrice, change24h, symbol = "SOL" }: PerpChartProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<any>(null);
    const seriesRef = useRef<any>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const lastCandleTimeRef = useRef(0);
    const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>("15m");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    const fetchAndRender = useCallback(async (tf: Timeframe) => {
        setLoading(true);
        setError("");
        try {
            const candles = await fetchPhoenixCandles(symbol, TF_MAP[tf], 180);
            if (!candles.length) {
                throw new Error("Phoenix returned no candle data for this market.");
            }

            if (!containerRef.current) return;

            const { createChart, ColorType, CrosshairMode, CandlestickSeries } = await import("lightweight-charts");

            resizeObserverRef.current?.disconnect();
            resizeObserverRef.current = null;
            if (chartRef.current) {
                chartRef.current.remove();
                chartRef.current = null;
                seriesRef.current = null;
            }

            const width = Math.max(containerRef.current.clientWidth, 320);
            const height = Math.max(containerRef.current.clientHeight, 360);
            const chart = createChart(containerRef.current, {
                width,
                height,
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
            lastCandleTimeRef.current = candles[candles.length - 1]?.time || 0;

            chartRef.current = chart;
            seriesRef.current = series;

            // Handle resize
            const resizeObs = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    chart.applyOptions({
                        width: Math.max(entry.contentRect.width, 320),
                        height: Math.max(entry.contentRect.height, 360),
                    });
                }
            });
            resizeObs.observe(containerRef.current);
            resizeObserverRef.current = resizeObs;
        } catch (err) {
            console.error("[PerpChart] Error:", err);
            setError(err instanceof Error ? err.message : "Chart failed to load.");
        } finally {
            setLoading(false);
        }
    }, [symbol]);

    useEffect(() => {
        fetchAndRender(activeTimeframe);
        return () => {
            resizeObserverRef.current?.disconnect();
            resizeObserverRef.current = null;
            if (chartRef.current) {
                chartRef.current.remove();
                chartRef.current = null;
            }
        };
    }, [activeTimeframe, fetchAndRender]);

    // Update last candle with live price
    useEffect(() => {
        if (!seriesRef.current || markPrice <= 0) return;
        const now = Math.max(Math.floor(Date.now() / 1000), lastCandleTimeRef.current);
        seriesRef.current.update({
            time: now,
            open: markPrice,
            high: markPrice,
            low: markPrice,
            close: markPrice,
        });
        lastCandleTimeRef.current = now;
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
                    <span style={{ fontSize: 10, opacity: 0.5 }}>Phoenix {symbol}-PERP</span>
                </div>
            </div>
            <div className="perp-chart-body" style={{ position: "relative" }}>
                {loading && (
                    <div className="perp-chart-price-overlay">
                        <span className="perp-chart-big">Loading chart...</span>
                    </div>
                )}
                {!loading && error && (
                    <div className="perp-chart-price-overlay">
                        <span className="perp-chart-big">Chart unavailable</span>
                        <span className="perp-chart-error">{error}</span>
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
