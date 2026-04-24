import { getSource } from ".";
import { MANGA_SOURCE_IDS, normalizeMangaSourceId, type MangaSourceId } from "./source-ids";
import type { Chapter, Manga } from "./types";

const WEAK_CHAPTER_THRESHOLD = 10;
const FALLBACK_ADVANTAGE_MIN = 20;

function normalizeTitle(value: string): string {
    return value
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\b(the|a|an|of|and|part|chapter|vol|volume)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function scoreTitleMatch(query: string, candidate: string): number {
    const queryTokens = normalizeTitle(query).split(" ").filter(Boolean);
    const candidateTokens = new Set(normalizeTitle(candidate).split(" ").filter(Boolean));
    if (queryTokens.length === 0 || candidateTokens.size === 0) return 0;
    if (normalizeTitle(query) === normalizeTitle(candidate)) return 100;

    let overlap = 0;
    for (const token of queryTokens) {
        if (candidateTokens.has(token)) overlap += 1;
    }

    return Math.round((overlap / queryTokens.length) * 100);
}

export async function findBestSourceMatch(
    sourceId: string,
    title: string,
    minimumScore = 70,
): Promise<Manga | null> {
    const source = getSource(sourceId);
    const results = await source.searchManga(title, 12, 0);
    let best: Manga | null = null;
    let bestScore = 0;

    for (const result of results) {
        const score = scoreTitleMatch(title, result.title);
        if (score > bestScore) {
            best = result;
            bestScore = score;
        }
    }

    return bestScore >= minimumScore ? best : null;
}

export async function resolveSeriesFallback(
    requestedSourceId: string,
    requestedSeries: Manga | null,
    requestedChapters: Chapter[],
    preferredFallbackSourceId: MangaSourceId = MANGA_SOURCE_IDS.ATSUMARU,
): Promise<{ sourceId: MangaSourceId; mangaId: string; manga: Manga; chapters: Chapter[] } | null> {
    const normalizedRequestedSource = normalizeMangaSourceId(requestedSourceId);
    if (normalizedRequestedSource === preferredFallbackSourceId) return null;
    if (!requestedSeries?.title) return null;

    const currentCount = requestedChapters.length;
    const fallbackCandidate = await findBestSourceMatch(preferredFallbackSourceId, requestedSeries.title);
    if (!fallbackCandidate) return null;

    const fallbackSource = getSource(preferredFallbackSourceId);
    const [fallbackManga, fallbackChapters] = await Promise.all([
        fallbackSource.getMangaDetails(fallbackCandidate.id),
        fallbackSource.getChapters(fallbackCandidate.id),
    ]);

    if (!fallbackManga || fallbackChapters.length === 0) return null;

    const shouldUseFallback =
        currentCount === 0 ||
        (currentCount <= WEAK_CHAPTER_THRESHOLD &&
            fallbackChapters.length >= Math.max(WEAK_CHAPTER_THRESHOLD + FALLBACK_ADVANTAGE_MIN, currentCount + FALLBACK_ADVANTAGE_MIN));

    if (!shouldUseFallback) return null;

    return {
        sourceId: preferredFallbackSourceId,
        mangaId: fallbackCandidate.id,
        manga: {
            ...fallbackManga,
            sourceStr: preferredFallbackSourceId,
        },
        chapters: fallbackChapters.map((chapter) => ({
            ...chapter,
            mangaId: fallbackCandidate.id,
            sourceStr: preferredFallbackSourceId,
        })),
    };
}
