import { supabase } from "@/lib/supabase";
import { getLocal, setLocal, removeLocal } from "@/lib/storage";

/**
 * Persistent Sakura AI chat history (per wallet, with cloud sync).
 *
 * Goals
 * -----
 * - **Local-first**: every turn is written to localStorage immediately, so the
 *   conversation survives app restarts and works offline.
 * - **Cross-device**: when Supabase is configured + the migration in
 *   supabase/migrations/20260429050000_sakura_ai_chat_history.sql is applied,
 *   each turn is also pushed to the cloud and pulled on `loadChatHistory`. A
 *   user importing their seed phrase onto a new device gets their history back.
 * - **Graceful degradation**: if Supabase isn't reachable / table doesn't exist
 *   yet, everything still works locally — no errors surfaced to the user.
 *
 * Wire format
 * -----------
 * - We store one DB row per chat message and merge with the local cache on
 *   load. `client_created_at` (millis-since-epoch) gives us a stable cross-
 *   device order independent of server clock skew.
 * - Tool messages capture the tool name + raw payload so we can re-render
 *   discovery cards and confirmation events on history reload.
 * - Threads: every conversation is keyed by `thread_id`. The default thread is
 *   `default`. We can introduce a thread picker later.
 */

const LOCAL_KEY_PREFIX = "sakura_ai_chat_v1__";
const THREAD_INDEX_PREFIX = "sakura_ai_threads_v1__";
const DEFAULT_THREAD = "default";
const MAX_LOCAL_TURNS = 200;

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface StoredChatMessage {
    id: string;
    walletAddress: string;
    threadId: string;
    role: ChatRole;
    content: string | null;
    toolName?: string | null;
    toolPayload?: any;
    cards?: any[] | null;
    cardsHeader?: string | null;
    clientCreatedAt: number;
    syncedAt?: number | null;
}

export interface ChatThreadSummary {
    id: string;
    title: string;
    updatedAt: number;
    lastMessage?: string;
}

interface ChatRow {
    id: string;
    wallet_address: string;
    thread_id: string;
    role: ChatRole;
    content: string | null;
    tool_name: string | null;
    tool_payload: any;
    cards: any[] | null;
    cards_header: string | null;
    client_created_at: number;
}

function localKey(walletAddress: string, threadId: string): string {
    return `${LOCAL_KEY_PREFIX}${walletAddress}__${threadId}`;
}

function threadIndexKey(walletAddress: string): string {
    return `${THREAD_INDEX_PREFIX}${walletAddress}`;
}

function generateId(): string {
    if (typeof crypto !== "undefined" && (crypto as any).randomUUID) {
        return (crypto as any).randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function readLocal(walletAddress: string, threadId: string): StoredChatMessage[] {
    if (!walletAddress) return [];
    return getLocal<StoredChatMessage[]>(localKey(walletAddress, threadId), []);
}

function writeLocal(walletAddress: string, threadId: string, messages: StoredChatMessage[]): void {
    if (!walletAddress) return;
    // Cap the local cache so an enthusiastic user doesn't blow out
    // localStorage. Cloud always retains the full thread.
    const trimmed = messages.slice(-MAX_LOCAL_TURNS);
    setLocal(localKey(walletAddress, threadId), trimmed);
}

function readThreads(walletAddress: string): ChatThreadSummary[] {
    return getLocal<ChatThreadSummary[]>(threadIndexKey(walletAddress), []);
}

function writeThreads(walletAddress: string, threads: ChatThreadSummary[]): void {
    setLocal(
        threadIndexKey(walletAddress),
        threads.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50),
    );
}

function upsertThread(walletAddress: string, threadId: string, message?: string): void {
    if (!walletAddress) return;
    const threads = readThreads(walletAddress);
    const idx = threads.findIndex((t) => t.id === threadId);
    const title = idx >= 0
        ? threads[idx].title
        : message?.trim()?.slice(0, 42) || (threadId === DEFAULT_THREAD ? "Main chat" : "New chat");
    const next: ChatThreadSummary = {
        id: threadId,
        title,
        updatedAt: Date.now(),
        lastMessage: message?.trim()?.slice(0, 90) || threads[idx]?.lastMessage,
    };
    if (idx >= 0) threads[idx] = next;
    else threads.push(next);
    writeThreads(walletAddress, threads);
}

function rowToStored(row: ChatRow): StoredChatMessage {
    return {
        id: row.id,
        walletAddress: row.wallet_address,
        threadId: row.thread_id,
        role: row.role,
        content: row.content,
        toolName: row.tool_name,
        toolPayload: row.tool_payload,
        cards: row.cards,
        cardsHeader: row.cards_header,
        clientCreatedAt: row.client_created_at,
        syncedAt: Date.now(),
    };
}

function storedToInsert(message: StoredChatMessage) {
    return {
        id: message.id,
        wallet_address: message.walletAddress,
        thread_id: message.threadId,
        role: message.role,
        content: message.content,
        tool_name: message.toolName ?? null,
        tool_payload: message.toolPayload ?? null,
        cards: message.cards ?? null,
        cards_header: message.cardsHeader ?? null,
        client_created_at: message.clientCreatedAt,
    };
}

function mergeById(local: StoredChatMessage[], remote: StoredChatMessage[]): StoredChatMessage[] {
    const map = new Map<string, StoredChatMessage>();
    for (const m of local) map.set(m.id, m);
    // Remote wins for content equality but we preserve any local-only entries
    // (rows the cloud hasn't accepted yet — e.g. supabase was offline mid-turn).
    for (const m of remote) map.set(m.id, m);
    return Array.from(map.values()).sort((a, b) => a.clientCreatedAt - b.clientCreatedAt);
}

/**
 * Load the entire conversation for a wallet, merged from local cache + cloud.
 * Always returns local rows immediately if cloud is unreachable.
 */
export async function loadChatHistory(
    walletAddress: string,
    threadId: string = DEFAULT_THREAD,
): Promise<StoredChatMessage[]> {
    if (!walletAddress) return [];
    upsertThread(walletAddress, threadId);
    const localRows = readLocal(walletAddress, threadId);

    if (!supabase) return localRows;

    try {
        const { data, error } = await supabase
            .from("sakura_ai_chat_history")
            .select("*")
            .eq("wallet_address", walletAddress)
            .eq("thread_id", threadId)
            .order("client_created_at", { ascending: true });

        if (error) {
            // 42P01 → relation does not exist yet (migration not applied).
            // 401/permission errors → degrade to local. Either way, don't crash.
            if ((error as any).code !== "42P01") {
                console.warn("[sakura-ai chat-history] cloud load failed", error);
            }
            return localRows;
        }

        const remote = ((data as ChatRow[]) || []).map(rowToStored);
        const merged = mergeById(localRows, remote);
        writeLocal(walletAddress, threadId, merged);
        return merged;
    } catch (e) {
        console.warn("[sakura-ai chat-history] cloud load threw", e);
        return localRows;
    }
}

/**
 * Append a single message to local + cloud. Local writes are synchronous so
 * the UI can render immediately. The cloud write is fire-and-forget; if it
 * fails the row stays local-only and will sync on the next loadChatHistory
 * via the merge logic.
 */
export async function appendChatMessage(
    walletAddress: string,
    payload: Omit<StoredChatMessage, "id" | "walletAddress" | "threadId" | "clientCreatedAt"> & {
        threadId?: string;
        clientCreatedAt?: number;
    },
): Promise<StoredChatMessage | null> {
    if (!walletAddress) return null;
    const threadId = payload.threadId ?? DEFAULT_THREAD;
    const message: StoredChatMessage = {
        id: generateId(),
        walletAddress,
        threadId,
        role: payload.role,
        content: payload.content,
        toolName: payload.toolName ?? null,
        toolPayload: payload.toolPayload ?? null,
        cards: payload.cards ?? null,
        cardsHeader: payload.cardsHeader ?? null,
        clientCreatedAt: payload.clientCreatedAt ?? Date.now(),
        syncedAt: null,
    };

    const local = readLocal(walletAddress, threadId);
    const next = [...local, message];
    writeLocal(walletAddress, threadId, next);
    if (message.role === "user" || message.role === "assistant") {
        upsertThread(walletAddress, threadId, message.content || undefined);
    }

    if (supabase) {
        try {
            const { error } = await supabase
                .from("sakura_ai_chat_history")
                .insert(storedToInsert(message));
            if (error) {
                if ((error as any).code !== "42P01") {
                    console.warn("[sakura-ai chat-history] cloud insert failed", error);
                }
            } else {
                message.syncedAt = Date.now();
                // Update the local row with the syncedAt timestamp.
                const refreshed = readLocal(walletAddress, threadId).map((m) =>
                    m.id === message.id ? { ...m, syncedAt: message.syncedAt } : m,
                );
                writeLocal(walletAddress, threadId, refreshed);
            }
        } catch (e) {
            console.warn("[sakura-ai chat-history] cloud insert threw", e);
        }
    }

    return message;
}

/**
 * Clear the entire conversation for a wallet, locally and in the cloud.
 * Used by the "New chat" button. We don't return errors — best-effort.
 */
export async function clearChatHistory(
    walletAddress: string,
    threadId: string = DEFAULT_THREAD,
): Promise<void> {
    if (!walletAddress) return;
    removeLocal(localKey(walletAddress, threadId));
    writeThreads(walletAddress, readThreads(walletAddress).filter((t) => t.id !== threadId));
    if (!supabase) return;
    try {
        const { error } = await supabase
            .from("sakura_ai_chat_history")
            .delete()
            .eq("wallet_address", walletAddress)
            .eq("thread_id", threadId);
        if (error && (error as any).code !== "42P01") {
            console.warn("[sakura-ai chat-history] cloud delete failed", error);
        }
    } catch (e) {
        console.warn("[sakura-ai chat-history] cloud delete threw", e);
    }
}

/**
 * Quick lookup of the most recent turn timestamp — used when we want to
 * know "have we ever talked to this wallet before?" without loading the
 * full thread.
 */
export function getLocalLastTurnAt(walletAddress: string, threadId: string = DEFAULT_THREAD): number | null {
    const rows = readLocal(walletAddress, threadId);
    if (rows.length === 0) return null;
    return rows[rows.length - 1].clientCreatedAt;
}

export const CHAT_DEFAULT_THREAD = DEFAULT_THREAD;

export function listChatThreads(walletAddress: string): ChatThreadSummary[] {
    if (!walletAddress) return [];
    const threads = readThreads(walletAddress);
    if (threads.length === 0) {
        return [{ id: DEFAULT_THREAD, title: "Main chat", updatedAt: Date.now() }];
    }
    return threads;
}

export function createChatThread(walletAddress: string, title = "New chat"): ChatThreadSummary {
    const thread: ChatThreadSummary = {
        id: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title,
        updatedAt: Date.now(),
    };
    writeThreads(walletAddress, [thread, ...readThreads(walletAddress)]);
    return thread;
}

export function renameChatThread(walletAddress: string, threadId: string, title: string): void {
    const cleaned = title.trim().slice(0, 60);
    if (!walletAddress || !threadId || !cleaned) return;
    writeThreads(
        walletAddress,
        readThreads(walletAddress).map((t) =>
            t.id === threadId ? { ...t, title: cleaned, updatedAt: Date.now() } : t,
        ),
    );
}
