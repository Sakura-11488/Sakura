import { SAKURA_MINT } from './config';

const JUP_PRICE = 'https://api.jup.ag/price/v2';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const COMMON_TOKENS: Record<string, string> = {
  sol: WSOL_MINT,
  wsol: WSOL_MINT,
  sakura: SAKURA_MINT.toBase58(),
  skr: SAKURA_MINT.toBase58(),
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  usdt: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  bonk: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  jup: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
};

export interface TokenPrice {
  mint: string;
  symbol?: string;
  priceUsd: number;
}

/** Resolve a user-typed token (symbol or mint) to a mint address. */
export function resolveTokenMint(input: string): string | null {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (COMMON_TOKENS[lower]) return COMMON_TOKENS[lower];
  // Heuristic: base58 mint addresses are 32–44 chars, no spaces.
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return trimmed;
  return null;
}

export async function fetchTokenPrices(mints: string[]): Promise<Record<string, number>> {
  const unique = Array.from(new Set(mints.filter(Boolean)));
  if (unique.length === 0) return {};
  try {
    const res = await fetch(`${JUP_PRICE}?ids=${unique.join(',')}`);
    if (!res.ok) return {};
    const json = (await res.json()) as { data?: Record<string, { price?: string | number }> };
    const out: Record<string, number> = {};
    for (const mint of unique) {
      const price = json.data?.[mint]?.price;
      const n = typeof price === 'string' ? parseFloat(price) : Number(price);
      if (Number.isFinite(n)) out[mint] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export async function lookupTokenPrice(input: string): Promise<TokenPrice | null> {
  const mint = resolveTokenMint(input);
  if (!mint) return null;
  const prices = await fetchTokenPrices([mint]);
  const priceUsd = prices[mint];
  if (priceUsd == null) return null;
  const symbol = Object.entries(COMMON_TOKENS).find(([, m]) => m === mint)?.[0]?.toUpperCase();
  return { mint, symbol, priceUsd };
}

export async function getSolPriceUsd(): Promise<number> {
  const prices = await fetchTokenPrices([WSOL_MINT]);
  return prices[WSOL_MINT] ?? 0;
}

export async function getSakuraPriceUsd(): Promise<number> {
  const mint = SAKURA_MINT.toBase58();
  const prices = await fetchTokenPrices([mint]);
  return prices[mint] ?? 0;
}
