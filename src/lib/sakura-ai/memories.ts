import { supabase } from "@/lib/supabase";

/**
 * Long-term memory store for Sakura AI.
 *
 * Each row is a free-form note Sakura should remember about the user across
 * sessions: "I prefer dub over sub", "Don't recommend horror", "I publish
 * Sakura works under @yumi". The engine fetches the N most recent memories
 * before every turn and injects them into the system prompt so behavior
 * persists without making the model carry the entire history.
 *
 * Schema lives in supabase/migrations/20260429051000_sakura_ai_memories.sql.
 * All helpers degrade gracefully when Supabase is unconfigured or the table
 * hasn't been migrated yet (return [] / { ok: false }).
 */

export interface SakuraMemory {
    id: string;
    wallet_address: string;
    note: string;
    tag: string | null;
    created_at: string;
    updated_at: string;
}

const MAX_NOTE_LENGTH = 240;
const MAX_INJECT = 6;

export function isValidMemoryNote(note: string): boolean {
    const trimmed = (note || "").trim();
    return trimmed.length >= 3 && trimmed.length <= MAX_NOTE_LENGTH;
}

export async function listMemories(walletAddress: string, limit = 20): Promise<SakuraMemory[]> {
    if (!supabase || !walletAddress) return [];
    const { data, error } = await supabase
        .from("sakura_ai_memories")
        .select("*")
        .eq("wallet_address", walletAddress)
        .order("created_at", { ascending: false })
        .limit(Math.min(Math.max(limit, 1), 50));
    if (error) {
        if ((error as any).code === "42P01") return [];
        console.warn("[sakura-ai memories] list failed", error);
        return [];
    }
    return (data as SakuraMemory[]) || [];
}

/**
 * Compact, prompt-friendly summary of the user's recent memories. Returns
 * an empty string if there's nothing to inject — the engine concatenates
 * the result into the system prompt verbatim.
 */
export async function buildMemoryContext(walletAddress: string): Promise<string> {
    const items = await listMemories(walletAddress, MAX_INJECT);
    if (items.length === 0) return "";
    const lines = items.map((m, idx) => `  ${idx + 1}. ${m.note}${m.tag ? ` (#${m.tag})` : ""}`);
    return [
        "Long-term memories about this user (always factor these into your responses):",
        ...lines,
    ].join("\n");
}

export type AddMemoryResult =
    | { ok: true; memory: SakuraMemory }
    | { ok: false; reason: "invalid" | "no_supabase" | "db_error"; message: string };

export async function addMemory(
    walletAddress: string,
    note: string,
    tag?: string | null,
): Promise<AddMemoryResult> {
    if (!isValidMemoryNote(note)) {
        return {
            ok: false,
            reason: "invalid",
            message: `Memory must be between 3 and ${MAX_NOTE_LENGTH} characters.`,
        };
    }
    if (!supabase) {
        return { ok: false, reason: "no_supabase", message: "Database is not configured." };
    }
    const { data, error } = await supabase
        .from("sakura_ai_memories")
        .insert({
            wallet_address: walletAddress,
            note: note.trim(),
            tag: tag?.trim() || null,
        })
        .select()
        .single();
    if (error || !data) {
        if ((error as any)?.code === "42P01") {
            return { ok: false, reason: "no_supabase", message: "Memory table not yet migrated." };
        }
        return { ok: false, reason: "db_error", message: error?.message || "Failed to save memory." };
    }
    return { ok: true, memory: data as SakuraMemory };
}

export type ForgetMemoryResult =
    | { ok: true; deleted: number }
    | { ok: false; reason: "no_supabase" | "not_found" | "db_error"; message: string };

export type UpdateMemoryResult =
    | { ok: true; memory: SakuraMemory }
    | { ok: false; reason: "invalid" | "no_supabase" | "not_found" | "db_error"; message: string };

export async function updateMemory(
    walletAddress: string,
    id: string,
    note: string,
    tag?: string | null,
): Promise<UpdateMemoryResult> {
    if (!isValidMemoryNote(note)) {
        return {
            ok: false,
            reason: "invalid",
            message: `Memory must be between 3 and ${MAX_NOTE_LENGTH} characters.`,
        };
    }
    if (!supabase) return { ok: false, reason: "no_supabase", message: "Database is not configured." };
    const { data, error } = await supabase
        .from("sakura_ai_memories")
        .update({ note: note.trim(), tag: tag?.trim() || null })
        .eq("wallet_address", walletAddress)
        .eq("id", id)
        .select()
        .maybeSingle();
    if (error) {
        if ((error as any).code === "42P01") {
            return { ok: false, reason: "no_supabase", message: "Memory table not yet migrated." };
        }
        return { ok: false, reason: "db_error", message: error.message };
    }
    if (!data) return { ok: false, reason: "not_found", message: "No matching memory." };
    return { ok: true, memory: data as SakuraMemory };
}

/**
 * Forget a memory either by exact id (preferred — supplied by list_memories)
 * or by a substring match on the note text. Substring deletion deletes ALL
 * matches so the AI should warn the user when there are several.
 */
export async function forgetMemory(
    walletAddress: string,
    options: { id?: string; contains?: string },
): Promise<ForgetMemoryResult> {
    if (!supabase) {
        return { ok: false, reason: "no_supabase", message: "Database is not configured." };
    }
    let query = supabase
        .from("sakura_ai_memories")
        .delete({ count: "exact" })
        .eq("wallet_address", walletAddress);

    if (options.id) {
        query = query.eq("id", options.id);
    } else if (options.contains?.trim()) {
        query = query.ilike("note", `%${options.contains.trim()}%`);
    } else {
        return { ok: false, reason: "not_found", message: "Provide an id or a substring." };
    }

    const { error, count } = await query;
    if (error) {
        if ((error as any).code === "42P01") {
            return { ok: false, reason: "no_supabase", message: "Memory table not yet migrated." };
        }
        return { ok: false, reason: "db_error", message: error.message };
    }
    if (!count || count === 0) {
        return { ok: false, reason: "not_found", message: "No matching memory." };
    }
    return { ok: true, deleted: count };
}
