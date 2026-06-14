import { PhoenixHttpClient } from "@ellipsis-labs/rise";

const DEFAULT_PHOENIX_API_URL = "https://perp-api.phoenix.trade";
const DEFAULT_PHOENIX_WS_URL = "wss://perp-api.phoenix.trade/v1/ws";
const DEFAULT_MARKET_SYMBOL = "SOL";

let httpClient: PhoenixHttpClient | null = null;

export function getPhoenixApiUrl(): string {
    return (process.env.NEXT_PUBLIC_PHOENIX_API_URL || DEFAULT_PHOENIX_API_URL).replace(/\/+$/, "");
}

export function getPhoenixWsUrl(): string {
    return (process.env.NEXT_PUBLIC_PHOENIX_WS_URL || DEFAULT_PHOENIX_WS_URL).trim();
}

export function normalizePhoenixSymbol(symbol?: string | null): string {
    const configured = (symbol || process.env.NEXT_PUBLIC_PHOENIX_DEFAULT_MARKET || DEFAULT_MARKET_SYMBOL).trim();
    return configured.replace(/-PERP$/i, "").toUpperCase();
}

export function getDefaultPhoenixSymbol(): string {
    return normalizePhoenixSymbol();
}

export function getPhoenixHttpClient(): PhoenixHttpClient {
    if (!httpClient) {
        httpClient = new PhoenixHttpClient({
            apiUrl: getPhoenixApiUrl(),
            timeout: 30_000,
        });
    }
    return httpClient;
}

export function resetPhoenixHttpClientForTests(): void {
    httpClient?.dispose?.();
    httpClient = null;
}
