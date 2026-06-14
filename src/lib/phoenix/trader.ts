import { getPhoenixHttpClient, normalizePhoenixSymbol } from "./client";
import type {
    PhoenixBalanceInfo,
    PhoenixOpenOrder,
    PhoenixPositionInfo,
    PhoenixTradeRecord,
    PhoenixTraderData,
} from "./types";

type TokenAmountLike = { ui?: string; value?: string | number; decimals?: number };
type TraderPositionLike = {
    symbol?: string;
    marketSymbol?: string;
    side?: string;
    baseLots?: string | number;
    baseUnits?: string | number;
    size?: string | number;
    entryPrice?: string | number;
    markPrice?: string | number;
    pnl?: string | number;
    unrealizedPnl?: string | number;
    margin?: string | number;
    liquidationPrice?: string | number;
};
type TraderSubaccountLike = {
    collateral?: string | number;
    positions?: TraderPositionLike[];
    orders?: Array<Record<string, unknown>>;
};
type TraderStateLike = {
    riskState?: string;
    collateralBalance?: TokenAmountLike;
    effectiveCollateral?: TokenAmountLike;
    maintenanceMargin?: TokenAmountLike;
    initialMargin?: TokenAmountLike;
    unrealizedPnl?: TokenAmountLike;
    traders?: Array<{
        state?: string;
        collateralBalance?: TokenAmountLike;
        effectiveCollateral?: TokenAmountLike;
        maintenanceMargin?: TokenAmountLike;
        initialMargin?: TokenAmountLike;
        unrealizedPnl?: TokenAmountLike;
        riskState?: string;
        positions?: TraderPositionLike[];
        orders?: Array<Record<string, unknown>>;
    }>;
    snapshot?: {
        capabilities?: { state?: string };
        subaccounts?: TraderSubaccountLike[];
    };
};
type HistoryResponse = { data?: Array<Record<string, unknown>> };

function toNumber(value: unknown, fallback = 0): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function tokenUi(value: TokenAmountLike | undefined): number {
    if (!value) return 0;
    if (typeof value.ui === "string") return toNumber(value.ui);
    const decimals = toNumber(value.decimals);
    const raw = toNumber(value.value);
    return decimals > 0 ? raw / 10 ** decimals : raw;
}

function normalizePosition(position: TraderPositionLike | undefined, markPrice: number): PhoenixPositionInfo | null {
    if (!position) return null;
    const size = Math.abs(toNumber(position.baseUnits ?? position.size ?? position.baseLots));
    if (size <= 0) return null;

    const sideText = String(position.side || "").toLowerCase();
    const side = sideText.includes("ask") || sideText.includes("short") ? "short" : "long";
    const entryPrice = toNumber(position.entryPrice, markPrice);
    const pnl = toNumber(position.pnl ?? position.unrealizedPnl);
    const notional = size * markPrice;
    const margin = toNumber(position.margin, notional > 0 ? notional / 5 : 0);

    return {
        hasPosition: true,
        side,
        size,
        notional,
        entryPrice,
        markPrice,
        pnl,
        pnlPercent: margin > 0 ? (pnl / margin) * 100 : 0,
        margin,
        leverage: margin > 0 ? notional / margin : 0,
        liquidationPrice: toNumber(position.liquidationPrice),
        market: normalizePhoenixSymbol(position.symbol || position.marketSymbol || "SOL"),
    };
}

function normalizeOrder(order: Record<string, unknown>, index: number): PhoenixOpenOrder {
    return {
        id: String(order.orderId ?? order.id ?? order.orderSequenceNumber ?? index),
        market: normalizePhoenixSymbol(String(order.symbol ?? order.marketSymbol ?? "SOL")),
        side: String(order.side ?? "unknown"),
        price: toNumber(order.price ?? order.priceUsd),
        size: Math.abs(toNumber(order.size ?? order.quantity ?? order.baseUnits ?? order.baseLots)),
        reduceOnly: Boolean(order.reduceOnly ?? order.isReduceOnly),
    };
}

function normalizeTrade(row: Record<string, unknown>, index: number): PhoenixTradeRecord {
    const size = toNumber(row.baseQty ?? row.baseAmount ?? row.quantity ?? row.size);
    return {
        id: String(row.id ?? row.transactionSignature ?? index),
        market: normalizePhoenixSymbol(String(row.marketSymbol ?? row.symbol ?? "SOL")),
        side: String(row.side ?? (size >= 0 ? "buy" : "sell")),
        size: Math.abs(size),
        price: toNumber(row.price),
        pnl: row.pnl == null ? null : toNumber(row.pnl),
        status: String(row.status ?? "filled"),
        createdAt: new Date(toNumber(row.timestamp ?? row.createdAt ?? Date.now())).toISOString(),
        txSig: typeof row.transactionSignature === "string" ? row.transactionSignature : undefined,
    };
}

export async function fetchPhoenixTraderData(wallet: string, markPrice = 0): Promise<PhoenixTraderData> {
    const client = getPhoenixHttpClient();
    const [stateResult, snapshotResult, tradesResult, ordersResult] = await Promise.allSettled([
        client.traders().getTraderState(wallet) as unknown as Promise<TraderStateLike>,
        client.traders().getTraderStateSnapshot(wallet) as unknown as Promise<TraderStateLike>,
        client.trades().getTraderTradesHistory(wallet, { limit: 30 }) as unknown as Promise<HistoryResponse>,
        client.orders().getTraderOrderHistory(wallet, { limit: 30 }) as unknown as Promise<HistoryResponse>,
    ]);

    const state = stateResult.status === "fulfilled" ? stateResult.value : null;
    const snapshot = snapshotResult.status === "fulfilled" ? snapshotResult.value : null;
    const firstTrader = state?.traders?.[0];
    const firstSubaccount = snapshot?.snapshot?.subaccounts?.[0];
    const positions = firstTrader?.positions || firstSubaccount?.positions || [];
    const openOrders = firstTrader?.orders || firstSubaccount?.orders || [];
    const position = normalizePosition(positions[0], markPrice);
    const collateral = tokenUi(firstTrader?.collateralBalance ?? state?.collateralBalance);
    const effectiveCollateral = tokenUi(firstTrader?.effectiveCollateral ?? state?.effectiveCollateral);
    const unrealizedPnl = tokenUi(firstTrader?.unrealizedPnl ?? state?.unrealizedPnl);
    const riskState = firstTrader?.riskState || state?.riskState || snapshot?.snapshot?.capabilities?.state || "unknown";

    return {
        balance: {
            wallet,
            collateral,
            availableMargin: Math.max(0, effectiveCollateral - tokenUi(firstTrader?.initialMargin ?? state?.initialMargin)),
            effectiveCollateral,
            maintenanceMargin: tokenUi(firstTrader?.maintenanceMargin ?? state?.maintenanceMargin),
            initialMargin: tokenUi(firstTrader?.initialMargin ?? state?.initialMargin),
            unrealizedPnl,
            riskState,
        },
        position,
        openOrders: openOrders.map(normalizeOrder),
        trades: tradesResult.status === "fulfilled"
            ? (tradesResult.value.data || []).map(normalizeTrade)
            : [],
        isActivated: riskState !== "unknown",
    };
}
