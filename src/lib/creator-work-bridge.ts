import { supabase } from "@/lib/supabase";
import {
    createCreatorWork,
    createWorkRelease,
    deleteWorkRelease,
    deleteCreatorWork,
    getWorkReleases,
    updateCreatorWork,
    updateWorkRelease,
} from "@/lib/creator-works";
import { slugifyWorkTitle, type CreatorWork, type WorkRelease } from "@/lib/publishing";
import type { Novel, NovelChapter } from "@/lib/novel";

const LEGACY_NOVEL_SOURCE = "legacy_novel_dashboard";

type LegacyNovelChapterLike = Pick<
    NovelChapter,
    "id" | "chapter_number" | "title" | "published" | "release_time" | "created_at"
> & {
    content?: string;
};

export async function getCreatorWorkByLegacyNovelId(novelId: string): Promise<CreatorWork | null> {
    if (!supabase || !novelId) return null;

    const { data, error } = await supabase
        .from("creator_works")
        .select("*")
        .contains("release_metadata", { legacy_novel_id: novelId })
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error("getCreatorWorkByLegacyNovelId:", error);
        return null;
    }

    return (data as CreatorWork | null) || null;
}

export async function syncLegacyNovelToCreatorWork(
    wallet: string,
    novel: Novel
): Promise<CreatorWork | null> {
    if (!wallet || !novel.id) return null;

    const existing = await getCreatorWorkByLegacyNovelId(novel.id);
    const releaseMetadata = {
        ...(existing?.release_metadata || {}),
        legacy_novel_id: novel.id,
        legacy_source: LEGACY_NOVEL_SOURCE,
        legacy_bridge_updated_at: new Date().toISOString(),
        cover_url: novel.cover_url || String(existing?.release_metadata?.cover_url || ""),
        pricing: {
            free_until_chapter: novel.free_until_chapter,
            paid_from_chapter: novel.paid_from_chapter,
            price_per_chapter: novel.price_per_chapter,
            allow_pass: novel.allow_pass,
        },
    };

    const mappedFields = {
        title: novel.title,
        description: novel.description,
        genres: novel.genres,
        language: novel.language,
        series_status: novel.status,
        publication_status: novel.published ? "published" : "draft",
        visibility: novel.published ? "public" : "private",
        published_at: novel.published ? novel.updated_at : null,
        release_metadata: releaseMetadata,
    } as const;

    if (!existing) {
        return createCreatorWork(wallet, {
            kind: "novel",
            slug: `${slugifyWorkTitle(novel.title) || "novel"}-${novel.id.slice(0, 8)}`,
            ...mappedFields,
        });
    }

    const updated = await updateCreatorWork(existing.id, wallet, mappedFields);
    if (!updated) {
        return existing;
    }

    return {
        ...existing,
        ...mappedFields,
    };
}

export async function syncLegacyNovelChaptersToWorkReleases(
    wallet: string,
    workId: string,
    chapters: LegacyNovelChapterLike[]
): Promise<WorkRelease[]> {
    if (!wallet || !workId || chapters.length === 0) {
        return getWorkReleases(workId);
    }

    const existingReleases = await getWorkReleases(workId);
    const byLegacyChapterId = new Map<string, WorkRelease>();
    const bySequence = new Map<number, WorkRelease>();

    for (const release of existingReleases) {
        const legacyChapterId = String(release.release_metadata?.legacy_chapter_id || "");
        if (legacyChapterId) {
            byLegacyChapterId.set(legacyChapterId, release);
        }
        bySequence.set(release.sequence_number, release);
    }

    for (const chapter of chapters) {
        const releaseMetadata = {
            legacy_source: LEGACY_NOVEL_SOURCE,
            legacy_chapter_id: chapter.id,
            legacy_chapter_number: chapter.chapter_number,
            legacy_bridge_updated_at: new Date().toISOString(),
            legacy_release_time: chapter.release_time,
        };
        const existingRelease = byLegacyChapterId.get(chapter.id) || bySequence.get(chapter.chapter_number);

        if (!existingRelease) {
            const created = await createWorkRelease(workId, wallet, {
                sequence_number: chapter.chapter_number,
                title: chapter.title,
                summary: "",
                body_text: chapter.content || "",
                content_type: "novel_chapter",
                publication_status: chapter.published ? "published" : "draft",
                visibility: chapter.published ? "public" : "private",
                release_metadata: releaseMetadata,
            });

            if (created) {
                byLegacyChapterId.set(chapter.id, created);
                bySequence.set(chapter.chapter_number, created);
            }
            continue;
        }

        const releaseUpdates: Partial<WorkRelease> = {
            sequence_number: chapter.chapter_number,
            title: chapter.title,
            publication_status: chapter.published ? "published" : "draft",
            visibility: chapter.published ? "public" : "private",
            published_at: chapter.published ? chapter.release_time || existingRelease.published_at || chapter.created_at : null,
            release_metadata: {
                ...(existingRelease.release_metadata || {}),
                ...releaseMetadata,
            },
        };

        if (typeof chapter.content === "string" && chapter.content.trim()) {
            releaseUpdates.body_text = chapter.content;
        }

        await updateWorkRelease(existingRelease.id, wallet, releaseUpdates);
    }

    return getWorkReleases(workId);
}

export async function bridgeLegacyNovelBundle(input: {
    wallet: string;
    novel: Novel;
    chapters?: LegacyNovelChapterLike[];
}): Promise<CreatorWork | null> {
    const work = await syncLegacyNovelToCreatorWork(input.wallet, input.novel);
    if (!work) return null;

    if (input.chapters && input.chapters.length > 0) {
        await syncLegacyNovelChaptersToWorkReleases(input.wallet, work.id, input.chapters);
    }

    return work;
}

export async function deleteLegacyNovelBridge(wallet: string, novelId: string): Promise<boolean> {
    if (!wallet || !novelId) return false;

    const work = await getCreatorWorkByLegacyNovelId(novelId);
    if (!work) return true;

    return deleteCreatorWork(work.id, wallet);
}

export async function deleteLegacyNovelChapterBridge(
    wallet: string,
    novelId: string,
    chapterId: string
): Promise<boolean> {
    if (!wallet || !novelId || !chapterId) return false;

    const work = await getCreatorWorkByLegacyNovelId(novelId);
    if (!work) return true;

    const releases = await getWorkReleases(work.id);
    const matchedRelease = releases.find(
        (release) => String(release.release_metadata?.legacy_chapter_id || "") === chapterId
    );

    if (!matchedRelease) return true;
    return deleteWorkRelease(matchedRelease.id, wallet);
}
