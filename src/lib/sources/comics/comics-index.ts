import type { Manga, MangaSource } from "../types";
import { XoxoComicSource } from "./xoxo-source";
import {
    MANGA_SOURCE_IDS,
    getDefaultComicSourceId,
    getPrimaryComicSourceId,
    isComicSourceId,
    normalizeMangaSourceId,
    type MangaSourceId,
} from "../source-ids";

const xoxoComicSource = new XoxoComicSource();

const comicSources: Partial<Record<MangaSourceId, MangaSource>> = {
    [xoxoComicSource.id]: xoxoComicSource,
};

export function getComicSource(id?: string | null): MangaSource {
    const normalized = normalizeMangaSourceId(id);
    return comicSources[normalized] || xoxoComicSource;
}

export function getAllComicSources(): MangaSource[] {
    return Object.values(comicSources).filter(Boolean) as MangaSource[];
}

export function getDefaultComicSource(): MangaSource {
    return comicSources[getDefaultComicSourceId()] || xoxoComicSource;
}

/**
 * Multi-source search across every registered comic source. Mirrors the
 * shape of `searchAllSources` from the manga pipeline so the UI can reuse
 * the same result handling.
 */
export async function searchAllComics(query: string): Promise<Manga[]> {
    const sources = getAllComicSources();
    const errors: unknown[] = [];

    const results = await Promise.all(
        sources.map(async (s) => {
            try {
                if (!query || query.trim() === "") {
                    return s.getTrending ? await s.getTrending() : [];
                }
                return await s.searchManga(query);
            } catch (e) {
                console.error(`Comic search failed for ${s.name}:`, e);
                errors.push(e);
                return [] as Manga[];
            }
        }),
    );

    const flat = results.flat();

    if (flat.length === 0 && errors.length > 0 && errors.length === sources.length) {
        throw errors[0];
    }

    // Dedup by normalized title, prioritizing the primary comic source
    const primary = getPrimaryComicSourceId();
    const unique = new Map<string, Manga>();

    for (const item of flat) {
        const key = (item.title || "").toLowerCase().trim();
        if (!key) continue;
        if (!unique.has(key)) {
            unique.set(key, item);
            continue;
        }
        const existing = unique.get(key)!;
        if (existing.sourceStr !== primary && item.sourceStr === primary) {
            unique.set(key, item);
        }
    }

    return Array.from(unique.values());
}

export { xoxoComicSource, MANGA_SOURCE_IDS, isComicSourceId };
