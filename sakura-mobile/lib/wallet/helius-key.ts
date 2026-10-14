/**
 * The Helius API key, for builds that call Helius directly: native builds
 * without EXPO_PUBLIC_SOLANA_RPC fall back to it in ./config. The web build
 * never reads it — see helius-key.web.ts.
 */
export const HELIUS_API_KEY = (process.env.EXPO_PUBLIC_HELIUS_API_KEY || '').trim();
