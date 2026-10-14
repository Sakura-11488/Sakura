/**
 * Phoenix endpoint and market-symbol settings, kept apart from ./phoenix.
 *
 * Why a separate file: ./phoenix imports the perps SDK (@ellipsis-labs/rise,
 * @solana/kit, zod: about 2MB on web), so screens load it with import() only
 * when they fetch market data. app/trade.tsx still needs the default symbol
 * synchronously, while it renders; reading it from here costs nothing and
 * keeps the SDK out of that screen's own chunk. ./phoenix re-exports all of
 * this, so existing imports keep working.
 */
const DEFAULT_PHOENIX_API_URL = 'https://perp-api.phoenix.trade';
const DEFAULT_MARKET_SYMBOL = 'SOL';

export function getPhoenixApiUrl(): string {
  return (process.env.EXPO_PUBLIC_PHOENIX_API_URL || DEFAULT_PHOENIX_API_URL).replace(/\/+$/, '');
}

export function normalizePhoenixSymbol(symbol?: string | null): string {
  const configured = (
    symbol ||
    process.env.EXPO_PUBLIC_PHOENIX_DEFAULT_MARKET ||
    DEFAULT_MARKET_SYMBOL
  ).trim();
  return configured.replace(/-PERP$/i, '').toUpperCase();
}

export function getDefaultPhoenixSymbol(): string {
  return normalizePhoenixSymbol();
}
