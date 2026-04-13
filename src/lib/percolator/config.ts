/**
 * Trading configuration for the Sakura perps integration.
 * The actual trading is handled by the backend (Drift Protocol).
 * This file retains fee and risk display parameters used by the frontend.
 */

// ============ Risk Parameters (for UI display) ============

export const RISK_PARAMS = {
    maintenanceMarginBps: 500, // 5%
    initialMarginBps: 1000, // 10%
    tradingFeeBps: 10, // 0.1%
} as const;

// ============ Fee Configuration ============

export const TRADING_FEE_SAKURA = 100_000; // 100,000 $SAKURA per trade
export const FEE_SPLITS = {
    creators: 30, // 30%
    ops: 20, // 20%
    provenance: 30, // 30%
    community: 20, // 20%
} as const;
