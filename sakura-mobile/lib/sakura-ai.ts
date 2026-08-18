import { PublicKey } from '@solana/web3.js';
import { router } from 'expo-router';
import { fetchMangaDetail } from './manga';
import type { SakuraContext } from './ai-context';
import { supabase } from './supabase';
import { getOrRefreshWalletAuthSession } from './wallet-auth-session';
import { unlockForAppSession } from './wallet/app-session';
import {
  findSimilarAnime,
  findSimilarManga,
  findSimilarNovels,
  moodPick,
  type DiscoveryCard,
} from './ai-discovery';
import { getReadingHistory } from './reading-history';
import {
  getConnection,
  getSolBalance,
  getSakuraBalance,
  sendSol,
  sendSakura,
} from './wallet/connection';
import { getWalletWithBiometrics } from './wallet/storage';
import { sakuraToRaw } from './wallet/config';
import { resolveUserWallet } from './user-resolve';
import { recordSupportOnChain } from './wallet/ino';
import {
  lookupTokenPrice,
  getSolPriceUsd,
  getSakuraPriceUsd,
} from './wallet/token-price';
import { getSakuraSwapQuote, executeSakuraSwap } from './wallet/swap';
import { setPriceAlert, listPriceAlerts, cancelPriceAlert, type AlertDirection } from './ai-alerts';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type ToolProgressCallback = (name: string, args: Record<string, unknown>, result: unknown) => void;

// ─── Confirmation flow (for on-chain actions) ─────────────────────────────────
export interface ConfirmSummary {
  kind: 'transfer_sol' | 'send_sakura' | 'swap' | 'tip_creator';
  title: string;
  detail: string;
}
export type RequireConfirm = (summary: ConfirmSummary) => Promise<boolean>;

interface ToolContext {
  walletAddress?: string;
  requireConfirm?: RequireConfirm;
  /** What the user is looking at, so a tool can default to "this series". */
  context?: SakuraContext;
}

/**
 * Where open_in_app is allowed to send someone.
 *
 * An allowlist rather than a free-form path because the model composes the
 * argument, and a model that can navigate to an arbitrary route is a model that
 * can be talked into navigating somewhere unfortunate by text it read
 * elsewhere. Each entry builds its own path; nothing here concatenates
 * model output into a route.
 */
const NAV_TARGETS = {
  home: () => '/(tabs)/home',
  library: () => '/(tabs)/library',
  downloads: () => '/downloads',
  search: () => '/(tabs)/search',
} as const;

// ─── Edge function call ───────────────────────────────────────────────────────

/**
 * Tool groups this surface is able to dispatch. The catalogue itself now lives
 * on the server (supabase/functions/sakura-ai-chat/tools.ts) — the client only
 * declares what it can *run*, and the server decides what it is willing to
 * offer. It used to be the other way round, which meant anyone POSTing to the
 * function chose the model's powers.
 */
export type AiCapability = 'content' | 'wallet' | 'money' | 'alerts' | 'navigation';
const DEFAULT_CAPABILITIES: AiCapability[] = ['content', 'wallet', 'money', 'alerts', 'navigation'];

/**
 * What the reader surface asks for. Note what is absent: no 'money'. A surface
 * whose whole job is answering questions about a chapter has no business being
 * able to emit send_sakura, and the cheapest way to guarantee that is to never
 * put the tool in the schema. This matters more once Stage 2 puts web text in
 * the context window.
 */
export const READER_CAPABILITIES: AiCapability[] = ['content', 'navigation'];

export type ServerToolResult = { tool_call_id: string; name: string; content: string };

interface ChatTurn {
  message: { role: string; content: string | null; tool_calls?: any[] };
  finish_reason: string;
  server_tool_results?: ServerToolResult[];
}

/** A refusal we want shown to the user verbatim, not swallowed as "network error". */
export class SakuraAiError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SakuraAiError';
    this.code = code;
  }
}

async function aiHeaders(): Promise<Record<string, string>> {
  // unlockForAppSession, never getWalletWithBiometrics: this is a chat message,
  // and raising a modal captioned "Confirm transaction" for one is how users
  // learn to tap through confirmations without reading them.
  return getOrRefreshWalletAuthSession(unlockForAppSession, 'sakura-ai');
}

async function invokeAi(body: Record<string, unknown>): Promise<any> {
  let headers: Record<string, string>;
  try {
    headers = await aiHeaders();
  } catch {
    throw new SakuraAiError('Unlock your wallet to chat with Sakura.', 'locked');
  }

  const { data, error } = await supabase.functions.invoke('sakura-ai-chat', { body, headers });

  // supabase-js turns any non-2xx into `error` and hides the body, so the
  // server's own wording (the gate copy, the retry hint) is only reachable by
  // reading the Response off the FunctionsHttpError.
  if (error) {
    const res = (error as any)?.context as Response | undefined;
    if (res && typeof res.json === 'function') {
      try {
        const payload = await res.json();
        if (payload?.error) throw new SakuraAiError(String(payload.error), String(payload.code ?? res.status));
      } catch (e) {
        if (e instanceof SakuraAiError) throw e;
      }
    }
    throw new SakuraAiError(error.message || 'Network error reaching Sakura AI', 'network');
  }

  if (data?.error) throw new SakuraAiError(String(data.error), String(data.code ?? 'error'));
  return data;
}

async function invokeOnce(
  messages: object[],
  capabilities: AiCapability[],
  surface: string,
  context?: SakuraContext,
): Promise<ChatTurn> {
  const data = await invokeAi({ messages, capabilities, surface, context });
  if (!data?.message) throw new SakuraAiError('Unexpected response from Sakura AI', 'malformed');
  return data as ChatTurn;
}

/** Server-side entitlement check — the authoritative one. */
export async function fetchAiEntitlement(): Promise<{
  entitled: boolean;
  reason: 'holding' | 'xp' | 'none';
  sakura: number;
  xp: number;
  requirement: string;
}> {
  return invokeAi({ action: 'entitlement' });
}

/** Memory CRUD, routed through the function that knows the verified wallet. */
export async function invokeMemoryOp(body: Record<string, unknown>): Promise<any> {
  return invokeAi({ action: 'memories', ...body });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function resolveRecipient(input: string): Promise<string | null> {
  return resolveUserWallet(input);
}

function historyToCards(items: Awaited<ReturnType<typeof getReadingHistory>>): DiscoveryCard[] {
  return items.map((h) => {
    const route =
      h.kind === 'anime'
        ? `/anime/${encodeURIComponent(h.animeId || '')}`
        : h.kind === 'manga'
          ? `/manga/${encodeURIComponent(h.mangaId || '')}`
          : `/novel/${encodeURIComponent(h.novelPath || '')}`;
    return {
      kind: h.kind,
      id: h.id,
      title: h.title,
      image: h.cover,
      route,
    };
  });
}

// ─── Tool dispatch ────────────────────────────────────────────────────────────
async function dispatchTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext,
): Promise<unknown> {
  const { walletAddress, requireConfirm } = ctx;

  switch (name) {
    // Content
    case 'find_similar_anime':
      return findSimilarAnime(args.reference || '');
    case 'find_similar_manga':
      return findSimilarManga(args.reference || '');
    case 'find_similar_novels':
      return findSimilarNovels(args.reference || '');
    case 'mood_pick':
      return moodPick(args.tags || [], args.kind || 'both');
    case 'continue_where_i_left_off': {
      const items = await getReadingHistory(12);
      const inProgress = items.filter((i) => i.progress < 0.98);
      const cards = historyToCards(inProgress).slice(0, 8);
      return cards.length
        ? { ok: true, header: 'Pick up where you left off', cards }
        : { ok: true, header: '', cards: [], note: 'Nothing in progress yet.' };
    }
    case 'recommend_for_me': {
      const items = await getReadingHistory(20);
      if (items.length === 0) return { ok: true, cards: [], note: 'No history yet — watch or read something first.' };
      const ref = items[0];
      let result;
      if (ref.kind === 'anime') result = await findSimilarAnime(ref.title);
      else if (ref.kind === 'novel') result = await findSimilarNovels(ref.title);
      else result = await findSimilarManga(ref.title);
      return { ok: true, header: `Because you enjoyed ${ref.title}`, cards: result.cards };
    }

    // Memory (remember / forget / recall_memories) is executed inside the edge
    // function against the wallet it verified, and never reaches this switch.

    // Reader context tools. These are local reads — no vendor, no cost — and
    // they live here rather than only in the reader so that /ai can answer the
    // same questions. A tool the server offers but no surface implements comes
    // back to the user as "Unknown tool", which reads as the AI being broken.
    case 'series_facts': {
      const seriesId = String(args.series_id || ctx.context?.seriesId || '');
      if (!seriesId) {
        return {
          ok: false,
          error: 'No series in view. Ask the user which series they mean.',
        };
      }
      const detail = await fetchMangaDetail(seriesId).catch(() => null);
      if (!detail) return { ok: false, error: 'No stored facts for that series.' };
      return {
        ok: true,
        title: detail.title,
        description: detail.description,
        genres: detail.genres,
        status: detail.status,
        type: detail.type,
        rating: detail.rating ?? null,
      };
    }

    case 'my_progress': {
      const seriesId = String(args.series_id || ctx.context?.seriesId || '');
      const history = await getReadingHistory(60).catch(() => []);
      const match = seriesId
        ? history.find((h) => h.mangaId === seriesId || h.id === seriesId || h.animeId === seriesId)
        : history[0];
      if (!match) return { ok: true, found: false, note: 'Nothing recorded for that series yet.' };
      return {
        ok: true,
        found: true,
        title: match.title,
        kind: match.kind,
        where: match.subtitle,
        percent_through: Math.round((match.progress ?? 0) * 100),
        last_read: new Date(match.updatedAt).toISOString(),
      };
    }

    case 'open_in_app': {
      const target = String(args.target || '');

      if (target === 'chapter') {
        const seriesId = String(args.series_id || ctx.context?.seriesId || '');
        const chapterId = args.chapter_id ? String(args.chapter_id) : '';
        if (!chapterId) {
          // Resolving a chapter NUMBER to an id needs the reader's own loaded
          // chapter list, which this module does not have. The reader supplies
          // its own handler via dispatchExtra; anywhere else, say so honestly
          // rather than navigating somewhere approximate.
          return {
            ok: false,
            error: 'Opening a specific chapter only works from inside the reader.',
          };
        }
        // The reader's route id is `mangaId~chapterId`, not a bare chapter id.
        // Pushing the bare one opened a blank reader while this returned
        // ok: true — the model then told the user it had taken them there.
        // `seriesId` was already being computed here and simply not used.
        if (!seriesId) {
          return {
            ok: false,
            error: "I don't know which series that chapter belongs to.",
          };
        }
        const routeId = `${seriesId}~${chapterId}`;
        router.push({ pathname: '/chapter/[id]', params: { id: routeId } } as never);
        return { ok: true, opened: 'chapter', chapter_id: chapterId };
      }

      if (target === 'series') {
        const seriesId = String(args.series_id || ctx.context?.seriesId || '');
        if (!seriesId) return { ok: false, error: 'No series to open.' };
        router.push({ pathname: '/manga/[id]', params: { id: seriesId } } as never);
        return { ok: true, opened: 'series', series_id: seriesId };
      }

      const build = NAV_TARGETS[target as keyof typeof NAV_TARGETS];
      if (!build) return { ok: false, error: `Can't open "${target}".` };
      router.push(build() as never);
      return { ok: true, opened: target };
    }

    // Wallet intelligence
    case 'analyze_wallet': {
      if (!walletAddress) return { ok: false, error: 'Connect a wallet first.' };
      const pk = new PublicKey(walletAddress);
      const [sol, sakura, solPrice, sakuraPrice] = await Promise.all([
        getSolBalance(pk),
        getSakuraBalance(pk),
        getSolPriceUsd(),
        getSakuraPriceUsd(),
      ]);
      const solUsd = (sol ?? 0) * solPrice;
      const sakuraUsd = (sakura ?? 0) * sakuraPrice;
      return {
        ok: true,
        sol: sol ?? 0,
        sakura: sakura ?? 0,
        sol_usd: solUsd,
        sakura_usd: sakuraUsd,
        total_value_usd: solUsd + sakuraUsd,
      };
    }
    case 'lookup_token': {
      const price = await lookupTokenPrice(args.token || '');
      if (!price) return { ok: false, error: `Couldn't find a price for "${args.token}".` };
      return { ok: true, symbol: price.symbol || args.token, price_usd: price.priceUsd, mint: price.mint };
    }
    case 'recent_activity': {
      if (!walletAddress) return { ok: false, error: 'Connect a wallet first.' };
      const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
      const sigs = await getConnection().getSignaturesForAddress(new PublicKey(walletAddress), { limit });
      return {
        ok: true,
        transactions: sigs.map((s) => ({
          signature: s.signature,
          slot: s.slot,
          err: s.err ? 'failed' : 'success',
          time: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
        })),
      };
    }
    case 'find_user': {
      const wallet = await resolveRecipient(`@${(args.username || '').replace(/^@/, '')}`);
      return wallet
        ? { ok: true, found: true, username: args.username, wallet }
        : { ok: true, found: false };
    }

    // On-chain actions
    case 'transfer_sol': {
      if (!walletAddress) return { ok: false, error: 'Connect a wallet first.' };
      const to = await resolveRecipient(args.to || '');
      if (!to) return { ok: false, error: `Couldn't resolve recipient "${args.to}".` };
      const amount = Number(args.amount);
      if (!(amount > 0)) return { ok: false, error: 'Amount must be positive.' };
      const approved = requireConfirm
        ? await requireConfirm({ kind: 'transfer_sol', title: `Send ${amount} SOL`, detail: `To ${to.slice(0, 8)}…${to.slice(-4)}` })
        : false;
      if (!approved) return { ok: false, error: 'Transfer cancelled.' };
      const keypair = await getWalletWithBiometrics();
      if (!keypair) return { ok: false, error: 'Could not unlock wallet.' };
      const signature = await sendSol(keypair, to, amount);
      return { ok: true, signature, amount, to };
    }
    case 'send_sakura': {
      if (!walletAddress) return { ok: false, error: 'Connect a wallet first.' };
      const to = await resolveRecipient(args.to || '');
      if (!to) return { ok: false, error: `Couldn't resolve recipient "${args.to}".` };
      const amount = Number(args.amount);
      if (!(amount > 0)) return { ok: false, error: 'Amount must be positive.' };
      const pk = new PublicKey(walletAddress);
      const [sol, sakura] = await Promise.all([getSolBalance(pk), getSakuraBalance(pk)]);
      if ((sakura ?? 0) < amount) {
        return { ok: false, error: `Insufficient SAKURA. Available: ${Math.floor(sakura ?? 0).toLocaleString()}.` };
      }
      if ((sol ?? 0) < 0.003) {
        return { ok: false, error: 'You need a small amount of SOL (~0.003) for network fees when sending SAKURA.' };
      }
      const approved = requireConfirm
        ? await requireConfirm({ kind: 'send_sakura', title: `Send ${amount.toLocaleString()} SAKURA`, detail: `To ${to.slice(0, 8)}…${to.slice(-4)}` })
        : false;
      if (!approved) return { ok: false, error: 'Transfer cancelled.' };
      const keypair = await getWalletWithBiometrics();
      if (!keypair) return { ok: false, error: 'Could not unlock wallet.' };
      const signature = await sendSakura(keypair, to, amount);
      return { ok: true, signature, amount, to, symbol: 'SAKURA' };
    }
    case 'buy_sakura': {
      if (!walletAddress) return { ok: false, error: 'Connect a wallet first.' };
      const solAmount = Number(args.sol_amount);
      if (!(solAmount > 0)) return { ok: false, error: 'SOL amount must be positive.' };
      const quote = await getSakuraSwapQuote(solAmount);
      const approved = requireConfirm
        ? await requireConfirm({
            kind: 'swap',
            title: `Buy ~${Math.round(quote.outAmountSakura).toLocaleString()} SAKURA`,
            detail: `Spending ${solAmount} SOL · price impact ${Number(quote.priceImpactPct).toFixed(2)}%`,
          })
        : false;
      if (!approved) return { ok: false, error: 'Swap cancelled.' };
      const keypair = await getWalletWithBiometrics();
      if (!keypair) return { ok: false, error: 'Could not unlock wallet.' };
      const result = await executeSakuraSwap(quote, keypair);
      if (!result.success) return { ok: false, error: result.error || 'Swap failed.' };
      return { ok: true, signature: result.txid, input_amount: solAmount, output_amount: quote.outAmountSakura };
    }
    case 'tip_creator': {
      if (!walletAddress) return { ok: false, error: 'Connect a wallet first.' };
      const username = (args.username || '').replace(/^@/, '');
      const wallet = await resolveRecipient(`@${username}`);
      if (!wallet) return { ok: false, error: `${args.username} isn't on Sakura yet.` };
      const amount = Number(args.amount);
      if (!(amount > 0)) return { ok: false, error: 'Tip amount must be positive.' };
      const approved = requireConfirm
        ? await requireConfirm({ kind: 'tip_creator', title: `Tip @${username} ${amount.toLocaleString()} SAKURA`, detail: `To ${wallet.slice(0, 8)}…${wallet.slice(-4)}` })
        : false;
      if (!approved) return { ok: false, error: 'Tip cancelled.' };
      const keypair = await getWalletWithBiometrics();
      if (!keypair) return { ok: false, error: 'Could not unlock wallet.' };
      const signature = await sendSakura(keypair, wallet, amount);
      // Best-effort: record the tip in the on-chain Ino support registry.
      let supportSignature: string | undefined;
      try {
        supportSignature = await recordSupportOnChain(
          keypair,
          new PublicKey(wallet),
          BigInt(sakuraToRaw(amount)),
        );
      } catch {
        // registry record is non-critical; the tip already settled
      }
      return { ok: true, signature, support_signature: supportSignature, creator: `@${username}`, amount };
    }

    // Price alerts
    case 'set_price_alert':
      return setPriceAlert(args.token || '', (args.direction as AlertDirection) || 'above', Number(args.target));
    case 'list_price_alerts': {
      const { active, triggered } = await listPriceAlerts();
      return {
        ok: true,
        active: active.map((a) => ({ id: a.id, summary: `${a.token} ${a.direction} $${a.target}` })),
        triggered: triggered.map((a) => ({ id: a.id, summary: `${a.token} ${a.direction} $${a.target}` })),
      };
    }
    case 'cancel_price_alert':
      return cancelPriceAlert(args.match || '');

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
// ─── Main send function ───────────────────────────────────────────────────────

export interface SendChatOptions {
  /** Which tool groups this surface can dispatch. Defaults to all of them. */
  capabilities?: AiCapability[];
  /** Free-form label recorded against token usage, e.g. 'chat', 'reader'. */
  surface?: string;
  /**
   * What the user is looking at. Sent on every hop, not just the first: the
   * server rebuilds the system prompt from scratch each time, so dropping it
   * mid-conversation would silently disarm the spoiler guard.
   */
  context?: SakuraContext;
  /** Lets a surface run a tool the shared dispatcher doesn't know about. */
  dispatchExtra?: (name: string, args: Record<string, any>) => Promise<unknown> | unknown;
}

export async function sendChatMessage(
  history: ChatMessage[],
  walletAddress?: string,
  onToolProgress?: ToolProgressCallback,
  requireConfirm?: RequireConfirm,
  options?: SendChatOptions,
): Promise<string> {
  // No system message and no memory block here any more: the server owns the
  // persona and injects the memories itself, against the wallet it verified
  // rather than the one the client claims. Anything role:'system' we sent would
  // be dropped there anyway.
  const messages: object[] = [...history];

  const capabilities = options?.capabilities ?? DEFAULT_CAPABILITIES;
  const surface = options?.surface ?? 'chat';
  const ctx: ToolContext = { walletAddress, requireConfirm, context: options?.context };

  // Tool call loop — max 6 steps to prevent runaway
  for (let step = 0; step < 6; step++) {
    const result = await invokeOnce(messages, capabilities, surface, options?.context);
    const calls = result.message.tool_calls ?? [];

    // Branch on the calls themselves, NOT on finish_reason. The server exits on
    // `calls.length === 0 || serverCalls.length === 0`; if the client also
    // required finish_reason === 'tool_calls' the two could disagree, and they
    // do: a provider returning tool_calls alongside 'stop' or 'length' sent the
    // client down the final-answer path, where content is null and the turn died
    // with "returned an empty response". On the mixed-batch path the server has
    // already run its tools by then, so a `remember` write landed and the
    // conversation carrying it was thrown away.
    if (calls.length === 0) {
      const content = result.message.content;
      if (!content) throw new SakuraAiError('Sakura AI returned an empty response', 'empty');
      return content;
    }

    messages.push({
      role: 'assistant',
      content: result.message.content ?? null,
      tool_calls: calls,
    });

    // Memory tools run server-side against the verified wallet and come back
    // already answered. Replay their results into the transcript and skip
    // dispatching them — every tool_call still needs a matching tool message or
    // the provider rejects the next hop.
    const preAnswered = new Set<string>();
    for (const r of result.server_tool_results ?? []) {
      preAnswered.add(r.tool_call_id);
      messages.push({ role: 'tool', tool_call_id: r.tool_call_id, content: r.content });
    }

    for (const tc of calls) {
      if (preAnswered.has(tc.id)) continue;

      let args: Record<string, any> = {};
      try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch {}

      onToolProgress?.(tc.function.name, args, null);
      let toolResult: unknown;
      try {
        // A surface can own tools the shared dispatcher knows nothing about —
        // the reader's navigation and series lookups need the reader's own
        // state, which does not exist here.
        const extra = await options?.dispatchExtra?.(tc.function.name, args);
        toolResult =
          extra === undefined ? await dispatchTool(tc.function.name, args, ctx) : extra;
      } catch (e: any) {
        toolResult = { ok: false, error: e?.message || 'Tool failed' };
      }
      onToolProgress?.(tc.function.name, args, toolResult);

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  throw new SakuraAiError('Sakura AI tool-call loop exceeded maximum steps', 'loop');
}
