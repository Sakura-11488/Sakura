import { MangaSource } from './types';
import { SakuraContentSource } from './sakura-source';
// import { WeebCentralSource } from './weebcentral';

const sakuraContent = new SakuraContentSource();

// Source Registry
const sources: Record<string, MangaSource> = {
    [sakuraContent.id]: sakuraContent,
};

export function getSource(id: string): MangaSource {
    return sources[id] || sakuraContent;
}

export function getAllSources(): MangaSource[] {
    return Object.values(sources);
}

// Multi-source Search with De-duplication
export async function searchAllSources(query: string) {
    const errors: any[] = [];

    // Run searches in parallel
    const promises = Object.values(sources).map(async s => {
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
        if (errors.length === Object.keys(sources).length) throw errors[0];
    }

    // De-duplication / Merging Logic
    // Prioritize primary source. If a title exists in multiple sources, keep the primary.
    // Matching strategy: Normalized Title.
    const uniqueMap = new Map<string, any>();

    for (const manga of rawResults) {
        const key = manga.title.toLowerCase().trim();

        // If not in map, add it
        if (!uniqueMap.has(key)) {
            uniqueMap.set(key, manga);
            continue;
        }

        // If already in map, keep the primary source version
        const existing = uniqueMap.get(key);
        if (existing.sourceStr !== 'mangadex' && manga.sourceStr === 'mangadex') {
            uniqueMap.set(key, manga);
        }
    }

    return Array.from(uniqueMap.values());
}
