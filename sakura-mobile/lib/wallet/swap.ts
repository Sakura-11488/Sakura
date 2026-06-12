import { PublicKey, VersionedTransaction, Keypair } from '@solana/web3.js';
import { getConnection } from './connection';
import { SAKURA_MINT, SAKURA_DECIMALS } from './config';

const JUPITER_BASE = 'https://api.jup.ag/swap/v1';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_PRIORITY_FEE_LAMPORTS = 1_000_000;

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

  const staticKeys = new Set(message.staticAccountKeys.map((key) => key.toBase58()));
  if (!staticKeys.has(SAKURA_MINT.toBase58())) {
    throw new Error('Swap transaction is missing the SAKURA mint.');
  }
  if (!staticKeys.has(WSOL_MINT)) {
    throw new Error('Swap transaction is missing the wrapped SOL mint.');
  }
}

export async function getSakuraSwapQuote(amountSol: number): Promise<SwapQuote> {
  const lamports = Math.round(amountSol * 1e9);
  const url = `${JUPITER_BASE}/quote?inputMint=${WSOL_MINT}&outputMint=${SAKURA_MINT.toBase58()}&amount=${lamports}&slippageBps=100&restrictIntermediateTokens=true`;
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error || `Jupiter API error ${res.status}`);
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
      headers: { 'Content-Type': 'application/json' },
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
      throw new Error(body.message || body.error || `Jupiter swap error ${swapRes.status}`);
    }

    const { swapTransaction } = await swapRes.json();
    const tx = VersionedTransaction.deserialize(base64ToBytes(swapTransaction));
    validateJupiterTransaction(tx, quote, keypair);

    tx.sign([keypair]);

    const latestBlockhash = await connection.getLatestBlockhash();
    const txid = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    });
    await connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: txid,
    }, 'confirmed');

    return { success: true, txid };
  } catch (e: any) {
    return { success: false, error: e.message ?? 'Unknown error' };
  }
}
