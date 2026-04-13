import {
    Connection,
    Keypair,
    PublicKey,
} from "@solana/web3.js";
import {
    DriftClient,
    Wallet,
    BulkAccountLoader,
    PositionDirection,
    OrderType,
    MarketType,
    BN,
    BASE_PRECISION,
    PRICE_PRECISION,
    QUOTE_PRECISION,
    initialize,
    PerpMarketAccount,
    convertToNumber,
    getMarketOrderParams,
    PerpPosition,
} from "@drift-labs/sdk";
import bs58 from "bs58";

let driftClient: DriftClient | null = null;
let connection: Connection | null = null;

const SOL_PERP_MARKET_INDEX = 0;
const SOL_SPOT_MARKET_INDEX = 1; // SOL spot market for deposits
const USDC_SPOT_MARKET_INDEX = 0;

function getServerKeypair(): Keypair {
    const key = process.env.DRIFT_WALLET_KEY;
    if (!key) throw new Error("DRIFT_WALLET_KEY not set");
    return Keypair.fromSecretKey(bs58.decode(key));
}

function getConnection(): Connection {
    if (!connection) {
        const endpoint = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
        connection = new Connection(endpoint, "confirmed");
    }
    return connection;
}

export async function initDrift(): Promise<void> {
    const conn = getConnection();
    const keypair = getServerKeypair();
    const wallet = new Wallet(keypair);

    const sdkConfig = initialize({ env: "mainnet-beta" });

    const accountLoader = new BulkAccountLoader(conn, "confirmed", 5000);

    driftClient = new DriftClient({
        connection: conn,
        wallet,
        env: "mainnet-beta",
        accountSubscription: {
            type: "polling",
            accountLoader,
        },
    });

    await driftClient.subscribe();
}

export async function shutdownDrift(): Promise<void> {
    if (driftClient) {
        await driftClient.unsubscribe();
        driftClient = null;
    }
}

function getDrift(): DriftClient {
    if (!driftClient) throw new Error("Drift client not initialized");
    return driftClient;
}

// ============ Sub-account Management ============

export async function initializeSubAccount(subAccountId: number): Promise<string> {
    const dc = getDrift();
    const [txSig] = await dc.initializeUserAccount(subAccountId);
    return txSig;
}

export async function switchSubAccount(subAccountId: number): Promise<void> {
    const dc = getDrift();
    await dc.switchActiveUser(subAccountId);
}

// ============ Market Data ============

export interface DriftMarketState {
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

export async function getMarketState(): Promise<DriftMarketState> {
    const dc = getDrift();

    const perpMarket = dc.getPerpMarketAccount(SOL_PERP_MARKET_INDEX);
    if (!perpMarket) throw new Error("SOL-PERP market not found");

    const oracleData = dc.getOracleDataForPerpMarket(SOL_PERP_MARKET_INDEX);
    const oraclePrice = convertToNumber(oracleData.price, PRICE_PRECISION);

    const markPriceBN = dc.getPerpMarketAccount(SOL_PERP_MARKET_INDEX)!.amm.lastMarkPriceTwap;
    const markPrice = convertToNumber(markPriceBN, PRICE_PRECISION) || oraclePrice;

    // Funding rate: fundingRate is in quote/base, divide by oracle twap to get percentage
    const lastFundingRate = perpMarket.amm.lastFundingRate;
    const oracleTwap = perpMarket.amm.historicalOracleData.lastOraclePriceTwap;
    let fundingRatePct = 0;
    if (oracleTwap && !oracleTwap.isZero()) {
        fundingRatePct = convertToNumber(lastFundingRate, new BN(1e9)) /
            convertToNumber(oracleTwap, PRICE_PRECISION);
    }

    // Open interest in base asset amount (both longs and shorts)
    const baseAssetAmountLong = convertToNumber(
        perpMarket.amm.baseAssetAmountLong.abs(),
        BASE_PRECISION
    );
    const baseAssetAmountShort = convertToNumber(
        perpMarket.amm.baseAssetAmountShort.abs(),
        BASE_PRECISION
    );
    const openInterest = ((baseAssetAmountLong + baseAssetAmountShort) / 2) * oraclePrice;

    // Next funding timestamp
    const nextFundingTs = perpMarket.amm.nextFundingRateTs?.toNumber() || 0;

    // For 24h stats, use Drift's data API as fallback via CoinGecko
    let volume24h = 0;
    let high24h = oraclePrice;
    let low24h = oraclePrice;
    let change24h = 0;
    try {
        const cgRes = await fetch(
            "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true"
        );
        if (cgRes.ok) {
            const cgData = await cgRes.json();
            if (cgData.solana) {
                volume24h = cgData.solana.usd_24h_vol || 0;
                change24h = cgData.solana.usd_24h_change || 0;
                high24h = change24h > 0 ? oraclePrice : oraclePrice / (1 + change24h / 100);
                low24h = change24h < 0 ? oraclePrice : oraclePrice / (1 + change24h / 100);
            }
        }
    } catch { /* fallback to defaults */ }

    return {
        markPrice: Math.round(oraclePrice * 100) / 100,
        indexPrice: Math.round(oraclePrice * 100) / 100,
        fundingRate: fundingRatePct,
        nextFundingTs,
        openInterest: Math.round(openInterest),
        volume24h,
        high24h: Math.round(high24h * 100) / 100,
        low24h: Math.round(low24h * 100) / 100,
        change24h: Math.round(change24h * 100) / 100,
    };
}

// ============ Order Book (from Drift DLOB) ============

export interface OrderBookLevel {
    price: number;
    size: number;
    total: number;
}

export async function getOrderBook(): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] }> {
    try {
        const res = await fetch(
            `https://dlob.drift.trade/l2?marketIndex=${SOL_PERP_MARKET_INDEX}&marketType=perp&depth=12`
        );
        if (!res.ok) throw new Error("DLOB fetch failed");
        const data = await res.json();

        let bidTotal = 0;
        const bids: OrderBookLevel[] = (data.bids || []).slice(0, 12).map((b: any) => {
            const size = parseFloat(b.size) / 1e9;
            bidTotal += size;
            return {
                price: parseFloat(b.price) / 1e6,
                size: Math.round(size * 100) / 100,
                total: Math.round(bidTotal * 100) / 100,
            };
        });

        let askTotal = 0;
        const asks: OrderBookLevel[] = (data.asks || []).slice(0, 12).map((a: any) => {
            const size = parseFloat(a.size) / 1e9;
            askTotal += size;
            return {
                price: parseFloat(a.price) / 1e6,
                size: Math.round(size * 100) / 100,
                total: Math.round(askTotal * 100) / 100,
            };
        });

        return { bids, asks: asks.reverse() };
    } catch (err) {
        console.error("[drift] Order book fetch error:", err);
        return { bids: [], asks: [] };
    }
}

// ============ Recent Trades ============

export interface RecentTrade {
    price: number;
    size: number;
    side: "buy" | "sell";
    time: string;
    ts: number;
}

export async function getRecentTrades(): Promise<RecentTrade[]> {
    try {
        const res = await fetch(
            `https://data.api.drift.trade/trades/perpMarketTrades?marketIndex=${SOL_PERP_MARKET_INDEX}&limit=20`
        );
        if (!res.ok) throw new Error("Trades fetch failed");
        const data = await res.json();

        return (data.trades || data || []).slice(0, 20).map((t: any) => ({
            price: (parseFloat(t.quoteAssetAmountFilled || t.price) / 1e6) /
                (parseFloat(t.baseAssetAmountFilled || "1") / 1e9) || parseFloat(t.oraclePrice) / 1e6,
            size: parseFloat(t.baseAssetAmountFilled || t.size || "0") / 1e9,
            side: t.taker_order_direction === "long" || t.direction === "long" ? "buy" as const : "sell" as const,
            time: new Date(parseInt(t.ts) * 1000 || Date.now()).toLocaleTimeString([], {
                hour: "2-digit", minute: "2-digit", second: "2-digit",
            }),
            ts: parseInt(t.ts) || Math.floor(Date.now() / 1000),
        }));
    } catch (err) {
        console.error("[drift] Recent trades fetch error:", err);
        return [];
    }
}

// ============ Funding Rates ============

export async function getFundingRates(): Promise<{ rate: number; nextTs: number }> {
    try {
        const res = await fetch(
            `https://data.api.drift.trade/fundingRates?marketName=SOL-PERP`
        );
        if (!res.ok) throw new Error("Funding rate fetch failed");
        const data = await res.json();
        const rates = data.fundingRates || [];
        if (rates.length === 0) return { rate: 0, nextTs: 0 };

        const latest = rates[0];
        const fundingRatePct =
            (parseFloat(latest.fundingRate) / 1e9) /
            (parseFloat(latest.oraclePriceTwap) / 1e6);

        return { rate: fundingRatePct, nextTs: parseInt(latest.ts) || 0 };
    } catch {
        return { rate: 0, nextTs: 0 };
    }
}

// ============ Collateral / Deposit / Withdraw ============

export async function depositCollateral(
    subAccountId: number,
    amountSol: number
): Promise<string> {
    const dc = getDrift();
    await dc.switchActiveUser(subAccountId);

    const amountLamports = new BN(Math.round(amountSol * 1e9));
    const walletPubkey = dc.wallet.publicKey;

    const txSig = await dc.deposit(
        amountLamports,
        SOL_SPOT_MARKET_INDEX,
        walletPubkey,
        subAccountId,
    );

    return txSig as unknown as string;
}

export async function withdrawCollateral(
    subAccountId: number,
    amountSol: number
): Promise<string> {
    const dc = getDrift();
    await dc.switchActiveUser(subAccountId);

    const amountLamports = new BN(Math.round(amountSol * 1e9));
    const walletPubkey = dc.wallet.publicKey;

    const txSig = await dc.withdraw(
        amountLamports,
        SOL_SPOT_MARKET_INDEX,
        walletPubkey,
    );

    return txSig as unknown as string;
}

// ============ Trading ============

export interface TradeParams {
    side: "long" | "short";
    size: number; // SOL amount
    leverage: number;
    subAccountId: number;
}

export interface TradeResult {
    success: boolean;
    txSig?: string;
    error?: string;
}

export async function openPosition(params: TradeParams): Promise<TradeResult> {
    try {
        const dc = getDrift();
        await dc.switchActiveUser(params.subAccountId);

        const direction =
            params.side === "long" ? PositionDirection.LONG : PositionDirection.SHORT;

        const baseAmount = dc.convertToPerpPrecision(params.size);

        const oracleData = dc.getOracleDataForPerpMarket(SOL_PERP_MARKET_INDEX);
        const oraclePrice = oracleData.price;

        // Use a 0.3% slippage buffer for market orders
        const slippageBps = 30;
        const auctionStart = params.side === "long"
            ? oraclePrice.neg().divn(10000).muln(slippageBps).neg()
            : oraclePrice.divn(10000).muln(slippageBps);
        const auctionEnd = params.side === "long"
            ? oraclePrice.divn(10000).muln(slippageBps)
            : oraclePrice.neg().divn(10000).muln(slippageBps).neg();

        const orderParams = getMarketOrderParams({
            marketIndex: SOL_PERP_MARKET_INDEX,
            direction,
            baseAssetAmount: baseAmount,
            auctionStartPrice: auctionStart,
            auctionEndPrice: auctionEnd,
            auctionDuration: 60,
        });

        const txSig = await dc.placePerpOrder(orderParams);

        return { success: true, txSig: txSig as unknown as string };
    } catch (err: any) {
        console.error("[drift] openPosition error:", err);
        return { success: false, error: err.message || "Trade execution failed" };
    }
}

export async function closePosition(subAccountId: number): Promise<TradeResult> {
    try {
        const dc = getDrift();
        await dc.switchActiveUser(subAccountId);

        const user = dc.getUser();
        const position = user.getPerpPosition(SOL_PERP_MARKET_INDEX);
        if (!position || position.baseAssetAmount.isZero()) {
            return { success: false, error: "No open position to close" };
        }

        const isLong = position.baseAssetAmount.gt(new BN(0));
        const direction = isLong ? PositionDirection.SHORT : PositionDirection.LONG;
        const baseAmount = position.baseAssetAmount.abs();

        const orderParams = getMarketOrderParams({
            marketIndex: SOL_PERP_MARKET_INDEX,
            direction,
            baseAssetAmount: baseAmount,
            reduceOnly: true,
        });

        const txSig = await dc.placePerpOrder(orderParams);

        return { success: true, txSig: txSig as unknown as string };
    } catch (err: any) {
        console.error("[drift] closePosition error:", err);
        return { success: false, error: err.message || "Close failed" };
    }
}

// ============ Position Info ============

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

export async function getPosition(subAccountId: number): Promise<PositionInfo> {
    const dc = getDrift();
    await dc.switchActiveUser(subAccountId);

    const user = dc.getUser();
    const position = user.getPerpPosition(SOL_PERP_MARKET_INDEX);

    if (!position || position.baseAssetAmount.isZero()) {
        return {
            hasPosition: false,
            side: "none",
            size: 0,
            notional: 0,
            entryPrice: 0,
            markPrice: 0,
            pnl: 0,
            pnlPercent: 0,
            margin: 0,
            leverage: 0,
            liquidationPrice: 0,
        };
    }

    const oracleData = dc.getOracleDataForPerpMarket(SOL_PERP_MARKET_INDEX);
    const markPrice = convertToNumber(oracleData.price, PRICE_PRECISION);

    const isLong = position.baseAssetAmount.gt(new BN(0));
    const size = Math.abs(convertToNumber(position.baseAssetAmount, BASE_PRECISION));
    const notional = size * markPrice;

    // Entry price from quoteEntryAmount / baseAssetAmount
    let entryPrice = 0;
    if (!position.baseAssetAmount.isZero()) {
        entryPrice = Math.abs(
            convertToNumber(position.quoteEntryAmount, QUOTE_PRECISION) /
            convertToNumber(position.baseAssetAmount, BASE_PRECISION)
        );
    }

    // Unrealized PnL
    const pnl = isLong
        ? (markPrice - entryPrice) * size
        : (entryPrice - markPrice) * size;

    // Margin / collateral from user account
    const totalCollateral = convertToNumber(
        user.getTotalCollateral(),
        QUOTE_PRECISION
    );

    const leverage = totalCollateral > 0 ? notional / totalCollateral : 0;
    const pnlPercent = totalCollateral > 0 ? (pnl / totalCollateral) * 100 : 0;

    // Approximate liquidation price
    const maintenanceMargin = 0.05; // 5%
    let liquidationPrice = 0;
    if (size > 0) {
        if (isLong) {
            liquidationPrice = entryPrice * (1 - (totalCollateral / notional) + maintenanceMargin);
        } else {
            liquidationPrice = entryPrice * (1 + (totalCollateral / notional) - maintenanceMargin);
        }
    }

    return {
        hasPosition: true,
        side: isLong ? "long" : "short",
        size: Math.round(size * 1000) / 1000,
        notional: Math.round(notional * 100) / 100,
        entryPrice: Math.round(entryPrice * 100) / 100,
        markPrice: Math.round(markPrice * 100) / 100,
        pnl: Math.round(pnl * 100) / 100,
        pnlPercent: Math.round(pnlPercent * 100) / 100,
        margin: Math.round(totalCollateral * 100) / 100,
        leverage: Math.round(leverage * 10) / 10,
        liquidationPrice: Math.round(liquidationPrice * 100) / 100,
    };
}

export function getServerWalletAddress(): string {
    return getServerKeypair().publicKey.toBase58();
}
