import {
    getLocal,
    STORAGE_KEYS,
    getAnimeHistory,
    type AnimeHistoryEntry,
} from "@/lib/storage";
import {
    findSimilarAnime,
    findSimilarManga,
    type DiscoveryCard,
    type DiscoveryResult,
} from "./discovery";

/**
 * Library / history-aware helpers for Sakura AI.
 *
 * Exposes two capabilities to the engine:
 *
 *  - `getResumeItems(limit)` — collects the user's most recently engaged
 *    titles from BOTH anime watch history and manga reading history and
 *    returns them as `DiscoveryCard`s with deeplinks that resume the user
 *    exactly where they left off (`/anime/watch?id=…&ep=…`,
 *    `/chapter?id=…&manga=…&source=…`).
 *
 *  - `recommendForMe()` — picks the top entries from history and uses
 *    `findSimilarAnime` / `findSimilarManga` to fan-out genre-aware
 *    recommendations so the user gets "more like what they actually read".
 *
 * Both helpers are pure client-side reads from localStorage; they do not
 * touch Supabase. They will return `[]` on the server and on first launch.
 */

const RESUME_LIMIT_DEFAULT = 8;
const RECO_PER_REFERENCE = 3;
const RECO_MAX_TOTAL = 8;

interface LocalMangaHistoryItem {
    mangaId: string;
    chapterId: string;
    title: string;
    cover: string;
    lastReadAt: number;
    chapterNum?: string;
    sourceId?: string;
}

function readMangaHistory(): LocalMangaHistoryItem[] {
    return getLocal<LocalMangaHistoryItem[]>(STORAGE_KEYS.HISTORY, []);
}

function animeHistoryToCard(entry: AnimeHistoryEntry): DiscoveryCard {
    const route = `/anime/watch?id=${encodeURIComponent(entry.animeId)}&ep=${encodeURIComponent(entry.episodeId)}`;
    return {
        kind: "anime",
        id: entry.animeId,
        title: entry.animeTitle,
        image: entry.image,
        type: `Resume · Ep ${entry.episodeNumber}`,
        route,
    };
}

function mangaHistoryToCard(entry: LocalMangaHistoryItem): DiscoveryCard {
    const source = entry.sourceId || "mangadex";
    const route = `/chapter?id=${encodeURIComponent(entry.chapterId)}&manga=${encodeURIComponent(entry.mangaId)}&source=${encodeURIComponent(source)}`;
    return {
        kind: "manga",
        id: entry.mangaId,
        title: entry.title,
        image: entry.cover,
        type: entry.chapterNum ? `Resume · Ch ${entry.chapterNum}` : "Resume reading",
        route,
    };
}

/**
 * Top resumable items across anime + manga, sorted by recency.
 * Each card's `route` deep-links into the exact chapter / episode the
 * user last opened.
 */
export function getResumeItems(limit: number = RESUME_LIMIT_DEFAULT): DiscoveryCard[] {
    const animeCards = getAnimeHistory().map((e) => ({
        card: animeHistoryToCard(e),
        ts: e.timestamp,
    }));
    const mangaCards = readMangaHistory().map((e) => ({
        card: mangaHistoryToCard(e),
        ts: e.lastReadAt,
    }));
    return [...animeCards, ...mangaCards]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, Math.max(1, limit))
        .map((x) => x.card);
}

export interface RecommendForMeResult {
    /** Cards we recommend, dedup'd across anime + manga. */
    cards: DiscoveryCard[];
    /** The history references we seeded discovery from. */
    seeds: { kind: "anime" | "manga"; title: string }[];
}

function dedupCards(input: DiscoveryCard[]): DiscoveryCard[] {
    const seen = new Set<string>();
    const out: DiscoveryCard[] = [];
    for (const card of input) {
        const key = `${card.kind}:${card.id}:${card.title}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(card);
    }
    return out;
}

/**
 * Use the user's most-recently engaged anime and manga titles to seed
 * discovery. We pull the top N seeds, fan out to `findSimilar*`, then
 * interleave the results so neither bucket dominates.
 */
export async function recommendForMe(maxSeeds: number = 2): Promise<RecommendForMeResult> {
    const anime = getAnimeHistory().slice(0, maxSeeds);
    const manga = readMangaHistory().slice(0, maxSeeds);

    const seeds: { kind: "anime" | "manga"; title: string }[] = [
        ...anime.map((a) => ({ kind: "anime" as const, title: a.animeTitle })),
        ...manga.map((m) => ({ kind: "manga" as const, title: m.title })),
    ];

    if (seeds.length === 0) {
        return { cards: [], seeds: [] };
    }

    const animeResults: DiscoveryResult[] = await Promise.all(
        anime.map((a) => findSimilarAnime(a.animeTitle).catch(() => ({ reference: a.animeTitle, cards: [] }))),
    );
    const mangaResults: DiscoveryResult[] = await Promise.all(
        manga.map((m) => findSimilarManga(m.title).catch(() => ({ reference: m.title, cards: [] }))),
    );

    // Skip cards that are exactly the same as our seed (Sakura
    // shouldn't recommend the title the user already opened).
    const seedTitles = new Set(seeds.map((s) => s.title.toLowerCase()));
    const buckets = [
        ...animeResults.map((r) => r.cards.slice(0, RECO_PER_REFERENCE)),
        ...mangaResults.map((r) => r.cards.slice(0, RECO_PER_REFERENCE)),
    ].map((cards) => cards.filter((c) => !seedTitles.has(c.title.toLowerCase())));

    // Round-robin interleave so we balance anime + manga in the result.
    const out: DiscoveryCard[] = [];
    let active = true;
    while (active && out.length < RECO_MAX_TOTAL) {
        active = false;
        for (const bucket of buckets) {
            const next = bucket.shift();
            if (next) {
                out.push(next);
                active = true;
                if (out.length >= RECO_MAX_TOTAL) break;
            }
        }
    }

    return { cards: dedupCards(out), seeds };
}

/**
 * Anime browse only: seeds recommendations from watch history (no manga reads).
 */
export async function recommendAnimeFromHistory(maxSeeds: number = 2): Promise<RecommendForMeResult> {
    const anime = getAnimeHistory().slice(0, maxSeeds);
    const seeds: { kind: "anime"; title: string }[] = anime.map((a) => ({
        kind: "anime",
        title: a.animeTitle,
    }));
    if (seeds.length === 0) {
        return { cards: [], seeds: [] };
    }
    const animeResults: DiscoveryResult[] = await Promise.all(
        anime.map((a) => findSimilarAnime(a.animeTitle).catch(() => ({ reference: a.animeTitle, cards: [] }))),
    );
    const seedTitles = new Set(seeds.map((s) => s.title.toLowerCase()));
    const buckets = animeResults.map((r) =>
        r.cards.slice(0, RECO_PER_REFERENCE).filter((c) => !seedTitles.has(c.title.toLowerCase())),
    );
    const out: DiscoveryCard[] = [];
    let active = true;
    while (active && out.length < RECO_MAX_TOTAL) {
        active = false;
        for (const bucket of buckets) {
            const next = bucket.shift();
            if (next) {
                out.push(next);
                active = true;
                if (out.length >= RECO_MAX_TOTAL) break;
            }
        }
    }
    return { cards: dedupCards(out), seeds };
}

export type { DiscoveryCard };
