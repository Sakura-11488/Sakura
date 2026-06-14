import { getPhoenixHttpClient } from "./client";

const ACTIVATION_KEY_PREFIX = "sakura_phoenix_activated_";

export function getPhoenixReferralCode(): string {
    return (process.env.NEXT_PUBLIC_PHOENIX_REFERRAL_CODE || "").trim();
}

export function getPhoenixActivationCacheKey(wallet: string): string {
    return `${ACTIVATION_KEY_PREFIX}${wallet}`;
}

export function isPhoenixActivatedCached(wallet: string): boolean {
    if (typeof window === "undefined") return false;
    try {
        return window.localStorage.getItem(getPhoenixActivationCacheKey(wallet)) === "1";
    } catch {
        return false;
    }
}

export function cachePhoenixActivated(wallet: string): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(getPhoenixActivationCacheKey(wallet), "1");
    } catch {
        // Local cache is only a UX optimization; server state remains canonical.
    }
}

export async function activatePhoenixWithReferral(wallet: string): Promise<{ traderPda: string }> {
    const referralCode = getPhoenixReferralCode();
    if (!referralCode) {
        throw new Error("Phoenix referral code is missing. Set NEXT_PUBLIC_PHOENIX_REFERRAL_CODE before enabling trading.");
    }

    const response = await getPhoenixHttpClient().invite().activateInviteWithReferral({
        authority: wallet,
        referral_code: referralCode,
    });

    const traderPda = (response as { trader_pda?: string; traderPda?: string }).trader_pda
        || (response as { traderPda?: string }).traderPda
        || "";
    cachePhoenixActivated(wallet);
    return { traderPda };
}
