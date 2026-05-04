import { MangaSource } from './types';
import { MangadexSource } from './sakura-source';
import { AtsumaruSource } from './atsumaru-source';
import { xoxoComicSource } from './comics/comics-index';
import {
    getPrimaryMangaSourceId,
    isComicSourceId,
    normalizeMangaSourceId,
    type MangaSourceId,
} from './source-ids';
// import { WeebCentralSource } from './weebcentral';

const mangadexSource = new MangadexSource();
const atsumaruSource = new AtsumaruSource();

// Manga-only registry (used by searchAllSources and manga landing pages)
const mangaSources: Partial<Record<MangaSourceId, MangaSource>> = {
    [mangadexSource.id]: mangadexSource,
    [atsumaruSource.id]: atsumaruSource,
};

// Full registry including comics — used by getSource() so shared pages
// (title, chapter reader, library) can look up any source by id.
const sources: Partial<Record<MangaSourceId, MangaSource>> = {
    ...mangaSources,
    [xoxoComicSource.id]: xoxoComicSource,
};

export function getSource(id: string): MangaSource {
    return sources[normalizeMangaSourceId(id)] || mangadexSource;
}

export function getAllSources(): MangaSource[] {
    return Object.values(sources).filter(Boolean) as MangaSource[];
}

export function getAllMangaSources(): MangaSource[] {
    return Object.values(mangaSources).filter(Boolean) as MangaSource[];
}

export function getPrimarySourceId(): MangaSourceId {
    return getPrimaryMangaSourceId();
}

// Multi-source Search with De-duplication (manga only)
export async function searchAllSources(query: string) {
    const errors: any[] = [];

    const pool = Object.values(mangaSources).filter(Boolean) as MangaSource[];

    // Run searches in parallel
    const promises = pool.map(async s => {
        try {
            if (!query || query.trim() === "") {
                if (s.getTrending) {
                    return await s.getTrending();
                }
                return [];
            }
            return await s.searchManga(query);
        } catch (e) {
            console.error(`Search/Featured failed for ${s.name}:`, e);
            errors.push(e);
            return [];
        }
    });

    const rawResults = (await Promise.all(promises)).flat();

    // If no results and we had errors, throw appropriately
    if (rawResults.length === 0 && errors.length > 0) {
        // If all failed, throw first error
        if (errors.length === pool.length) throw errors[0];
    }

    // De-duplication / Merging Logic
    // Prioritize primary source. If a title exists in multiple sources, keep the primary.
    // Matching strategy: Normalized Title.
    const uniqueMap = new Map<string, any>();

    for (const manga of rawResults) {
        // Safety guard: if a comic somehow leaks in, drop it from the manga feed.
        if (isComicSourceId(manga.sourceStr)) continue;

        const key = manga.title.toLowerCase().trim();

        // If not in map, add it
        if (!uniqueMap.has(key)) {
            uniqueMap.set(key, manga);
            continue;
        }

        // If already in map, keep the primary source version
        const existing = uniqueMap.get(key);
        if (existing.sourceStr !== getPrimarySourceId() && manga.sourceStr === getPrimarySourceId()) {
            uniqueMap.set(key, manga);
        }
    }

    return Array.from(uniqueMap.values());
}

// Re-export the comics entrypoint so UIs can import from one place.
export { searchAllComics, getComicSource, getAllComicSources } from './comics/comics-index';
