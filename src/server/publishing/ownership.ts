import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { WorkKind } from "@/lib/publishing";

export interface ResolvedPublishingOwnership {
    walletAddress: string;
    workId: string | null;
    releaseId: string | null;
    linkableWorkId: string | null;
    legacyNovelId: string | null;
    workKind: WorkKind | null;
}

export async function resolvePublishingOwnership(
    supabaseAdmin: SupabaseClient,
    input: { walletAddress: string; workId: string | null; releaseId: string | null }
): Promise<ResolvedPublishingOwnership> {
    if (input.releaseId) {
        const release = await supabaseAdmin
            .from("work_releases")
            .select("id, work_id")
            .eq("id", input.releaseId)
            .single();

        if (release.error || !release.data) {
            throw new Error("Release not found.");
        }

        const work = await supabaseAdmin
            .from("creator_works")
            .select("id, creator_wallet, kind")
            .eq("id", release.data.work_id)
            .single();

        if (work.error || !work.data) {
            throw new Error("Parent work not found.");
        }

        if (work.data.creator_wallet !== input.walletAddress) {
            throw new Error("You do not own this release.");
        }

        return {
            walletAddress: input.walletAddress,
            workId: work.data.id,
            releaseId: release.data.id,
            linkableWorkId: work.data.id,
            legacyNovelId: null,
            workKind: work.data.kind as WorkKind,
        };
    }

    if (input.workId) {
        const work = await supabaseAdmin
            .from("creator_works")
            .select("id, creator_wallet, kind")
            .eq("id", input.workId)
            .maybeSingle();

        if (work.data) {
            if (work.data.creator_wallet !== input.walletAddress) {
                throw new Error("You do not own this work.");
            }

            return {
                walletAddress: input.walletAddress,
                workId: work.data.id,
                releaseId: null,
                linkableWorkId: work.data.id,
                legacyNovelId: null,
                workKind: work.data.kind as WorkKind,
            };
        }

        const legacyNovel = await supabaseAdmin
            .from("novels")
            .select("id, creator_wallet")
            .eq("id", input.workId)
            .maybeSingle();

        if (legacyNovel.error || !legacyNovel.data) {
            throw new Error("Work not found.");
        }

        if (legacyNovel.data.creator_wallet !== input.walletAddress) {
            throw new Error("You do not own this work.");
        }

        return {
            walletAddress: input.walletAddress,
            workId: null,
            releaseId: null,
            linkableWorkId: null,
            legacyNovelId: legacyNovel.data.id,
            workKind: "novel",
        };
    }

    return {
        walletAddress: input.walletAddress,
        workId: null,
        releaseId: null,
        linkableWorkId: null,
        legacyNovelId: null,
        workKind: null,
    };
}
