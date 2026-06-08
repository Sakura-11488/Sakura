/**
 * Sakura AI — chat transport.
 *
 * On desktop (Electron) the provider key lives in the main process only and
 * is reached through `window.electronAPI.sakuraAiChat`. The renderer bundle
 * therefore never carries the secret, DevTools cannot read it, and shipped
 * sourcemaps cannot leak it.
 *
 * On non-Electron contexts (web/dev) we fall back to the legacy
 * NEXT_PUBLIC_GROQ_API_KEY path so local development still works.
 */

const GROQ_BASE = "https://api.groq.com/openai/v1";

const PRIMARY_MODEL = "llama-3.1-8b-instant";
const FALLBACK_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-20b"];

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    name?: string;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
}

export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, any>;
    };
}

export interface ChatResponse {
    message: ChatMessage;
    finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | string;
}

interface ElectronAiBridge {
    sakuraAiChat?: (payload: {
        model: string;
        messages: ChatMessage[];
        tools?: ToolDefinition[];
        temperature?: number;
        max_tokens?: number;
    }) => Promise<{ status: number; body: string; retryAfterSec?: number | null }>;
    sakuraAiConfigured?: () => Promise<boolean>;
    isElectron?: boolean;
}

class GroqError extends Error {
    status: number;
    retryAfterSec: number | null;
    rateLimited: boolean;
    constructor(message: string, status: number, retryAfterSec: number | null = null) {
        super(message);
        this.status = status;
        this.retryAfterSec = retryAfterSec;
        this.rateLimited = status === 429;
    }
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

function pickRetryAfterFromHeader(headers: Headers): number | null {
    const raw = headers.get("retry-after");
    if (!raw) return null;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    return null;
}

function getElectronBridge(): ElectronAiBridge | null {
    if (typeof window === "undefined") return null;
    const api = (window as unknown as { electronAPI?: ElectronAiBridge }).electronAPI;
    if (!api?.isElectron) return null;
    if (typeof api.sakuraAiChat !== "function") return null;
    return api;
}

function parseChoice(json: any): ChatResponse {
    const choice = json?.choices?.[0];
    if (!choice) {
        console.error("[sakura-ai] empty choices", JSON.stringify(json).slice(0, 500));
        throw new Error("Sakura AI returned an empty response. Try again.");
    }
    const message: ChatMessage = {
        role: "assistant",
        content: choice.message?.content ?? null,
        tool_calls: choice.message?.tool_calls,
    };
    return { message, finish_reason: choice.finish_reason };
}

async function callViaElectron(
    bridge: ElectronAiBridge,
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
): Promise<ChatResponse> {
    const res = await bridge.sakuraAiChat!({
        model,
        messages,
        tools: tools.length ? tools : undefined,
    });
    if (res.status < 200 || res.status >= 300) {
        console.error("[sakura-ai] electron proxy", res.status, res.body.slice(0, 500));
        throw new GroqError(
            `Sakura AI request failed (code ${res.status}).`,
            res.status,
            res.retryAfterSec ?? null,
        );
    }
    let parsed: any;
    try {
        parsed = JSON.parse(res.body);
    } catch {
        throw new GroqError("Sakura AI returned a malformed response. Try again.", 0, null);
    }
    return parseChoice(parsed);
}

async function callDirect(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
): Promise<ChatResponse> {
    const key = process.env.NEXT_PUBLIC_GROQ_API_KEY || "";
    if (!key) throw new GroqError("Sakura AI is not configured yet (missing API key).", 0, null);
    const res = await fetch(`${GROQ_BASE}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            messages,
            tools: tools.length ? tools : undefined,
            tool_choice: tools.length ? "auto" : undefined,
            temperature: 0.4,
            max_tokens: 1500,
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        console.error("[sakura-ai] chat HTTP error", res.status, body.slice(0, 500));
        throw new GroqError(
            `Sakura AI request failed (code ${res.status}).`,
            res.status,
            pickRetryAfterFromHeader(res.headers),
        );
    }
    const json = await res.json();
    return parseChoice(json);
}

async function callOnce(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
): Promise<ChatResponse> {
    const bridge = getElectronBridge();
    if (bridge) return callViaElectron(bridge, model, messages, tools);
    return callDirect(model, messages, tools);
}

/**
 * Resilient single-shot completion.
 *
 * Strategy:
 *   1. Try PRIMARY_MODEL.
 *   2. On 429: wait for the server-suggested retry window (capped at 8s)
 *      and retry the SAME model once before falling through. All Groq
 *      models share the same account-wide RPM/TPM, so jumping straight
 *      to a different model rarely helps — backoff is the real fix.
 *   3. On 5xx: short backoff and one same-model retry.
 *   4. On any other 4xx (model retired, bad request): fall through
 *      immediately to the next FALLBACK_MODELS entry.
 *   5. If everything fails, surface a friendly, action-oriented error.
 */
export async function groqChat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
): Promise<ChatResponse> {
    let lastErr: GroqError | Error | null = null;
    const candidates = [PRIMARY_MODEL, ...FALLBACK_MODELS];

    for (const model of candidates) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                return await callOnce(model, messages, tools);
            } catch (err) {
                lastErr = err as Error;
                const ge = err as GroqError;
                const status = typeof ge.status === "number" ? ge.status : 0;

                if (status === 429) {
                    const waitSec = Math.min(
                        Math.max(ge.retryAfterSec ?? 1.5, 0.75),
                        8,
                    );
                    console.warn(
                        `[sakura-ai] 429 on ${model}, attempt ${attempt + 1}, waiting ${waitSec.toFixed(2)}s`,
                    );
                    if (attempt === 0) {
                        await sleep(waitSec * 1000);
                        continue; // retry same model once
                    }
                    break; // fall through to next model
                }

                if (status >= 500 && status < 600) {
                    console.warn(
                        `[sakura-ai] ${status} on ${model}, attempt ${attempt + 1}`,
                    );
                    if (attempt === 0) {
                        await sleep(800);
                        continue;
                    }
                    break;
                }

                console.warn(
                    "[sakura-ai] non-retriable, falling through:",
                    model,
                    ge?.message || err,
                );
                break;
            }
        }
    }

    if (lastErr instanceof GroqError && lastErr.rateLimited) {
        const waitMsg = lastErr.retryAfterSec
            ? ` Try again in about ${Math.max(1, Math.ceil(lastErr.retryAfterSec))} seconds.`
            : " Wait a moment and try again.";
        throw new Error(`Sakura AI is rate-limited right now.${waitMsg}`);
    }
    if (lastErr instanceof GroqError && lastErr.status > 0) {
        throw new Error(
            `Sakura AI is having trouble right now (request failed, code ${lastErr.status}). Try again in a moment.`,
        );
    }
    throw lastErr || new Error("Sakura AI could not get a response. Try again shortly.");
}
