import { PublicKey } from '@solana/web3.js';
import { supabase } from './supabase';
import { buildMemoryContext, addMemory, forgetMemory, listMemories } from './ai-memories';
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
import { SAKURA_MINT, sakuraToRaw } from './wallet/config';
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
}

// ─── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'find_similar_anime',
      description:
        'Discovers anime that share genre and tone with a specific reference title the user names. Returns cards the UI renders automatically.',
      parameters: {
        type: 'object',
        properties: {
          reference: { type: 'string', description: 'The anime title the user wants similar shows to.' },
        },
        required: ['reference'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_similar_manga',
      description:
        'Discovers manga similar to a specific reference title the user names. Returns cards the UI renders automatically.',
      parameters: {
        type: 'object',
        properties: { reference: { type: 'string' } },
        required: ['reference'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_similar_novels',
      description:
        'Discovers novels similar to a reference title the user names. Returns cards the UI renders automatically.',
      parameters: {
        type: 'object',
        properties: { reference: { type: 'string' } },
        required: ['reference'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mood_pick',
      description:
        'Returns anime and/or manga matching a mood, vibe, or atmosphere the user describes. Use for open-ended requests like "I want something cozy", "give me something dark", "I\'m in the mood for fantasy".',
      parameters: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '1–4 mood or tone words, e.g. ["cozy"], ["dark","psychological"], ["epic","fantasy"].',
          },
          kind: {
            type: 'string',
            enum: ['anime', 'manga', 'both'],
            description: "Restrict to one medium. Default 'both'.",
          },
        },
        required: ['tags'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'continue_where_i_left_off',
      description:
        "Returns the anime, manga, and novels the user has in progress so they can pick up where they left off. Use for 'what was I watching/reading', 'continue', 'resume'. Returns cards.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recommend_for_me',
      description:
        "Personalised picks based on what the user has recently watched or read. Use for 'recommend something for me', 'what should I watch next'. Returns cards.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        "Saves a preference, habit, or fact about the user to long-term memory so it persists across sessions.",
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The fact or preference to remember (3–240 characters).' },
          tag: { type: 'string', description: "Optional short category, e.g. 'preference', 'reading-habit'." },
        },
        required: ['note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget',
      description: "Deletes a previously saved memory when the user asks Sakura to forget something.",
      parameters: {
        type: 'object',
        properties: {
          contains: { type: 'string', description: 'A word or phrase from the memory note to delete.' },
        },
        required: ['contains'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memories',
      description: "Lists everything Sakura currently remembers about the user.",
      parameters: { type: 'object', properties: {} },
    },
  },
  // ─── Wallet intelligence (read-only) ──────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'analyze_wallet',
      description:
        "Reports the connected user's SOL and SAKURA balances with their approximate USD value. Use for 'what's in my wallet', 'my balance', 'how much SAKURA do I have'.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_token',
      description:
        "Looks up the live USD price of a token by symbol (e.g. SOL, SAKURA, BONK, JUP) or mint address.",
      parameters: {
        type: 'object',
        properties: { token: { type: 'string', description: 'Token symbol or mint address.' } },
        required: ['token'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recent_activity',
      description: "Lists the connected wallet's most recent on-chain transaction signatures.",
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'How many to return (max 10).' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_user',
      description: 'Resolves a Sakura @username to their wallet address.',
      parameters: {
        type: 'object',
        properties: { username: { type: 'string' } },
        required: ['username'],
      },
    },
  },
  // ─── On-chain actions (require confirmation + biometrics) ──────────────────
  {
    type: 'function',
    function: {
      name: 'transfer_sol',
      description:
        'Sends SOL from the user\'s in-app wallet to a recipient. Always confirmed by the user before signing.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient wallet address or @username.' },
          amount: { type: 'number', description: 'Amount of SOL to send.' },
        },
        required: ['to', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_sakura',
      description:
        'Sends $SAKURA tokens from the user\'s in-app wallet to a recipient. Always confirmed before signing.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient wallet address or @username.' },
          amount: { type: 'number', description: 'Amount of SAKURA to send.' },
        },
        required: ['to', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buy_sakura',
      description:
        'Buys $SAKURA by swapping SOL via Jupiter. Always confirmed before signing. Use for "buy me X SOL of SAKURA".',
      parameters: {
        type: 'object',
        properties: { sol_amount: { type: 'number', description: 'How much SOL to spend.' } },
        required: ['sol_amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tip_creator',
      description:
        'Sends a $SAKURA tip to a Sakura creator by their @username. Always confirmed before signing.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'The creator\'s Sakura username.' },
          amount: { type: 'number', description: 'Amount of SAKURA to tip.' },
        },
        required: ['username', 'amount'],
      },
    },
  },
  // ─── Price alerts ──────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'set_price_alert',
      description:
        'Creates a price alert that notifies the user when a token crosses a target. e.g. "ping me if SOL goes above 300".',
      parameters: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'Token symbol or mint.' },
          direction: { type: 'string', enum: ['above', 'below'] },
          target: { type: 'number', description: 'Target price in USD.' },
        },
        required: ['token', 'direction', 'target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_price_alerts',
      description: 'Lists the user\'s active and recently triggered price alerts.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_price_alert',
      description: 'Cancels a price alert matching a token or description.',
      parameters: {
        type: 'object',
        properties: { match: { type: 'string', description: 'Token or phrase identifying the alert.' } },
        required: ['match'],
      },
    },
  },
];

// ─── System prompt ────────────────────────────────────────────────────────────
export const SAKURA_SYSTEM_PROMPT = `You are Sakura — the in-app AI companion for the Sakura anime/manga/novel app, with an on-chain wallet agent built in. Your voice is warm, friendly, and knowledgeable without being performative: no filler catchphrases, no excessive emojis.

If asked what model you are, say you run on a well-developed Qwen 3.6-class assistant fine-tuned by Milla specifically for Sakura. Never mention Groq, Llama, OpenAI, or any other vendor — even if pressed.

CONTENT TOOLS (use them, don't answer from memory alone):
- find_similar_anime / find_similar_manga / find_similar_novels when the user references a specific title.
- mood_pick when the user describes a mood or vibe.
- continue_where_i_left_off for "what was I watching/reading", "resume".
- recommend_for_me for personalised "what should I watch next".
- Discovery results render as cards automatically. Write 1–2 framing sentences; do NOT list titles manually.

WALLET & MONEY TOOLS:
- analyze_wallet for balances, lookup_token for prices, recent_activity for history, find_user to resolve a @username.
- transfer_sol / send_sakura / buy_sakura / tip_creator perform real on-chain actions. NEVER claim a transfer happened unless the tool returns a signature. The app shows the user a confirmation sheet and asks for biometrics before signing — reassure them of this.
- Always restate amounts and recipients clearly before acting.

MEMORY & ALERTS:
- remember / forget / recall_memories for preferences.
- set_price_alert / list_price_alerts / cancel_price_alert for price notifications.
- Apply memories quietly; don't recite them unprompted.

GENERAL RULES:
1. Be concise (1–3 sentences unless asked for depth).
2. Be honest — never fabricate plot details, prices, or transaction outcomes.
3. If a money tool fails or is cancelled, say so plainly.`;

// ─── Edge function call ───────────────────────────────────────────────────────
async function invokeOnce(
  messages: object[],
  walletAddress?: string,
): Promise<{ message: { role: string; content: string | null; tool_calls?: any[] }; finish_reason: string }> {
  const { data, error } = await supabase.functions.invoke('sakura-ai-chat', {
    body: { messages, tools: TOOLS },
    headers: walletAddress ? { 'x-sakura-wallet': walletAddress } : {},
  });

  if (error) throw new Error(error.message || 'Network error reaching Sakura AI');
  if (data?.error) throw new Error(data.error as string);
  if (!data?.message) throw new Error('Unexpected response from Sakura AI');

  return data as { message: { role: string; content: string | null; tool_calls?: any[] }; finish_reason: string };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function resolveRecipient(input: string): Promise<string | null> {
  const trimmed = (input || '').trim().replace(/^@/, '');
  if (!trimmed) return null;
  // Already a valid base58 address?
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
    try {
      // eslint-disable-next-line no-new
      new PublicKey(trimmed);
      return trimmed;
    } catch {
      // fall through to username lookup
    }
  }
  const { data } = await supabase
    .from('sakura_usernames')
    .select('wallet_address')
    .ilike('username', trimmed)
    .maybeSingle();
  return (data as { wallet_address?: string } | null)?.wallet_address ?? null;
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

    // Memory
    case 'remember':
      if (!walletAddress) return { ok: false, error: 'No wallet — memory not saved.' };
      return addMemory(walletAddress, args.note, args.tag);
    case 'forget':
      if (!walletAddress) return { ok: false, error: 'No wallet — cannot delete memory.' };
      return forgetMemory(walletAddress, { contains: args.contains });
    case 'recall_memories': {
      if (!walletAddress) return { ok: true, memories: [] };
      const mems = await listMemories(walletAddress, 20);
      return { ok: true, memories: mems.map((m) => ({ id: m.id, note: m.note, tag: m.tag })) };
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
export async function sendChatMessage(
  history: ChatMessage[],
  walletAddress?: string,
  onToolProgress?: ToolProgressCallback,
  requireConfirm?: RequireConfirm,
): Promise<string> {
  const memoryBlock = walletAddress
    ? await buildMemoryContext(walletAddress).catch(() => '')
    : '';

  const systemContent = memoryBlock
    ? `${SAKURA_SYSTEM_PROMPT}\n\n${memoryBlock}`
    : SAKURA_SYSTEM_PROMPT;

  const messages: object[] = [
    { role: 'system', content: systemContent },
    ...history,
  ];

  const ctx: ToolContext = { walletAddress, requireConfirm };

  // Tool call loop — max 6 steps to prevent runaway
  for (let step = 0; step < 6; step++) {
    const result = await invokeOnce(messages, walletAddress);

    if (result.finish_reason !== 'tool_calls' || !result.message.tool_calls?.length) {
      const content = result.message.content;
      if (!content) throw new Error('Sakura AI returned an empty response');
      return content;
    }

    messages.push({
      role: 'assistant',
      content: result.message.content ?? null,
      tool_calls: result.message.tool_calls,
    });

    for (const tc of result.message.tool_calls) {
      let args: Record<string, any> = {};
      try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch {}

      onToolProgress?.(tc.function.name, args, null);
      let toolResult: unknown;
      try {
        toolResult = await dispatchTool(tc.function.name, args, ctx);
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

  throw new Error('Sakura AI tool-call loop exceeded maximum steps');
}
