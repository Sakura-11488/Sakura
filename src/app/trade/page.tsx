"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Header from "@/components/Header";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSakuraWalletModal } from "@/components/SakuraWalletModal";
import { payTradingFee } from "@/lib/percolator/fee-router";
import { TRADING_FEE_SAKURA, RISK_PARAMS } from "@/lib/percolator/config";
import {
    fetchMarketState,
    fetchOrderBook,
    fetchRecentTrades,
    fetchPositions,
    fetchTradeHistory,
    fetchBalance,
    openTrade,
    closeTrade,
    buildAuthHeaders,
    generateAuthMessage,
    type MarketState,
    type OrderBook,
    type RecentTrade,
    type PositionInfo,
    type TradeRecord,
    type UserBalance,
} from "@/lib/perps-api";
import PerpChart from "@/components/PerpChart";
import DepositWithdrawModal from "@/components/DepositWithdrawModal";
import bs58 from "bs58";

// ============ Types ============

type TradeSide = "long" | "short";
type OrderType = "market" | "limit";
type MarginMode = "cross" | "isolated";
type TradeState = "idle" | "paying_fee" | "executing" | "success" | "error";

interface Position {
    side: TradeSide;
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

interface OrderBookLevel {
    price: number;
    size: number;
    total: number;
}

// ============ Component ============

export default function TradePage() {
    const { publicKey, signTransaction, signMessage, connected } = useWallet();
    const { setVisible } = useSakuraWalletModal();

    // Market
    const [market, setMarket] = useState<MarketState>({
        markPrice: 0,
        indexPrice: 0,
        fundingRate: 0,
        nextFundingTs: 0,
        volume24h: 0,
        openInterest: 0,
        high24h: 0,
        low24h: 0,
        change24h: 0,
    });
    const [priceFlash, setPriceFlash] = useState<"up" | "down" | null>(null);
    const [fundingCountdown, setFundingCountdown] = useState(3600);
    const prevPriceRef = useRef(0);

    // Order book & trades
    const [orderBook, setOrderBook] = useState<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] }>({ bids: [], asks: [] });
    const [recentTrades, setRecentTrades] = useState<RecentTrade[]>([]);

    // Trading controls
    const [tradeSide, setTradeSide] = useState<TradeSide>("long");
    const [orderType, setOrderType] = useState<OrderType>("market");
    const [marginMode, setMarginMode] = useState<MarginMode>("cross");
    const [leverage, setLeverage] = useState(5);
    const [tradeSize, setTradeSize] = useState("");
    const [limitPrice, setLimitPrice] = useState("");
    const [tradeState, setTradeState] = useState<TradeState>("idle");
    const [tradeError, setTradeError] = useState("");

    // Positions & orders
    const [activeTab, setActiveTab] = useState<"positions" | "orders" | "trades">("positions");
    const [position, setPosition] = useState<PositionInfo | null>(null);
    const [tradeHistory, setTradeHistory] = useState<TradeRecord[]>([]);
    const [balance, setBalance] = useState<UserBalance | null>(null);

    const [showDepositModal, setShowDepositModal] = useState(false);

    // ============ Live Market Data from Backend ============

    useEffect(() => {
        let isMounted = true;

        const pollData = async () => {
            try {
                const [marketData, bookData, tradesData] = await Promise.allSettled([
                    fetchMarketState(),
                    fetchOrderBook(),
                    fetchRecentTrades(),
                ]);

                if (!isMounted) return;

                if (marketData.status === "fulfilled") {
                    const md = marketData.value;
                    if (prevPriceRef.current !== 0 && md.markPrice !== prevPriceRef.current) {
                        setPriceFlash(md.markPrice > prevPriceRef.current ? "up" : "down");
                        setTimeout(() => setPriceFlash(null), 400);
                    }
                    prevPriceRef.current = md.markPrice;
                    setMarket(md);

                    // Update funding countdown from next funding timestamp
                    if (md.nextFundingTs) {
                        const remaining = md.nextFundingTs - Math.floor(Date.now() / 1000);
                        if (remaining > 0) setFundingCountdown(remaining);
                    }
                }

                if (bookData.status === "fulfilled") {
                    setOrderBook(bookData.value);
                }

                if (tradesData.status === "fulfilled") {
                    setRecentTrades(tradesData.value);
                }
            } catch (err) {
                console.error("Market data fetch error:", err);
            }
        };

        pollData();
        const interval = setInterval(pollData, 4000);

        return () => {
            isMounted = false;
            clearInterval(interval);
        };
    }, []);

    // Funding countdown ticker
    useEffect(() => {
        const interval = setInterval(() => {
            setFundingCountdown((prev) => (prev <= 0 ? 3600 : prev - 1));
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    // Load user position & balance when wallet connects
    useEffect(() => {
        if (!connected || !publicKey) {
            setPosition(null);
            setBalance(null);
            setTradeHistory([]);
            return;
        }

        let isMounted = true;
        const wallet = publicKey.toBase58();

        const loadUserData = async () => {
            try {
                const [posData, balData, histData] = await Promise.allSettled([
                    fetchPositions(wallet),
                    fetchBalance(wallet),
                    fetchTradeHistory(wallet),
                ]);

                if (!isMounted) return;

                if (posData.status === "fulfilled") {
                    setPosition(posData.value.position);
                }
                if (balData.status === "fulfilled") {
                    setBalance(balData.value);
                }
                if (histData.status === "fulfilled") {
                    setTradeHistory(histData.value);
                }
            } catch (err) {
                console.error("User data fetch error:", err);
            }
        };

        loadUserData();
        const interval = setInterval(loadUserData, 8000);

        return () => {
            isMounted = false;
            clearInterval(interval);
        };
    }, [connected, publicKey]);

    // ============ Calculations ============

    const sizeNum = parseFloat(tradeSize) || 0;
    const notional = sizeNum * market.markPrice;
    const marginRequired = notional / leverage;
    const liquidationPrice = useMemo(() => {
        if (sizeNum <= 0 || market.markPrice <= 0) return 0;
        const mmRatio = RISK_PARAMS.maintenanceMarginBps / 10000;
        if (tradeSide === "long") {
            return Math.round((market.markPrice * (1 - 1 / leverage + mmRatio)) * 100) / 100;
        }
        return Math.round((market.markPrice * (1 + 1 / leverage - mmRatio)) * 100) / 100;
    }, [sizeNum, market.markPrice, leverage, tradeSide]);

    const formatFunding = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    };

    const formatUsd = (v: number) =>
        v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` :
        v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` :
        `$${v.toLocaleString()}`;

    const maxDepth = Math.max(
        ...orderBook.bids.map((l) => l.total),
        ...orderBook.asks.map((l) => l.total),
        1
    );

    // ============ Auth Helper ============

    const signAuthMessage = useCallback(async (action: string) => {
        if (!signMessage || !publicKey) throw new Error("Wallet not connected");
        const message = generateAuthMessage(action);
        const msgBytes = new TextEncoder().encode(message);
        const sigBytes = await signMessage(msgBytes);
        return {
            headers: buildAuthHeaders(publicKey.toBase58(), bs58.encode(sigBytes), message),
        };
    }, [signMessage, publicKey]);

    // ============ Trade Execution ============

    const handleTrade = async () => {
        if (!connected || !publicKey || !signTransaction) {
            setVisible(true);
            return;
        }
        if (!tradeSize || sizeNum <= 0) {
            setTradeError("Enter a valid size");
            setTradeState("error");
            return;
        }

        try {
            setTradeState("paying_fee");
            setTradeError("");

            // Step 1: Pay $SAKURA fee on mainnet (user signs)
            const feeResult = await payTradingFee(publicKey, signTransaction);
            if (!feeResult.success || !feeResult.signature) {
                throw new Error(feeResult.error || "Fee payment failed");
            }

            setTradeState("executing");

            // Step 2: Sign auth message for backend
            const { headers } = await signAuthMessage("trade");

            // Step 3: Execute trade via backend
            const tradeResult = await openTrade(
                {
                    side: tradeSide,
                    size: sizeNum,
                    leverage,
                    feeSignature: feeResult.signature,
                },
                headers
            );

            if (!tradeResult.success) {
                throw new Error(tradeResult.error || "Trade execution failed");
            }

            setTradeState("success");
            setTradeSize("");

            // Refresh position data
            const wallet = publicKey.toBase58();
            const posData = await fetchPositions(wallet);
            setPosition(posData.position);

            setTimeout(() => setTradeState("idle"), 3000);
        } catch (error: unknown) {
            setTradeError(error instanceof Error ? error.message : "Trade failed");
            setTradeState("error");
        }
    };

    const handleClose = async () => {
        if (!connected || !publicKey || !signMessage) return;

        try {
            setTradeState("executing");
            const { headers } = await signAuthMessage("close");
            const result = await closeTrade(headers);

            if (!result.success) {
                throw new Error(result.error || "Close failed");
            }

            setPosition(null);
            setTradeState("idle");

            // Refresh history
            const histData = await fetchTradeHistory(publicKey.toBase58());
            setTradeHistory(histData);
        } catch (error: unknown) {
            setTradeError(error instanceof Error ? error.message : "Close failed");
            setTradeState("error");
        }
    };

    // Build the position display from the backend position info
    const positions: Position[] = position && position.hasPosition ? [{
        side: position.side as TradeSide,
        size: position.size,
        notional: position.notional,
        entryPrice: position.entryPrice,
        markPrice: position.markPrice,
        pnl: position.pnl,
        pnlPercent: position.pnlPercent,
        margin: position.margin,
        leverage: position.leverage,
        liquidationPrice: position.liquidationPrice,
    }] : [];

    // ============ Render ============

    return (
        <>
            <Header />
            <main className="main-content perp-page">
                {/* ===== Top Market Info Bar ===== */}
                <div className="perp-market-bar">
                    <div className="perp-pair">
                        <div className="perp-pair-icon">◎</div>
                        <div>
                            <span className="perp-pair-name">SOL-PERP</span>
                            <span className="perp-pair-badge">{leverage}x</span>
                        </div>
                    </div>

                    <div className={`perp-mark-price ${priceFlash ? `flash-${priceFlash}` : ""}`}>
                        {market.markPrice > 0 ? `$${market.markPrice.toFixed(2)}` : "Loading..."}
                    </div>

                    <div className="perp-stats-row">
                        <div className="perp-stat-pill">
                            <span className="perp-stat-k">Index</span>
                            <span className="perp-stat-v">${market.indexPrice.toFixed(2)}</span>
                        </div>
                        <div className="perp-stat-pill">
                            <span className="perp-stat-k">24h Change</span>
                            <span className={`perp-stat-v ${market.change24h >= 0 ? "green" : "red"}`}>
                                {market.change24h >= 0 ? "+" : ""}{market.change24h.toFixed(2)}%
                            </span>
                        </div>
                        <div className="perp-stat-pill">
                            <span className="perp-stat-k">24h High</span>
                            <span className="perp-stat-v">${market.high24h.toFixed(2)}</span>
                        </div>
                        <div className="perp-stat-pill">
                            <span className="perp-stat-k">24h Low</span>
                            <span className="perp-stat-v">${market.low24h.toFixed(2)}</span>
                        </div>
                        <div className="perp-stat-pill">
                            <span className="perp-stat-k">24h Vol</span>
                            <span className="perp-stat-v">{formatUsd(market.volume24h)}</span>
                        </div>
                        <div className="perp-stat-pill">
                            <span className="perp-stat-k">Open Interest</span>
                            <span className="perp-stat-v">{formatUsd(market.openInterest)}</span>
                        </div>
                        <div className="perp-stat-pill funding">
                            <span className="perp-stat-k">Funding / Countdown</span>
                            <span className={`perp-stat-v ${market.fundingRate >= 0 ? "green" : "red"}`}>
                                {market.fundingRate >= 0 ? "+" : ""}{(market.fundingRate * 100).toFixed(4)}% / {formatFunding(fundingCountdown)}
                            </span>
                        </div>
                    </div>
                </div>

                {/* ===== Main Trading Grid ===== */}
                <div className="perp-grid">
                    {/* Left: Order Book */}
                    <div className="perp-orderbook">
                        <div className="perp-panel-header">
                            <span>Order Book</span>
                            <div className="perp-ob-modes">
                                <button className="perp-ob-mode active" title="Both">
                                    <span className="ob-icon-both" />
                                </button>
                                <button className="perp-ob-mode" title="Bids">
                                    <span className="ob-icon-bids" />
                                </button>
                                <button className="perp-ob-mode" title="Asks">
                                    <span className="ob-icon-asks" />
                                </button>
                            </div>
                        </div>

                        <div className="perp-ob-header-row">
                            <span>Price (USD)</span>
                            <span>Size (SOL)</span>
                            <span>Total</span>
                        </div>

                        <div className="perp-ob-asks">
                            {orderBook.asks.length > 0 ? orderBook.asks.map((level, i) => (
                                <div key={`a${i}`} className="perp-ob-row ask">
                                    <div className="perp-ob-depth ask" style={{ width: `${(level.total / maxDepth) * 100}%` }} />
                                    <span className="perp-ob-price red">{level.price.toFixed(2)}</span>
                                    <span className="perp-ob-size">{level.size.toFixed(2)}</span>
                                    <span className="perp-ob-total">{level.total.toFixed(2)}</span>
                                </div>
                            )) : (
                                <div className="perp-ob-loading">Loading...</div>
                            )}
                        </div>

                        <div className="perp-ob-spread">
                            <span className={`perp-ob-mid ${priceFlash ? `flash-${priceFlash}` : ""}`}>
                                {market.markPrice > 0 ? `$${market.markPrice.toFixed(2)}` : "—"}
                            </span>
                            <span className="perp-ob-spread-val">
                                Spread: ${(orderBook.asks[orderBook.asks.length - 1]?.price - orderBook.bids[0]?.price || 0).toFixed(2)}
                            </span>
                        </div>

                        <div className="perp-ob-bids">
                            {orderBook.bids.map((level, i) => (
                                <div key={`b${i}`} className="perp-ob-row bid">
                                    <div className="perp-ob-depth bid" style={{ width: `${(level.total / maxDepth) * 100}%` }} />
                                    <span className="perp-ob-price green">{level.price.toFixed(2)}</span>
                                    <span className="perp-ob-size">{level.size.toFixed(2)}</span>
                                    <span className="perp-ob-total">{level.total.toFixed(2)}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Center: Chart */}
                    <PerpChart markPrice={market.markPrice} change24h={market.change24h} />

                    {/* Right: Order Entry */}
                    <div className="perp-order-panel">
                        <div className="perp-margin-toggle">
                            <button className={`perp-margin-btn ${marginMode === "cross" ? "active" : ""}`} onClick={() => setMarginMode("cross")}>Cross</button>
                            <button className={`perp-margin-btn ${marginMode === "isolated" ? "active" : ""}`} onClick={() => setMarginMode("isolated")}>Isolated</button>
                        </div>

                        <div className="perp-side-toggle">
                            <button className={`perp-side-btn ${tradeSide === "long" ? "active-long" : ""}`} onClick={() => setTradeSide("long")}>Long</button>
                            <button className={`perp-side-btn ${tradeSide === "short" ? "active-short" : ""}`} onClick={() => setTradeSide("short")}>Short</button>
                        </div>

                        <div className="perp-order-types">
                            {(["market", "limit"] as const).map((t) => (
                                <button key={t} className={`perp-ot-btn ${orderType === t ? "active" : ""}`} onClick={() => setOrderType(t)}>
                                    {t.charAt(0).toUpperCase() + t.slice(1)}
                                </button>
                            ))}
                        </div>

                        {orderType === "limit" && (
                            <div className="perp-field">
                                <label>Price (USD)</label>
                                <div className="perp-input-row">
                                    <button className="perp-input-btn" onClick={() => setLimitPrice(String(Math.max(0, (parseFloat(limitPrice) || market.markPrice) - 0.1).toFixed(2)))}>−</button>
                                    <input type="number" className="perp-input" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} placeholder={market.markPrice.toFixed(2)} />
                                    <button className="perp-input-btn" onClick={() => setLimitPrice(String(((parseFloat(limitPrice) || market.markPrice) + 0.1).toFixed(2)))}>+</button>
                                </div>
                            </div>
                        )}

                        <div className="perp-field">
                            <label>Size (SOL)</label>
                            <div className="perp-input-row">
                                <input
                                    type="number"
                                    className="perp-input"
                                    value={tradeSize}
                                    onChange={(e) => { setTradeSize(e.target.value); if (tradeState === "error") setTradeState("idle"); }}
                                    placeholder="0.00"
                                />
                                <span className="perp-input-unit">SOL</span>
                            </div>
                            <div className="perp-size-pct">
                                {[10, 25, 50, 75, 100].map((p) => (
                                    <button key={p} className="perp-pct-btn" onClick={() => setTradeSize(String((p * 10 / 100).toFixed(2)))}>
                                        {p}%
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="perp-field">
                            <div className="perp-lev-header">
                                <label>Leverage</label>
                                <span className="perp-lev-val">{leverage}x</span>
                            </div>
                            <input type="range" className="perp-slider" min={1} max={20} step={1} value={leverage} onChange={(e) => setLeverage(parseInt(e.target.value))} />
                            <div className="perp-lev-marks">
                                {[1, 5, 10, 15, 20].map((v) => (
                                    <button key={v} className={`perp-lev-mark ${leverage === v ? "active" : ""}`} onClick={() => setLeverage(v)}>{v}x</button>
                                ))}
                            </div>
                        </div>

                        {/* Balance indicator */}
                        {connected && (
                            <div className="perp-order-info" style={{ marginBottom: 8 }}>
                                <div className="perp-info-row">
                                    <span>Available Margin</span>
                                    <span>{(balance?.available_margin || 0).toFixed(4)} SOL</span>
                                </div>
                                <button
                                    className="perp-pct-btn"
                                    style={{ width: "100%", marginTop: 4, padding: "6px 0" }}
                                    onClick={() => setShowDepositModal(true)}
                                >
                                    Deposit / Withdraw
                                </button>
                            </div>
                        )}

                        <div className="perp-order-info">
                            <div className="perp-info-row">
                                <span>Notional Value</span>
                                <span>${notional.toFixed(2)}</span>
                            </div>
                            <div className="perp-info-row">
                                <span>Margin Required</span>
                                <span>${marginRequired.toFixed(2)}</span>
                            </div>
                            <div className="perp-info-row">
                                <span>Est. Liq. Price</span>
                                <span className="red">${liquidationPrice.toFixed(2)}</span>
                            </div>
                            <div className="perp-info-row">
                                <span>Trading Fee</span>
                                <span>{RISK_PARAMS.tradingFeeBps / 100}%</span>
                            </div>
                            <div className="perp-info-row sakura-fee">
                                <span>Sakura Fee</span>
                                <span>{TRADING_FEE_SAKURA.toLocaleString()} $SAKURA</span>
                            </div>
                        </div>

                        {!connected ? (
                            <button className="perp-execute-btn connect-btn" onClick={() => setVisible(true)}>
                                Connect Wallet
                            </button>
                        ) : tradeState === "paying_fee" || tradeState === "executing" ? (
                            <button className={`perp-execute-btn ${tradeSide}-btn`} disabled>
                                <span className="perp-spinner" />
                                {tradeState === "paying_fee" ? "Paying $SAKURA Fee..." : "Executing on Drift..."}
                            </button>
                        ) : tradeState === "success" ? (
                            <button className="perp-execute-btn success-btn" disabled>
                                Order Filled
                            </button>
                        ) : (
                            <>
                                {tradeState === "error" && <div className="perp-error">{tradeError}</div>}
                                <button
                                    className={`perp-execute-btn ${tradeSide}-btn`}
                                    onClick={handleTrade}
                                    disabled={sizeNum <= 0}
                                >
                                    {tradeSide === "long" ? "Buy / Long" : "Sell / Short"}
                                </button>
                            </>
                        )}
                    </div>

                    {/* Recent Trades */}
                    <div className="perp-recent-trades">
                        <div className="perp-panel-header">
                            <span>Recent Trades</span>
                        </div>
                        <div className="perp-rt-header">
                            <span>Price</span>
                            <span>Size</span>
                            <span>Time</span>
                        </div>
                        <div className="perp-rt-list">
                            {recentTrades.length > 0 ? recentTrades.map((t, i) => (
                                <div key={i} className="perp-rt-row">
                                    <span className={t.side === "buy" ? "green" : "red"}>{t.price.toFixed(2)}</span>
                                    <span>{t.size.toFixed(2)}</span>
                                    <span className="perp-rt-time">{t.time}</span>
                                </div>
                            )) : (
                                <div className="perp-ob-loading">Loading trades...</div>
                            )}
                        </div>
                    </div>
                </div>

                {/* ===== Bottom: Positions / Orders / History ===== */}
                <div className="perp-bottom">
                    <div className="perp-bottom-tabs">
                        <button className={`perp-bt-tab ${activeTab === "positions" ? "active" : ""}`} onClick={() => setActiveTab("positions")}>
                            Positions ({positions.length})
                        </button>
                        <button className={`perp-bt-tab ${activeTab === "orders" ? "active" : ""}`} onClick={() => setActiveTab("orders")}>
                            Open Orders (0)
                        </button>
                        <button className={`perp-bt-tab ${activeTab === "trades" ? "active" : ""}`} onClick={() => setActiveTab("trades")}>
                            Trade History ({tradeHistory.length})
                        </button>
                    </div>

                    {activeTab === "positions" && (
                        positions.length === 0 ? (
                            <div className="perp-empty">No open positions</div>
                        ) : (
                            <div className="perp-positions-table">
                                <div className="perp-pt-header">
                                    <span>Symbol</span>
                                    <span>Size</span>
                                    <span>Entry Price</span>
                                    <span>Mark Price</span>
                                    <span>PnL (ROE%)</span>
                                    <span>Margin</span>
                                    <span>Liq. Price</span>
                                    <span>Actions</span>
                                </div>
                                {positions.map((pos, i) => (
                                    <div key={i} className="perp-pt-row">
                                        <div className="perp-pt-symbol">
                                            <span className={`perp-pt-side ${pos.side}`}>{pos.side.toUpperCase()}</span>
                                            SOL-PERP
                                        </div>
                                        <span>{pos.size.toFixed(2)} SOL</span>
                                        <span>${pos.entryPrice.toFixed(2)}</span>
                                        <span>${pos.markPrice.toFixed(2)}</span>
                                        <span className={pos.pnl >= 0 ? "green" : "red"}>
                                            {pos.pnl >= 0 ? "+" : ""}${pos.pnl.toFixed(2)}
                                            <small> ({pos.pnlPercent >= 0 ? "+" : ""}{pos.pnlPercent.toFixed(2)}%)</small>
                                        </span>
                                        <span>${pos.margin.toFixed(2)} ({pos.leverage.toFixed(1)}x)</span>
                                        <span className="red">${pos.liquidationPrice.toFixed(2)}</span>
                                        <div className="perp-pt-actions">
                                            <button className="perp-close-btn" onClick={handleClose}>
                                                Close
                                            </button>
                                        </div>
                                    </div>
                                ))}

                                <div className="perp-pt-footer">
                                    <span>Total Unrealized PnL:</span>
                                    <span className={positions.reduce((s, p) => s + p.pnl, 0) >= 0 ? "green" : "red"}>
                                        {positions.reduce((s, p) => s + p.pnl, 0) >= 0 ? "+" : ""}
                                        ${positions.reduce((s, p) => s + p.pnl, 0).toFixed(2)}
                                    </span>
                                </div>
                            </div>
                        )
                    )}

                    {activeTab === "orders" && <div className="perp-empty">No open orders</div>}

                    {activeTab === "trades" && (
                        tradeHistory.length === 0 ? (
                            <div className="perp-empty">No trade history</div>
                        ) : (
                            <div className="perp-positions-table">
                                <div className="perp-pt-header">
                                    <span>Symbol</span>
                                    <span>Side</span>
                                    <span>Size</span>
                                    <span>Entry</span>
                                    <span>Exit</span>
                                    <span>PnL</span>
                                    <span>Status</span>
                                    <span>Date</span>
                                </div>
                                {tradeHistory.map((t) => (
                                    <div key={t.id} className="perp-pt-row">
                                        <span>SOL-PERP</span>
                                        <span className={t.side === "long" ? "green" : "red"}>{t.side.toUpperCase()}</span>
                                        <span>{t.size.toFixed(2)} SOL</span>
                                        <span>${t.entry_price?.toFixed(2) || "—"}</span>
                                        <span>${t.exit_price?.toFixed(2) || "—"}</span>
                                        <span className={(t.pnl || 0) >= 0 ? "green" : "red"}>
                                            {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}` : "—"}
                                        </span>
                                        <span>{t.status}</span>
                                        <span className="perp-rt-time">{new Date(t.created_at).toLocaleDateString()}</span>
                                    </div>
                                ))}
                            </div>
                        )
                    )}
                </div>

                {/* Powered by */}
                <div className="perp-powered">
                    <span className="perp-powered-dot" />
                    Powered by Drift Protocol on Solana · {TRADING_FEE_SAKURA.toLocaleString()} $SAKURA per trade
                </div>
            </main>

            <DepositWithdrawModal
                isOpen={showDepositModal}
                onClose={() => setShowDepositModal(false)}
                onBalanceUpdate={setBalance}
            />
        </>
    );
}
