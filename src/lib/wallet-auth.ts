export type WalletAuthHeaders = Record<string, string>;

export function buildWalletAuthHeaders(
    wallet: string,
    signature: string,
    message: string
): WalletAuthHeaders {
    return {
        "x-wallet-address": wallet,
        "x-signature": signature,
        "x-message": message,
    };
}

export function generateWalletAuthMessage(action: string): string {
    const ts = Math.floor(Date.now() / 1000);
    return `sakura:${action}:ts:${ts}`;
}
