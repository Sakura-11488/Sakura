import { MangaSource } from './types';
import { SakuraContentSource } from './sakura-source';
import { AtsumaruSource } from './atsumaru-source';
import { xoxoComicSource } from './comics/comics-index';
import {
    getPrimaryMangaSourceId,
    isComicSourceId,
    normalizeMangaSourceId,
    type MangaSourceId,
} from './source-ids';

const mangadexSource = new SakuraContentSource();
const atsumaruSource = new AtsumaruSource();

const mangaSources: Partial<Record<MangaSourceId, MangaSource>> = {
    [mangadexSource.id]: mangadexSource,
    [atsumaruSource.id]: atsumaruSource,
};

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

export function getPrimarySource(): MangaSource {
    return getSource(getPrimaryMangaSourceId());
}

export function getDetailsSource(): MangaSource {
    return mangadexSource;
}

export async function searchAllSources(query: string) {
    const errors: any[] = [];

    const pool = Object.values(mangaSources).filter(Boolean) as MangaSource[];

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

    if (rawResults.length === 0 && errors.length > 0) {
        if (errors.length === pool.length) throw errors[0];
    }

    const uniqueMap = new Map<string, any>();

    for (const manga of rawResults) {
        if (isComicSourceId(manga.sourceStr)) continue;

        const key = manga.title.toLowerCase().trim();

        if (!uniqueMap.has(key)) {
            uniqueMap.set(key, manga);
            continue;
        }

        const existing = uniqueMap.get(key);
        if (existing.sourceStr !== getPrimarySourceId() && manga.sourceStr === getPrimarySourceId()) {
            uniqueMap.set(key, manga);
        }
    }

    return Array.from(uniqueMap.values());
}

export { searchAllComics, getComicSource, getAllComicSources } from './comics/comics-index';
