import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { SAKURA_MINT, getConnection, SOLANA_NETWORK, JUPITER_API_KEY } from "./solana";

const JUPITER_BASE = "https://api.jup.ag/swap/v1";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface SwapQuote {
    inAmount: string;
    outAmount: string;
    priceImpactPct: string;
    routePlan: any[];
    _raw: any;
}

export interface SwapResult {
    success: boolean;
    txid?: string;
    error?: string;
}

function jupiterHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (JUPITER_API_KEY) h["x-api-key"] = JUPITER_API_KEY;
    return h;
}

export async function getSakuraSwapQuote(amountSol: number): Promise<SwapQuote | null> {
    if ((SOLANA_NETWORK as string) !== "mainnet-beta") {
        throw new Error("Jupiter Swap requires Mainnet.");
    }

    if (!JUPITER_API_KEY) {
        throw new Error("Jupiter API key not configured. Get a free key at portal.jup.ag and add it in Settings.");
    }

    try {
        const lamports = Math.round(amountSol * 1e9);
        const url = `${JUPITER_BASE}/quote?inputMint=${WSOL_MINT}&outputMint=${SAKURA_MINT.toBase58()}&amount=${lamports}&slippageBps=50&restrictIntermediateTokens=true`;

        const response = await fetch(url, { headers: jupiterHeaders() });

        if (!response.ok) {
            let errorText = "Failed to fetch quote from Jupiter.";
            try {
                const errBody = await response.json();
                errorText = errBody.message || errBody.error || errorText;
            } catch {
                errorText = `Jupiter API returned HTTP ${response.status}`;
            }
            throw new Error(errorText);
        }

        const data = await response.json();
        return {
            inAmount: data.inAmount,
            outAmount: data.outAmount,
            priceImpactPct: data.priceImpactPct || "0",
            routePlan: data.routePlan || [],
            _raw: data
        };
    } catch (e: any) {
        console.error("Jupiter Quote Error:", e);
        throw e;
    }
}

export async function executeSakuraSwap(
    quote: SwapQuote,
    walletPublicKey: PublicKey,
    signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>
): Promise<SwapResult> {
    if ((SOLANA_NETWORK as string) !== "mainnet-beta") {
        return { success: false, error: "Jupiter Swap requires Mainnet." };
    }

    try {
        const connection = getConnection();

        const swapResponse = await fetch(`${JUPITER_BASE}/swap`, {
            method: "POST",
            headers: jupiterHeaders(),
            body: JSON.stringify({
                quoteResponse: quote._raw,
                userPublicKey: walletPublicKey.toBase58(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                dynamicSlippage: true,
                prioritizationFeeLamports: {
                    priorityLevelWithMaxLamports: {
                        maxLamports: 1000000,
                        priorityLevel: "veryHigh"
                    }
                }
            })
        });

        if (!swapResponse.ok) {
            let errorText = "Failed to get swap transaction";
            try {
                const errBody = await swapResponse.json();
                errorText = errBody.message || errBody.error || errorText;
            } catch {
                errorText = `Jupiter Swap API returned HTTP ${swapResponse.status}`;
            }
            throw new Error(errorText);
        }

        const swapData = await swapResponse.json();
        const { swapTransaction } = swapData;

        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

        const signedTransaction = await signTransaction(transaction);
        const rawTransaction = signedTransaction.serialize();

        // Use the blockhash that's actually in the signed transaction +
        // Jupiter's reported lastValidBlockHeight. Fetching a fresh
        // blockhash here would point confirmation at a different message
        // than what the network is asked to land, and on slow public RPC
        // the window expires before the tx propagates -> "block height
        // exceeded".
        const txBlockhash = signedTransaction.message.recentBlockhash;
        const txLastValidBlockHeight: number =
            swapData.lastValidBlockHeight ||
            (await connection.getLatestBlockhash()).lastValidBlockHeight;

        const txid = await sendAndConfirmWithRetry(
            connection,
            rawTransaction,
            txBlockhash,
            txLastValidBlockHeight,
        );

        return { success: true, txid };

    } catch (error: any) {
        console.error("Jupiter Swap Error:", error);
        return { success: false, error: error.message || "Unknown error occurred during swap" };
    }
}

/**
 * Broadcast a signed raw transaction and rebroadcast every ~1.5s while
 * polling for confirmation. Throws once the chain advances past
 * lastValidBlockHeight or after a hard timeout. Removes the most common
 * "block height exceeded" failure mode where a single initial broadcast
 * gets dropped by a congested leader.
 */
async function sendAndConfirmWithRetry(
    connection: ReturnType<typeof getConnection>,
    rawTransaction: Uint8Array,
    blockhash: string,
    lastValidBlockHeight: number,
): Promise<string> {
    const signature = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
        maxRetries: 0,
    });
    const start = Date.now();
    while (true) {
        const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: false });
        const value = status.value;
        if (value && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized")) {
            if (value.err) throw new Error(`Swap failed on-chain: ${JSON.stringify(value.err)}`);
            return signature;
        }
        const currentHeight = await connection.getBlockHeight("confirmed");
        if (currentHeight > lastValidBlockHeight) {
            throw new Error(
                "The transaction expired before confirming (network congestion). Please try again.",
            );
        }
        if (Date.now() - start > 1500) {
            try { await connection.sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 0 }); } catch {}
        }
        if (Date.now() - start > 90_000) {
            throw new Error("Swap confirmation timed out after 90s.");
        }
        await new Promise((r) => setTimeout(r, 1500));
        // Avoid suppressing the unused-var warning for `blockhash` — we
        // intentionally don't pass it to confirmTransaction (we poll
        // status directly), but it's kept for future debugging.
        void blockhash;
    }
}
