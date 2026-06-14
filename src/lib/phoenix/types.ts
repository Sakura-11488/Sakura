export type PhoenixSide = "long" | "short";
export type PhoenixOrderType = "market" | "limit";

export interface PhoenixMarketState {
    symbol: string;
    displaySymbol: string;
    markPrice: number;
    indexPrice: number;
    midPrice: number;
    fundingRate: number;
    nextFundingTs: number;
    openInterest: number;
    volume24h: number;
    high24h: number;
    low24h: number;
    change24h: number;
    maxLeverage: number;
    takerFee: number;
    makerFee: number;
    active: boolean;
}

export interface PhoenixOrderBookLevel {
    price: number;
    size: number;
    total: number;
}

export interface PhoenixOrderBook {
    bids: PhoenixOrderBookLevel[];
    asks: PhoenixOrderBookLevel[];
    midPrice: number;
}

export interface PhoenixRecentTrade {
    price: number;
    size: number;
    side: "buy" | "sell";
    time: string;
    ts: number;
}

export interface PhoenixCandle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

export interface PhoenixPositionInfo {
    hasPosition: boolean;
    side: PhoenixSide | "none";
    size: number;
    notional: number;
    entryPrice: number;
    markPrice: number;
    pnl: number;
    pnlPercent: number;
    margin: number;
    leverage: number;
    liquidationPrice: number;
    market: string;
}

export interface PhoenixBalanceInfo {
    wallet: string;
    collateral: number;
    availableMargin: number;
    effectiveCollateral: number;
    maintenanceMargin: number;
    initialMargin: number;
    unrealizedPnl: number;
    riskState: string;
}

export interface PhoenixTradeRecord {
    id: string;
    market: string;
    side: string;
    size: number;
    price: number;
    pnl: number | null;
    status: string;
    createdAt: string;
    txSig?: string;
}

export interface PhoenixOpenOrder {
    id: string;
    market: string;
    side: string;
    price: number;
    size: number;
    reduceOnly?: boolean;
}

export interface PhoenixTraderData {
    balance: PhoenixBalanceInfo;
    position: PhoenixPositionInfo | null;
    openOrders: PhoenixOpenOrder[];
    trades: PhoenixTradeRecord[];
    isActivated: boolean;
}

export interface PhoenixOrderRequest {
    authority: string;
    symbol: string;
    side: PhoenixSide;
    orderType: PhoenixOrderType;
    quantity: number;
    price?: number;
    reduceOnly?: boolean;
    postOnly?: boolean;
    transferAmount?: number;
    takeProfitPrice?: number;
    stopLossPrice?: number;
}

export interface PhoenixOrderResult {
    signature: string;
    orderType: PhoenixOrderType;
}
