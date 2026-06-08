import {
    PublicKey,
    SystemProgram,
    Transaction,
    LAMPORTS_PER_SOL,
    VersionedTransaction,
} from "@solana/web3.js";
import type { ChainName, Quote, SolanaTransactionSigner, Token } from "@mayanfinance/swap-sdk";
import {
    getAssociatedTokenAddress,
    createTransferInstruction,
    createAssociatedTokenAccountInstruction,
    getAccount,
    getMint,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Browser } from "@capacitor/browser";
import {
    SAKURA_MINT,
    JUPITER_API_KEY,
    getConnection,
} from "@/lib/solana";
import { findKnownToken, resolveToken, SOL_MINT, type KnownToken } from "./tokens";

/**
 * Action handlers used by Sakura AI tool calls. Every action that mutates
 * on-chain state returns the txid (or error string) so the AI can confirm
 * outcomes back to the user. Read-only quoting actions return the raw
 * Jupiter response so the AI can describe the route.
 */

export interface ActionSuccess<T = any> { ok: true; data: T; }
export interface ActionFailure { ok: false; error: string; }
export type ActionResult<T = any> = ActionSuccess<T> | ActionFailure;

const JUPITER_BASE = "https://lite-api.jup.ag/swap/v1";
const MAYAN_API_KEY = process.env.NEXT_PUBLIC_MAYAN_API_KEY || "";

function jupiterHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (JUPITER_API_KEY) h["x-api-key"] = JUPITER_API_KEY;
    return h;
}

async function tokenProgramFor(mint: PublicKey): Promise<PublicKey> {
    const conn = getConnection();
    const info = await conn.getAccountInfo(mint);
    if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
    return TOKEN_PROGRAM_ID;
}

// ============================================================================
// SOL transfer
// ============================================================================

export interface TransferSolArgs {
    walletPublicKey: PublicKey;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
    to: string;
    amountSol: number;
}

export async function aiTransferSol({
    walletPublicKey,
    signTransaction,
    to,
    amountSol,
}: TransferSolArgs): Promise<ActionResult<{ signature: string }>> {
    try {
        if (amountSol <= 0) return { ok: false, error: "Amount must be greater than zero." };
        const recipient = new PublicKey(to);
        const conn = getConnection();
        const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

        const balance = await conn.getBalance(walletPublicKey);
        if (balance < lamports + 5000) {
            return { ok: false, error: "Insufficient SOL balance for the transfer + fees." };
        }

        const tx = new Transaction().add(
            SystemProgram.transfer({ fromPubkey: walletPublicKey, toPubkey: recipient, lamports }),
        );
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = walletPublicKey;

        const signed = await signTransaction(tx);
        const signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        await conn.confirmTransaction({ blockhash, lastValidBlockHeight, signature }, "confirmed");
        return { ok: true, data: { signature } };
    } catch (e: any) {
        return { ok: false, error: e?.message || "SOL transfer failed." };
    }
}

// ============================================================================
// SPL transfer (works for Token + Token-2022)
// ============================================================================

export interface TransferTokenArgs {
    walletPublicKey: PublicKey;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
    to: string;
    mint: string;
    amount: number;
}

export async function aiTransferToken({
    walletPublicKey,
    signTransaction,
    to,
    mint,
    amount,
}: TransferTokenArgs): Promise<ActionResult<{ signature: string }>> {
    try {
        if (amount <= 0) return { ok: false, error: "Amount must be greater than zero." };
        const conn = getConnection();
        const mintPk = new PublicKey(mint);
        const recipient = new PublicKey(to);
        const tokenProgram = await tokenProgramFor(mintPk);

        const mintInfo = await getMint(conn, mintPk, "confirmed", tokenProgram);
        const amountSmallest = BigInt(Math.round(amount * 10 ** mintInfo.decimals));

        const fromAta = await getAssociatedTokenAddress(
            mintPk, walletPublicKey, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        const toAta = await getAssociatedTokenAddress(
            mintPk, recipient, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
        );

        // Verify the sender's ATA exists and has enough balance.
        try {
            const src = await getAccount(conn, fromAta, "confirmed", tokenProgram);
            if (src.amount < amountSmallest) {
                return { ok: false, error: `Insufficient token balance. You have ${Number(src.amount) / 10 ** mintInfo.decimals}.` };
            }
        } catch {
            return { ok: false, error: "You don't hold this token yet." };
        }

        const tx = new Transaction();
        const recipientAtaInfo = await conn.getAccountInfo(toAta);
        if (!recipientAtaInfo) {
            tx.add(
                createAssociatedTokenAccountInstruction(
                    walletPublicKey, toAta, recipient, mintPk,
                    tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
                ),
            );
        }
        tx.add(
            createTransferInstruction(
                fromAta, toAta, walletPublicKey, amountSmallest, [], tokenProgram,
            ),
        );

        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = walletPublicKey;

        const signed = await signTransaction(tx);
        const signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        await conn.confirmTransaction({ blockhash, lastValidBlockHeight, signature }, "confirmed");
        return { ok: true, data: { signature } };
    } catch (e: any) {
        return { ok: false, error: e?.message || "Token transfer failed." };
    }
}

// ============================================================================
// Generic Jupiter swap (any input → any output)
// ============================================================================

export interface SwapQuoteSummary {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    inAmountUi: number;
    outAmountUi: number;
    priceImpactPct: string;
    raw: any;
}

export async function aiGetSwapQuote(
    inputSymbolOrMint: string,
    outputSymbolOrMint: string,
    inputAmountUi: number,
): Promise<ActionResult<SwapQuoteSummary>> {
    try {
        if (inputAmountUi <= 0) return { ok: false, error: "Input amount must be > 0." };
        const inTok = (await resolveToken(inputSymbolOrMint)) || findKnownToken(inputSymbolOrMint);
        const outTok = (await resolveToken(outputSymbolOrMint)) || findKnownToken(outputSymbolOrMint);
        if (!inTok) return { ok: false, error: `Unknown input token "${inputSymbolOrMint}".` };
        if (!outTok) return { ok: false, error: `Unknown output token "${outputSymbolOrMint}".` };

        const amountSmallest = Math.round(inputAmountUi * 10 ** inTok.decimals);
        const url = `${JUPITER_BASE}/quote?inputMint=${inTok.mint}&outputMint=${outTok.mint}&amount=${amountSmallest}&slippageBps=80&restrictIntermediateTokens=true`;
        const res = await fetch(url, { headers: jupiterHeaders() });
        if (!res.ok) {
            const body = await res.text();
            return { ok: false, error: `Quote failed (${res.status}): ${body.slice(0, 200)}` };
        }
        const data = await res.json();
        return {
            ok: true,
            data: {
                inputMint: inTok.mint,
                outputMint: outTok.mint,
                inAmount: data.inAmount,
                outAmount: data.outAmount,
                inAmountUi: Number(data.inAmount) / 10 ** inTok.decimals,
                outAmountUi: Number(data.outAmount) / 10 ** outTok.decimals,
                priceImpactPct: data.priceImpactPct || "0",
                raw: data,
            },
        };
    } catch (e: any) {
        return { ok: false, error: e?.message || "Quote failed." };
    }
}

export interface ExecuteSwapArgs {
    walletPublicKey: PublicKey;
    signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
    quote: SwapQuoteSummary;
}

export async function aiExecuteSwap({
    walletPublicKey,
    signTransaction,
    quote,
}: ExecuteSwapArgs): Promise<ActionResult<{ signature: string }>> {
    try {
        const swapRes = await fetch(`${JUPITER_BASE}/swap`, {
            method: "POST",
            headers: jupiterHeaders(),
            body: JSON.stringify({
                quoteResponse: quote.raw,
                userPublicKey: walletPublicKey.toBase58(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                dynamicSlippage: true,
                prioritizationFeeLamports: {
                    priorityLevelWithMaxLamports: {
                        maxLamports: 1_000_000,
                        priorityLevel: "veryHigh",
                    },
                },
            }),
        });
        if (!swapRes.ok) {
            const body = await swapRes.text();
            return { ok: false, error: `Swap build failed (${swapRes.status}): ${body.slice(0, 200)}` };
        }
        const swapData = await swapRes.json();
        const { swapTransaction } = swapData;
        const buf = Buffer.from(swapTransaction, "base64");
        const tx = VersionedTransaction.deserialize(buf);
        const signed = await signTransaction(tx);

        const conn = getConnection();
        const rawTx = signed.serialize();
        // Use the in-tx blockhash + Jupiter's reported lastValidBlockHeight
        // for confirmation. Fetching a fresh blockhash here would mismatch
        // the signed message and cause "block height exceeded" once the
        // network drifts past the original window.
        const txBlockhash = signed.message.recentBlockhash;
        const txLastValidBlockHeight: number =
            swapData.lastValidBlockHeight ||
            (await conn.getLatestBlockhash()).lastValidBlockHeight;

        const signature = await sendWithRebroadcast(conn, rawTx, txBlockhash, txLastValidBlockHeight);
        return { ok: true, data: { signature } };
    } catch (e: any) {
        return { ok: false, error: e?.message || "Swap failed." };
    }
}

/**
 * Send a signed raw transaction and re-broadcast it every few seconds
 * until either:
 *   • the signature is confirmed (returns the signature), or
 *   • the chain's current block height passes lastValidBlockHeight
 *     (throws — the tx truly missed its window).
 *
 * This avoids the most common cause of the "block height exceeded" toast:
 * one initial broadcast that the network drops because of priority-fee
 * congestion, with no follow-up resends. By re-broadcasting we let the tx
 * land on a healthy leader before its blockhash expires.
 */
async function sendWithRebroadcast(
    conn: ReturnType<typeof getConnection>,
    rawTx: Uint8Array,
    blockhash: string,
    lastValidBlockHeight: number,
): Promise<string> {
    const signature = await conn.sendRawTransaction(rawTx, {
        skipPreflight: true,
        maxRetries: 0,
    });
    const start = Date.now();
    while (true) {
        const status = await conn.getSignatureStatus(signature, { searchTransactionHistory: false });
        const value = status.value;
        if (value && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized")) {
            if (value.err) throw new Error(`Tx failed on-chain: ${JSON.stringify(value.err)}`);
            return signature;
        }
        const currentHeight = await conn.getBlockHeight("confirmed");
        if (currentHeight > lastValidBlockHeight) {
            throw new Error(
                `Signature ${signature.slice(0, 12)}… expired before confirming (block height exceeded). ` +
                "The network was congested — please retry.",
            );
        }
        // Quietly re-broadcast every ~2s while we still have headroom.
        if (Date.now() - start > 1500) {
            try { await conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }); } catch {}
        }
        await new Promise((r) => setTimeout(r, 1500));
        // Hard ceiling so we never spin forever even if RPC misbehaves.
        if (Date.now() - start > 90_000) {
            throw new Error("Confirmation timed out after 90s.");
        }
    }
}

// ============================================================================
// Cross-chain bridge — native Mayan SDK for Solana-origin routes.
//
// Sakura's embedded wallet is Solana-only, so the fully native bridge path
// supports routes FROM Solana. Destination can be Solana or any Mayan-supported
// destination chain, but non-Solana destinations require the user to provide
// that chain's recipient address. EVM-origin routes still use the Mayan UI
// handoff because Sakura cannot sign EVM transactions.
// ============================================================================

const MAYAN_BASE = "https://swap.mayan.finance";

const BRIDGE_CHAINS = new Set([
    "solana", "ethereum", "polygon", "bsc", "arbitrum", "avalanche", "base", "optimism",
    "unichain", "linea", "sonic", "hyperevm", "monad",
]);

const mayanTokenCache = new Map<string, Token[]>();

function isBridgeChain(value: string): value is ChainName {
    return BRIDGE_CHAINS.has(value);
}

function decimalToAtomic(amount: number, decimals: number): string {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be greater than zero.");
    const [wholeRaw, fracRaw = ""] = String(amount).split(".");
    const whole = wholeRaw || "0";
    const fraction = fracRaw.slice(0, decimals).padEnd(decimals, "0");
    const normalized = `${whole}${fraction}`.replace(/^0+/, "") || "0";
    return normalized;
}

async function getMayanTokens(chain: ChainName): Promise<Token[]> {
    const cached = mayanTokenCache.get(chain);
    if (cached) return cached;
    const { fetchTokenList } = await import("@mayanfinance/swap-sdk");
    const tokens = await fetchTokenList(chain, false, undefined, MAYAN_API_KEY || undefined);
    mayanTokenCache.set(chain, tokens);
    return tokens;
}

async function resolveMayanToken(chain: ChainName, symbolOrMint: string): Promise<Token | null> {
    const q = (symbolOrMint || "").trim();
    if (!q) return null;
    const lower = q.toLowerCase();
    const tokens = await getMayanTokens(chain);

    const exactContract = tokens.find((t) =>
        t.contract?.toLowerCase() === lower ||
        t.mint?.toLowerCase() === lower ||
        t.realOriginContractAddress?.toLowerCase() === lower ||
        (t as any).wrappedAddress?.toLowerCase() === lower,
    );
    if (exactContract) return exactContract;

    const exactSymbol = tokens.find((t) => t.symbol.toLowerCase() === lower && t.verified);
    if (exactSymbol) return exactSymbol;

    return tokens.find((t) => t.symbol.toLowerCase() === lower) || null;
}

function mayanUiUrl(args: {
    fromChain: string;
    toChain: string;
    fromTokenSymbol: string;
    toTokenSymbol: string;
    amount?: number;
    recipient?: string;
}): string {
    const params = new URLSearchParams();
    params.set("fromChain", args.fromChain);
    params.set("toChain", args.toChain);
    if (args.fromTokenSymbol) params.set("fromToken", args.fromTokenSymbol.toUpperCase());
    if (args.toTokenSymbol) params.set("toToken", args.toTokenSymbol.toUpperCase());
    if (args.amount && args.amount > 0) params.set("amount", String(args.amount));
    if (args.recipient) params.set("recipient", args.recipient);
    return `${MAYAN_BASE}/?${params.toString()}`;
}

export interface BridgeQuoteSummary {
    quote: Quote;
    fromChain: ChainName;
    toChain: ChainName;
    fromToken: Token;
    toToken: Token;
    amountInUi: number;
    expectedAmountOut: number;
    minAmountOut: number;
    priceImpactPct: number | null;
    slippageBps: number;
    etaSeconds: number;
    routeType: string;
}

export interface BridgeStatusSummary {
    signature: string;
    status: string;
    clientStatus?: string | null;
    fromChain?: string | null;
    toChain?: string | null;
    fromToken?: string | null;
    toToken?: string | null;
    explorerUrl: string;
    raw?: any;
}

export async function aiGetBridgeQuote(args: {
    fromChain: string;
    toChain: string;
    fromToken: string;
    toToken: string;
    amount: number;
    destinationAddress?: string;
    slippageBps?: number | "auto";
    gasDrop?: number;
}): Promise<ActionResult<BridgeQuoteSummary>> {
    try {
        const fromChain = (args.fromChain || "").toLowerCase();
        const toChain = (args.toChain || "").toLowerCase();
        if (!isBridgeChain(fromChain) || !isBridgeChain(toChain)) {
            return { ok: false, error: `Unsupported chain. Try one of: ${[...BRIDGE_CHAINS].join(", ")}.` };
        }
        if (fromChain !== "solana") {
            return {
                ok: false,
                error: "Native Sakura bridge currently supports Solana-origin routes only. I can open Mayan for non-Solana source chains.",
            };
        }

        const fromToken = await resolveMayanToken(fromChain, args.fromToken);
        const toToken = await resolveMayanToken(toChain, args.toToken);
        if (!fromToken) return { ok: false, error: `Mayan does not list ${args.fromToken} on ${fromChain}.` };
        if (!toToken) return { ok: false, error: `Mayan does not list ${args.toToken} on ${toChain}.` };

        const { fetchQuote } = await import("@mayanfinance/swap-sdk");
        const amountIn64 = decimalToAtomic(args.amount, fromToken.decimals);
        const quotes = await fetchQuote(
            {
                amountIn64,
                fromToken: fromToken.contract,
                fromChain,
                toToken: toToken.contract,
                toChain,
                slippageBps: args.slippageBps ?? "auto",
                gasDrop: args.gasDrop,
                destinationAddress: args.destinationAddress,
            },
            { apiKey: MAYAN_API_KEY || undefined },
        );
        const quote = quotes?.[0];
        if (!quote) return { ok: false, error: "Mayan returned no bridge route for that pair." };

        return {
            ok: true,
            data: {
                quote,
                fromChain,
                toChain,
                fromToken,
                toToken,
                amountInUi: args.amount,
                expectedAmountOut: quote.expectedAmountOut,
                minAmountOut: quote.minAmountOut,
                priceImpactPct: typeof quote.priceImpact === "number" ? quote.priceImpact : null,
                slippageBps: quote.slippageBps,
                etaSeconds: quote.etaSeconds ?? quote.eta ?? 0,
                routeType: quote.type,
            },
        };
    } catch (e: any) {
        const quoteError = e?.response?.data?.message || e?.data?.message;
        return { ok: false, error: quoteError || e?.message || "Bridge quote failed." };
    }
}

export async function aiExecuteBridge(args: {
    walletPublicKey: PublicKey;
    signTransaction: (tx: Transaction | VersionedTransaction) => Promise<Transaction | VersionedTransaction>;
    fromChain: string;
    toChain: string;
    fromToken: string;
    toToken: string;
    amount: number;
    destinationAddress?: string;
    slippageBps?: number | "auto";
    gasDrop?: number;
}): Promise<ActionResult<{ signature: string; explorerUrl: string; routeType: string }>> {
    try {
        const toChain = (args.toChain || "").toLowerCase();
        const destinationAddress = args.destinationAddress || (toChain === "solana" ? args.walletPublicKey.toBase58() : "");
        if (!destinationAddress) {
            return {
                ok: false,
                error: `Destination address required for ${toChain}. Use the recipient wallet on that chain.`,
            };
        }

        const quoteResult = await aiGetBridgeQuote({
            fromChain: args.fromChain,
            toChain: args.toChain,
            fromToken: args.fromToken,
            toToken: args.toToken,
            amount: args.amount,
            destinationAddress,
            slippageBps: args.slippageBps,
            gasDrop: args.gasDrop,
        });
        if (!quoteResult.ok) return quoteResult;

        const { swapFromSolana } = await import("@mayanfinance/swap-sdk");
        const conn = getConnection();
        const signed = await swapFromSolana(
            quoteResult.data.quote,
            args.walletPublicKey.toBase58(),
            destinationAddress,
            null,
            args.signTransaction as SolanaTransactionSigner,
            conn,
            [],
            { skipPreflight: false },
            undefined,
            undefined,
            { onTransactionSigned: () => {}, apiKey: MAYAN_API_KEY || undefined },
        );

        return {
            ok: true,
            data: {
                signature: signed.signature,
                explorerUrl: `https://explorer.mayan.finance/swap/${signed.signature}`,
                routeType: quoteResult.data.routeType,
            },
        };
    } catch (e: any) {
        return { ok: false, error: e?.message || "Bridge execution failed." };
    }
}

export async function aiGetBridgeStatus(signature: string): Promise<ActionResult<BridgeStatusSummary>> {
    try {
        const clean = (signature || "").trim();
        if (!clean) return { ok: false, error: "Bridge signature required." };
        const res = await fetch(`https://explorer-api.mayan.finance/v3/swap/trx/${encodeURIComponent(clean)}`);
        if (res.status === 404) {
            return {
                ok: true,
                data: {
                    signature: clean,
                    status: "PENDING_INDEX",
                    clientStatus: "PENDING_INDEX",
                    explorerUrl: `https://explorer.mayan.finance/swap/${clean}`,
                },
            };
        }
        if (!res.ok) throw new Error(`Mayan status HTTP ${res.status}`);
        const data = await res.json();
        const clientStatus =
            data?.clientStatus ||
            data?.swap?.clientStatus ||
            data?.status ||
            data?.swap?.status ||
            null;
        return {
            ok: true,
            data: {
                signature: clean,
                status: clientStatus || "INPROGRESS",
                clientStatus,
                fromChain: data?.fromChain || data?.swap?.fromChain || null,
                toChain: data?.toChain || data?.swap?.toChain || null,
                fromToken: data?.fromToken?.symbol || data?.swap?.fromToken?.symbol || null,
                toToken: data?.toToken?.symbol || data?.swap?.toToken?.symbol || null,
                explorerUrl: `https://explorer.mayan.finance/swap/${clean}`,
                raw: data,
            },
        };
    } catch (e: any) {
        return { ok: false, error: e?.message || "Bridge status lookup failed." };
    }
}

export async function aiOpenBridge(args: {
    fromChain: string;
    toChain: string;
    fromTokenSymbol: string;
    toTokenSymbol: string;
    amount?: number;
    recipient?: string;
}): Promise<ActionResult<{ url: string }>> {
    const fromChain = (args.fromChain || "").toLowerCase();
    const toChain = (args.toChain || "").toLowerCase();
    if (!BRIDGE_CHAINS.has(fromChain) || !BRIDGE_CHAINS.has(toChain)) {
        return {
            ok: false,
            error: `Unsupported chain. Try one of: ${[...BRIDGE_CHAINS].join(", ")}.`,
        };
    }

    const url = mayanUiUrl({
        fromChain,
        toChain,
        fromTokenSymbol: args.fromTokenSymbol,
        toTokenSymbol: args.toTokenSymbol,
        amount: args.amount,
        recipient: args.recipient,
    });
    try {
        await Browser.open({ url, presentationStyle: "popover" });
    } catch {
        if (typeof window !== "undefined") window.open(url, "_blank");
    }
    return { ok: true, data: { url } };
}

// ============================================================================
// Local balance helpers
// ============================================================================

export async function aiGetSakuraBalance(walletAddress: string): Promise<number> {
    try {
        const conn = getConnection();
        const wallet = new PublicKey(walletAddress);
        const accounts = await conn.getParsedTokenAccountsByOwner(wallet, { mint: SAKURA_MINT });
        let total = 0;
        for (const acc of accounts.value) {
            const ui = acc.account.data.parsed.info.tokenAmount.uiAmount;
            total += Number(ui ?? 0);
        }
        return total;
    } catch {
        return 0;
    }
}

export async function aiGetSolBalance(walletAddress: string): Promise<number> {
    try {
        const conn = getConnection();
        const lamports = await conn.getBalance(new PublicKey(walletAddress));
        return lamports / LAMPORTS_PER_SOL;
    } catch {
        return 0;
    }
}

export type { KnownToken };
export { SOL_MINT };
