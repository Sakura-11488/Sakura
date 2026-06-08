import {
    fetchAnimeByGenre,
    ANIME_GENRES,
    type AnimeResult,
} from "@/lib/anime";
import {
    searchMangaByGenre,
    MANGA_GENRES,
    type Manga,
} from "@/lib/content-source";
import type { DiscoveryCard } from "./discovery";

/**
 * Mood / tone-driven discovery for Sakura AI.
 *
 * The user can ask for "something cozy", "dark and cerebral", or
 * "feel-good comedies". We translate those tone words into a small set of
 * genre filters supported by AniList / MangaDex, query each, and return a
 * round-robin merged card list. This is a different shape from `findSimilar*`
 * (which seeds off a reference title) — it's purely tag-driven so it works
 * even for users with empty history.
 *
 * Tone vocabulary is intentionally fuzzy and overlapping so we can route
 * many phrasings into the same buckets ("light" → "Slice of Life" + "Comedy",
 * "dark" → "Horror" + "Mystery" + "Supernatural").
 */

export type MoodCardKind = "anime" | "manga";

const MAX_PER_GENRE = 4;
const MAX_TOTAL = 8;

const MOOD_GENRE_MAP: Record<string, string[]> = {
    cozy: ["Slice of Life", "Comedy", "Romance"],
    chill: ["Slice of Life", "Comedy"],
    light: ["Comedy", "Slice of Life"],
    feelgood: ["Comedy", "Slice of Life", "Romance"],
    feel_good: ["Comedy", "Slice of Life", "Romance"],
    "feel-good": ["Comedy", "Slice of Life", "Romance"],
    funny: ["Comedy"],
    comedy: ["Comedy"],
    romance: ["Romance"],
    romantic: ["Romance"],
    sad: ["Drama", "Romance"],
    emotional: ["Drama", "Romance"],
    drama: ["Drama"],
    cerebral: ["Mystery", "Sci-Fi", "Supernatural"],
    "mind-bending": ["Mystery", "Sci-Fi", "Supernatural"],
    psychological: ["Mystery", "Drama", "Supernatural"],
    thriller: ["Mystery", "Action", "Supernatural"],
    dark: ["Horror", "Mystery", "Supernatural"],
    edgy: ["Horror", "Action", "Supernatural"],
    horror: ["Horror"],
    spooky: ["Horror", "Supernatural"],
    intense: ["Action", "Drama"],
    epic: ["Action", "Adventure", "Fantasy"],
    action: ["Action"],
    adventure: ["Adventure"],
    fantasy: ["Fantasy"],
    isekai: ["Fantasy", "Adventure"],
    scifi: ["Sci-Fi"],
    "sci-fi": ["Sci-Fi"],
    sports: ["Sports"],
    competitive: ["Sports", "Action"],
    sliceoflife: ["Slice of Life"],
    "slice-of-life": ["Slice of Life"],
};

export interface MoodPickResult {
    requested: string[];
    matchedGenres: string[];
    cards: DiscoveryCard[];
}

function normalizeMood(token: string): string {
    return token.trim().toLowerCase().replace(/\s+/g, " ");
}

function expandTags(tags: string[]): string[] {
    const out = new Set<string>();
    for (const raw of tags) {
        const norm = normalizeMood(raw);
        if (!norm) continue;
        const direct = MOOD_GENRE_MAP[norm];
        if (direct) {
            for (const g of direct) out.add(g);
            continue;
        }
        // Fall back to direct genre name match (case-insensitive) so
        // "Mystery" still works even though it's not in the mood map.
        const directGenre = ANIME_GENRES.find((g) => g.name.toLowerCase() === norm);
        if (directGenre) out.add(directGenre.name);
        const directManga = MANGA_GENRES.find((g) => g.name.toLowerCase() === norm);
        if (directManga) out.add(directManga.name);
    }
    return Array.from(out);
}

function animeToCard(a: AnimeResult): DiscoveryCard {
    return {
        kind: "anime",
        id: a.id,
        title: a.title,
        image: a.image,
        year: a.year ?? null,
        score: a.score ?? null,
        type: a.type,
        route: `/anime/details?id=${encodeURIComponent(a.id)}`,
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
 * Pick titles that match the requested mood / tone tags.
 *
 * @param tags free-form tone words (e.g. ["cozy", "romance"]) — case-
 *   insensitive, fuzzily mapped to genre IDs via MOOD_GENRE_MAP.
 * @param kind  restrict to anime / manga / both.
 */
export async function moodPick(
    tags: string[],
    kind: MoodCardKind | "both" = "both",
): Promise<MoodPickResult> {
    const expanded = expandTags(tags);
    if (expanded.length === 0) {
        return { requested: tags, matchedGenres: [], cards: [] };
    }

    const animeBuckets: AnimeResult[][] = [];
    const mangaBuckets: Manga[][] = [];

    if (kind !== "manga") {
        for (const name of expanded) {
            const entry = ANIME_GENRES.find((g) => g.name.toLowerCase() === name.toLowerCase());
            if (!entry) continue;
            try {
                const list = await fetchAnimeByGenre(entry.id);
                animeBuckets.push(list.slice(0, MAX_PER_GENRE));
            } catch (e) {
                console.warn("[mood] anime genre fetch failed", entry.name, (e as any)?.message);
            }
        }
    }
    if (kind !== "anime") {
        for (const name of expanded) {
            const entry = MANGA_GENRES.find((g) => g.name.toLowerCase() === name.toLowerCase());
            if (!entry) continue;
            try {
                const list = await searchMangaByGenre(entry.id);
                mangaBuckets.push(list.slice(0, MAX_PER_GENRE));
            } catch (e) {
                console.warn("[mood] manga genre fetch failed", entry.name, (e as any)?.message);
            }
        }
    }

    // Round-robin interleave so the result feels mood-balanced rather than
    // anime-first or manga-first.
    const interleavedAnime: AnimeResult[] = [];
    const interleavedManga: Manga[] = [];
    let active = true;
    while (active) {
        active = false;
        for (const bucket of animeBuckets) {
            const next = bucket.shift();
            if (next) { interleavedAnime.push(next); active = true; }
        }
        for (const bucket of mangaBuckets) {
            const next = bucket.shift();
            if (next) { interleavedManga.push(next); active = true; }
        }
        if (interleavedAnime.length + interleavedManga.length >= MAX_TOTAL * 2) break;
    }

    const merged: DiscoveryCard[] = [];
    let i = 0;
    while (
        merged.length < MAX_TOTAL &&
        (i < interleavedAnime.length || i < interleavedManga.length)
    ) {
        if (i < interleavedAnime.length && merged.length < MAX_TOTAL) {
            merged.push(animeToCard(interleavedAnime[i]));
        }
        if (i < interleavedManga.length && merged.length < MAX_TOTAL) {
            merged.push(mangaToCard(interleavedManga[i]));
        }
        i += 1;
    }

    // De-dup by title to cover any cross-source overlap.
    const seen = new Set<string>();
    const cards = merged.filter((c) => {
        const key = `${c.kind}:${c.title.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return {
        requested: tags,
        matchedGenres: expanded,
        cards: cards.slice(0, MAX_TOTAL),
    };
}
