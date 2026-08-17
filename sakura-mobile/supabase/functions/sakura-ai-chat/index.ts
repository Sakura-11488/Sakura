import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { getSakuraHolding } from '../_shared/sakura-holding.ts';
import { buildSystemPrompt, type SakuraContext } from './prompt.ts';
import { isServerTool, resolveGroups, resolveTools, type ToolGroup } from './tools.ts';

/**
 * Sakura AI — gated, metered, server-authoritative chat proxy.
 *
 * What this replaces: a function at the repo root that took an *unverified*
 * `x-sakura-wallet` header, trusted the caller's tool catalogue and system
 * prompt wholesale, rate-limited in a `Map` that a cold start wiped, and had no
 * holding check at all. The 500,000 SKR gate existed only in the client, and
 * the anon key ships inside both the APK and the PWA bundle — so the gate was
 * decorative and `GROQ_API_KEY` was effectively public.
 *
 * Moving the function under sakura-mobile/ is what makes the fix possible: it
 * can now import `_shared/`, so auth is an Ed25519 signature over
 * `sakura:sakura-ai:ts:<unix>` and rate limits live in `api_rate_buckets`
 * where a cold start cannot forget them.
 *
 * Three layers of metering, because they fail differently:
 *   1. durable per-wallet buckets (burst + daily request count)
 *   2. a per-request token ledger fed from Groq's own `usage` field
 *   3. a global daily token budget that returns a friendly 503
 */

const cors = corsHeaders();

const GROQ_BASE = 'https://api.groq.com/openai/v1';

/**
 * Groq decommissioned llama-3.1-8b-instant and llama-3.3-70b-versatile on
 * 2026-08-16. The chain that shipped here led with both of them, so every single
 * turn spent two 404 round trips before quietly succeeding on the third entry —
 * the fallback worked exactly as designed and that is precisely why nobody
 * noticed the primary was dead.
 *
 * These are Groq's own stated migration targets (8b-instant -> gpt-oss-20b,
 * 70b-versatile -> gpt-oss-120b). gpt-oss-20b and -120b are the only two
 * production general-purpose chat models Groq still offers; qwen3.6-27b is a
 * Preview model and sits last because Preview can be withdrawn without notice.
 *
 * All three support tool calling. None of the GPT-OSS models support *parallel*
 * tool calls — they emit at most one per turn — which the loop below already
 * copes with, since it treats tool_calls as a list of unknown length rather than
 * assuming a batch.
 */
const PRIMARY_MODEL = Deno.env.get('SAKURA_AI_MODEL') || 'openai/gpt-oss-20b';
const FALLBACK_MODELS = (Deno.env.get('SAKURA_AI_FALLBACK_MODELS') || 'openai/gpt-oss-120b,qwen/qwen3.6-27b')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const MIN_HOLDING_SAKURA = Number(Deno.env.get('SAKURA_AI_MIN_HOLDING') || '100000');
const MIN_LIFETIME_XP = Number(Deno.env.get('SAKURA_AI_MIN_XP') || '1000');
const ENTITLEMENT_TTL_SEC = Number(Deno.env.get('SAKURA_AI_ENTITLEMENT_TTL_SEC') || '300');

const RATE_PER_MINUTE = Number(Deno.env.get('SAKURA_AI_RATE_LIMIT_PER_MINUTE') || '12');
const RATE_PER_DAY = Number(Deno.env.get('SAKURA_AI_RATE_LIMIT_PER_DAY') || '120');
const DAILY_TOKEN_BUDGET = Number(Deno.env.get('SAKURA_AI_DAILY_TOKEN_BUDGET') || '4000000');

const MAX_MESSAGES = Number(Deno.env.get('SAKURA_AI_MAX_MESSAGES') || '26');
const MAX_CHARS_PER_MESSAGE = 8_000;
const MAX_TOTAL_CHARS = 60_000;
const MAX_SERVER_HOPS = 3;
const MEMORY_INJECT = 6;
const MEMORY_MAX_PER_WALLET = 100;

// Every one of these can be overridden by a project secret, and one of them
// silently was: SAKURA_AI_RATE_LIMIT_PER_MINUTE survived from the old
// root-level function at 24, quietly doubling the 12 written above. Print the
// resolved values on boot so the deployed reality is never a guess, and expose
// them on the entitlement response so a test can assert against what the server
// is actually doing rather than what the source says it should.
console.log(
  '[sakura-ai] effective config',
  JSON.stringify({
    model: PRIMARY_MODEL,
    min_holding: MIN_HOLDING_SAKURA,
    min_xp: MIN_LIFETIME_XP,
    rate_per_minute: RATE_PER_MINUTE,
    rate_per_day: RATE_PER_DAY,
    daily_token_budget: DAILY_TOKEN_BUDGET,
  }),
);

const GATE_COPY =
  `Sakura AI is for holders and readers. Hold ${MIN_HOLDING_SAKURA.toLocaleString()} SKR, ` +
  `or reach Level 5 by reading (${MIN_LIFETIME_XP.toLocaleString()} XP) — either one unlocks it.`;

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

type ToolCall = {
  id: string;
  type?: string;
  function: { name: string; arguments?: string };
};

type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

// ─── Entitlement ──────────────────────────────────────────────────────────────

type Entitlement = {
  entitled: boolean;
  sakura: number;
  xp: number;
  reason: 'holding' | 'xp' | 'none';
};

/**
 * Two doors, either suffices: hold enough $SAKURA, or have earned enough
 * lifetime XP by reading.
 *
 * XP is checked FIRST and on purpose. It is a single indexed read against a
 * table we own, it never fails transiently, and it is the door most users will
 * come through — so a reader never pays for a Solana RPC round trip, and a
 * Helius blip cannot lock out someone whose entitlement has nothing to do with
 * the chain.
 *
 * XP here is `user_xp_state.xp`, which is lifetime and never decremented
 * (spends move `xp_spent` instead). Reading it is a gate, not a charge: nothing
 * is debited, so the `xp_redemptions` ledger stays reconcilable.
 */
async function computeEntitlement(supabase: SupabaseClient, wallet: string): Promise<Entitlement> {
  const { data: xpRow } = await supabase
    .from('user_xp_state')
    .select('xp')
    .eq('wallet_address', wallet)
    .maybeSingle();

  const xp = Number(xpRow?.xp ?? 0);
  if (xp >= MIN_LIFETIME_XP) {
    return { entitled: true, sakura: -1, xp, reason: 'xp' };
  }

  const holding = await getSakuraHolding(wallet);
  return {
    entitled: holding.whole >= MIN_HOLDING_SAKURA,
    sakura: holding.whole,
    xp,
    reason: holding.whole >= MIN_HOLDING_SAKURA ? 'holding' : 'none',
  };
}

async function getEntitlement(
  supabase: SupabaseClient,
  wallet: string,
  force = false,
): Promise<Entitlement> {
  const { data: cached } = await supabase
    .from('sakura_ai_entitlement')
    .select('entitled, sakura_balance, lifetime_xp, reason, checked_at')
    .eq('wallet_address', wallet)
    .maybeSingle();

  if (!force && cached) {
    const age = (Date.now() - new Date(cached.checked_at as string).getTime()) / 1000;
    if (age < ENTITLEMENT_TTL_SEC) {
      return {
        entitled: Boolean(cached.entitled),
        sakura: Number(cached.sakura_balance ?? 0),
        xp: Number(cached.lifetime_xp ?? 0),
        reason: (cached.reason as Entitlement['reason']) ?? 'none',
      };
    }
  }

  let fresh: Entitlement;
  try {
    fresh = await computeEntitlement(supabase, wallet);
  } catch (e) {
    // A transient RPC failure must not read as "you don't hold enough" — that
    // is a different, and wrong, thing to tell a user. Serve the stale row if
    // we have one; otherwise let the caller turn this into a 503.
    if (cached) {
      return {
        entitled: Boolean(cached.entitled),
        sakura: Number(cached.sakura_balance ?? 0),
        xp: Number(cached.lifetime_xp ?? 0),
        reason: (cached.reason as Entitlement['reason']) ?? 'none',
      };
    }
    throw e;
  }

  await supabase.from('sakura_ai_entitlement').upsert(
    {
      wallet_address: wallet,
      entitled: fresh.entitled,
      sakura_balance: fresh.sakura < 0 ? (cached?.sakura_balance ?? 0) : fresh.sakura,
      lifetime_xp: fresh.xp,
      reason: fresh.reason,
      checked_at: new Date().toISOString(),
    },
    { onConflict: 'wallet_address' },
  );

  return fresh;
}

// ─── Metering ─────────────────────────────────────────────────────────────────

async function dailyTokensUsed(supabase: SupabaseClient): Promise<number> {
  const { data } = await supabase
    .from('sakura_ai_daily_usage')
    .select('total_tokens')
    .eq('day', utcDay())
    .maybeSingle();
  return Number(data?.total_tokens ?? 0);
}

async function recordUsage(
  supabase: SupabaseClient,
  wallet: string,
  model: string,
  surface: string,
  usage: Usage,
): Promise<void> {
  try {
    await supabase.from('sakura_ai_usage').insert({
      wallet_address: wallet,
      model,
      surface,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    });
    await supabase.rpc('bump_sakura_ai_daily_usage', { p_tokens: usage.total_tokens });
  } catch (e) {
    // Never fail a user's message because accounting hiccuped — but do say so
    // loudly in the logs, because a silent stop here is how a token budget
    // stops being a budget.
    console.error('[sakura-ai] usage record failed', e instanceof Error ? e.message : e);
  }
}

// ─── Message hygiene ──────────────────────────────────────────────────────────

/**
 * The client's messages are input, not instructions. Any `system` role it sends
 * is dropped — the persona is ours — and the transcript is bounded so a caller
 * cannot turn one request into a 100k-token bill.
 */
function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];

  const cleaned: ChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as ChatMessage;
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;

    const content = typeof m.content === 'string' ? m.content.slice(0, MAX_CHARS_PER_MESSAGE) : null;
    const next: ChatMessage = { role: m.role, content };
    if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string' || !m.tool_call_id) continue;
      next.tool_call_id = m.tool_call_id;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      next.tool_calls = m.tool_calls
        .filter((c) => c && typeof c.id === 'string' && typeof c.function?.name === 'string')
        .slice(0, 8);
      if (next.tool_calls.length === 0) delete next.tool_calls;
    }
    if (next.content === null && !next.tool_calls) continue;
    cleaned.push(next);
  }

  // Keep the most recent turns...
  let trimmed = cleaned.slice(-MAX_MESSAGES);

  // ...but never start on a `tool` message: its assistant `tool_calls` would be
  // gone and the provider rejects the whole request with a 400.
  while (trimmed.length > 0 && trimmed[0].role === 'tool') trimmed = trimmed.slice(1);

  let total = 0;
  const bounded: ChatMessage[] = [];
  for (let i = trimmed.length - 1; i >= 0; i--) {
    total += trimmed[i].content?.length ?? 0;
    if (total > MAX_TOTAL_CHARS && bounded.length > 0) break;
    bounded.unshift(trimmed[i]);
  }
  while (bounded.length > 0 && bounded[0].role === 'tool') bounded.shift();

  return bounded;
}

// ─── Server-side tools ────────────────────────────────────────────────────────

async function loadMemories(
  supabase: SupabaseClient,
  wallet: string,
  limit: number,
): Promise<Array<{ id: string; note: string; tag: string | null }>> {
  const { data, error } = await supabase
    .from('sakura_ai_memories')
    .select('id, note, tag')
    .eq('wallet_address', wallet)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(1, limit), 50));
  if (error) {
    console.error('[sakura-ai] memory read failed', error.message);
    return [];
  }
  return (data ?? []) as Array<{ id: string; note: string; tag: string | null }>;
}

async function runServerTool(
  supabase: SupabaseClient,
  wallet: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'remember': {
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      if (note.length < 3 || note.length > 240) {
        return { ok: false, error: 'Memory must be between 3 and 240 characters.' };
      }
      const { count } = await supabase
        .from('sakura_ai_memories')
        .select('id', { count: 'exact', head: true })
        .eq('wallet_address', wallet);
      if ((count ?? 0) >= MEMORY_MAX_PER_WALLET) {
        return { ok: false, error: `Memory is full (${MEMORY_MAX_PER_WALLET}). Forget something first.` };
      }
      const tag = typeof args.tag === 'string' && args.tag.trim() ? args.tag.trim().slice(0, 40) : null;
      const { data, error } = await supabase
        .from('sakura_ai_memories')
        .insert({ wallet_address: wallet, note, tag })
        .select('id, note, tag')
        .single();
      if (error || !data) return { ok: false, error: error?.message || 'Failed to save memory.' };
      return { ok: true, memory: data };
    }

    case 'forget': {
      const contains = typeof args.contains === 'string' ? args.contains.trim() : '';
      if (!contains) return { ok: false, error: 'Say which memory to forget.' };
      const { error, count } = await supabase
        .from('sakura_ai_memories')
        .delete({ count: 'exact' })
        .eq('wallet_address', wallet)
        .ilike('note', `%${contains.replace(/[%_]/g, '')}%`);
      if (error) return { ok: false, error: error.message };
      if (!count) return { ok: false, error: 'No matching memory found.' };
      return { ok: true, deleted: count };
    }

    case 'recall_memories': {
      const memories = await loadMemories(supabase, wallet, 20);
      return { ok: true, memories };
    }

    default:
      return { ok: false, error: `Unknown server tool: ${name}` };
  }
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    return call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return {};
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

type ProviderOk = {
  ok: true;
  model: string;
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string;
  usage: Usage;
};
type ProviderErr = { ok: false; status: number; retryAfter: number; message: string };

async function callProvider(
  model: string,
  messages: ChatMessage[],
  tools: unknown[],
): Promise<ProviderOk | ProviderErr> {
  const key = Deno.env.get('GROQ_API_KEY') || '';
  if (!key) return { ok: false, status: 500, retryAfter: 0, message: 'Sakura AI proxy is missing GROQ_API_KEY.' };

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.35,
    max_tokens: 1200,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  const retryAfter = Number(res.headers.get('retry-after') || '0');

  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text)?.error?.message || text;
    } catch {
      // keep the raw provider body for the logs only
    }
    // 404 on a model is not a transient blip — it means the model is gone, and
    // the chain will paper over it on every request until someone reads a log.
    // Say so in the words a future reader needs to hear.
    if (res.status === 404) {
      console.error(
        `[sakura-ai] MODEL GONE: ${model} returned 404. It has been decommissioned or the key lost access. ` +
          'Update SAKURA_AI_MODEL / SAKURA_AI_FALLBACK_MODELS — every request is paying for this round trip.',
      );
    }
    console.error('[sakura-ai] provider error', res.status, model, String(message).slice(0, 500));
    return { ok: false, status: res.status, retryAfter, message: String(message) };
  }

  const data = JSON.parse(text);
  const choice = data.choices?.[0];
  if (!choice) return { ok: false, status: 502, retryAfter: 0, message: 'Provider returned no choices.' };

  return {
    ok: true,
    model,
    message: {
      role: 'assistant',
      content: choice.message?.content ?? null,
      tool_calls: choice.message?.tool_calls,
    },
    finish_reason: choice.finish_reason,
    usage: {
      prompt_tokens: Number(data.usage?.prompt_tokens ?? 0),
      completion_tokens: Number(data.usage?.completion_tokens ?? 0),
      total_tokens: Number(data.usage?.total_tokens ?? 0),
    },
  };
}

/** Walks the fallback chain. A 429 from the provider stops it — trying the next
 *  model on a rate limit just burns the next model's quota too. */
async function callWithFallback(
  messages: ChatMessage[],
  tools: unknown[],
): Promise<ProviderOk | ProviderErr> {
  let last: ProviderErr = { ok: false, status: 502, retryAfter: 0, message: 'Sakura AI could not get a response.' };
  for (const model of [PRIMARY_MODEL, ...FALLBACK_MODELS]) {
    const result = await callProvider(model, messages, tools);
    if (result.ok) return result;
    if (result.status === 429) return result;
    last = result;
  }
  return last;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  let wallet: string;
  try {
    wallet = verifyWalletHeaders(req.headers, 'sakura-ai').walletAddress;
  } catch {
    return jsonResponse(
      401,
      {
        error: "Sakura AI couldn't verify your wallet. Reconnect it and try again — if you're on an older build, update the app.",
        code: 'unauthenticated',
      },
      cors,
    );
  }

  const supabase = serviceClient();

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action : 'chat';

    // ── Rate limits (durable; survive a cold start, unlike the old Map) ──────
    const minute = await checkRateLimit(supabase, `sakura-ai:m:${wallet}`, RATE_PER_MINUTE, 60);
    if (!minute.allowed) {
      return jsonResponse(
        429,
        { error: 'Sakura needs a breather — give her a moment.', retry_after_seconds: minute.retryAfterSec, code: 'rate_limited' },
        cors,
      );
    }
    const day = await checkRateLimit(supabase, `sakura-ai:d:${wallet}`, RATE_PER_DAY, 86_400);
    if (!day.allowed) {
      return jsonResponse(
        429,
        {
          error: "You've hit today's Sakura AI limit. It resets in a few hours.",
          retry_after_seconds: day.retryAfterSec,
          code: 'daily_limit',
        },
        cors,
      );
    }

    // ── Entitlement ─────────────────────────────────────────────────────────
    let entitlement: Entitlement;
    try {
      entitlement = await getEntitlement(supabase, wallet, action === 'entitlement');
    } catch (e) {
      console.error('[sakura-ai] entitlement check failed', e instanceof Error ? e.message : e);
      return jsonResponse(
        503,
        { error: "Couldn't check your balance right now. Try again in a moment.", code: 'entitlement_unavailable' },
        cors,
      );
    }

    if (action === 'entitlement') {
      return jsonResponse(200, {
        entitled: entitlement.entitled,
        reason: entitlement.reason,
        // -1 means the XP door opened and the chain was never queried. Report
        // that as "unknown", not as a balance.
        sakura: entitlement.sakura < 0 ? null : entitlement.sakura,
        xp: entitlement.xp,
        min_holding: MIN_HOLDING_SAKURA,
        min_xp: MIN_LIFETIME_XP,
        requirement: GATE_COPY,
        limits: {
          per_minute: RATE_PER_MINUTE,
          per_day: RATE_PER_DAY,
          daily_token_budget: DAILY_TOKEN_BUDGET,
        },
      }, cors);
    }

    if (!entitlement.entitled) {
      return jsonResponse(
        402,
        {
          error: GATE_COPY,
          code: 'not_entitled',
          sakura: entitlement.sakura,
          xp: entitlement.xp,
          min_holding: MIN_HOLDING_SAKURA,
          min_xp: MIN_LIFETIME_XP,
        },
        cors,
      );
    }

    // ── Memory CRUD for the client (the table is service-role only now) ─────
    if (action === 'memories') {
      const op = typeof body.op === 'string' ? body.op : 'list';
      if (op === 'list') {
        const limit = Number(body.limit ?? 20);
        return jsonResponse(200, { ok: true, memories: await loadMemories(supabase, wallet, limit) }, cors);
      }
      if (op === 'add' || op === 'forget') {
        const name = op === 'add' ? 'remember' : 'forget';
        const result = await runServerTool(supabase, wallet, name, body as Record<string, unknown>);
        return jsonResponse(200, result as Record<string, unknown>, cors);
      }
      return jsonResponse(400, { error: 'Unknown memory op.' }, cors);
    }

    // ── Global token budget ─────────────────────────────────────────────────
    if (DAILY_TOKEN_BUDGET > 0) {
      const used = await dailyTokensUsed(supabase);
      if (used >= DAILY_TOKEN_BUDGET) {
        return jsonResponse(
          503,
          { error: "Sakura AI has hit today's limit across the whole app. She'll be back tomorrow.", code: 'budget_exhausted' },
          cors,
        );
      }
    }

    // ── Chat ────────────────────────────────────────────────────────────────
    const history = sanitizeMessages(body.messages);
    if (history.length === 0) return jsonResponse(400, { error: 'Messages are required.' }, cors);

    const surface = typeof body.surface === 'string' ? body.surface.slice(0, 40) : 'chat';
    const capabilities = Array.isArray(body.capabilities)
      ? (body.capabilities.filter((c) => typeof c === 'string') as string[])
      : undefined;
    const withdrawn: ToolGroup[] = [];
    const tools = resolveTools(capabilities, withdrawn);
    const activeGroups = resolveGroups(capabilities, withdrawn);

    // What the user is looking at. Rendered into the system block on every
    // turn rather than offered as a tool — see prompt.ts for why.
    const context =
      body.context && typeof body.context === 'object'
        ? (body.context as SakuraContext)
        : undefined;

    const memories = await loadMemories(supabase, wallet, MEMORY_INJECT);
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(memories, context, activeGroups) },
      ...history,
    ];

    const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let lastModel = PRIMARY_MODEL;

    for (let hop = 0; ; hop++) {
      // On the last hop, drop the tools entirely so the model has to answer in
      // prose rather than looping on server tools forever.
      const result = await callWithFallback(messages, hop >= MAX_SERVER_HOPS ? [] : tools);
      // NB: on the final hop the tools are withheld deliberately. The system
      // prompt still describes them, which is survivable — the model answering
      // in prose is the desired outcome there — but if that ever starts drawing
      // a phantom tool call, rebuild the prompt for that hop with no groups.

      if (!result.ok) {
        await recordUsage(supabase, wallet, lastModel, surface, usage);
        if (result.status === 429) {
          return jsonResponse(
            429,
            { error: 'Sakura AI is rate-limited right now. Try again shortly.', retry_after_seconds: result.retryAfter || 15, code: 'provider_rate_limited' },
            cors,
          );
        }
        return jsonResponse(502, { error: result.message }, cors);
      }

      lastModel = result.model;
      usage.prompt_tokens += result.usage.prompt_tokens;
      usage.completion_tokens += result.usage.completion_tokens;
      usage.total_tokens += result.usage.total_tokens;

      const calls = result.message.tool_calls ?? [];
      const serverCalls = calls.filter((c) => isServerTool(c.function?.name ?? ''));

      if (calls.length === 0 || serverCalls.length === 0) {
        await recordUsage(supabase, wallet, lastModel, surface, usage);
        return jsonResponse(
          200,
          { message: result.message, finish_reason: result.finish_reason, usage, model: lastModel },
          cors,
        );
      }

      const serverResults = await Promise.all(
        serverCalls.map(async (call) => ({
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(
            await runServerTool(supabase, wallet, call.function.name, parseArgs(call)).catch(
              (e) => ({ ok: false, error: e instanceof Error ? e.message : 'Tool failed' }),
            ),
          ),
        })),
      );

      // Mixed batch: the rest needs the device (signing key, local history), so
      // hand back the assistant message together with the results we already
      // produced. The client appends both before dispatching what's left.
      if (serverCalls.length !== calls.length) {
        await recordUsage(supabase, wallet, lastModel, surface, usage);
        return jsonResponse(
          200,
          {
            message: result.message,
            finish_reason: result.finish_reason,
            server_tool_results: serverResults,
            usage,
            model: lastModel,
          },
          cors,
        );
      }

      messages.push({ role: 'assistant', content: result.message.content, tool_calls: calls });
      for (const r of serverResults) {
        messages.push({ role: 'tool', tool_call_id: r.tool_call_id, content: r.content });
      }
    }
  } catch (e) {
    console.error('[sakura-ai] request failed', e instanceof Error ? e.message : e);
    return jsonResponse(500, { error: 'Sakura AI could not process that request.' }, cors);
  }
});
