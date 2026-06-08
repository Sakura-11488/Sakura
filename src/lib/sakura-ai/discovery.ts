import {
    searchAnime,
    fetchAnimeInfo,
    fetchAnimeByGenre,
    ANIME_GENRES,
    type AnimeResult,
} from "@/lib/anime";
import {
    searchManga,
    searchMangaByGenre,
    MANGA_GENRES,
    type Manga,
} from "@/lib/content-source";

/**
 * Content discovery for Sakura AI.
 *
 * The AI agent can answer prompts like "I need an anime like Jujutsu
 * Kaisen" by:
 *   1. Searching for the reference title in our normal anime/manga
 *      pipeline (AniList → Jikan fallback for anime, MangaDex for manga).
 *   2. Pulling that title's genre tags.
 *   3. Querying additional titles by the strongest matching genre, then
 *      filtering out the reference itself + duplicates.
 *
 * Each result carries a `route` field — a deeplink that the chat UI
 * renders as a tappable card (`/anime/details?id=…`, `/title?id=…`).
 *
 * If anything fails (offline, sources blocked) we fall back to a smaller
 * "trending in matching genre" sample so the AI still has something to
 * show. We never invent results.
 */

export type DiscoveryKind = "anime" | "manga" | "novel";

export interface DiscoveryCard {
    kind: DiscoveryKind;
    id: string;
    title: string;
    image?: string;
    year?: number | null;
    score?: number | null;
    type?: string;
    route: string;
    genres?: string[];
}

export interface DiscoveryResult {
    reference: string;
    matchedGenre?: string;
    cards: DiscoveryCard[];
}

const MAX_CARDS = 8;

function uniqueById<T extends { id: string; title?: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    const seenTitles = new Set<string>();
    const out: T[] = [];
    for (const item of items) {
        const idKey = String(item.id);
        const titleKey = (item.title || "").trim().toLowerCase();
        if (seen.has(idKey)) continue;
        if (titleKey && seenTitles.has(titleKey)) continue;
        seen.add(idKey);
        if (titleKey) seenTitles.add(titleKey);
        out.push(item);
    }
    return out;
}

function pickGenreId(genreNames: string[] | undefined, table: { id: number | string; name: string }[]): { id: number | string; name: string } | null {
    if (!genreNames || genreNames.length === 0) return null;
    for (const candidate of genreNames) {
        const lower = candidate.toLowerCase();
        const hit = table.find((g) => g.name.toLowerCase() === lower);
        if (hit) return hit;
    }
    return null;
}

function animeResultToCard(r: AnimeResult, genres?: string[]): DiscoveryCard {
    return {
        kind: "anime",
        id: r.id,
        title: r.title,
        image: r.image,
        year: r.year ?? null,
        score: r.score ?? null,
        type: r.type,
        route: `/anime/details?id=${encodeURIComponent(r.id)}`,
        genres,
    };
}

function mangaToCard(m: Manga): DiscoveryCard {
    return {
        kind: "manga",
        id: m.id,
        title: m.title,
        image: m.cover,
        year: m.year ?? null,
        score: m.rating ?? null,
        type: "Manga",
        route: `/title?id=${encodeURIComponent(m.id)}&source=mangadex`,
        genres: m.tags?.slice(0, 4),
    };
}

/**
 * Recommend anime similar to the supplied title. Returns up to 8 cards.
 */
export async function findSimilarAnime(reference: string): Promise<DiscoveryResult> {
    const refQuery = (reference || "").trim();
    if (!refQuery) return { reference, cards: [] };

    let matchedGenre: string | undefined;
    const cards: DiscoveryCard[] = [];

    try {
        const searchHits = await searchAnime(refQuery);
        if (searchHits.length === 0) {
            return { reference: refQuery, cards: [] };
        }
        const top = searchHits[0];
        const info = await fetchAnimeInfo(top.id);
        const genreNames = info?.genres?.length ? info.genres : top.type ? [top.type] : [];

        const genreEntry = pickGenreId(genreNames, ANIME_GENRES);
        if (genreEntry) {
            matchedGenre = genreEntry.name;
            try {
                const byGenre = await fetchAnimeByGenre(genreEntry.id as number);
                for (const a of byGenre) {
                    if (String(a.id) === String(top.id)) continue;
                    if (cards.length >= MAX_CARDS) break;
                    cards.push(animeResultToCard(a, genreNames.slice(0, 4)));
                }
            } catch (e) {
                console.warn("[discovery] fetchAnimeByGenre failed:", (e as any)?.message);
            }
        }

        // If genre lookup gave us nothing, fall back to other strong search hits.
        if (cards.length === 0) {
            for (const a of searchHits.slice(1)) {
                if (cards.length >= MAX_CARDS) break;
                cards.push(animeResultToCard(a, genreNames.slice(0, 4)));
            }
        }
    } catch (e) {
        console.warn("[discovery] findSimilarAnime failed:", (e as any)?.message);
    }

    return {
        reference: refQuery,
        matchedGenre,
        cards: uniqueById(cards).slice(0, MAX_CARDS),
    };
}

/**
 * Recommend manga similar to the supplied title.
 */
export async function findSimilarManga(reference: string): Promise<DiscoveryResult> {
    const refQuery = (reference || "").trim();
    if (!refQuery) return { reference, cards: [] };

    let matchedGenre: string | undefined;
    const cards: DiscoveryCard[] = [];

    try {
        const searchHits = await searchManga(refQuery, 8);
        if (searchHits.length === 0) {
            return { reference: refQuery, cards: [] };
        }
        const top = searchHits[0];
        const tags = top.tags || [];
        // Try to match a known genre in our short list. We only keep
        // genres MangaDex exposes via tag UUIDs.
        const genreEntry = pickGenreId(tags, MANGA_GENRES);
        if (genreEntry) {
            matchedGenre = genreEntry.name;
            try {
                const byGenre = await searchMangaByGenre(String(genreEntry.id));
                for (const m of byGenre) {
                    if (m.id === top.id) continue;
                    if (cards.length >= MAX_CARDS) break;
                    cards.push(mangaToCard(m));
                }
            } catch (e) {
                console.warn("[discovery] searchMangaByGenre failed:", (e as any)?.message);
            }
        }
        if (cards.length === 0) {
            for (const m of searchHits.slice(1)) {
                if (cards.length >= MAX_CARDS) break;
                cards.push(mangaToCard(m));
            }
        }
    } catch (e) {
        console.warn("[discovery] findSimilarManga failed:", (e as any)?.message);
    }

    return {
        reference: refQuery,
        matchedGenre,
        cards: uniqueById(cards).slice(0, MAX_CARDS),
    };
}

/**
 * Recommend light novels / web novels similar to the supplied title.
 *
 * Sakura doesn't yet ship a dedicated light-novel source, so we route
 * novel queries through the manga pipeline and tag the cards as `novel`
 * when MangaDex labels them as such. Falls back to plain manga results
 * so the user still gets a useful response.
 */
export async function findSimilarNovels(reference: string): Promise<DiscoveryResult> {
    const refQuery = (reference || "").trim();
    if (!refQuery) return { reference, cards: [] };

    const result = await findSimilarManga(refQuery);
    // Reclassify any card that MangaDex tagged as light/web novel.
    const cards = result.cards.map<DiscoveryCard>((card) => {
        const looksLikeNovel = (card.genres || []).some((g) =>
            /novel/i.test(g),
        );
        return looksLikeNovel ? { ...card, kind: "novel", type: "Light Novel" } : card;
    });
    return { ...result, cards };
}
