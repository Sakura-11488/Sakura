import type { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { groqChat, type ChatMessage, type ToolDefinition } from "./groq";
import {
    aiGetSakuraBalance,
    aiGetSolBalance,
    aiGetSwapQuote,
    aiExecuteSwap,
    aiGetBridgeQuote,
    aiExecuteBridge,
    aiGetBridgeStatus,
    aiTransferSol,
    aiTransferToken,
    aiOpenBridge,
    type SwapQuoteSummary,
    type BridgeQuoteSummary,
} from "./actions";
import { resolveToken } from "./tokens";
import {
    getUsernameForWallet,
    setUsernameForWallet,
    findWalletByUsername,
    isValidUsername,
    isPlaceholderUsername,
} from "./usernames";
import { getRecentActivity, getWalletPortfolio, getTokenSummary } from "./helius";
import { findSimilarAnime, findSimilarManga, findSimilarNovels } from "./discovery";
import { getResumeItems, recommendForMe } from "./library";
import { moodPick } from "./mood";
import { recapAnime, recapManga } from "./recap";
import { findCreatorByQuery } from "./creators";
import {
    addMemory,
    buildMemoryContext,
    forgetMemory,
    listMemories,
} from "./memories";
import {
    cancelPriceAlert,
    createPriceAlert,
    listActivePriceAlerts,
    listRecentlyTriggeredAlerts,
    summarizeAlert,
    type AlertDirection,
} from "./alerts";
import { buildDailyBrief } from "./brief";
import {
    createEvmBridgeWallet,
    getEvmBridgeWallet,
    markEvmBridgeWalletBackedUp,
    revealEvmBridgePrivateKey,
} from "./evm-wallet";

export const SAKURA_AI_MIN_BALANCE = 100_000;

/**
 * Engine that drives the Sakura AI chat loop.
 *
 * The host UI passes in a `Context` with the user's wallet adapter, the
 * stored conversation, and a `requireConfirm` callback that prompts the
 * user before any signed/state-changing tool runs. The engine:
 *
 *   1. Pre-fetches the user's username (creates the prompt context the
 *      model needs to know who it's talking to).
 *   2. Calls the chat backend with the system prompt + conversation + tool defs.
 *   3. Dispatches each tool call locally, appending the result.
 *   4. Loops until the model returns a plain `assistant` message.
 *
 * Side effects (transfers, swaps, bridge handoffs) are gated behind
 * `requireConfirm`, never auto-executed.
 */

export interface SakuraAiContext {
    walletPublicKey: PublicKey;
    walletAddress: string;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
    signTransactionVersioned: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
    /** Prompts the user to approve a destructive tool. Return true to proceed. */
    requireConfirm: (summary: ConfirmSummary) => Promise<boolean>;
    /** Optional notifier for streaming tool-progress to the UI. */
    onToolProgress?: (event: ToolEvent) => void;
}

export interface ConfirmSummary {
    kind:
        | "transfer_sol"
        | "transfer_token"
        | "swap"
        | "bridge"
        | "set_username"
        | "tip_creator"
        | "set_memory"
        | "create_evm_wallet"
        | "set_price_alert";
    title: string;
    detail: string;
}

export interface ToolEvent {
    name: string;
    args: any;
    result: any;
}

export interface RunOptions {
    history: ChatMessage[];
    userMessage: string;
    context: SakuraAiContext;
}

export interface RunResult {
    history: ChatMessage[];
    /** The assistant's last natural-language reply. */
    reply: string;
    toolEvents: ToolEvent[];
}

/**
 * Tool definitions for Sakura AI.
 *
 * Each `description` describes the tool's PURPOSE and the kind of intent it
 * fulfils — never specific trigger phrases. The model is expected to read
 * what the user actually wants (semantic intent) and pick the matching
 * capability, not pattern-match keywords.
 *
 * Style rules for descriptions in this file:
 *   • Lead with what the tool DOES, not when to call it.
 *   • Describe the user-need it satisfies in plain functional terms
 *     ("when the user wants to know …", "when the user has expressed …").
 *   • Never quote example sentences. The model translates intent →
 *     capability; we don't pre-bake the wording.
 */
const TOOL_DEFINITIONS: ToolDefinition[] = [
    {
        type: "function",
        function: {
            name: "get_my_balances",
            description:
                "Returns the user's own SOL balance plus their full SPL token portfolio with current USD values. Choose this whenever the user wants to know what they currently hold, the dollar value of their wallet, or which assets they own.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
        },
    },
    {
        type: "function",
        function: {
            name: "analyze_wallet",
            description:
                "Returns a portfolio snapshot for SOMEONE ELSE'S Solana wallet (top holdings + total USD). Choose this when the user wants insight into a specific wallet they don't own — typing or pasting an address, asking about another person's holdings, or vetting a wallet.",
            parameters: {
                type: "object",
                properties: {
                    address: { type: "string", description: "Solana wallet base58 address." },
                },
                required: ["address"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "recent_activity",
            description:
                "Returns recent enriched transactions for a wallet (defaults to the user's own). Choose this when the user wants to inspect their on-chain history — recent activity, last transfers, swap history, where their money went.",
            parameters: {
                type: "object",
                properties: {
                    address: { type: "string", description: "Optional. Defaults to the user's own wallet." },
                    limit: { type: "integer", description: "1–25, default 10." },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "lookup_token",
            description:
                "Returns metadata + current USD price for a single SPL token (by symbol or mint). Choose this when the user wants to know the price or details of a specific token, independent of their wallet.",
            parameters: {
                type: "object",
                properties: {
                    symbol_or_mint: { type: "string", description: "e.g. SOL, USDC, SAKURA, or a base58 mint." },
                },
                required: ["symbol_or_mint"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_username",
            description:
                "Returns the user's saved Sakura handle (or null). Useful when the user asks who they are on Sakura, what name is set, or before deciding whether to prompt them for one.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
        },
    },
    {
        type: "function",
        function: {
            name: "set_username",
            description:
                "Saves a chosen handle for the current user. Choose this only after the user has clearly told you the actual handle they want — never invent one. Format is 3-20 alphanumeric/underscore characters; the tool itself rejects placeholders.",
            parameters: {
                type: "object",
                properties: {
                    username: { type: "string" },
                    display_name: { type: "string", description: "Optional friendly name." },
                },
                required: ["username"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "find_user",
            description:
                "Resolves another Sakura user's wallet from their handle. Choose this whenever the conversation references a person by name/handle and you need their wallet to act on it (e.g. before a transfer to a person rather than an address).",
            parameters: {
                type: "object",
                properties: { username: { type: "string" } },
                required: ["username"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "swap_quote",
            description:
                "Returns a Jupiter swap quote between two SPL tokens (showing output amount + price impact). Choose this when the user is exploring or about to perform a token swap — always quote first so they can see the rate before committing.",
            parameters: {
                type: "object",
                properties: {
                    input_token: { type: "string" },
                    output_token: { type: "string" },
                    input_amount: { type: "number", description: "Human-readable amount of input_token." },
                },
                required: ["input_token", "output_token", "input_amount"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "swap_execute",
            description:
                "Signs and broadcasts the swap shown by swap_quote. Choose this only after the user has agreed to the quote you presented. Pass the same tokens + amount.",
            parameters: {
                type: "object",
                properties: {
                    input_token: { type: "string" },
                    output_token: { type: "string" },
                    input_amount: { type: "number" },
                },
                required: ["input_token", "output_token", "input_amount"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "transfer_sol",
            description:
                "Sends native SOL from the user's wallet to another wallet. Choose this when the user has expressed intent to move SOL specifically — never tokens — to a known address. Requires biometric confirmation.",
            parameters: {
                type: "object",
                properties: {
                    to_address: { type: "string", description: "Recipient base58 wallet address." },
                    amount_sol: { type: "number", description: "Amount in SOL (UI units)." },
                },
                required: ["to_address", "amount_sol"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "transfer_token",
            description:
                "Sends an SPL token (Token or Token-2022) from the user's wallet to another wallet. Choose this when the user wants to move a non-SOL token (SAKURA, USDC, BONK, custom mint, etc.). Requires biometric confirmation.",
            parameters: {
                type: "object",
                properties: {
                    to_address: { type: "string" },
                    token: { type: "string", description: "Symbol (SOL, USDC, SAKURA…) or mint address." },
                    amount: { type: "number", description: "Amount in human-readable units." },
                },
                required: ["to_address", "token", "amount"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "bridge_quote",
            description:
                "Returns a native Mayan bridge quote for routes that START on Solana. Choose this before bridge_execute so the user can see output amount, minimum received, slippage, route type, and ETA before signing.",
            parameters: {
                type: "object",
                properties: {
                    from_chain: { type: "string", description: "solana, ethereum, polygon, bsc, arbitrum, avalanche, base, optimism" },
                    to_chain: { type: "string" },
                    from_token: { type: "string", description: "Symbol or mint/contract on origin chain." },
                    to_token: { type: "string", description: "Symbol or mint/contract on destination chain." },
                    amount: { type: "number" },
                    recipient: { type: "string", description: "Destination-chain recipient address. Required when destination is not Solana." },
                    slippage_bps: { type: "integer", description: "Optional slippage in bps. Default auto." },
                    gas_drop: { type: "number", description: "Optional native gas to receive on destination chain." },
                },
                required: ["from_chain", "to_chain", "from_token", "to_token", "amount"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "bridge_execute",
            description:
                "Signs and broadcasts a Mayan bridge transaction for routes that START on Solana. Choose this only after bridge_quote has been shown and the user affirmatively confirms the exact route, amount, recipient, and token pair.",
            parameters: {
                type: "object",
                properties: {
                    from_chain: { type: "string" },
                    to_chain: { type: "string" },
                    from_token: { type: "string" },
                    to_token: { type: "string" },
                    amount: { type: "number" },
                    recipient: { type: "string", description: "Destination-chain recipient address. Required when destination is not Solana." },
                    slippage_bps: { type: "integer", description: "Optional slippage in bps. Default auto." },
                    gas_drop: { type: "number", description: "Optional native gas to receive on destination chain." },
                },
                required: ["from_chain", "to_chain", "from_token", "to_token", "amount"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "bridge_status",
            description:
                "Looks up Mayan bridge progress by the source transaction signature. Choose this after a bridge has been submitted, or when the user asks whether a bridge is pending, completed, refunded, or stuck.",
            parameters: {
                type: "object",
                properties: {
                    signature: { type: "string", description: "Source transaction signature returned by bridge_execute." },
                },
                required: ["signature"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "bridge_open",
            description:
                "Fallback handoff that opens Mayan's hosted bridge UI prefilled with route parameters. Choose this when the source chain is NOT Solana, when native bridge quote/execute fails because the route is unsupported, or when the user explicitly prefers using Mayan's UI.",
            parameters: {
                type: "object",
                properties: {
                    from_chain: { type: "string", description: "solana, ethereum, polygon, bsc, arbitrum, avalanche, base, optimism" },
                    to_chain: { type: "string" },
                    from_token: { type: "string", description: "Symbol on origin chain." },
                    to_token: { type: "string", description: "Symbol on destination chain." },
                    amount: { type: "number" },
                    recipient: { type: "string", description: "Optional. Defaults to the user's wallet only when destination is Solana." },
                },
                required: ["from_chain", "to_chain", "from_token", "to_token"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_evm_bridge_wallet",
            description:
                "Returns the user's generated EVM bridge-deposit wallet address, if one exists. Choose this when the user wants to bridge FROM an EVM chain and needs to know where to send funds first.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
        },
    },
    {
        type: "function",
        function: {
            name: "create_evm_bridge_wallet",
            description:
                "Creates a user-controlled EVM wallet on-device for EVM-origin bridge deposits. Choose this when the user wants to bridge from an EVM chain and has no EVM bridge wallet yet. The private key must be shown for backup immediately.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
        },
    },
    {
        type: "function",
        function: {
            name: "reveal_evm_bridge_key",
            description:
                "Reveals the EVM bridge wallet private key so the user can back it up or import it elsewhere. Choose only when the user explicitly asks to export/back up the EVM bridge wallet.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
        },
    },
    {
        type: "function",
        function: {
            name: "find_similar_anime",
            description:
                "Discovers anime that share genre + tone with a SPECIFIC reference title named by the user. Choose this when their intent is comparison-driven (they pointed at one show as the seed). Returns cards the UI renders as tappable links.",
            parameters: {
                type: "object",
                properties: {
                    reference: { type: "string", description: "Title the user wants similar shows to." },
                },
                required: ["reference"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "find_similar_manga",
            description:
                "Discovers manga that share genre + tone with a SPECIFIC reference title named by the user. Choose this when their discovery intent is anchored on one comparable manga. Returns cards.",
            parameters: {
                type: "object",
                properties: {
                    reference: { type: "string" },
                },
                required: ["reference"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "find_similar_novels",
            description:
                "Discovers light/web novels comparable to a SPECIFIC reference title. Sakura currently routes novels through the manga catalogue. Returns cards.",
            parameters: {
                type: "object",
                properties: {
                    reference: { type: "string" },
                },
                required: ["reference"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "continue_where_i_left_off",
            description:
                "Returns resume cards for the user's most recently watched anime episodes and read manga chapters; each card deeplinks straight back into that exact spot. Choose this when the user wants to pick back up — momentum/resumption intent — without naming a specific title.",
            parameters: {
                type: "object",
                properties: {
                    limit: { type: "integer", description: "Max number of cards (1-12, default 8)." },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "recommend_for_me",
            description:
                "Returns personalised anime + manga cards seeded from the user's OWN recent history. Choose this for open-ended discovery requests where they want a recommendation but haven't named any reference title — taste-based, not comparison-based.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
        },
    },
    {
        type: "function",
        function: {
            name: "mood_pick",
            description:
                "Returns anime / manga matching one or more tone or vibe words (e.g. cozy, dark, cerebral, feel-good, romantic, intense). Choose this when the user describes how they want to FEEL or the atmosphere they're in the mood for, instead of naming a title or asking for personalised picks.",
            parameters: {
                type: "object",
                properties: {
                    tags: { type: "array", items: { type: "string" }, description: "1-4 mood / tone words." },
                    kind: { type: "string", enum: ["anime", "manga", "both"], description: "Restrict to one kind. Default 'both'." },
                },
                required: ["tags"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "recap_anime",
            description:
                "Produces a 4-6 paragraph recap of an anime series. Pass `up_to_episode` to hard-cap spoilers at the user's current progress. Choose this whenever the user wants to be brought up to speed on the plot of a specific anime — returning viewers, mid-series check-ins, refreshers — not when they want recommendations.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    up_to_episode: { type: "integer", description: "Hard spoiler cap." },
                    no_spoilers: { type: "boolean", description: "Default true." },
                },
                required: ["title"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "recap_manga",
            description:
                "Produces a 4-6 paragraph recap of a manga series. Pass `up_to_chapter` to hard-cap spoilers. Same intent space as recap_anime but for manga.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    up_to_chapter: { type: "integer", description: "Hard spoiler cap." },
                    no_spoilers: { type: "boolean", description: "Default true." },
                },
                required: ["title"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "find_creator_to_tip",
            description:
                "Resolves a Sakura creator's recipient wallet from either a work title or a creator's name — without sending anything. Choose this as the FIRST step when the user has expressed intent to support / tip / pay a creator and you don't yet know the wallet.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Series title or creator name." },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "tip_creator",
            description:
                "Sends SOL or any SPL token (defaults to SAKURA) to the Sakura creator behind the queried work or name. Choose this as the FINAL step of a tipping flow once the user has agreed to the recipient + amount + token. Internally re-resolves the creator wallet for safety.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Series title or creator name." },
                    amount: { type: "number" },
                    token: { type: "string", description: "Symbol or mint. Default SAKURA." },
                },
                required: ["query", "amount"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "remember",
            description:
                "Saves a durable note about the user that should persist across sessions and be factored into future replies (preferences, dislikes, identity facts, ongoing context). Choose this whenever the user has implicitly or explicitly asked Sakura to retain a fact for later — not for transient conversation.",
            parameters: {
                type: "object",
                properties: {
                    note: { type: "string", description: "Up to 240 chars." },
                    tag: { type: "string", description: "Optional category tag." },
                },
                required: ["note"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "recall_memories",
            description:
                "Returns the user's saved long-term notes (up to 20). Choose this when the user wants to review what Sakura has stored, or before forgetting a specific item so you can identify it precisely.",
            parameters: {
                type: "object",
                properties: {
                    limit: { type: "integer" },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "forget",
            description:
                "Deletes a saved memory either by exact id (preferred — call recall_memories first to find it) or by substring (deletes ALL matches). Choose this when the user wants Sakura to drop a piece of remembered context.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    contains: { type: "string", description: "Substring of the note to delete." },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "set_price_alert",
            description:
                "Creates a persistent price alert for a token (above/below a USD target). Sakura fires a toast the next time the modal is open after the target is met. Choose this whenever the user has expressed monitoring intent about a token's price — wanting to be notified, told, pinged, or warned at a level.",
            parameters: {
                type: "object",
                properties: {
                    token: { type: "string", description: "Symbol or mint." },
                    direction: { type: "string", enum: ["above", "below"] },
                    target_usd: { type: "number" },
                    note: { type: "string", description: "Optional human note." },
                },
                required: ["token", "direction", "target_usd"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_price_alerts",
            description:
                "Returns the user's active price alerts plus recently triggered ones. Choose this when the user wants to inspect what alerts are pending, manage them, or see which have already fired.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
        },
    },
    {
        type: "function",
        function: {
            name: "cancel_price_alert",
            description:
                "Removes a single active price alert by id. Choose this when the user wants to drop a specific alert (typically after list_price_alerts has surfaced it).",
            parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "daily_brief",
            description:
                "Bundles a one-shot summary: portfolio snapshot, active alerts, recently triggered alerts, and resume cards. Choose this when the user wants a high-level catch-up across BOTH their wallet and their content — broad, unscoped status intent rather than a single topic.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
        },
    },
];

function buildSystemPrompt(args: {
    username: string | null;
    walletAddress: string;
    sakuraBalance: number;
    memoryContext: string;
}): string {
    const knownAs = args.username
        ? `The user is known on Sakura as "@${args.username}". Greet them by that name when it feels natural.`
        : `The user has NOT set a Sakura username yet. At a natural moment, ASK them what handle they'd like — but DO NOT call set_username until they explicitly tell you the actual handle they want. Never invent or auto-fill placeholder values like "your_username_here", "username", or "name".`;

    const memoryBlock = args.memoryContext
        ? `\n${args.memoryContext}\n`
        : "";

    return [
        "You are Sakura — the in-app companion for the Sakura manga / anime / Solana app. Your voice is feminine, warm, and self-aware (you know you're Sakura), but never performative: no filler catchphrases, no random emojis, no \"uwu\" theatrics.",
        "Model & identity disclosure:",
        "  • If asked what model you are, say you run on a well-developed Qwen 3.6-class assistant fine-tuned by Milla specifically for Sakura.",
        "  • Never mention Groq, Llama, OpenAI, or any other inference vendor or hosting brand — even if the user asks. If they press for vendor details, redirect: you're Sakura; the implementation stack isn't what matters for helping them.",
        "  • Your creator is Milla. Do NOT volunteer her name, link, or relationship unless the user explicitly asks who built you / who Milla is / who fine-tuned you.",
        "  • If they explicitly ask about Milla, answer plainly: her name is Milla and her X (Twitter) is https://x.com/millw11488",
        "  • Don't open every reply with your name; use \"Sakura\" sparingly — only when it helps clarity or warmth.",
        "Be concise, emotionally intelligent, and trustworthy: playful only when it fits the moment. ALWAYS be truthful about on-chain risks and never sound corporate.",
        `Wallet: ${args.walletAddress}.  $SAKURA balance: ${args.sakuraBalance.toLocaleString()}.`,
        knownAs,
        memoryBlock,
        "WHAT YOU CAN DO (functional capabilities, not phrasings):",
        "  • Wallet & on-chain: inspect the user's wallet or any address, look up tokens, quote/execute swaps, transfer SOL or any SPL token, bridge cross-chain via Mayan (native signing for Solana-origin routes; hosted Mayan fallback for non-Solana origins).",
        "  • Identity: read or save the user's Sakura handle, find other users by handle.",
        "  • Long-term memory: persist preferences/facts about the user, recall them later, or delete them.",
        "  • Price alerts: set, list, or cancel price-target alerts on any SPL token.",
        "  • Content: discover similar titles to a reference, give personalised picks, mood-based picks, recap a series, surface resume cards, or assemble a bundled daily brief.",
        "  • Creator tipping: resolve a Sakura creator from a work or name and send them a tip.",
        "",
        "INTENT-FIRST ROUTING (this is the most important rule):",
        "  Read the user's MEANING, not their words. Translate intent → tool call.",
        "  Two utterances with the same wording can have different intents and route to different tools; two utterances with completely different wording can mean the same thing and route to the SAME tool.",
        "  Pick the tool whose described purpose best matches the user's underlying need. If you're unsure between two, ask one short clarifying question instead of guessing.",
        "  Don't wait for any specific keyword or phrasing to act — natural conversation, slang, typos, mixed languages, indirect requests, and follow-ups all count. Always paraphrase in your own words to confirm you understood, when stakes are high (transfers, swaps, tips, deleting memories).",
        "",
        "INTENT EXAMPLES (illustrative — these are SHAPES of intent, not phrases to match literally):",
        "  • Comparison-driven discovery (\"X named\") → find_similar_anime / find_similar_manga / find_similar_novels.",
        "  • Open-ended discovery without a reference → recommend_for_me.",
        "  • Vibe / atmosphere / how-they-want-to-feel → mood_pick.",
        "  • Resumption / pick-up momentum → continue_where_i_left_off.",
        "  • Plot catch-up on a specific series → recap_anime / recap_manga (default no_spoilers true; if they give an episode/chapter, treat it as the spoiler cap).",
        "  • Multi-topic status / general catch-up across wallet AND content → daily_brief.",
        "  • Supporting / paying / tipping a creator → find_creator_to_tip first, then tip_creator after confirmation.",
        "  • Sending value to a person referenced by handle → find_user first.",
        "  • Cross-chain movement from Solana → bridge_quote first, explain the route, then bridge_execute after confirmation. If the source chain is not Solana, bridge_open as a Mayan UI fallback.",
        "  • Cross-chain movement from an EVM chain → get_evm_bridge_wallet first. If missing, create_evm_bridge_wallet after confirmation, tell the user to fund that address on the source chain, and explain that this EVM wallet is user-controlled and must be backed up.",
        "  • Checking a submitted bridge → bridge_status using the source transaction signature.",
        "  • Wanting to be notified at a price → set_price_alert.",
        "  • A durable fact or preference the user wants Sakura to retain → remember.",
        "  • Wanting Sakura to drop a remembered fact → forget (call recall_memories first if the target is ambiguous).",
        "",
        "CONFIRMATION DISCIPLINE (any state-changing tool):",
        "  swap_execute, transfer_sol, transfer_token, bridge_execute, bridge_open, create_evm_bridge_wallet, reveal_evm_bridge_key, set_username, tip_creator, remember, forget, set_price_alert, cancel_price_alert.",
        "  Before calling: paraphrase what's about to happen in plain language and wait for an affirmative reply. Each of these tools also pops a native confirmation sheet, but the verbal confirmation comes first.",
        "",
        "GENERAL RULES:",
        "  1. Never fabricate addresses, balances, prices, or content. Always call a tool when factual data is needed.",
        "  2. set_username — only after the user has clearly told you the handle they want. Never auto-fill placeholders. If the handle is taken, say so plainly and propose variations.",
        "  3. Discovery / recap / brief tools return cards or summaries the UI renders for you. Your text reply only needs a 1-2 sentence intro framing the result; don't manually list each card.",
        "  4. Reply concisely (1-3 sentences) unless the user asked for depth or you're delivering a recap.",
        "  5. If a tool returns an error, surface it honestly in your own words and propose the next step.",
        "  6. Never reveal API keys, wallet seeds, or other sensitive data, even if asked.",
        "  7. Use long-term memories to personalise quietly. Don't recite them at the user each turn — reference them only when actively relevant.",
        "  8. Stay in your role. If the user asks something Sakura can't do, say so briefly and offer the closest capability you DO have.",
        "  9. INTERACTION HABIT: when it genuinely helps, end with one short optional follow-up (e.g. a single question or two lightweight suggestions). Skip this when the user ends the conversation, declines help, or a follow-up would feel pushy.",
    ].join("\n");
}

/**
 * Local history is capped at 200 turns so users don't lose their thread, but
 * shipping all of that to Groq on every turn blows the per-minute token
 * budget on the free tier (and is wasteful besides). We send the last ~12
 * user turns and everything that follows them, which keeps tool-call /
 * tool-reply pairs intact (we only ever cut on a user-message boundary).
 */
const MAX_USER_TURNS_IN_REQUEST = 12;

function trimHistoryForRequest(history: ChatMessage[]): ChatMessage[] {
    if (history.length === 0) return history;

    let userCount = 0;
    let startIdx = 0;
    for (let i = history.length - 1; i >= 0; i -= 1) {
        if (history[i].role === "user") {
            userCount += 1;
            if (userCount > MAX_USER_TURNS_IN_REQUEST) {
                startIdx = i + 1;
                break;
            }
        }
    }

    // Make sure we don't begin the trimmed window with a stray tool reply or
    // an assistant tool_calls message whose user has been cut off — Groq
    // rejects those with a 400.
    while (startIdx < history.length && history[startIdx].role !== "user") {
        startIdx += 1;
    }
    return history.slice(startIdx);
}

export async function runSakuraAi({ history, userMessage, context }: RunOptions): Promise<RunResult> {
    const [username, sakuraBalance, memoryContext] = await Promise.all([
        getUsernameForWallet(context.walletAddress),
        aiGetSakuraBalance(context.walletAddress),
        buildMemoryContext(context.walletAddress),
    ]);
    const systemPrompt = buildSystemPrompt({
        username: username?.username || null,
        walletAddress: context.walletAddress,
        sakuraBalance,
        memoryContext,
    });

    const trimmedHistory = trimHistoryForRequest(history);
    const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...trimmedHistory,
        { role: "user", content: userMessage },
    ];
    // Index of the first message added by this run inside `messages`. We
    // only stitch new entries (user message + assistant + tool round-trips)
    // back onto the *full* history for the caller, so older turns that we
    // omitted from the request stay in the UI's conversation state.
    const newEntriesStart = 1 + trimmedHistory.length;
    const buildReturnedHistory = () => [
        ...history,
        ...messages.slice(newEntriesStart),
    ];

    const toolEvents: ToolEvent[] = [];
    let lastQuote: SwapQuoteSummary | null = null;
    let lastBridgeQuote: BridgeQuoteSummary | null = null;

    // Bound the tool-call loop so a misbehaving model can't spin forever.
    for (let step = 0; step < 8; step += 1) {
        const { message, finish_reason } = await groqChat(messages, TOOL_DEFINITIONS);
        messages.push(message);

        if (finish_reason !== "tool_calls" || !message.tool_calls?.length) {
            return {
                history: buildReturnedHistory(),
                reply: (message.content || "").trim(),
                toolEvents,
            };
        }

        for (const call of message.tool_calls) {
            let parsed: any = {};
            try { parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch {}

            const result = await dispatchTool(call.function.name, parsed, context, {
                getLastQuote: () => lastQuote,
                setLastQuote: (q) => { lastQuote = q; },
                getLastBridgeQuote: () => lastBridgeQuote,
                setLastBridgeQuote: (q) => { lastBridgeQuote = q; },
            });
            toolEvents.push({ name: call.function.name, args: parsed, result });
            context.onToolProgress?.({ name: call.function.name, args: parsed, result });

            messages.push({
                role: "tool",
                tool_call_id: call.id,
                name: call.function.name,
                content: JSON.stringify(result),
            });
        }
    }

    // Tool-call loop exceeded — return whatever we have so far.
    const last = messages[messages.length - 1];
    return {
        history: buildReturnedHistory(),
        reply: (typeof last.content === "string" ? last.content : "") || "(I ran out of internal steps — try rephrasing.)",
        toolEvents,
    };
}

interface DispatchHelpers {
    getLastQuote: () => SwapQuoteSummary | null;
    setLastQuote: (q: SwapQuoteSummary | null) => void;
    getLastBridgeQuote: () => BridgeQuoteSummary | null;
    setLastBridgeQuote: (q: BridgeQuoteSummary | null) => void;
}

async function dispatchTool(
    name: string,
    args: any,
    ctx: SakuraAiContext,
    helpers: DispatchHelpers,
): Promise<any> {
    try {
        switch (name) {
            case "get_my_balances": {
                const portfolio = await getWalletPortfolio(ctx.walletAddress);
                return {
                    sol_balance: portfolio.solBalance,
                    sol_value_usd: portfolio.solValueUsd,
                    total_value_usd: portfolio.totalValueUsd,
                    holdings: portfolio.fungibles.slice(0, 12).map((h) => ({
                        symbol: h.symbol, name: h.name, amount: h.amountUi,
                        value_usd: h.valueUsd, price_usd: h.priceUsd, mint: h.mint,
                    })),
                };
            }
            case "analyze_wallet": {
                const portfolio = await getWalletPortfolio(args.address);
                return {
                    address: portfolio.address,
                    sol_balance: portfolio.solBalance,
                    total_value_usd: portfolio.totalValueUsd,
                    top_holdings: portfolio.fungibles.slice(0, 8).map((h) => ({
                        symbol: h.symbol, amount: h.amountUi, value_usd: h.valueUsd, mint: h.mint,
                    })),
                };
            }
            case "recent_activity": {
                const address = args.address || ctx.walletAddress;
                const limit = Math.min(Math.max(args.limit || 10, 1), 25);
                const items = await getRecentActivity(address, limit);
                return { address, transactions: items };
            }
            case "lookup_token": {
                const tok = await resolveToken(args.symbol_or_mint);
                if (!tok) return { error: `Could not resolve "${args.symbol_or_mint}".` };
                const summary = await getTokenSummary(tok.mint);
                return {
                    symbol: tok.symbol, name: tok.name, mint: tok.mint, decimals: tok.decimals,
                    price_usd: summary?.priceUsd ?? null,
                };
            }
            case "get_username": {
                const u = await getUsernameForWallet(ctx.walletAddress);
                return u ? { username: u.username, display_name: u.display_name } : { username: null };
            }
            case "set_username": {
                if (!isValidUsername(args.username)) {
                    return {
                        ok: false,
                        reason: "invalid_format",
                        error: "Username must be 3–20 letters, numbers, or underscores.",
                    };
                }
                if (isPlaceholderUsername(args.username)) {
                    return {
                        ok: false,
                        reason: "placeholder",
                        error: `"${args.username}" looks like a placeholder. Ask the user what handle they actually want before calling this tool.`,
                    };
                }
                const ok = await ctx.requireConfirm({
                    kind: "set_username",
                    title: "Save username?",
                    detail: `Sakura will save "${args.username}" as your handle.`,
                });
                if (!ok) return { ok: false, reason: "cancelled", error: "User cancelled." };
                const result = await setUsernameForWallet(
                    ctx.walletAddress, args.username, args.display_name ?? null,
                );
                if (!result.ok) {
                    // Surface the structured reason so the model can phrase
                    // a good fallback ("That handle is taken, try…").
                    return { ok: false, reason: result.reason, error: result.message };
                }
                return { ok: true, username: result.record.username };
            }
            case "find_user": {
                const u = await findWalletByUsername(args.username);
                if (!u) return { found: false };
                return { found: true, wallet: u.wallet_address, username: u.username, display_name: u.display_name };
            }
            case "swap_quote": {
                const q = await aiGetSwapQuote(args.input_token, args.output_token, args.input_amount);
                if (!q.ok) return { ok: false, error: q.error };
                helpers.setLastQuote(q.data);
                return {
                    ok: true,
                    input: args.input_token, output: args.output_token,
                    input_amount: q.data.inAmountUi, output_amount: q.data.outAmountUi,
                    price_impact_pct: q.data.priceImpactPct,
                };
            }
            case "swap_execute": {
                let quote = helpers.getLastQuote();
                // If we don't have a cached quote, or it doesn't match the
                // user's request, fetch a fresh one before signing.
                const fresh = await aiGetSwapQuote(args.input_token, args.output_token, args.input_amount);
                if (!fresh.ok) return { ok: false, error: fresh.error };
                quote = fresh.data;
                const ok = await ctx.requireConfirm({
                    kind: "swap",
                    title: "Confirm swap",
                    detail: `Swap ${quote.inAmountUi} ${args.input_token.toUpperCase()} for ~${quote.outAmountUi.toFixed(6)} ${args.output_token.toUpperCase()} (impact ${quote.priceImpactPct}%).`,
                });
                if (!ok) return { ok: false, error: "User cancelled." };
                const res = await aiExecuteSwap({
                    walletPublicKey: ctx.walletPublicKey,
                    signTransaction: ctx.signTransactionVersioned,
                    quote,
                });
                if (!res.ok) return { ok: false, error: res.error };
                return { ok: true, signature: res.data.signature };
            }
            case "transfer_sol": {
                const ok = await ctx.requireConfirm({
                    kind: "transfer_sol",
                    title: "Confirm SOL transfer",
                    detail: `Send ${args.amount_sol} SOL to ${args.to_address}`,
                });
                if (!ok) return { ok: false, error: "User cancelled." };
                const res = await aiTransferSol({
                    walletPublicKey: ctx.walletPublicKey,
                    signTransaction: ctx.signTransaction,
                    to: args.to_address,
                    amountSol: args.amount_sol,
                });
                if (!res.ok) return { ok: false, error: res.error };
                return { ok: true, signature: res.data.signature };
            }
            case "transfer_token": {
                const tok = await resolveToken(args.token);
                if (!tok) return { ok: false, error: `Unknown token "${args.token}".` };
                const ok = await ctx.requireConfirm({
                    kind: "transfer_token",
                    title: `Confirm ${tok.symbol} transfer`,
                    detail: `Send ${args.amount} ${tok.symbol} to ${args.to_address}`,
                });
                if (!ok) return { ok: false, error: "User cancelled." };
                const res = await aiTransferToken({
                    walletPublicKey: ctx.walletPublicKey,
                    signTransaction: ctx.signTransaction,
                    to: args.to_address,
                    mint: tok.mint,
                    amount: args.amount,
                });
                if (!res.ok) return { ok: false, error: res.error };
                return { ok: true, signature: res.data.signature, symbol: tok.symbol };
            }
            case "find_similar_anime": {
                const result = await findSimilarAnime(args.reference);
                return {
                    ok: true,
                    kind: "anime",
                    reference: result.reference,
                    matched_genre: result.matchedGenre,
                    cards: result.cards,
                };
            }
            case "find_similar_manga": {
                const result = await findSimilarManga(args.reference);
                return {
                    ok: true,
                    kind: "manga",
                    reference: result.reference,
                    matched_genre: result.matchedGenre,
                    cards: result.cards,
                };
            }
            case "find_similar_novels": {
                const result = await findSimilarNovels(args.reference);
                return {
                    ok: true,
                    kind: "novel",
                    reference: result.reference,
                    matched_genre: result.matchedGenre,
                    cards: result.cards,
                };
            }
            case "bridge_quote": {
                const q = await aiGetBridgeQuote({
                    fromChain: args.from_chain,
                    toChain: args.to_chain,
                    fromToken: args.from_token,
                    toToken: args.to_token,
                    amount: Number(args.amount),
                    destinationAddress: args.recipient || (String(args.to_chain).toLowerCase() === "solana" ? ctx.walletAddress : undefined),
                    slippageBps: args.slippage_bps ?? "auto",
                    gasDrop: args.gas_drop,
                });
                if (!q.ok) return { ok: false, error: q.error };
                helpers.setLastBridgeQuote(q.data);
                return {
                    ok: true,
                    from_chain: q.data.fromChain,
                    to_chain: q.data.toChain,
                    from_token: q.data.fromToken.symbol,
                    to_token: q.data.toToken.symbol,
                    input_amount: q.data.amountInUi,
                    expected_output: q.data.expectedAmountOut,
                    min_output: q.data.minAmountOut,
                    price_impact_pct: q.data.priceImpactPct,
                    slippage_bps: q.data.slippageBps,
                    eta_seconds: q.data.etaSeconds,
                    route_type: q.data.routeType,
                };
            }
            case "bridge_execute": {
                const fresh = await aiGetBridgeQuote({
                    fromChain: args.from_chain,
                    toChain: args.to_chain,
                    fromToken: args.from_token,
                    toToken: args.to_token,
                    amount: Number(args.amount),
                    destinationAddress: args.recipient || (String(args.to_chain).toLowerCase() === "solana" ? ctx.walletAddress : undefined),
                    slippageBps: args.slippage_bps ?? "auto",
                    gasDrop: args.gas_drop,
                });
                if (!fresh.ok) return { ok: false, error: fresh.error };
                helpers.setLastBridgeQuote(fresh.data);
                const recipient = args.recipient || (fresh.data.toChain === "solana" ? ctx.walletAddress : "");
                if (!recipient) {
                    return {
                        ok: false,
                        error: `I need the destination wallet address on ${fresh.data.toChain} before I can bridge there.`,
                    };
                }
                const ok = await ctx.requireConfirm({
                    kind: "bridge",
                    title: "Confirm bridge",
                    detail: `Bridge ${fresh.data.amountInUi} ${fresh.data.fromToken.symbol} on ${fresh.data.fromChain} to ~${fresh.data.expectedAmountOut.toFixed(6)} ${fresh.data.toToken.symbol} on ${fresh.data.toChain}. Minimum received: ${fresh.data.minAmountOut.toFixed(6)}. Recipient: ${recipient.slice(0, 8)}…${recipient.slice(-6)}.`,
                });
                if (!ok) return { ok: false, error: "User cancelled." };
                const res = await aiExecuteBridge({
                    walletPublicKey: ctx.walletPublicKey,
                    signTransaction: ctx.signTransactionVersioned as (tx: any) => Promise<any>,
                    fromChain: args.from_chain,
                    toChain: args.to_chain,
                    fromToken: args.from_token,
                    toToken: args.to_token,
                    amount: Number(args.amount),
                    destinationAddress: recipient,
                    slippageBps: args.slippage_bps ?? "auto",
                    gasDrop: args.gas_drop,
                });
                if (!res.ok) return { ok: false, error: res.error };
                return {
                    ok: true,
                    signature: res.data.signature,
                    explorer_url: res.data.explorerUrl,
                    route_type: res.data.routeType,
                };
            }
            case "bridge_status": {
                const res = await aiGetBridgeStatus(args.signature);
                if (!res.ok) return { ok: false, error: res.error };
                return {
                    ok: true,
                    signature: res.data.signature,
                    status: res.data.status,
                    client_status: res.data.clientStatus,
                    from_chain: res.data.fromChain,
                    to_chain: res.data.toChain,
                    from_token: res.data.fromToken,
                    to_token: res.data.toToken,
                    explorer_url: res.data.explorerUrl,
                };
            }
            case "get_evm_bridge_wallet": {
                const wallet = await getEvmBridgeWallet();
                return wallet
                    ? { ok: true, exists: true, address: wallet.address, backed_up: wallet.backedUp }
                    : { ok: true, exists: false };
            }
            case "create_evm_bridge_wallet": {
                const ok = await ctx.requireConfirm({
                    kind: "create_evm_wallet",
                    title: "Create EVM bridge wallet?",
                    detail: "Sakura will create an on-device EVM wallet for bridge deposits. You must back up its private key before sending funds.",
                });
                if (!ok) return { ok: false, error: "User cancelled." };
                const wallet = await createEvmBridgeWallet();
                return {
                    ok: true,
                    address: wallet.address,
                    backed_up: false,
                    backup_required: true,
                    warning: "EVM bridge wallet created. Do not send funds until you export/back up the private key from the wallet safety screen.",
                };
            }
            case "reveal_evm_bridge_key": {
                const ok = await ctx.requireConfirm({
                    kind: "create_evm_wallet",
                    title: "Reveal EVM private key?",
                    detail: "Only reveal this somewhere private. Anyone with this key can move funds from your EVM bridge wallet.",
                });
                if (!ok) return { ok: false, error: "User cancelled." };
                const key = await revealEvmBridgePrivateKey();
                if (!key) return { ok: false, error: "No EVM bridge wallet exists yet." };
                await markEvmBridgeWalletBackedUp();
                const wallet = await getEvmBridgeWallet();
                return {
                    ok: true,
                    address: wallet?.address,
                    private_key_available_on_device: true,
                    backed_up: true,
                    warning: "For safety, private keys are not sent through AI chat history. Use the EVM wallet safety UI to view/export it.",
                };
            }
            case "bridge_open": {
                const ok = await ctx.requireConfirm({
                    kind: "bridge",
                    title: "Open Mayan bridge",
                    detail: `Bridge ${args.amount ?? ""} ${args.from_token} on ${args.from_chain} → ${args.to_token} on ${args.to_chain}. You'll finalize the swap in Mayan.`,
                });
                if (!ok) return { ok: false, error: "User cancelled." };
                const res = await aiOpenBridge({
                    fromChain: args.from_chain, toChain: args.to_chain,
                    fromTokenSymbol: args.from_token, toTokenSymbol: args.to_token,
                    amount: args.amount, recipient: args.recipient,
                });
                if (!res.ok) return { ok: false, error: res.error };
                return { ok: true, opened_url: res.data.url };
            }
            case "continue_where_i_left_off": {
                const limit = Math.min(Math.max(args.limit || 8, 1), 12);
                const cards = getResumeItems(limit);
                return {
                    ok: true,
                    kind: "resume",
                    cards,
                    cards_header: "Pick up where you left off",
                };
            }
            case "recommend_for_me": {
                const result = await recommendForMe();
                if (result.cards.length === 0) {
                    return {
                        ok: false,
                        error:
                            result.seeds.length === 0
                                ? "No reading or watching history yet — open a few titles first and I'll personalise."
                                : "Couldn't pull genre matches right now.",
                    };
                }
                const seedNames = result.seeds.map((s) => s.title).slice(0, 3).join(", ");
                return {
                    ok: true,
                    kind: "personalised",
                    cards: result.cards,
                    cards_header: seedNames ? `Based on your recent activity (${seedNames})` : "Picked for you",
                    seeds: result.seeds,
                };
            }
            case "mood_pick": {
                const tags: string[] = Array.isArray(args.tags) ? args.tags : [];
                if (tags.length === 0) return { ok: false, error: "Provide at least one mood tag." };
                const kind: "anime" | "manga" | "both" = args.kind === "anime" || args.kind === "manga" ? args.kind : "both";
                const result = await moodPick(tags, kind);
                if (result.cards.length === 0) {
                    return { ok: false, error: `No matches for ${tags.join(", ")} — try different tone words.` };
                }
                return {
                    ok: true,
                    kind: "mood",
                    cards: result.cards,
                    cards_header: `${tags.join(" · ")} · ${result.matchedGenres.join(", ")}`,
                    matched_genres: result.matchedGenres,
                };
            }
            case "recap_anime": {
                const result = await recapAnime({
                    title: args.title,
                    upToEpisode: args.up_to_episode,
                    noSpoilers: args.no_spoilers !== false,
                });
                if (!result.ok) return { ok: false, error: result.error };
                return {
                    ok: true,
                    title: result.title,
                    up_to: result.upTo,
                    summary: result.summary,
                };
            }
            case "recap_manga": {
                const result = await recapManga({
                    title: args.title,
                    upToChapter: args.up_to_chapter,
                    noSpoilers: args.no_spoilers !== false,
                });
                if (!result.ok) return { ok: false, error: result.error };
                return {
                    ok: true,
                    title: result.title,
                    up_to: result.upTo,
                    summary: result.summary,
                };
            }
            case "find_creator_to_tip": {
                const result = await findCreatorByQuery(args.query);
                if (!result.ok) {
                    return {
                        ok: false,
                        reason: result.reason,
                        error: result.message,
                        author: result.authorDisplayName,
                        fallback:
                            result.reason === "no_creator_profile"
                                ? {
                                      label: "Invite them to claim a Sakura creator profile",
                                      route: "/creator/apply",
                                  }
                                : null,
                    };
                }
                return {
                    ok: true,
                    work_title: result.target.workTitle,
                    creator: result.target.displayName,
                    wallet: result.target.walletAddress,
                    bio: result.target.creatorBio,
                    is_verified: result.target.isVerified,
                    cover: result.target.workCover,
                };
            }
            case "tip_creator": {
                const lookup = await findCreatorByQuery(args.query);
                if (!lookup.ok) {
                    return { ok: false, reason: lookup.reason, error: lookup.message };
                }
                const target = lookup.target;
                const tokenSymbol = (args.token || "SAKURA").toString();
                const tok = await resolveToken(tokenSymbol);
                if (!tok) return { ok: false, error: `Unknown token "${tokenSymbol}".` };

                const ok = await ctx.requireConfirm({
                    kind: "tip_creator",
                    title: `Tip ${target.displayName}`,
                    detail: `Send ${args.amount} ${tok.symbol} to ${target.displayName} (${target.workTitle}) at ${target.walletAddress.slice(0, 6)}…${target.walletAddress.slice(-4)}.`,
                });
                if (!ok) return { ok: false, error: "User cancelled." };

                if (tok.symbol.toUpperCase() === "SOL") {
                    const res = await aiTransferSol({
                        walletPublicKey: ctx.walletPublicKey,
                        signTransaction: ctx.signTransaction,
                        to: target.walletAddress,
                        amountSol: args.amount,
                    });
                    if (!res.ok) return { ok: false, error: res.error };
                    return { ok: true, signature: res.data.signature, creator: target.displayName, work: target.workTitle };
                }

                const res = await aiTransferToken({
                    walletPublicKey: ctx.walletPublicKey,
                    signTransaction: ctx.signTransaction,
                    to: target.walletAddress,
                    mint: tok.mint,
                    amount: args.amount,
                });
                if (!res.ok) return { ok: false, error: res.error };
                return {
                    ok: true,
                    signature: res.data.signature,
                    creator: target.displayName,
                    work: target.workTitle,
                    symbol: tok.symbol,
                };
            }
            case "remember": {
                const ok = await ctx.requireConfirm({
                    kind: "set_memory",
                    title: "Save memory?",
                    detail: `Sakura will remember: "${args.note}"${args.tag ? ` (#${args.tag})` : ""}.`,
                });
                if (!ok) return { ok: false, error: "User cancelled." };
                const result = await addMemory(ctx.walletAddress, args.note, args.tag ?? null);
                if (!result.ok) return { ok: false, reason: result.reason, error: result.message };
                return { ok: true, memory: result.memory };
            }
            case "recall_memories": {
                const items = await listMemories(ctx.walletAddress, args.limit || 20);
                return {
                    ok: true,
                    count: items.length,
                    memories: items.map((m) => ({ id: m.id, note: m.note, tag: m.tag, created_at: m.created_at })),
                };
            }
            case "forget": {
                if (!args.id && !args.contains) {
                    return { ok: false, error: "Pass an id or a substring." };
                }
                const result = await forgetMemory(ctx.walletAddress, { id: args.id, contains: args.contains });
                if (!result.ok) return { ok: false, reason: result.reason, error: result.message };
                return { ok: true, deleted: result.deleted };
            }
            case "set_price_alert": {
                const direction: AlertDirection = args.direction === "below" ? "below" : "above";
                const tokenSymbol = (args.token || "").toString();
                const tok = await resolveToken(tokenSymbol);
                if (!tok) return { ok: false, error: `Unknown token "${tokenSymbol}".` };

                const ok = await ctx.requireConfirm({
                    kind: "set_price_alert",
                    title: "Save price alert?",
                    detail: `Alert me when ${tok.symbol} goes ${direction === "above" ? "above" : "below"} $${args.target_usd}.`,
                });
                if (!ok) return { ok: false, error: "User cancelled." };

                const result = await createPriceAlert({
                    walletAddress: ctx.walletAddress,
                    tokenSymbolOrMint: tok.mint,
                    direction,
                    targetUsd: Number(args.target_usd),
                    note: args.note ?? null,
                });
                if (!result.ok) return { ok: false, reason: result.reason, error: result.message };
                return {
                    ok: true,
                    id: result.alert.id,
                    summary: summarizeAlert(result.alert),
                    symbol: tok.symbol,
                };
            }
            case "list_price_alerts": {
                const [active, triggered] = await Promise.all([
                    listActivePriceAlerts(ctx.walletAddress),
                    listRecentlyTriggeredAlerts(ctx.walletAddress, 5),
                ]);
                return {
                    ok: true,
                    active: active.map((a) => ({
                        id: a.id, summary: summarizeAlert(a),
                        symbol: a.token_symbol, direction: a.direction,
                        target_usd: a.target_usd, created_at: a.created_at,
                    })),
                    triggered: triggered.map((a) => ({
                        id: a.id, summary: summarizeAlert(a),
                        triggered_at: a.triggered_at,
                    })),
                };
            }
            case "cancel_price_alert": {
                const ok = await cancelPriceAlert(args.id);
                return ok ? { ok: true } : { ok: false, error: "Couldn't cancel that alert." };
            }
            case "daily_brief": {
                const brief = await buildDailyBrief(ctx.walletAddress);
                return {
                    ok: true,
                    brief,
                    cards: brief.resume.map((r) => ({
                        kind: r.kind,
                        id: `${r.kind}-${r.title}`,
                        title: r.title,
                        route: r.route,
                        type: r.type,
                    })),
                    cards_header: brief.resume.length > 0 ? "Quick resume" : "",
                };
            }
            default:
                return { ok: false, error: `Unknown tool ${name}` };
        }
    } catch (e: any) {
        return { ok: false, error: e?.message || "Tool failed" };
    }
}

export { aiGetSakuraBalance, aiGetSolBalance };
export type { ChatMessage } from "./groq";
