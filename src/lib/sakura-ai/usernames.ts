import { supabase } from "@/lib/supabase";

/**
 * Username storage for Sakura AI.
 *
 * The Sakura AI assistant addresses users by handle (e.g. "Tomoko") rather
 * than by truncated wallet address. Each wallet has a single canonical
 * `username`. The DB schema lives in
 * supabase/migrations/20260429040000_sakura_ai_usernames.sql and must be
 * applied once before this module is functional. All helpers degrade
 * gracefully (return null / "ok: false") when the table does not exist or
 * supabase is unconfigured so the AI can still operate read-only.
 */

export interface SakuraUsername {
    wallet_address: string;
    username: string;
    display_name: string | null;
    created_at: string;
    updated_at: string;
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

// Words the LLM is most likely to hallucinate in place of a real
// user-chosen handle. We reject these so the AI can't "auto-fill" a
// placeholder when the user just said hello. Compared case-insensitively
// against the normalized input.
const PLACEHOLDER_USERNAMES = new Set([
    "username",
    "your_username",
    "your_username_here",
    "yourusername",
    "yourname",
    "your_name",
    "user",
    "name",
    "test",
    "tester",
    "demo",
    "example",
    "anonymous",
    "anon",
    "null",
    "undefined",
    "unknown",
    "string",
    "placeholder",
    "default",
    "guest",
    "tbd",
    "todo",
]);

export type SetUsernameResult =
    | { ok: true; record: SakuraUsername }
    | {
          ok: false;
          reason:
              | "invalid_format"
              | "placeholder"
              | "taken"
              | "no_supabase"
              | "db_error";
          message: string;
      };

export function normalizeUsername(raw: string): string {
    return (raw || "").trim().replace(/^@+/, "");
}

export function isValidUsername(raw: string): boolean {
    return USERNAME_RE.test(normalizeUsername(raw));
}

export function isPlaceholderUsername(raw: string): boolean {
    return PLACEHOLDER_USERNAMES.has(normalizeUsername(raw).toLowerCase());
}

export async function getUsernameForWallet(walletAddress: string): Promise<SakuraUsername | null> {
    if (!supabase || !walletAddress) return null;
    const { data, error } = await supabase
        .from("sakura_usernames")
        .select("*")
        .eq("wallet_address", walletAddress)
        .maybeSingle();
    if (error) {
        // Missing table / migration not yet applied: silently return null so
        // the assistant can still chat without crashing.
        if ((error as any).code === "42P01") return null;
        console.warn("[sakura-ai] getUsernameForWallet error", error);
        return null;
    }
    return (data as SakuraUsername) || null;
}

export async function findWalletByUsername(username: string): Promise<SakuraUsername | null> {
    const normalized = normalizeUsername(username);
    if (!supabase || !normalized) return null;
    const { data, error } = await supabase
        .from("sakura_usernames")
        .select("*")
        // Case-insensitive lookup: matches the lower(username) unique index.
        .ilike("username", normalized)
        .maybeSingle();
    if (error) {
        if ((error as any).code === "42P01") return null;
        console.warn("[sakura-ai] findWalletByUsername error", error);
        return null;
    }
    return (data as SakuraUsername) || null;
}

export async function setUsernameForWallet(
    walletAddress: string,
    username: string,
    displayName?: string | null,
): Promise<SetUsernameResult> {
    const normalized = normalizeUsername(username);
    if (!isValidUsername(normalized)) {
        return {
            ok: false,
            reason: "invalid_format",
            message:
                "Usernames must be 3–20 characters and only contain letters, numbers, or underscores.",
        };
    }
    if (isPlaceholderUsername(normalized)) {
        return {
            ok: false,
            reason: "placeholder",
            message:
                "Please ask the user for the actual handle they want — that one looks like a placeholder.",
        };
    }
    if (!supabase) {
        return { ok: false, reason: "no_supabase", message: "Database is not configured." };
    }

    const existing = await findWalletByUsername(normalized);
    if (existing && existing.wallet_address !== walletAddress) {
        return {
            ok: false,
            reason: "taken",
            message: `That username is already taken by another wallet.`,
        };
    }

    const { data, error } = await supabase
        .from("sakura_usernames")
        .upsert(
            {
                wallet_address: walletAddress,
                username: normalized,
                display_name: displayName ?? null,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "wallet_address" },
        )
        .select()
        .single();

    if (error || !data) {
        const code = (error as any)?.code;
        // Race against the unique index — surface as "taken".
        if (code === "23505") {
            return {
                ok: false,
                reason: "taken",
                message: "That username was just taken. Try another.",
            };
        }
        return {
            ok: false,
            reason: "db_error",
            message: error?.message || "Failed to save username.",
        };
    }
    return { ok: true, record: data as SakuraUsername };
}
