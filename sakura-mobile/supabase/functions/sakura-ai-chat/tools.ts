/**
 * The tool catalogue, server-owned.
 *
 * It used to ship inside the client bundle and arrive on every request as
 * `body.tools`, which meant the caller decided what the model was allowed to
 * do. That is exactly backwards once untrusted text can reach the context
 * (Stage 2 adds web search), so the catalogue lives here and the client sends
 * only a list of *capabilities* — "this surface can dispatch content tools and
 * wallet tools" — which the server intersects with what it is willing to offer.
 *
 * `executor` says who runs the tool. `server` tools are executed inside the
 * edge function against the verified wallet and never reach the client;
 * `client` tools need the device (the signing key, local reading history,
 * navigation) and are returned for dispatch.
 */

export type ToolGroup = 'content' | 'memory' | 'wallet' | 'money' | 'alerts' | 'navigation';

export type SakuraTool = {
  group: ToolGroup;
  executor: 'server' | 'client';
  schema: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
};

const t = (
  group: ToolGroup,
  executor: 'server' | 'client',
  name: string,
  description: string,
  parameters: Record<string, unknown> = { type: 'object', properties: {} },
): SakuraTool => ({ group, executor, schema: { type: 'function', function: { name, description, parameters } } });

export const CATALOGUE: SakuraTool[] = [
  // ─── Content discovery ────────────────────────────────────────────────────
  t('content', 'client', 'find_similar_anime',
    'Discovers anime that share genre and tone with a specific reference title the user names. Returns cards the UI renders automatically.',
    { type: 'object', properties: { reference: { type: 'string', description: 'The anime title the user wants similar shows to.' } }, required: ['reference'] }),
  t('content', 'client', 'find_similar_manga',
    'Discovers manga similar to a specific reference title the user names. Returns cards the UI renders automatically.',
    { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'] }),
  t('content', 'client', 'find_similar_novels',
    'Discovers novels similar to a reference title the user names. Returns cards the UI renders automatically.',
    { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'] }),
  t('content', 'client', 'mood_pick',
    'Returns anime and/or manga matching a mood, vibe, or atmosphere the user describes. Use for open-ended requests like "I want something cozy", "give me something dark", "I am in the mood for fantasy".',
    {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: '1–4 mood or tone words, e.g. ["cozy"], ["dark","psychological"], ["epic","fantasy"].' },
        kind: { type: 'string', enum: ['anime', 'manga', 'both'], description: "Restrict to one medium. Default 'both'." },
      },
      required: ['tags'],
    }),
  t('content', 'client', 'continue_where_i_left_off',
    "Returns the anime, manga, and novels the user has in progress so they can pick up where they left off. Use for 'what was I watching/reading', 'continue', 'resume'. Returns cards."),
  t('content', 'client', 'recommend_for_me',
    "Personalised picks based on what the user has recently watched or read. Use for 'recommend something for me', 'what should I watch next'. Returns cards."),

  // ─── Reader context (local data, no vendor, no cost) ─────────────────────
  t('content', 'client', 'series_facts',
    'Facts the app already holds about a series — synopsis, genres, status, author, chapter count. Use this before answering anything factual about what the user is reading, instead of recalling it from memory.',
    {
      type: 'object',
      properties: {
        series_id: { type: 'string', description: 'Omit to use the series the user is currently reading.' },
      },
    }),
  t('content', 'client', 'my_progress',
    "How far the user has actually got in a series — last chapter or episode reached, and when. Use it for 'where was I', and to check what is safe to discuss without spoiling.",
    {
      type: 'object',
      properties: {
        series_id: { type: 'string', description: 'Omit to use the series the user is currently reading.' },
      },
    }),
  t('navigation', 'client', 'open_in_app',
    "Takes the user somewhere in the app — a specific chapter, a series page, or a tab. Use it when they ask to go, jump, open, or continue somewhere. Say where you are taking them before you call it.",
    {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['chapter', 'series', 'library', 'home', 'downloads', 'search'],
          description: "What kind of place. 'chapter' needs chapter_number or chapter_id.",
        },
        chapter_number: { type: 'number', description: 'For target=chapter.' },
        chapter_id: { type: 'string', description: 'For target=chapter, if known exactly.' },
        series_id: { type: 'string', description: 'Defaults to the series being read.' },
      },
      required: ['target'],
    }),

  // ─── Memory (executed server-side against the verified wallet) ────────────
  t('memory', 'server', 'remember',
    'Saves a preference, habit, or fact about the user to long-term memory so it persists across sessions.',
    {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The fact or preference to remember (3–240 characters).' },
        tag: { type: 'string', description: "Optional short category, e.g. 'preference', 'reading-habit'." },
      },
      required: ['note'],
    }),
  t('memory', 'server', 'forget',
    'Deletes a previously saved memory when the user asks Sakura to forget something.',
    { type: 'object', properties: { contains: { type: 'string', description: 'A word or phrase from the memory note to delete.' } }, required: ['contains'] }),
  t('memory', 'server', 'recall_memories',
    'Lists everything Sakura currently remembers about the user.'),

  // ─── Wallet intelligence (read-only) ──────────────────────────────────────
  t('wallet', 'client', 'analyze_wallet',
    "Reports the connected user's SOL and SAKURA balances with their approximate USD value. Use for 'what's in my wallet', 'my balance', 'how much SAKURA do I have'."),
  t('wallet', 'client', 'lookup_token',
    'Looks up the live USD price of a token by symbol (e.g. SOL, SAKURA, BONK, JUP) or mint address.',
    { type: 'object', properties: { token: { type: 'string', description: 'Token symbol or mint address.' } }, required: ['token'] }),
  t('wallet', 'client', 'recent_activity',
    "Lists the connected wallet's most recent on-chain transaction signatures.",
    { type: 'object', properties: { limit: { type: 'number', description: 'How many to return (max 10).' } } }),
  t('wallet', 'client', 'find_user',
    'Resolves a Sakura @username to their wallet address.',
    { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] }),

  // ─── On-chain actions (confirmation sheet + biometrics on the device) ─────
  t('money', 'client', 'transfer_sol',
    "Sends SOL from the user's in-app wallet to a recipient. Always confirmed by the user before signing.",
    {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient wallet address or @username.' },
        amount: { type: 'number', description: 'Amount of SOL to send.' },
      },
      required: ['to', 'amount'],
    }),
  t('money', 'client', 'send_sakura',
    "Sends $SAKURA tokens from the user's in-app wallet to a recipient. Always confirmed before signing.",
    {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient wallet address or @username.' },
        amount: { type: 'number', description: 'Amount of SAKURA to send.' },
      },
      required: ['to', 'amount'],
    }),
  t('money', 'client', 'buy_sakura',
    'Buys $SAKURA by swapping SOL via Jupiter. Always confirmed before signing. Use for "buy me X SOL of SAKURA".',
    { type: 'object', properties: { sol_amount: { type: 'number', description: 'How much SOL to spend.' } }, required: ['sol_amount'] }),
  t('money', 'client', 'tip_creator',
    'Sends a $SAKURA tip to a Sakura creator by their @username. Always confirmed before signing.',
    {
      type: 'object',
      properties: {
        username: { type: 'string', description: "The creator's Sakura username." },
        amount: { type: 'number', description: 'Amount of SAKURA to tip.' },
      },
      required: ['username', 'amount'],
    }),

  // ─── Price alerts ─────────────────────────────────────────────────────────
  t('alerts', 'client', 'set_price_alert',
    'Creates a price alert that notifies the user when a token crosses a target. e.g. "ping me if SOL goes above 300".',
    {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Token symbol or mint.' },
        direction: { type: 'string', enum: ['above', 'below'] },
        target: { type: 'number', description: 'Target price in USD.' },
      },
      required: ['token', 'direction', 'target'],
    }),
  t('alerts', 'client', 'list_price_alerts',
    "Lists the user's active and recently triggered price alerts."),
  t('alerts', 'client', 'cancel_price_alert',
    'Cancels a price alert matching a token or description.',
    { type: 'object', properties: { match: { type: 'string', description: 'Token or phrase identifying the alert.' } }, required: ['match'] }),
];

/** Groups a surface may request. Memory is always on — the server runs it. */
export const REQUESTABLE_GROUPS: ToolGroup[] = ['content', 'wallet', 'money', 'alerts', 'navigation'];

const BY_NAME = new Map(CATALOGUE.map((tool) => [tool.schema.function.name, tool]));

export function toolByName(name: string): SakuraTool | undefined {
  return BY_NAME.get(name);
}

export function isServerTool(name: string): boolean {
  return BY_NAME.get(name)?.executor === 'server';
}

/**
 * Resolve the tool schemas for a turn. `requested` comes from the client and is
 * intersected with what the server allows — a surface can narrow the catalogue
 * but never widen it, and can never reach a group the server has withdrawn for
 * this turn (Stage 2 withdraws `money` once web content is in the context).
 */
/** Which groups are actually live this turn — the persona is built from this,
 *  so the model is never told about tools it cannot call. */
export function resolveGroups(
  requested: string[] | undefined,
  withdrawn: ToolGroup[] = [],
): ToolGroup[] {
  const blocked = new Set(withdrawn);
  const asked = Array.isArray(requested)
    ? new Set(requested.filter((g): g is ToolGroup => (REQUESTABLE_GROUPS as string[]).includes(g)))
    : new Set<ToolGroup>(REQUESTABLE_GROUPS);

  const groups = new Set<ToolGroup>();
  for (const tool of CATALOGUE) {
    if (blocked.has(tool.group)) continue;
    if (tool.group === 'memory' || asked.has(tool.group)) groups.add(tool.group);
  }
  return [...groups];
}

export function resolveTools(
  requested: string[] | undefined,
  withdrawn: ToolGroup[] = [],
): SakuraTool['schema'][] {
  // An EMPTY array means "no client tools", not "surprise me". Treating [] as
  // absent — which is what `length > 0` did — handed the full catalogue,
  // money tools included, to any surface that thought it was asking for
  // nothing. Only a genuinely absent field falls back to everything, and that
  // exists solely so an older client that predates capabilities keeps working.
  const asked = Array.isArray(requested)
    ? new Set(requested.filter((g): g is ToolGroup => (REQUESTABLE_GROUPS as string[]).includes(g)))
    : new Set<ToolGroup>(REQUESTABLE_GROUPS);

  const blocked = new Set(withdrawn);
  return CATALOGUE.filter(
    (tool) => !blocked.has(tool.group) && (tool.group === 'memory' || asked.has(tool.group)),
  ).map((tool) => tool.schema);
}
