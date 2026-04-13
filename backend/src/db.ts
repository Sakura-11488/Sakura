import { createClient, SupabaseClient } from "@supabase/supabase-js";

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
    if (!supabase) {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_KEY;
        if (!url || !key) throw new Error("SUPABASE_URL or SUPABASE_SERVICE_KEY not set");
        supabase = createClient(url, key);
    }
    return supabase;
}

// ============ User Management ============

export async function getOrCreateUser(wallet: string): Promise<{ wallet: string; drift_sub_account_id: number }> {
    const sb = getSupabase();

    const { data: existing } = await sb
        .from("perp_users")
        .select("*")
        .eq("wallet", wallet)
        .single();

    if (existing) return existing;

    // Assign next available sub-account ID
    const { count } = await sb
        .from("perp_users")
        .select("*", { count: "exact", head: true });

    const nextId = (count || 0) + 1;

    const { data: created, error } = await sb
        .from("perp_users")
        .insert({ wallet, drift_sub_account_id: nextId })
        .select()
        .single();

    if (error) throw new Error(`Failed to create user: ${error.message}`);
    return created;
}

export async function getUserByWallet(wallet: string) {
    const sb = getSupabase();
    const { data } = await sb
        .from("perp_users")
        .select("*")
        .eq("wallet", wallet)
        .single();
    return data;
}

// ============ Balance Management ============

export async function getBalance(wallet: string) {
    const sb = getSupabase();
    const { data } = await sb
        .from("perp_balances")
        .select("*")
        .eq("wallet", wallet)
        .single();

    return data || { wallet, deposited_sol: 0, available_margin: 0, locked_margin: 0 };
}

export async function upsertBalance(wallet: string, updates: {
    deposited_sol?: number;
    available_margin?: number;
    locked_margin?: number;
}) {
    const sb = getSupabase();
    const { error } = await sb
        .from("perp_balances")
        .upsert({
            wallet,
            ...updates,
            updated_at: new Date().toISOString(),
        }, { onConflict: "wallet" });

    if (error) console.error("[db] Balance upsert error:", error);
}

// ============ Trade Records ============

export async function recordTrade(trade: {
    wallet: string;
    market: string;
    side: string;
    size: number;
    leverage: number;
    entry_price: number;
    fee_signature: string;
    drift_tx_sig: string;
    status: string;
}) {
    const sb = getSupabase();
    const { data, error } = await sb
        .from("perp_trades")
        .insert({
            ...trade,
            created_at: new Date().toISOString(),
        })
        .select()
        .single();

    if (error) console.error("[db] Trade record error:", error);
    return data;
}

export async function updateTradeClose(tradeId: string, exitPrice: number, pnl: number) {
    const sb = getSupabase();
    await sb
        .from("perp_trades")
        .update({
            exit_price: exitPrice,
            pnl,
            status: "closed",
            closed_at: new Date().toISOString(),
        })
        .eq("id", tradeId);
}

export async function getOpenTrades(wallet: string) {
    const sb = getSupabase();
    const { data } = await sb
        .from("perp_trades")
        .select("*")
        .eq("wallet", wallet)
        .eq("status", "open")
        .order("created_at", { ascending: false });
    return data || [];
}

export async function getTradeHistory(wallet: string, limit = 50) {
    const sb = getSupabase();
    const { data } = await sb
        .from("perp_trades")
        .select("*")
        .eq("wallet", wallet)
        .order("created_at", { ascending: false })
        .limit(limit);
    return data || [];
}

// ============ Deposit Records ============

export async function recordDeposit(deposit: {
    wallet: string;
    amount_sol: number;
    direction: "deposit" | "withdraw";
    tx_signature: string;
    status: string;
}) {
    const sb = getSupabase();
    const { data, error } = await sb
        .from("perp_deposits")
        .insert({
            ...deposit,
            created_at: new Date().toISOString(),
        })
        .select()
        .single();

    if (error) console.error("[db] Deposit record error:", error);
    return data;
}

export async function getDepositHistory(wallet: string) {
    const sb = getSupabase();
    const { data } = await sb
        .from("perp_deposits")
        .select("*")
        .eq("wallet", wallet)
        .order("created_at", { ascending: false })
        .limit(50);
    return data || [];
}
