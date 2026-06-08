import { getWalletPortfolio } from "./helius";
import { listActivePriceAlerts, listRecentlyTriggeredAlerts, summarizeAlert } from "./alerts";
import { getResumeItems } from "./library";

/**
 * "What's new today?" — bundled morning summary for Sakura AI.
 *
 * Pulls together:
 *   - The user's portfolio snapshot.
 *   - Active + recently triggered price alerts.
 *   - Resume cards (top recent reads / watches) so the user can jump back
 *     where they left off.
 *
 * The engine returns this object verbatim to the chat model so the AI can phrase the
 * brief naturally. Anything that fails returns an empty section instead of
 * crashing the whole brief — Sakura should still say something useful when
 * one source is offline.
 */

export interface DailyBriefData {
    walletAddress: string;
    portfolio?: {
        sol_balance: number;
        sol_value_usd: number | null;
        total_value_usd: number;
        top_holdings: { symbol: string; amount: number; value_usd: number | null }[];
    };
    activeAlerts: { id: string; summary: string; target_usd: number; direction: string; symbol: string | null }[];
    triggeredAlerts: { id: string; summary: string; triggered_at: string | null; symbol: string | null }[];
    resume: {
        kind: string;
        title: string;
        route: string;
        type?: string;
    }[];
    notes: string[];
}

export async function buildDailyBrief(walletAddress: string): Promise<DailyBriefData> {
    const notes: string[] = [];

    // Portfolio
    let portfolio: DailyBriefData["portfolio"];
    try {
        const p = await getWalletPortfolio(walletAddress);
        portfolio = {
            sol_balance: p.solBalance,
            sol_value_usd: p.solValueUsd,
            total_value_usd: p.totalValueUsd,
            top_holdings: p.fungibles.slice(0, 5).map((f) => ({
                symbol: f.symbol,
                amount: f.amountUi,
                value_usd: f.valueUsd,
            })),
        };
    } catch (e) {
        notes.push("Portfolio unavailable right now.");
    }

    // Alerts
    let activeAlerts: DailyBriefData["activeAlerts"] = [];
    let triggeredAlerts: DailyBriefData["triggeredAlerts"] = [];
    try {
        const [active, triggered] = await Promise.all([
            listActivePriceAlerts(walletAddress),
            listRecentlyTriggeredAlerts(walletAddress, 3),
        ]);
        activeAlerts = active.map((a) => ({
            id: a.id,
            summary: summarizeAlert(a),
            target_usd: a.target_usd,
            direction: a.direction,
            symbol: a.token_symbol,
        }));
        triggeredAlerts = triggered.map((a) => ({
            id: a.id,
            summary: summarizeAlert(a),
            triggered_at: a.triggered_at,
            symbol: a.token_symbol,
        }));
    } catch {
        notes.push("Alerts unavailable.");
    }

    // Resume cards
    let resume: DailyBriefData["resume"] = [];
    try {
        resume = getResumeItems(5).map((c) => ({
            kind: c.kind,
            title: c.title,
            route: c.route,
            type: c.type,
        }));
    } catch {
        // Local-only operation; only fails if storage was wiped.
    }

    return {
        walletAddress,
        portfolio,
        activeAlerts,
        triggeredAlerts,
        resume,
        notes,
    };
}
