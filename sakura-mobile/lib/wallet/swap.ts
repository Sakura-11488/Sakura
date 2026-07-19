import { PublicKey, VersionedTransaction, Keypair } from '@solana/web3.js';
import { getConnection } from './connection';
import { SAKURA_MINT, SAKURA_DECIMALS } from './config';

const JUPITER_BASE = 'https://api.jup.ag/swap/v1';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_PRIORITY_FEE_LAMPORTS = 1_000_000;
// Free key from https://portal.jup.ag — set EXPO_PUBLIC_JUPITER_API_KEY in .env; never commit the key.
const JUPITER_API_KEY = process.env.EXPO_PUBLIC_JUPITER_API_KEY?.trim() || '';

/** React Native has no Node `Buffer`; Jupiter returns base64-encoded transactions. */
function base64ToBytes(base64: string): Uint8Array {
  const atobFn = globalThis.atob;
  if (typeof atobFn !== 'function') {
    throw new Error('Base64 decode is not available on this device');
  }
  const binary = atobFn(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export interface SwapQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  outAmountSakura: number;
  _raw: any;
}

export interface SwapResult {
  success: boolean;
  txid?: string;
  error?: string;
}

function jupiterHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (JUPITER_API_KEY) headers['x-api-key'] = JUPITER_API_KEY;
  return headers;
}

function parseJupiterError(status: number, body: any, fallback: string): string {
  const raw = body?.message || body?.error || fallback;
  const message = typeof raw === 'string' ? raw : fallback;
  if (status === 401 || status === 403) {
    return 'Jupiter rejected the swap request. Please try again in a moment.';
  }
  if (status === 429) {
    return 'Jupiter is rate-limiting swap requests. Please wait a moment and try again.';
  }
  if (/NO_ROUTES_FOUND|TOKEN_NOT_TRADABLE|MARKET_NOT_FOUND/i.test(message)) {
    return 'No Jupiter route is currently available for buying SAKURA with SOL.';
  }
  return message;
}

function validateQuoteShape(quote: SwapQuote): void {
  const raw = quote._raw || {};
  if (raw.inputMint !== WSOL_MINT) {
    throw new Error('Swap quote input mint changed unexpectedly.');
  }
  if (raw.outputMint !== SAKURA_MINT.toBase58()) {
    throw new Error('Swap quote output mint changed unexpectedly.');
  }
  if (String(raw.inAmount) !== String(quote.inAmount) || String(raw.outAmount) !== String(quote.outAmount)) {
    throw new Error('Swap quote amounts changed unexpectedly.');
  }
}

function validateJupiterTransaction(tx: VersionedTransaction, quote: SwapQuote, keypair: Keypair): void {
  validateQuoteShape(quote);

  const message = tx.message;
  const feePayer = message.staticAccountKeys[0]?.toBase58();
  if (feePayer !== keypair.publicKey.toBase58()) {
    throw new Error('Swap transaction fee payer does not match wallet.');
  }

  const signerCount = message.header.numRequiredSignatures;
  const signers = message.staticAccountKeys.slice(0, signerCount).map((key) => key.toBase58());
  if (signers.length !== 1 || signers[0] !== keypair.publicKey.toBase58()) {
    throw new Error('Swap transaction requested an unexpected signer.');
  }
}

export async function getSakuraSwapQuote(amountSol: number): Promise<SwapQuote> {
  if (!JUPITER_API_KEY) {
    throw new Error('Jupiter API key not configured. Get a free key at portal.jup.ag and set EXPO_PUBLIC_JUPITER_API_KEY.');
  }
  const lamports = Math.round(amountSol * 1e9);
  const url = `${JUPITER_BASE}/quote?inputMint=${WSOL_MINT}&outputMint=${SAKURA_MINT.toBase58()}&amount=${lamports}&slippageBps=100&restrictIntermediateTokens=true`;
  const res = await fetch(url, { headers: jupiterHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(parseJupiterError(res.status, body, `Jupiter API error ${res.status}`));
  }
  const data = await res.json();
  return {
    inAmount: data.inAmount,
    outAmount: data.outAmount,
    priceImpactPct: data.priceImpactPct ?? '0',
    outAmountSakura: Number(data.outAmount) / 10 ** SAKURA_DECIMALS,
    _raw: data,
  };
}

export async function executeSakuraSwap(
  quote: SwapQuote,
  keypair: Keypair,
): Promise<SwapResult> {
  try {
    const connection = getConnection();

    const swapRes = await fetch(`${JUPITER_BASE}/swap`, {
      method: 'POST',
      headers: jupiterHeaders(),
      body: JSON.stringify({
        quoteResponse: quote._raw,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: MAX_PRIORITY_FEE_LAMPORTS,
            priorityLevel: 'veryHigh',
          },
        },
      }),
    });

    if (!swapRes.ok) {
      const body = await swapRes.json().catch(() => ({}));
      throw new Error(parseJupiterError(swapRes.status, body, `Jupiter swap error ${swapRes.status}`));
    }

    const { swapTransaction, lastValidBlockHeight } = await swapRes.json();
    const tx = VersionedTransaction.deserialize(base64ToBytes(swapTransaction));
    validateJupiterTransaction(tx, quote, keypair);

    tx.sign([keypair]);

    const txid = await sendAndConfirmWithRetry(
      tx.serialize(),
      tx.message.recentBlockhash,
      lastValidBlockHeight ?? (await connection.getLatestBlockhash()).lastValidBlockHeight,
    );

    return { success: true, txid };
  } catch (e: any) {
    return { success: false, error: e.message ?? 'Unknown error' };
  }
}

async function sendAndConfirmWithRetry(
  rawTransaction: Uint8Array,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<string> {
  const connection = getConnection();
  const signature = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: true,
    maxRetries: 0,
  });
  const startedAt = Date.now();
  let lastRebroadcastAt = startedAt;

  while (true) {
    const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: false });
    const value = status.value;
    if (value && (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized')) {
      if (value.err) throw new Error(`Swap failed on-chain: ${JSON.stringify(value.err)}`);
      return signature;
    }

    const currentHeight = await connection.getBlockHeight('confirmed');
    if (currentHeight > lastValidBlockHeight) {
      throw new Error('The swap expired before confirming. Please try again.');
    }

    if (Date.now() - lastRebroadcastAt > 1500) {
      try {
        await connection.sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 0 });
      } catch {
        // Another leader may have already accepted the transaction.
      }
      lastRebroadcastAt = Date.now();
    }

    if (Date.now() - startedAt > 90_000) {
      throw new Error('Swap confirmation timed out after 90s.');
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    void blockhash;
  }
}
