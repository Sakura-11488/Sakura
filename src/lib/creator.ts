import { supabase } from "./supabase";
import { MANGA_SOURCE_IDS, normalizeMangaSourceId } from "./sources/source-ids";
import {
    TWO_HE_ANIME_COVER,
    TWO_HE_ANIME_ID,
    TWO_HE_CREATOR_BIO,
    TWO_HE_CREATOR_WALLET,
} from "./2heAnime";

export interface CreatorProfile {
    wallet_address: string;
    display_name: string;
    bio: string | null;
    avatar_url: string | null;
    is_verified: boolean;
    mangadex_author_id: string | null;
    created_at: string;
    updated_at: string;
}

export interface TipRecord {
    id: number;
    tx_hash: string;
    sender_address: string;
    receiver_address: string;
    amount_sol: number;
    created_at: string;
}

export const TWO_HE_CREATOR_PROFILE: CreatorProfile = {
    wallet_address: TWO_HE_CREATOR_WALLET,
    display_name: "2heAnime",
    bio: TWO_HE_CREATOR_BIO,
    avatar_url: TWO_HE_ANIME_COVER,
    is_verified: true,
    mangadex_author_id: TWO_HE_ANIME_ID,
    created_at: "2026-05-25T00:00:00.000Z",
    updated_at: "2026-05-25T00:00:00.000Z",
};

function getStaticCreatorProfile(walletAddressOrAuthorId: string): CreatorProfile | null {
    const value = walletAddressOrAuthorId.toLowerCase();
    if (
        value === TWO_HE_CREATOR_WALLET.toLowerCase() ||
        value === TWO_HE_ANIME_ID ||
        value === "2he"
    ) {
        return TWO_HE_CREATOR_PROFILE;
    }
    return null;
}

export async function getCreatorProfile(walletAddressOrAuthorId: string): Promise<CreatorProfile | null> {
    const staticProfile = getStaticCreatorProfile(walletAddressOrAuthorId);
    if (staticProfile) return staticProfile;
    if (!supabase) return null;

    // Try to fetch by wallet_address or content author ID
    const { data, error } = await supabase
        .from("creator_profiles")
        .select("*")
        .or(`wallet_address.eq.${walletAddressOrAuthorId},mangadex_author_id.eq.${walletAddressOrAuthorId}`)
        .single();

    if (error && error.code !== "PGRST116") {
        console.error("Error fetching creator profile:", error);
        return getStaticCreatorProfile(walletAddressOrAuthorId);
    }

    return data || getStaticCreatorProfile(walletAddressOrAuthorId);
}

export async function getCreatorProfileByContentAuthor(sourceId: string, contentAuthorId: string): Promise<CreatorProfile | null> {
    if (normalizeMangaSourceId(sourceId) !== MANGA_SOURCE_IDS.MANGADEX) {
        return null;
    }

    return getCreatorProfile(contentAuthorId);
}

export type SubmitCreatorApplicationResult =
    | { ok: true }
    | { ok: false; message: string };

export async function submitCreatorApplication(
    walletAddress: string,
    displayName: string,
    bio: string,
    contentAuthorId: string | null
): Promise<SubmitCreatorApplicationResult> {
    if (!supabase) {
        return {
            ok: false,
            message: "Server unavailable, try again in a moment.",
        };
    }

    const { error } = await supabase
        .from("creator_profiles")
        .upsert({
            wallet_address: walletAddress,
            display_name: displayName,
            bio: bio,
            mangadex_author_id: contentAuthorId,
            is_verified: false, // Default to false until manually approved or via automated system
            updated_at: new Date().toISOString(),
        }, { onConflict: "wallet_address" });

    if (error) {
        console.error("Error submitting creator application:", error);
        return {
            ok: false,
            message: error.message || "Failed to submit creator application.",
        };
    }
    return { ok: true };
}

export async function recordTip(
    txHash: string,
    senderAddress: string,
    receiverAddress: string,
    amountSol: number
): Promise<boolean> {
    if (!supabase) return false;

    const { error } = await supabase
        .from("tips_history")
        .insert({
            tx_hash: txHash,
            sender_address: senderAddress,
            receiver_address: receiverAddress,
            amount_sol: amountSol
        });

    if (error) {
        console.error("Error recording tip:", error);
        return false;
    }
    return true;
}

export async function getCreatorTips(walletAddress: string): Promise<TipRecord[]> {
    if (!supabase) return [];

    const { data, error } = await supabase
        .from("tips_history")
        .select("*")
        .eq("receiver_address", walletAddress)
        .order("created_at", { ascending: false });

    if (error) {
        console.error("Error fetching tips:", error);
        return [];
    }

    return data || [];
}

export async function searchCreators(query: string): Promise<CreatorProfile[]> {
    const staticProfile = getStaticCreatorProfile(query.trim());
    if (!supabase || !query.trim()) return staticProfile ? [staticProfile] : [];

    const { data, error } = await supabase
        .from("creator_profiles")
        .select("*")
        .ilike("display_name", `%${query.trim()}%`)
        .eq("is_verified", true)
        .order("display_name", { ascending: true })
        .limit(20);

    if (error) {
        console.error("Error searching creators:", error);
        return staticProfile ? [staticProfile] : [];
    }

    const results = data || [];
    if (staticProfile && !results.some(profile => profile.wallet_address === staticProfile.wallet_address)) {
        return [staticProfile, ...results];
    }
    return results;
}

// Admin Functions
export async function getPendingCreators(): Promise<CreatorProfile[]> {
    if (!supabase) return [];

    const { data, error } = await supabase
        .from("creator_profiles")
        .select("*")
        .eq("is_verified", false)
        .order("created_at", { ascending: false });

    if (error) {
        console.error("Error fetching pending creators:", error);
        return [];
    }

    return data || [];
}

export async function verifyCreator(walletAddress: string): Promise<boolean> {
    if (!supabase) return false;

    const { error } = await supabase
        .from("creator_profiles")
        .update({ is_verified: true, updated_at: new Date().toISOString() })
        .eq("wallet_address", walletAddress);

    if (error) {
        console.error("Error verifying creator:", error);
        return false;
    }

    return true;
}
