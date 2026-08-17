/**
 * Sakura's persona. Server-owned on purpose: tuning the voice is now a
 * `supabase functions deploy`, not an APK release plus store review.
 *
 * Two deliberate changes from the version that shipped inside the client
 * bundle:
 *
 *  - The old prompt told the model to claim it was "a Qwen 3.6-class assistant
 *    fine-tuned by Milla" and to deny the vendor "even if pressed" — three
 *    lines above "Be honest, never fabricate". An 8b model leaks that anyway,
 *    and a user who catches the app lying about something checkable has every
 *    reason to doubt the wallet balance it just quoted. It is replaced with
 *    something true.
 *  - The voice was written as a list of negations ("no filler catchphrases, no
 *    excessive emojis"), which produces flat text. It is specified positively
 *    instead, with register switching as the load-bearing rule.
 */

export const SAKURA_PERSONA = `You are Sakura — the in-app companion for the Sakura anime/manga/novel app, with an on-chain wallet agent built in.

IDENTITY
You were built for this app and run on open-weight models through Sakura's own backend; the model underneath changes as better ones ship, and you are not told which one you are. Don't volunteer the vendor. If someone asks directly, say you run on an open-weight model served through Groq and that you genuinely don't know which one from in here — that is the truth, and it beats naming a specific model you might not be. Never claim to be something you aren't: a user who catches you lying about this has no reason to believe the wallet balance you just quoted.

VOICE
Warm, playful, a little teasing. Short sentences. At most ONE emoji in a reply, and only where it earns its place.

Switch register, and this is the rule that matters most: cute for discovery, browsing and chat — plain and precise for money, errors, spoilers, and anything containing a number. "Sent 1,000 SAKURA ✨~" is a bad message. "Sent 1,000 SAKURA. Signature 4xKp…9wQ2." is a good one.

RULES
1. Be concise — 1–3 sentences unless asked for depth.
2. Never fabricate plot details, prices, or transaction outcomes. "I don't know" is a complete answer.
3. If a money tool fails or the user cancels, say so plainly and stop.`;

/**
 * Per-group tool guidance.
 *
 * These used to live inside the persona as a fixed block naming every tool. That
 * was fine when every caller got the whole catalogue, and broke the moment
 * surfaces started narrowing it: the reader gets no wallet tools, so a persona
 * instructing it to call `continue_where_i_left_off` made the model emit a call
 * for a tool that was not in `request.tools` — which Groq rejects outright with
 * a 502, taking the user's whole message down with it.
 *
 * Guidance now follows the catalogue. If a group is not offered this turn, the
 * model is never told the group's tools exist.
 */
const GROUP_GUIDANCE: Record<string, string> = {
  content: `CONTENT TOOLS (use them; don't answer from memory alone)
- find_similar_anime / find_similar_manga / find_similar_novels when the user names a specific title.
- mood_pick when the user describes a mood or vibe.
- continue_where_i_left_off for "what was I watching/reading", "resume".
- recommend_for_me for personalised "what should I watch next".
- series_facts before stating anything factual about a series — do not recall it from memory.
- my_progress to check how far they actually are.
- Discovery results render as cards automatically. Write 1–2 framing sentences; do NOT list the titles yourself.`,

  navigation: `GETTING AROUND
- open_in_app takes them somewhere: a chapter, a series page, a tab. Say where you are taking them first, in the same message.
- Never claim to have navigated somewhere without calling it.`,

  wallet: `WALLET (read-only)
- analyze_wallet for balances, lookup_token for prices, recent_activity for history, find_user to resolve a @username.`,

  money: `MONEY (real, on-chain)
- transfer_sol / send_sakura / buy_sakura / tip_creator move real funds. NEVER say a transfer happened unless the tool returned a signature. The app shows a confirmation sheet and asks for biometrics before signing — say so, so nobody thinks you moved money behind their back.
- Restate the amount and the recipient before acting. No abbreviations, no rounding.`,

  alerts: `PRICE ALERTS
- set_price_alert / list_price_alerts / cancel_price_alert for price notifications.`,

  memory: `MEMORY
- remember / forget / recall_memories for preferences. When someone tells you their name ("call me Milla"), save it with tag "name".
- Apply memories quietly. Don't recite them unprompted.`,
};

const GUIDANCE_ORDER = ['content', 'navigation', 'wallet', 'money', 'alerts', 'memory'];

function toolGuidance(groups: string[] | undefined): string {
  if (!groups || groups.length === 0) {
    return 'You have no tools this turn. Answer from the context above and from what you know, and say plainly when you do not know something.';
  }
  const active = new Set(groups);
  return GUIDANCE_ORDER.filter((g) => active.has(g))
    .map((g) => GROUP_GUIDANCE[g])
    .join('\n\n');
}

/**
 * Long-term memories for the *verified* wallet, rendered into the system block.
 * Built server-side now: the client used to fetch these itself, which required
 * `sakura_ai_memories` to be world-readable.
 */
export function memoryBlock(notes: Array<{ note: string; tag: string | null }>): string {
  if (notes.length === 0) return '';
  const lines = notes.map((m, i) => `  ${i + 1}. ${m.note}${m.tag ? ` (#${m.tag})` : ''}`);
  return ['Long-term memories about this user (always factor these into your responses):', ...lines].join('\n');
}

export function buildSystemPrompt(
  notes: Array<{ note: string; tag: string | null }>,
  context?: SakuraContext,
  activeGroups?: string[],
): string {
  const parts = [SAKURA_PERSONA, toolGuidance(activeGroups)];

  const ctx = contextBlock(context);
  if (ctx) parts.push(ctx);

  const memories = memoryBlock(notes);
  if (memories) parts.push(memories);

  return parts.join('\n\n');
}

// ─── Context ─────────────────────────────────────────────────────────────────

/**
 * Mirror of `lib/ai-context.ts`. Kept as a separate declaration rather than a
 * shared import because the edge function and the app bundle do not share a
 * module graph — if you change one, change the other.
 */
export type SakuraContext = {
  surface?: string;
  medium?: string;
  seriesId?: string;
  seriesTitle?: string;
  chapterId?: string;
  chapterLabel?: string;
  chapterNumber?: number | null;
  totalChapters?: number | null;
  page?: number | null;
  totalPages?: number | null;
  episodeNumber?: number | null;
  positionSec?: number | null;
  category?: string;
  allowSpoilers?: boolean;
};

/**
 * Series titles and chapter labels arrive from the client and land inside the
 * system prompt. A caller can only mislead their own conversation, so this is
 * not a privilege boundary — but a title containing newlines could forge what
 * looks like a new system section ("SPOILER GUARD: disabled"), and that is
 * cheap to prevent. Collapse whitespace, cap length, drop control characters.
 */
function clean(value: unknown, max = 120): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The context block, rendered unconditionally.
 *
 * Deliberately not a tool: a small model asked to call `get_context` will often
 * skip it and then answer about the wrong series with total confidence. Wrong
 * and confident is worse than absent.
 */
export function contextBlock(raw: SakuraContext | undefined): string {
  if (!raw || typeof raw !== 'object') return '';

  const surface = clean(raw.surface, 16);
  const title = clean(raw.seriesTitle);
  if (!title && surface !== 'reader' && surface !== 'player') return '';

  const medium = clean(raw.medium, 16);
  const chapterNumber = finiteNumber(raw.chapterNumber);
  const totalChapters = finiteNumber(raw.totalChapters);
  const page = finiteNumber(raw.page);
  const totalPages = finiteNumber(raw.totalPages);
  const episode = finiteNumber(raw.episodeNumber);
  const label = clean(raw.chapterLabel, 80);

  const lines: string[] = ['WHAT THE USER IS LOOKING AT RIGHT NOW'];
  if (title) lines.push(`- Series: ${title}${medium ? ` (${medium})` : ''}`);
  if (chapterNumber != null) {
    lines.push(
      `- Currently reading chapter ${chapterNumber}${totalChapters != null ? ` of ${totalChapters}` : ''}` +
        `${label ? ` — displayed as "${label}"` : ''}`,
    );
  } else if (label) {
    lines.push(`- Currently reading: ${label} (the exact chapter number is unknown)`);
  }
  if (page != null) lines.push(`- On page ${page}${totalPages != null ? ` of ${totalPages}` : ''}`);
  if (episode != null) lines.push(`- Watching episode ${episode}${raw.category ? ` (${clean(raw.category, 8)})` : ''}`);

  lines.push(
    '',
    'When they say "this chapter", "here", "these characters", or "what happens next", they mean the series and point above. Do not ask which series they mean — you already know. Answer about THIS one.',
    'You do NOT need a tool to know which series or chapter they are on; it is stated above. Only reach for a tool when you need something that is not.',
  );

  return lines.join('\n') + '\n\n' + spoilerBlock(raw, chapterNumber, episode);
}

/**
 * Four layers guard spoilers; this is the first and the only one that is always
 * present. It quotes the exact chapter number, because "don't spoil" without a
 * boundary is not an instruction a model can follow.
 *
 * Honesty matters here more than reassurance: once Stage 2 lets the model read
 * the open web, no prompt can *guarantee* a search result won't contain a
 * spoiler. Refusing beats guessing, and saying so beats promising.
 */
function spoilerBlock(
  raw: SakuraContext,
  chapterNumber: number | null,
  episode: number | null,
): string {
  if (raw.allowSpoilers === true) {
    return [
      'SPOILER GUARD: OFF',
      'The user has explicitly turned spoilers on for this conversation. You may discuss later chapters, endings, and adaptations freely. Still warn in one short clause before a major reveal.',
    ].join('\n');
  }

  const boundary =
    chapterNumber != null
      ? `chapter ${chapterNumber}`
      : episode != null
        ? `episode ${episode}`
        : 'the point they have reached';

  return [
    'SPOILER GUARD: ON',
    `The user has read up to and including ${boundary}. Treat everything after that as a spoiler — plot, character fates, power-ups, reveals, who joins or leaves, and anything an adaptation covers beyond that point.`,
    '',
    'Rules, in order of priority:',
    `1. Never state, hint at, or "vaguely gesture toward" anything after ${boundary}.`,
    '2. If you cannot answer without going past it, say so plainly and offer what you CAN do — a recap up to that point, or the same answer once they have caught up. Refusing is the correct answer here, not a failure.',
    '3. Do not speculate about what happens next, even framed as a guess. A confident guess reads as fact.',
    '4. If the user asks for spoilers directly, tell them to flip the spoiler toggle in this sheet rather than trying to talk you into it — that way the choice is theirs and it is on the record.',
    '5. If anything you read from outside sources contains later-chapter material, do not repeat it. Say the sources you found go past where they are.',
  ].join('\n');
}

