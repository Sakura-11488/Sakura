"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Header from "@/components/Header";
import PerpChart from "@/components/PerpChart";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSakuraWalletModal } from "@/components/SakuraWalletModal";
import {
    activatePhoenixWithReferral,
    fetchPhoenixMarketState,
    fetchPhoenixOrderBook,
    fetchPhoenixRecentTrades,
    fetchPhoenixTraderData,
    closePhoenixPosition,
    executePhoenixOrder,
    getDefaultPhoenixSymbol,
    getPhoenixReferralCode,
    isPhoenixActivatedCached,
    subscribePhoenixLiveData,
    type PhoenixMarketState,
    type PhoenixOrderBook,
    type PhoenixOrderType,
    type PhoenixPositionInfo,
    type PhoenixRecentTrade,
    type PhoenixSide,
    type PhoenixTraderData,
} from "@/lib/phoenix";

type TradeTab = "chart" | "trade" | "book" | "portfolio";
type TradeState = "idle" | "activating" | "executing" | "success" | "error";
type WsStatus = "connecting" | "open" | "closed" | "error";

const DEFAULT_MARKET: PhoenixMarketState = {
    symbol: getDefaultPhoenixSymbol(),
    displaySymbol: `${getDefaultPhoenixSymbol()}-PERP`,
    markPrice: 0,
    indexPrice: 0,
    midPrice: 0,
    fundingRate: 0,
    nextFundingTs: 0,
    openInterest: 0,
    volume24h: 0,
    high24h: 0,
    low24h: 0,
    change24h: 0,
    maxLeverage: 15,
    takerFee: 0.00035,
    makerFee: 0.00005,
    active: false,
};

function formatUsd(value: number): string {
    if (!Number.isFinite(value)) return "$0.00";
    if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
    if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatNumber(value: number, decimals = 2): string {
    if (!Number.isFinite(value)) return "0";
    return value.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function formatFunding(seconds: number): string {
    const safe = Math.max(0, seconds);
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    const s = safe % 60;
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function getOrderButtonLabel(state: TradeState, side: PhoenixSide, orderType: PhoenixOrderType): string {
    if (state === "executing") return "Sending to Phoenix...";
    if (state === "success") return "Order sent";
    const action = side === "long" ? "Buy / Long" : "Sell / Short";
    return `${action} ${orderType === "limit" ? "Limit" : "Market"}`;
}

function positionCloseSide(position: PhoenixPositionInfo): PhoenixSide {
    return position.side === "long" ? "short" : "long";
}

export default function TradePage() {
    const { publicKey, connected, sendTransaction } = useWallet();
    const { setVisible } = useSakuraWalletModal();
    const walletAddress = publicKey?.toBase58() || "";
    const symbol = getDefaultPhoenixSymbol();

    const [activeTab, setActiveTab] = useState<TradeTab>("trade");
    const [market, setMarket] = useState<PhoenixMarketState>(DEFAULT_MARKET);
    const [orderBook, setOrderBook] = useState<PhoenixOrderBook>({ bids: [], asks: [], midPrice: 0 });
    const [recentTrades, setRecentTrades] = useState<PhoenixRecentTrade[]>([]);
    const [traderData, setTraderData] = useState<PhoenixTraderData | null>(null);
    const [loading, setLoading] = useState(true);
    const [wsStatus, setWsStatus] = useState<WsStatus>("closed");
    const [priceFlash, setPriceFlash] = useState<"up" | "down" | null>(null);
    const [fundingCountdown, setFundingCountdown] = useState(3600);
    const [side, setSide] = useState<PhoenixSide>("long");
    const [orderType, setOrderType] = useState<PhoenixOrderType>("market");
    const [quantity, setQuantity] = useState("");
    const [limitPrice, setLimitPrice] = useState("");
    const [leverage, setLeverage] = useState(5);
    const [postOnly, setPostOnly] = useState(false);
    const [reduceOnly, setReduceOnly] = useState(false);
    const [takeProfit, setTakeProfit] = useState("");
    const [stopLoss, setStopLoss] = useState("");
    const [tradeState, setTradeState] = useState<TradeState>("idle");
    const [tradeMessage, setTradeMessage] = useState("");
    const [activationMessage, setActivationMessage] = useState("");
    const prevMarkRef = useRef(0);

    const notional = (parseFloat(quantity) || 0) * market.markPrice;
    const marginEstimate = leverage > 0 ? notional / leverage : 0;
    const maxDepth = Math.max(
        ...orderBook.bids.map(level => level.total),
        ...orderBook.asks.map(level => level.total),
        1
    );

    const isActivated = useMemo(() => {
        if (!walletAddress) return false;
        return traderData?.isActivated || isPhoenixActivatedCached(walletAddress);
    }, [traderData?.isActivated, walletAddress]);

    const loadMarket = useCallback(async () => {
        const [marketState, book, trades] = await Promise.all([
            fetchPhoenixMarketState(symbol),
            fetchPhoenixOrderBook(symbol),
            fetchPhoenixRecentTrades(symbol),
        ]);
        setMarket(prev => ({ ...prev, ...marketState }));
        setOrderBook(book);
        setRecentTrades(trades);
        setFundingCountdown(Math.max(0, marketState.nextFundingTs - Math.floor(Date.now() / 1000)));
    }, [symbol]);

    const loadTrader = useCallback(async () => {
        if (!walletAddress) {
            setTraderData(null);
            return;
        }
        const data = await fetchPhoenixTraderData(walletAddress, market.markPrice);
        setTraderData(data);
    }, [market.markPrice, walletAddress]);

    useEffect(() => {
        let cancelled = false;
        async function boot() {
            setLoading(true);
            try {
                await loadMarket();
                if (!cancelled) await loadTrader();
            } catch (error) {
                console.error("[PhoenixTrade] initial load failed", error);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        void boot();
        return () => { cancelled = true; };
    }, [loadMarket, loadTrader]);

    useEffect(() => {
        const stop = subscribePhoenixLiveData({
            symbol,
            timeframe: "1m",
            authority: walletAddress || null,
            handlers: {
                onStatus: setWsStatus,
                onMarket: update => {
                    setMarket(prev => {
                        const next = { ...prev, ...update };
                        if (prevMarkRef.current && update.markPrice && update.markPrice !== prevMarkRef.current) {
                            setPriceFlash(update.markPrice > prevMarkRef.current ? "up" : "down");
                            window.setTimeout(() => setPriceFlash(null), 350);
                        }
                        if (update.markPrice) prevMarkRef.current = update.markPrice;
                        return next;
                    });
                },
                onOrderBook: setOrderBook,
                onTrades: trades => setRecentTrades(prev => [...trades, ...prev].slice(0, 30)),
                onTraderState: () => void loadTrader(),
            },
        });
        return stop;
    }, [loadTrader, symbol, walletAddress]);

    useEffect(() => {
        const interval = window.setInterval(() => {
            setFundingCountdown(prev => (prev <= 0 ? 3600 : prev - 1));
        }, 1000);
        return () => window.clearInterval(interval);
    }, []);

    const handleActivate = async () => {
        if (!connected || !walletAddress) {
            setVisible(true);
            return;
        }
        setTradeState("activating");
        setActivationMessage("");
        try {
            await activatePhoenixWithReferral(walletAddress);
            setActivationMessage("Phoenix trading activated for this wallet.");
            await loadTrader();
            setTradeState("idle");
        } catch (error) {
            setTradeState("error");
            setActivationMessage(error instanceof Error ? error.message : "Phoenix activation failed");
        }
    };

    const handleSubmitOrder = async () => {
        if (!connected || !publicKey || !sendTransaction) {
            setVisible(true);
            return;
        }
        const size = parseFloat(quantity);
        if (!Number.isFinite(size) || size <= 0) {
            setTradeState("error");
            setTradeMessage("Enter a valid order size.");
            return;
        }
        if (orderType === "limit" && (!limitPrice || parseFloat(limitPrice) <= 0)) {
            setTradeState("error");
            setTradeMessage("Enter a valid limit price.");
            return;
        }
        if (!isActivated) {
            setTradeState("error");
            setTradeMessage("Activate Phoenix trading before placing orders.");
            return;
        }

        setTradeState("executing");
        setTradeMessage("");
        try {
            const result = await executePhoenixOrder(
                {
                    authority: walletAddress,
                    symbol,
                    side,
                    orderType,
                    quantity: size,
                    price: orderType === "limit" ? parseFloat(limitPrice) : undefined,
                    postOnly,
                    reduceOnly,
                    transferAmount: Math.max(0, marginEstimate),
                    takeProfitPrice: takeProfit ? parseFloat(takeProfit) : undefined,
                    stopLossPrice: stopLoss ? parseFloat(stopLoss) : undefined,
                },
                { publicKey, sendTransaction }
            );
            setTradeState("success");
            setTradeMessage(`Phoenix order sent: ${result.signature.slice(0, 8)}...${result.signature.slice(-8)}`);
            setQuantity("");
            await loadTrader();
        } catch (error) {
            setTradeState("error");
            setTradeMessage(error instanceof Error ? error.message : "Phoenix order failed");
        }
    };

    const handleClosePosition = async (position: PhoenixPositionInfo) => {
        if (!publicKey || !sendTransaction || !walletAddress) {
            setVisible(true);
            return;
        }
        setTradeState("executing");
        setTradeMessage("");
        try {
            const result = await closePhoenixPosition(
                {
                    authority: walletAddress,
                    symbol: position.market,
                    side: positionCloseSide(position),
                    quantity: position.size,
                },
                { publicKey, sendTransaction }
            );
            setTradeState("success");
            setTradeMessage(`Close order sent: ${result.signature.slice(0, 8)}...${result.signature.slice(-8)}`);
            await loadTrader();
        } catch (error) {
            setTradeState("error");
            setTradeMessage(error instanceof Error ? error.message : "Close order failed");
        }
    };

    return (
        <>
            <Header />
            <main className="main-content perp-page phoenix-page">
                <section className="perp-market-bar phoenix-market-bar">
                    <div className="perp-pair">
                        <div className="perp-pair-icon">◎</div>
                        <div>
                            <span className="perp-pair-name">{market.displaySymbol}</span>
                            <span className="perp-pair-badge">Phoenix</span>
                        </div>
                    </div>
                    <div className={`perp-mark-price ${priceFlash ? `flash-${priceFlash}` : ""}`}>
                        {market.markPrice > 0 ? formatUsd(market.markPrice) : loading ? "Loading..." : "$0.00"}
                    </div>
                    <div className="perp-stats-row">
                        <div className="perp-stat-pill">
                            <span className="perp-stat-k">Index</span>
                            <span className="perp-stat-v">{formatUsd(market.indexPrice)}</span>
                        </div>
                        <div className="perp-stat-pill">
                            <span className="perp-stat-k">24h</span>
                            <span className={`perp-stat-v ${market.change24h >= 0 ? "green" : "red"}`}>
                                {market.change24h >= 0 ? "+" : ""}{market.change24h.toFixed(2)}%
                            </span>
                        </div>
                        <div className="perp-stat-pill">
                            <span className="perp-stat-k">Funding</span>
                            <span className={`perp-stat-v ${market.fundingRate >= 0 ? "green" : "red"}`}>
                                {(market.fundingRate * 100).toFixed(4)}%
                            </span>
                        </div>
                        <div className="perp-stat-pill">
                            <span className="perp-stat-k">Next</span>
                            <span className="perp-stat-v">{formatFunding(fundingCountdown)}</span>
                        </div>
                        <div className="perp-stat-pill">
                            <span className="perp-stat-k">WS</span>
                            <span className={`perp-stat-v ${wsStatus === "open" ? "green" : "red"}`}>{wsStatus}</span>
                        </div>
                    </div>
                </section>

                <nav className="phoenix-tabs" aria-label="Phoenix trading tabs">
                    {(["chart", "trade", "book", "portfolio"] as TradeTab[]).map(tab => (
                        <button
                            key={tab}
                            className={`phoenix-tab ${activeTab === tab ? "active" : ""}`}
                            onClick={() => setActiveTab(tab)}
                        >
                            {tab[0].toUpperCase() + tab.slice(1)}
                        </button>
                    ))}
                </nav>

                <section className="phoenix-terminal">
                    {activeTab === "chart" && (
                        <div className="phoenix-panel phoenix-chart-panel">
                            <PerpChart markPrice={market.markPrice} change24h={market.change24h} symbol={symbol} />
                        </div>
                    )}

                    {activeTab === "trade" && (
                        <div className="phoenix-panel phoenix-trade-panel">
                            {!connected ? (
                                <div className="phoenix-empty">
                                    <h2>Connect your wallet</h2>
                                    <p>Use your Sakura wallet to activate Phoenix and trade {market.displaySymbol}.</p>
                                    <button className="btn-primary" onClick={() => setVisible(true)}>Connect wallet</button>
                                </div>
                            ) : !isActivated ? (
                                <div className="phoenix-empty">
                                    <h2>Activate Phoenix trading</h2>
                                    <p>
                                        Phoenix is private beta. Sakura will activate your wallet using the configured referral code.
                                        {getPhoenixReferralCode() ? "" : " Add NEXT_PUBLIC_PHOENIX_REFERRAL_CODE before live trading."}
                                    </p>
                                    {activationMessage && <div className="perp-error">{activationMessage}</div>}
                                    <button
                                        className="btn-primary"
                                        disabled={tradeState === "activating"}
                                        onClick={() => void handleActivate()}
                                    >
                                        {tradeState === "activating" ? "Activating..." : "Activate Phoenix"}
                                    </button>
                                </div>
                            ) : (
                                <>
                                    <div className="perp-side-toggle">
                                        <button className={`perp-side-btn ${side === "long" ? "active-long" : ""}`} onClick={() => setSide("long")}>Long</button>
                                        <button className={`perp-side-btn ${side === "short" ? "active-short" : ""}`} onClick={() => setSide("short")}>Short</button>
                                    </div>
                                    <div className="perp-type-toggle">
                                        <button className={`perp-type-btn ${orderType === "market" ? "active" : ""}`} onClick={() => setOrderType("market")}>Market</button>
                                        <button className={`perp-type-btn ${orderType === "limit" ? "active" : ""}`} onClick={() => setOrderType("limit")}>Limit</button>
                                    </div>

                                    <div className="perp-field">
                                        <label>Order size</label>
                                        <div className="perp-input-row">
                                            <input className="perp-input" inputMode="decimal" value={quantity} onChange={event => setQuantity(event.target.value)} placeholder="0.00" />
                                            <span className="perp-input-unit">{symbol}</span>
                                        </div>
                                    </div>
                                    {orderType === "limit" && (
                                        <div className="perp-field">
                                            <label>Limit price</label>
                                            <div className="perp-input-row">
                                                <input className="perp-input" inputMode="decimal" value={limitPrice} onChange={event => setLimitPrice(event.target.value)} placeholder={market.markPrice.toFixed(2)} />
                                                <span className="perp-input-unit">USDC</span>
                                            </div>
                                        </div>
                                    )}

                                    <div className="perp-field">
                                        <label>Display leverage</label>
                                        <input className="perp-slider" type="range" min="1" max={market.maxLeverage || 15} value={leverage} onChange={event => setLeverage(Number(event.target.value))} />
                                        <div className="perp-slider-labels"><span>1x</span><strong>{leverage}x</strong><span>{market.maxLeverage || 15}x</span></div>
                                    </div>

                                    <div className="perp-checkbox-row">
                                        <label><input type="checkbox" checked={reduceOnly} onChange={event => setReduceOnly(event.target.checked)} /> Reduce only</label>
                                        <label><input type="checkbox" checked={postOnly} onChange={event => setPostOnly(event.target.checked)} disabled={orderType !== "limit"} /> Post only</label>
                                    </div>

                                    <div className="phoenix-advanced-row">
                                        <div className="perp-field">
                                            <label>Take profit (optional)</label>
                                            <input className="perp-input" inputMode="decimal" value={takeProfit} onChange={event => setTakeProfit(event.target.value)} placeholder="Phase C" />
                                        </div>
                                        <div className="perp-field">
                                            <label>Stop loss (optional)</label>
                                            <input className="perp-input" inputMode="decimal" value={stopLoss} onChange={event => setStopLoss(event.target.value)} placeholder="Phase C" />
                                        </div>
                                    </div>

                                    <div className="perp-order-info">
                                        <div className="perp-info-row"><span>Notional</span><strong>{formatUsd(notional)}</strong></div>
                                        <div className="perp-info-row"><span>Margin estimate</span><strong>{formatUsd(marginEstimate)}</strong></div>
                                        <div className="perp-info-row"><span>Taker fee</span><strong>{(market.takerFee * 100).toFixed(3)}%</strong></div>
                                        <div className="perp-info-row"><span>Collateral</span><strong>{formatUsd(traderData?.balance.collateral || 0)} USDC</strong></div>
                                    </div>

                                    {tradeMessage && <div className={tradeState === "error" ? "perp-error" : "perp-success"}>{tradeMessage}</div>}
                                    {(takeProfit || stopLoss) && (
                                        <div className="perp-warning">Phoenix TP/SL will be attached when the selected order builder supports conditional order config.</div>
                                    )}

                                    <button
                                        className={`perp-execute-btn ${side}-btn`}
                                        disabled={tradeState === "executing"}
                                        onClick={() => void handleSubmitOrder()}
                                    >
                                        {getOrderButtonLabel(tradeState, side, orderType)}
                                    </button>
                                </>
                            )}
                        </div>
                    )}

                    {activeTab === "book" && (
                        <div className="phoenix-panel phoenix-book-panel">
                            <div className="perp-panel-header"><span>Order Book</span><span>{market.displaySymbol}</span></div>
                            <div className="perp-ob-header-row"><span>Price</span><span>Size</span><span>Total</span></div>
                            <div className="phoenix-book-stack">
                                <div className="perp-ob-asks">
                                    {orderBook.asks.slice().reverse().map((level, index) => (
                                        <button key={`a${index}`} className="perp-ob-row ask" onClick={() => { setLimitPrice(String(level.price)); setOrderType("limit"); setActiveTab("trade"); }}>
                                            <div className="perp-ob-depth ask" style={{ width: `${(level.total / maxDepth) * 100}%` }} />
                                            <span className="perp-ob-price red">{level.price.toFixed(2)}</span>
                                            <span className="perp-ob-size">{formatNumber(level.size, 3)}</span>
                                            <span className="perp-ob-total">{formatNumber(level.total, 2)}</span>
                                        </button>
                                    ))}
                                </div>
                                <div className="perp-ob-mid">{formatUsd(market.midPrice || market.markPrice)}</div>
                                <div className="perp-ob-bids">
                                    {orderBook.bids.map((level, index) => (
                                        <button key={`b${index}`} className="perp-ob-row bid" onClick={() => { setLimitPrice(String(level.price)); setOrderType("limit"); setActiveTab("trade"); }}>
                                            <div className="perp-ob-depth bid" style={{ width: `${(level.total / maxDepth) * 100}%` }} />
                                            <span className="perp-ob-price green">{level.price.toFixed(2)}</span>
                                            <span className="perp-ob-size">{formatNumber(level.size, 3)}</span>
                                            <span className="perp-ob-total">{formatNumber(level.total, 2)}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="perp-recent-trades">
                                <div className="perp-panel-header"><span>Recent Trades</span></div>
                                {recentTrades.slice(0, 12).map(trade => (
                                    <div key={trade.ts} className="perp-trade-row">
                                        <span className={trade.side === "buy" ? "green" : "red"}>{trade.price.toFixed(2)}</span>
                                        <span>{formatNumber(trade.size, 3)}</span>
                                        <span>{trade.time}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {activeTab === "portfolio" && (
                        <div className="phoenix-panel phoenix-portfolio-panel">
                            {!connected ? (
                                <div className="phoenix-empty">Connect your wallet to view Phoenix portfolio state.</div>
                            ) : (
                                <>
                                    <div className="phoenix-balance-grid">
                                        <div><span>Collateral</span><strong>{formatUsd(traderData?.balance.collateral || 0)}</strong></div>
                                        <div><span>Available</span><strong>{formatUsd(traderData?.balance.availableMargin || 0)}</strong></div>
                                        <div><span>uPnL</span><strong>{formatUsd(traderData?.balance.unrealizedPnl || 0)}</strong></div>
                                        <div><span>Risk</span><strong>{traderData?.balance.riskState || "unknown"}</strong></div>
                                    </div>

                                    <div className="perp-bottom-section">
                                        <h3>Position</h3>
                                        {traderData?.position?.hasPosition ? (
                                            <div className={`perp-position-card ${traderData.position.side}`}>
                                                <div className="perp-pos-header">
                                                    <strong>{traderData.position.side.toUpperCase()} {traderData.position.market}-PERP</strong>
                                                    <span>{formatNumber(traderData.position.leverage, 1)}x</span>
                                                </div>
                                                <div className="perp-pos-grid">
                                                    <div><span>Size</span><strong>{formatNumber(traderData.position.size, 4)}</strong></div>
                                                    <div><span>Entry</span><strong>{formatUsd(traderData.position.entryPrice)}</strong></div>
                                                    <div><span>PnL</span><strong className={traderData.position.pnl >= 0 ? "green" : "red"}>{formatUsd(traderData.position.pnl)}</strong></div>
                                                    <div><span>Liq</span><strong>{traderData.position.liquidationPrice ? formatUsd(traderData.position.liquidationPrice) : "-"}</strong></div>
                                                </div>
                                                <button className="perp-close-btn" disabled={tradeState === "executing"} onClick={() => void handleClosePosition(traderData.position!)}>
                                                    Close position
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="perp-empty">No open Phoenix position.</div>
                                        )}
                                    </div>

                                    <div className="perp-bottom-section">
                                        <h3>Open Orders</h3>
                                        {traderData?.openOrders.length ? traderData.openOrders.map(order => (
                                            <div key={order.id} className="phoenix-order-row">
                                                <span>{order.side}</span>
                                                <strong>{formatNumber(order.size, 4)} {order.market}</strong>
                                                <span>{formatUsd(order.price)}</span>
                                            </div>
                                        )) : <div className="perp-empty">No open limit orders.</div>}
                                    </div>

                                    <div className="perp-bottom-section">
                                        <h3>Trade History</h3>
                                        {traderData?.trades.length ? traderData.trades.slice(0, 10).map(trade => (
                                            <div key={trade.id} className="phoenix-order-row">
                                                <span>{trade.side}</span>
                                                <strong>{formatNumber(trade.size, 4)} {trade.market}</strong>
                                                <span>{formatUsd(trade.price)}</span>
                                            </div>
                                        )) : <div className="perp-empty">No Phoenix trade history.</div>}
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </section>
            </main>
        </>
    );
}
