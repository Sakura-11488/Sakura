"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

interface TokenData {
    price: number;
    change24h: number;
    changePct: number;
    sparkline: number[];
}

interface MockPosition {
    side: "LONG" | "SHORT";
    entry: number;
    mark: number;
    size: number;
    leverage: number;
    pnl: number;
    pnlPct: number;
}

function generateSparkline(trend: number): number[] {
    const pts: number[] = [];
    let val = 50;
    for (let i = 0; i < 20; i++) {
        val += (Math.random() - 0.45 + trend * 0.15) * 4;
        val = Math.max(10, Math.min(90, val));
        pts.push(val);
    }
    return pts;
}

function SparklineSVG({ data, color }: { data: number[]; color: string }) {
    const w = 48, h = 24;
    const min = Math.min(...data), max = Math.max(...data);
    const range = max - min || 1;
    const points = data
        .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`)
        .join(" ");
    return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
            <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export default function TradeCheckModal({ isOpen, onClose }: Props) {
    const router = useRouter();
    const [sol, setSol] = useState<TokenData | null>(null);
    const [sakura, setSakura] = useState<TokenData | null>(null);
    const [position, setPosition] = useState<MockPosition | null>(null);
    const [closing, setClosing] = useState(false);

    const sakuraBalance = useMemo(() => Math.floor(Math.random() * 400) + 50, []);

    useEffect(() => {
        if (!isOpen) return;
        let mounted = true;

        (async () => {
            try {
                const res = await fetch(
                    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true"
                );
                if (!res.ok || !mounted) return;
                const data = await res.json();
                const s = data.solana;
                if (!s || !mounted) return;

                const price = s.usd;
                const pct = s.usd_24h_change ?? (Math.random() - 0.4) * 6;
                const change = price * (pct / 100);
                const trend = pct >= 0 ? 1 : -1;

                setSol({ price, change24h: change, changePct: pct, sparkline: generateSparkline(trend) });

                const sakPrice = 0.000045 + (Math.random() - 0.5) * 0.00001;
                const sakPct = (Math.random() - 0.45) * 8;
                const sakChange = sakPrice * (sakPct / 100);
                setSakura({ price: sakPrice, change24h: sakChange, changePct: sakPct, sparkline: generateSparkline(sakPct >= 0 ? 1 : -1) });

                const side: "LONG" | "SHORT" = Math.random() > 0.5 ? "LONG" : "SHORT";
                const entry = price - (Math.random() - 0.5) * 4;
                const leverage = 10;
                const size = parseFloat((0.5 + Math.random() * 2).toFixed(2));
                const priceDelta = price - entry;
                const pnlRaw = side === "LONG" ? priceDelta * size : -priceDelta * size;
                const pnlPctRaw = ((priceDelta / entry) * 100 * leverage) * (side === "LONG" ? 1 : -1);

                setPosition({ side, entry, mark: price, size, leverage, pnl: pnlRaw * leverage, pnlPct: pnlPctRaw });
            } catch {
                setSol({ price: 142.8, change24h: 3.13, changePct: 2.3, sparkline: generateSparkline(1) });
                setSakura({ price: 0.000046, change24h: -0.0000005, changePct: -1.2, sparkline: generateSparkline(-1) });
            }
        })();

        return () => { mounted = false; };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) {
            setClosing(false);
            return;
        }
    }, [isOpen]);

    if (!isOpen && !closing) return null;

    const handleClose = () => {
        setClosing(true);
        setTimeout(() => { setClosing(false); onClose(); }, 250);
    };

    const handleTrade = () => {
        onClose();
        router.push("/trade");
    };

    const isOpen_ = isOpen && !closing;

    const formatUsd = (n: number) => {
        if (Math.abs(n) < 0.01) return n >= 0 ? `$${n.toFixed(6)}` : `-$${Math.abs(n).toFixed(6)}`;
        if (Math.abs(n) < 1) return n >= 0 ? `$${n.toFixed(4)}` : `-$${Math.abs(n).toFixed(4)}`;
        return n >= 0 ? `$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
    };

    const formatPrice = (n: number) => {
        if (n >= 1) return `$${n.toFixed(2)}`;
        if (n >= 0.01) return `$${n.toFixed(4)}`;
        return `$${n.toFixed(6)}`;
    };

    return (
        <>
            <div className={`tcm-backdrop ${isOpen_ ? "open" : ""}`} onClick={handleClose} />
            <div className={`tcm-container ${isOpen_ ? "open" : ""}`}>
                {/* Ticker Bar */}
                <div className="tcm-ticker">
                    <div className="tcm-ticker-left">
                        <span className="tcm-ticker-icon">◎</span>
                        <span className="tcm-ticker-label">SOL</span>
                        <span className="tcm-ticker-dot">•</span>
                        <span className={`tcm-ticker-change ${(sol?.changePct ?? 0) >= 0 ? "up" : "down"}`}>
                            {(sol?.changePct ?? 0) >= 0 ? "+" : ""}{(sol?.changePct ?? 0).toFixed(1)}%
                        </span>
                        <span className="tcm-ticker-sep">|</span>
                        <span className="tcm-ticker-sakura">SAKURA</span>
                        <span className="tcm-ticker-sakura-badge">+{sakuraBalance}</span>
                    </div>
                    <div className="tcm-ticker-right">
                        <button className="tcm-chart-btn" onClick={handleTrade} aria-label="Full chart">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                            </svg>
                        </button>
                        <button className="tcm-expand-btn" onClick={handleTrade} aria-label="Expand">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="9 18 15 12 9 6" />
                            </svg>
                        </button>
                        <button className="tcm-trade-btn" onClick={handleTrade}>Trade</button>
                    </div>
                </div>

                {/* Token Rows */}
                <div className="tcm-tokens">
                    {/* SOL */}
                    <div className="tcm-token-row">
                        <div className="tcm-token-icon sol">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                                <path d="M5 17.5L8.5 14H20L16.5 17.5H5Z" fill="currentColor" opacity="0.9"/>
                                <path d="M5 6.5L8.5 10H20L16.5 6.5H5Z" fill="currentColor" opacity="0.9"/>
                                <path d="M5 12L8.5 8.5H20L16.5 12H5Z" fill="currentColor" opacity="0.6"/>
                            </svg>
                        </div>
                        <div className="tcm-token-info">
                            <span className="tcm-token-name">SOL</span>
                            <span className="tcm-token-sub">{sol ? sol.price.toFixed(2) : "—"}</span>
                        </div>
                        <div className="tcm-token-price">
                            <span className="tcm-token-price-main">{sol ? formatPrice(sol.price) : "—"}</span>
                            <span className={`tcm-token-price-sub ${(sol?.change24h ?? 0) >= 0 ? "up" : "down"}`}>
                                {sol ? `${sol.change24h >= 0 ? "+" : ""}${formatUsd(sol.change24h)}` : "—"}
                            </span>
                        </div>
                        <div className="tcm-token-change-col">
                            <span className={`tcm-token-change-abs ${(sol?.change24h ?? 0) >= 0 ? "up" : "down"}`}>
                                {sol ? `${sol.change24h >= 0 ? "+" : ""}${sol.change24h.toFixed(2)}` : "—"}
                                <span className="tcm-arrow">{(sol?.change24h ?? 0) >= 0 ? " ▲" : " ▼"}</span>
                            </span>
                            <span className={`tcm-token-change-pct ${(sol?.changePct ?? 0) >= 0 ? "up" : "down"}`}>
                                {sol ? `${sol.changePct >= 0 ? "+" : ""}${sol.changePct.toFixed(1)}%` : "—"}
                            </span>
                        </div>
                        <div className="tcm-token-chart-col">
                            <span className={`tcm-pct-badge ${(sol?.changePct ?? 0) >= 0 ? "up" : "down"}`}>
                                {sol ? `${sol.changePct >= 0 ? "+" : ""}${sol.changePct.toFixed(1)}%` : "—"}
                            </span>
                            {sol && <SparklineSVG data={sol.sparkline} color={(sol.changePct ?? 0) >= 0 ? "#00c853" : "#ff4081"} />}
                        </div>
                    </div>

                    {/* SAKURA */}
                    <div className="tcm-token-row">
                        <div className="tcm-token-icon sakura">
                            <span>🌸</span>
                        </div>
                        <div className="tcm-token-info">
                            <span className="tcm-token-name">SAKURA</span>
                            <span className="tcm-token-sub">{sakura ? formatPrice(sakura.price) : "—"}</span>
                        </div>
                        <div className="tcm-token-price">
                            <span className="tcm-token-price-main">{sakura ? formatPrice(sakura.price) : "—"}</span>
                            <span className={`tcm-token-price-sub ${(sakura?.changePct ?? 0) >= 0 ? "up" : "down"}`}>
                                {sakura ? `${sakura.change24h >= 0 ? "+" : ""}${sakura.change24h.toFixed(6)}` : "—"}
                            </span>
                        </div>
                        <div className="tcm-token-change-col">
                            <span className={`tcm-token-change-abs ${(sakura?.changePct ?? 0) >= 0 ? "up" : "down"}`}>
                                {sakura ? `${sakura.change24h >= 0 ? "+" : ""}${sakura.change24h.toFixed(6)}` : "—"}
                                <span className="tcm-arrow">{(sakura?.changePct ?? 0) >= 0 ? " ▲" : " ▼"}</span>
                            </span>
                            <span className={`tcm-token-change-pct ${(sakura?.changePct ?? 0) >= 0 ? "up" : "down"}`}>
                                {sakura ? `${sakura.changePct >= 0 ? "+" : ""}${sakura.changePct.toFixed(1)}%` : "—"}
                            </span>
                        </div>
                        <div className="tcm-token-chart-col">
                            <span className={`tcm-pct-badge ${(sakura?.changePct ?? 0) >= 0 ? "up" : "down"}`}>
                                {sakura ? `${sakura.changePct >= 0 ? "+" : ""}${sakura.changePct.toFixed(1)}%` : "—"}
                            </span>
                            {sakura && <SparklineSVG data={sakura.sparkline} color={(sakura.changePct ?? 0) >= 0 ? "#00c853" : "#ff4081"} />}
                        </div>
                    </div>
                </div>

                {/* Position Section */}
                {position && (
                    <div className="tcm-position">
                        <div className="tcm-position-header">
                            <span className={`tcm-position-side ${position.side === "LONG" ? "long" : "short"}`}>
                                {position.side}
                            </span>
                            <span className="tcm-position-leverage">{position.leverage}x</span>
                            <span className="tcm-position-pair">SOL-PERP</span>
                            <span className={`tcm-position-pnl ${position.pnl >= 0 ? "up" : "down"}`}>
                                {position.pnl >= 0 ? "+" : ""}{position.pnl.toFixed(2)} ({position.pnlPct >= 0 ? "+" : ""}{position.pnlPct.toFixed(1)}%)
                            </span>
                        </div>
                        <div className="tcm-position-details">
                            <div className="tcm-position-detail">
                                <span className="tcm-detail-label">Entry</span>
                                <span className="tcm-detail-value">${position.entry.toFixed(2)}</span>
                            </div>
                            <div className="tcm-position-detail">
                                <span className="tcm-detail-label">Mark</span>
                                <span className="tcm-detail-value">${position.mark.toFixed(2)}</span>
                            </div>
                            <div className="tcm-position-detail">
                                <span className="tcm-detail-label">Size</span>
                                <span className="tcm-detail-value">{position.size} SOL</span>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
