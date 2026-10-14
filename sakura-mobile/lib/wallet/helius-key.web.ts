/**
 * Web never calls Helius directly. Every Solana request goes through the
 * wallet-rpc edge function (EXPO_PUBLIC_SOLANA_RPC, which the web build
 * requires: web/scripts/check-public-env.mjs), and that function holds the
 * key server-side.
 *
 * So this file must not mention process.env.EXPO_PUBLIC_HELIUS_API_KEY at
 * all: Expo inlines every EXPO_PUBLIC_ value it sees into the public bundle,
 * and with the key in web/.env anyone could lift it and call Helius
 * directly, skipping wallet-rpc's method allowlist and rate limit.
 */
export const HELIUS_API_KEY = '';
