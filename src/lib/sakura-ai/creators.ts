import { supabase } from "@/lib/supabase";
import { searchManga, getMangaDetails } from "@/lib/content-source";
import { getCreatorProfile, type CreatorProfile } from "@/lib/creator";

/**
 * Creator-discovery for Sakura AI's `tip_creator` flow.
 *
 * The user can ask "tip the author of Chainsaw Man 100 SAKURA". We resolve
 * a recipient wallet by:
 *   1. Searching the title via the same MangaDex pipeline the rest of the
 *      app uses, so the resolved author matches what the user is reading.
 *   2. Looking up the matching `creator_profiles` row (keyed by
 *      `mangadex_author_id` or by display_name).
 *   3. Returning a `TipTarget` the engine can hand to the existing
 *      `transfer_token` / `transfer_sol` confirmation flow.
 *
 * Falls back to a fuzzy search on `creator_profiles.display_name` so users
 * can also tip a Sakura-native creator who hasn't (yet) linked an external
 * MangaDex author id.
 *
 * Always degrades gracefully — if Supabase isn't configured, this module
 * returns "no_creator_profile" instead of crashing, so the AI can explain
 * the situation to the user.
 */

export interface TipTarget {
    workTitle: string;
    walletAddress: string;
    displayName: string;
    creatorBio?: string | null;
    isVerified?: boolean;
    workCover?: string;
    matchedVia: "title" | "name" | "wallet";
}

export type FindCreatorResult =
    | { ok: true; target: TipTarget }
    | {
          ok: false;
          reason:
              | "title_not_found"
              | "no_author_id"
              | "no_creator_profile"
              | "name_not_found"
              | "no_supabase";
          message: string;
          /** Optional fallback display name from MangaDex even when we
           *  couldn't link to a Sakura wallet — the AI can use this to
           *  apologise gracefully ("Tatsuki Fujimoto isn't on Sakura yet"). */
          authorDisplayName?: string;
      };

async function findCreatorByMangadexAuthorId(authorId: string): Promise<CreatorProfile | null> {
    if (!supabase || !authorId) return null;
    return getCreatorProfile(authorId);
}

async function findCreatorByName(name: string): Promise<CreatorProfile | null> {
    if (!supabase || !name?.trim()) return null;
    const { data, error } = await supabase
        .from("creator_profiles")
        .select("*")
        .ilike("display_name", `%${name.trim()}%`)
        .order("is_verified", { ascending: false })
        .limit(1);
    if (error) {
        if ((error as any).code === "42P01") return null;
        console.warn("[creators] lookup by name failed", error);
        return null;
    }
    return ((data as CreatorProfile[]) || [])[0] || null;
}

/**
 * Resolve a Sakura creator from a free-form query. The query may be a
 * series title ("Chainsaw Man") or a creator's name/handle ("Fujimoto").
 */
export async function findCreatorByQuery(query: string): Promise<FindCreatorResult> {
    const trimmed = (query || "").trim();
    if (!trimmed) {
        return { ok: false, reason: "title_not_found", message: "Tell me what to tip — title or creator name." };
    }
    if (!supabase) {
        return { ok: false, reason: "no_supabase", message: "Tip lookups require a Supabase connection." };
    }

    // Try as a series title first — most natural request shape.
    try {
        const hits = await searchManga(trimmed, 3);
        if (hits.length > 0) {
            const detailed = await getMangaDetails(hits[0].id);
            const top = detailed || hits[0];
            const authorId = (top as any).authorId as string | undefined;
            if (!authorId) {
                // Couldn't extract a MangaDex author id — fall through to
                // name-based lookup using the author display name from
                // the search hit.
                const authorName = (top as any).author as string | undefined;
                if (authorName) {
                    const byName = await findCreatorByName(authorName);
                    if (byName) {
                        return {
                            ok: true,
                            target: {
                                workTitle: top.title,
                                walletAddress: byName.wallet_address,
                                displayName: byName.display_name,
                                creatorBio: byName.bio,
                                isVerified: byName.is_verified,
                                workCover: top.cover,
                                matchedVia: "title",
                            },
                        };
                    }
                    return {
                        ok: false,
                        reason: "no_creator_profile",
                        message: `${authorName} isn't on Sakura yet — there's no wallet to tip.`,
                        authorDisplayName: authorName,
                    };
                }
                return {
                    ok: false,
                    reason: "no_author_id",
                    message: `Couldn't find an author for "${top.title}".`,
                };
            }

            const profile = await findCreatorByMangadexAuthorId(authorId);
            if (profile) {
                return {
                    ok: true,
                    target: {
                        workTitle: top.title,
                        walletAddress: profile.wallet_address,
                        displayName: profile.display_name,
                        creatorBio: profile.bio,
                        isVerified: profile.is_verified,
                        workCover: top.cover,
                        matchedVia: "title",
                    },
                };
            }

            return {
                ok: false,
                reason: "no_creator_profile",
                message: `${(top as any).author || "That author"} isn't on Sakura yet — there's no wallet to tip.`,
                authorDisplayName: (top as any).author,
            };
        }
    } catch (e) {
        console.warn("[creators] search by title failed", (e as any)?.message);
    }

    // Fallback: treat the query as a creator name directly.
    const byName = await findCreatorByName(trimmed);
    if (byName) {
        return {
            ok: true,
            target: {
                workTitle: byName.display_name,
                walletAddress: byName.wallet_address,
                displayName: byName.display_name,
                creatorBio: byName.bio,
                isVerified: byName.is_verified,
                matchedVia: "name",
            },
        };
    }

    return {
        ok: false,
        reason: "title_not_found",
        message: `Couldn't find anything matching "${trimmed}".`,
    };
}
