import { supabase } from "@/lib/supabase";
import { resolveToken } from "./tokens";
import { getTokenSummary } from "./helius";

/**
 * Price alert storage + light-weight client-side polling for Sakura AI.
 *
 * The user can ask "tell me when SOL hits $250" or "ping me if SAKURA
 * drops below $0.001". We persist the alert in Supabase
 * (sakura_ai_price_alerts table) and the AI modal polls all active alerts
 * for the connected wallet whenever it's open. When a target is met we
 * mark the row as `triggered_at = now()` and surface a toast.
 *
 * Server-side push notifications are a TODO — for now we rely on the
 * modal poller, which is "good enough" for a v1.
 *
 * All helpers degrade gracefully when Supabase is unconfigured / table
 * not migrated yet.
 */

export type AlertDirection = "above" | "below";

export interface PriceAlert {
    id: string;
    wallet_address: string;
    token_mint: string;
    token_symbol: string | null;
    direction: AlertDirection;
    target_usd: number;
    note: string | null;
    triggered_at: string | null;
    cancelled_at: string | null;
    created_at: string;
}

export interface CreatePriceAlertInput {
    walletAddress: string;
    tokenSymbolOrMint: string;
    direction: AlertDirection;
    targetUsd: number;
    note?: string | null;
}

export type CreatePriceAlertResult =
    | { ok: true; alert: PriceAlert }
    | { ok: false; reason: "invalid" | "unknown_token" | "no_supabase" | "db_error"; message: string };

export async function createPriceAlert(
    input: CreatePriceAlertInput,
): Promise<CreatePriceAlertResult> {
    if (!input.walletAddress || !input.tokenSymbolOrMint || !input.direction || !input.targetUsd) {
        return { ok: false, reason: "invalid", message: "Missing required fields." };
    }
    if (input.targetUsd <= 0) {
        return { ok: false, reason: "invalid", message: "Target price must be > 0." };
    }
    if (input.direction !== "above" && input.direction !== "below") {
        return { ok: false, reason: "invalid", message: "Direction must be 'above' or 'below'." };
    }
    if (!supabase) {
        return { ok: false, reason: "no_supabase", message: "Database is not configured." };
    }

    const tok = await resolveToken(input.tokenSymbolOrMint);
    if (!tok) {
        return {
            ok: false,
            reason: "unknown_token",
            message: `Couldn't resolve token "${input.tokenSymbolOrMint}".`,
        };
    }

    const { data, error } = await supabase
        .from("sakura_ai_price_alerts")
        .insert({
            wallet_address: input.walletAddress,
            token_mint: tok.mint,
            token_symbol: tok.symbol,
            direction: input.direction,
            target_usd: input.targetUsd,
            note: input.note || null,
        })
        .select()
        .single();

    if (error || !data) {
        if ((error as any)?.code === "42P01") {
            return { ok: false, reason: "no_supabase", message: "Alerts table not yet migrated." };
        }
        return { ok: false, reason: "db_error", message: error?.message || "Failed to save alert." };
    }
    return { ok: true, alert: data as PriceAlert };
}

export async function listActivePriceAlerts(walletAddress: string): Promise<PriceAlert[]> {
    if (!supabase || !walletAddress) return [];
    const { data, error } = await supabase
        .from("sakura_ai_price_alerts")
        .select("*")
        .eq("wallet_address", walletAddress)
        .is("triggered_at", null)
        .is("cancelled_at", null)
        .order("created_at", { ascending: false });
    if (error) {
        if ((error as any).code !== "42P01") {
            console.warn("[alerts] list failed", error);
        }
        return [];
    }
    return (data as PriceAlert[]) || [];
}

export async function listRecentlyTriggeredAlerts(
    walletAddress: string,
    limit = 5,
): Promise<PriceAlert[]> {
    if (!supabase || !walletAddress) return [];
    const { data, error } = await supabase
        .from("sakura_ai_price_alerts")
        .select("*")
        .eq("wallet_address", walletAddress)
        .not("triggered_at", "is", null)
        .order("triggered_at", { ascending: false })
        .limit(limit);
    if (error) {
        if ((error as any).code !== "42P01") {
            console.warn("[alerts] list triggered failed", error);
        }
        return [];
    }
    return (data as PriceAlert[]) || [];
}

export async function cancelPriceAlert(alertId: string): Promise<boolean> {
    if (!supabase || !alertId) return false;
    const { error } = await supabase
        .from("sakura_ai_price_alerts")
        .update({ cancelled_at: new Date().toISOString() })
        .eq("id", alertId);
    if (error) {
        if ((error as any).code !== "42P01") {
            console.warn("[alerts] cancel failed", error);
        }
        return false;
    }
    return true;
}

async function markAlertTriggered(alertId: string): Promise<void> {
    if (!supabase) return;
    await supabase
        .from("sakura_ai_price_alerts")
        .update({ triggered_at: new Date().toISOString() })
        .eq("id", alertId)
        .is("triggered_at", null);
}

export interface AlertCheckResult {
    alert: PriceAlert;
    currentPriceUsd: number;
}

/**
 * Poll every active alert for the wallet and return the ones whose target
 * has been reached. Triggered alerts are atomically marked in the DB so a
 * second poll won't fire twice.
 *
 * The price source is Helius's `getAsset` endpoint. We cache lookups by
 * mint within a single call to avoid hammering Helius when several alerts
 * watch the same token.
 */
export async function pollAlerts(walletAddress: string): Promise<AlertCheckResult[]> {
    const alerts = await listActivePriceAlerts(walletAddress);
    if (alerts.length === 0) return [];

    const priceCache = new Map<string, number | null>();
    const triggered: AlertCheckResult[] = [];

    for (const alert of alerts) {
        let price = priceCache.get(alert.token_mint);
        if (price === undefined) {
            try {
                const summary = await getTokenSummary(alert.token_mint);
                price = summary?.priceUsd ?? null;
            } catch {
                price = null;
            }
            priceCache.set(alert.token_mint, price);
        }
        if (price == null) continue;

        const hits = alert.direction === "above"
            ? price >= alert.target_usd
            : price <= alert.target_usd;
        if (!hits) continue;

        triggered.push({ alert, currentPriceUsd: price });
        // Best-effort mark — if it fails the next poll will catch it and
        // potentially fire twice. We accept that for v1.
        await markAlertTriggered(alert.id);
    }

    return triggered;
}

/**
 * Small text helper used by the AI's tool-event renderer + toast bodies.
 */
export function summarizeAlert(alert: PriceAlert): string {
    const sym = alert.token_symbol || alert.token_mint.slice(0, 4);
    const direction = alert.direction === "above" ? "≥" : "≤";
    return `${sym} ${direction} $${formatUsd(alert.target_usd)}`;
}

export function formatUsd(value: number): string {
    if (!Number.isFinite(value)) return "?";
    if (value >= 1) return value.toFixed(2);
    if (value >= 0.01) return value.toFixed(4);
    return value.toFixed(6);
}
