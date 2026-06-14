type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const GROQ_BASE = "https://api.groq.com/openai/v1";
const PRIMARY_MODEL = Deno.env.get("SAKURA_AI_MODEL") || "llama-3.1-8b-instant";
const FALLBACK_MODELS = (Deno.env.get("SAKURA_AI_FALLBACK_MODELS") || "llama-3.3-70b-versatile,openai/gpt-oss-20b")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const MAX_REQUESTS_PER_MINUTE = Number(Deno.env.get("SAKURA_AI_RATE_LIMIT_PER_MINUTE") || "24");
const MAX_MESSAGES = Number(Deno.env.get("SAKURA_AI_MAX_MESSAGES") || "26");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sakura-wallet",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const buckets = new Map<string, { count: number; resetAt: number }>();

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getKey(): string {
  const key = Deno.env.get("GROQ_API_KEY") || "";
  if (!key) throw new Error("Sakura AI proxy is missing GROQ_API_KEY.");
  return key;
}

function rateLimitKeys(req: Request): string[] {
  const wallet = req.headers.get("x-sakura-wallet")?.trim();
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientKey = forwarded
    ? `ip:${forwarded}`
    : `ua:${req.headers.get("user-agent") || "unknown"}`;
  return wallet
    ? [clientKey, `wallet:${wallet.toLowerCase()}`]
    : [clientKey];
}

function checkRateLimit(req: Request) {
  const now = Date.now();
  const keys = rateLimitKeys(req);

  for (const key of keys) {
    const current = buckets.get(key);
    if (current && current.resetAt > now && current.count >= MAX_REQUESTS_PER_MINUTE) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
    }
  }

  for (const key of keys) {
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
    } else {
      current.count += 1;
    }
  }
  return { ok: true, retryAfter: 0 };
}

function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_MESSAGES) return messages;
  const system = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const recent = rest.slice(-MAX_MESSAGES + (system ? 1 : 0));
  return system ? [system, ...recent] : recent;
}

async function callProvider(model: string, messages: ChatMessage[], tools: ToolDefinition[]) {
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.35,
      max_tokens: 1200,
    }),
  });

  const text = await res.text();
  const retryAfter = Number(res.headers.get("retry-after") || "0");

  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text)?.error?.message || text;
    } catch {
      // Keep raw provider body for server logs only.
    }
    console.error("[sakura-ai-proxy] provider error", res.status, model, message.slice(0, 500));
    return { ok: false as const, status: res.status, retryAfter, message };
  }

  const data = JSON.parse(text);
  const choice = data.choices?.[0];
  if (!choice) {
    return { ok: false as const, status: 502, retryAfter: 0, message: "Provider returned no choices." };
  }

  return {
    ok: true as const,
    data: {
      message: {
        role: "assistant",
        content: choice.message?.content ?? null,
        tool_calls: choice.message?.tool_calls,
      },
      finish_reason: choice.finish_reason,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed." });

  const limited = checkRateLimit(req);
  if (!limited.ok) {
    return json(429, {
      error: "Sakura AI is a little busy right now. Please wait a moment and try again.",
      retry_after_seconds: limited.retryAfter,
    });
  }

  try {
    const body = await req.json();
    const messages = trimMessages(Array.isArray(body.messages) ? body.messages : []);
    const tools = Array.isArray(body.tools) ? body.tools : [];

    if (messages.length === 0) return json(400, { error: "Messages are required." });
    if (tools.length === 0) return json(400, { error: "Tools are required." });

    const candidates = [PRIMARY_MODEL, ...FALLBACK_MODELS];
    let lastError = "Sakura AI could not get a response.";

    for (const model of candidates) {
      const result = await callProvider(model, messages, tools);
      if (result.ok) return json(200, result.data);

      lastError = result.message;
      if (result.status === 429) {
        return json(429, {
          error: "Sakura AI is rate-limited right now. Please try again shortly.",
          retry_after_seconds: result.retryAfter || 15,
        });
      }
    }

    return json(502, { error: lastError });
  } catch (e) {
    console.error("[sakura-ai-proxy] request failed", e);
    return json(500, { error: "Sakura AI could not process that request." });
  }
});
