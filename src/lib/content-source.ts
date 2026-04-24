import { cacheWrap } from "./cache";
import { buildSourceCacheKey } from "./sources/source-scope";
import { MANGA_SOURCE_IDS } from "./sources/source-ids";

const CONTENT_API_URL = "https://api.mangadex.org";
const CDN_BASE_URL = "https://uploads.mangadex.org";

async function requestMd(url: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    return res.json();
}

export interface Manga {
    id: string;
    title: string;
    description: string;
    cover: string;
    author: string;
    authorId?: string;
    tags: string[];
    status: string;
    year: number;
    rating?: number;
    follows?: number;
}

export interface Chapter {
    id: string;
    volume: string;
    chapter: string;
    title: string;
    publishAt: string;
    pages: number;
    externalUrl?: string;
}

// Helper to get cover URL
function getCoverUrl(mangaId: string, filename: string) {
    return `${CDN_BASE_URL}/covers/${mangaId}/${filename}.256.jpg`;
}

/**
 * Checks which manga IDs have at least one readable chapter (pages > 0, no external URL).
 * Processes in small sequential batches to respect upstream rate limits.
 */
async function filterReadableManga(mangaIds: string[]): Promise<Set<string>> {
    const readable = new Set<string>();
    const BATCH = 3;

    for (let i = 0; i < mangaIds.length; i += BATCH) {
        const batch = mangaIds.slice(i, i + BATCH);

        const results = await Promise.all(batch.map(async (id) => {
            try {
                const params = new URLSearchParams({
                    limit: "5",
                    "order[chapter]": "desc",
                });
                params.append("translatedLanguage[]", "en");
                params.append("contentRating[]", "safe");
                params.append("contentRating[]", "suggestive");

                const url = `${CONTENT_API_URL}/manga/${id}/feed?${params.toString()}`;
                const data = await requestMd(url);

                const hasReadable = data.data?.some(
                    (ch: any) => ch.attributes.pages > 0 && !ch.attributes.externalUrl
                );
                return hasReadable ? id : null;
            } catch {
                return id;
            }
        }));

        for (const id of results) {
            if (id) readable.add(id);
        }

        if (i + BATCH < mangaIds.length) {
            await new Promise(r => setTimeout(r, 350));
        }
    }

    return readable;
}

// Search Manga
export async function searchManga(query: string = "", limit = 20, offset = 0): Promise<Manga[]> {
    const cacheKey = buildSourceCacheKey(MANGA_SOURCE_IDS.MANGADEX, `search:${query}:${limit}:${offset}`);
    return cacheWrap(cacheKey, async () => {
        try {
            const params = new URLSearchParams({
                limit: limit.toString(),
                offset: offset.toString(),
                "order[followedCount]": "desc",
                hasAvailableChapters: "true",
            });

            params.append("includes[]", "cover_art");
            params.append("includes[]", "author");
            params.append("contentRating[]", "safe");
            params.append("contentRating[]", "suggestive");
            params.append("availableTranslatedLanguage[]", "en");

            if (query) {
                params.append("title", query);
            }

            const url = `${CONTENT_API_URL}/manga?${params.toString()}`;
            const data = await requestMd(url);

            const allManga: Manga[] = data.data.map((item: any) => {
                const attributes = item.attributes;
                const coverRel = item.relationships.find((r: any) => r.type === "cover_art");
                const authorRel = item.relationships.find((r: any) => r.type === "author");
                const coverFileName = coverRel?.attributes?.fileName;

                return {
                    id: item.id,
                    title: attributes.title.en || Object.values(attributes.title)[0] || "Unknown Title",
                    description: attributes.description.en || "",
                    cover: coverFileName ? getCoverUrl(item.id, coverFileName) : "/placeholder.png",
                    author: authorRel?.attributes?.name || "Unknown Author",
                    authorId: authorRel?.id,
                    tags: attributes.tags.map((t: any) => t.attributes.name.en),
                    status: attributes.status,
                    year: attributes.year,
                };
            });

            const readable = await filterReadableManga(allManga.map(m => m.id));
            return allManga.filter(m => readable.has(m.id));
        } catch (error) {
            console.error("ContentSource Search Error:", error);
            return [];
        }
    });
}

// Get Author Details
export async function getAuthorDetails(authorId: string) {
    const cacheKey = buildSourceCacheKey(MANGA_SOURCE_IDS.MANGADEX, `author:${authorId}`);
    return cacheWrap(cacheKey, async () => {
        try {
            const url = `${CONTENT_API_URL}/author/${authorId}`;
            const data = await requestMd(url);
            const attrs = data.data.attributes;
            return {
                id: data.data.id,
                name: attrs.name,
                biography: attrs.biography?.en || "",
                twitter: attrs.twitter || null,
                pixiv: attrs.pixiv || null,
                youtube: attrs.youtube || null,
            };
        } catch (error) {
            console.error("ContentSource Author Error:", error);
            return null;
        }
    });
}

// Get Manga by Author
export async function getMangaByAuthor(authorId: string, limit = 20, offset = 0): Promise<Manga[]> {
    const cacheKey = buildSourceCacheKey(MANGA_SOURCE_IDS.MANGADEX, `author_manga:${authorId}:${limit}:${offset}`);
    return cacheWrap(cacheKey, async () => {
        try {
            const params = new URLSearchParams({
                limit: limit.toString(),
                offset: offset.toString(),
                "authors[]": authorId,
                "order[followedCount]": "desc",
                hasAvailableChapters: "true",
            });

            params.append("includes[]", "cover_art");
            params.append("includes[]", "author");
            params.append("contentRating[]", "safe");
            params.append("contentRating[]", "suggestive");
            params.append("availableTranslatedLanguage[]", "en");

            const url = `${CONTENT_API_URL}/manga?${params.toString()}`;
            const data = await requestMd(url);

            const allManga: Manga[] = data.data.map((item: any) => {
                const attributes = item.attributes;
                const coverRel = item.relationships.find((r: any) => r.type === "cover_art");
                const authorRel = item.relationships.find((r: any) => r.type === "author");
                const coverFileName = coverRel?.attributes?.fileName;

                return {
                    id: item.id,
                    title: attributes.title.en || Object.values(attributes.title)[0] || "Unknown Title",
                    description: attributes.description.en || "",
                    cover: coverFileName ? getCoverUrl(item.id, coverFileName) : "/placeholder.png",
                    author: authorRel?.attributes?.name || "Unknown Author",
                    authorId: authorRel?.id,
                    tags: attributes.tags.map((t: any) => t.attributes.name.en),
                    status: attributes.status,
                    year: attributes.year,
                };
            });

            const readable = await filterReadableManga(allManga.map(m => m.id));
            return allManga.filter(m => readable.has(m.id));
        } catch (error) {
            console.error("ContentSource Author Manga Error:", error);
            return [];
        }
    });
}
// Get Manga Statistics (Rating, Follows)
export async function getMangaStatistics(mangaIds: string[]) {
    const cacheKey = buildSourceCacheKey(MANGA_SOURCE_IDS.MANGADEX, `stats:${mangaIds.sort().join(',')}`);
    return cacheWrap(cacheKey, async () => {
        try {
            const params = new URLSearchParams();
            mangaIds.forEach(id => params.append("manga[]", id));

            const url = `${CONTENT_API_URL}/statistics/manga?${params.toString()}`;
            const data = await requestMd(url);
            return data.statistics;
        } catch (error) {
            console.error("ContentSource Stats Error:", error);
            return {};
        }
    });
}

// Get Manga Details
export async function getMangaDetails(id: string): Promise<Manga | null> {
    return cacheWrap(buildSourceCacheKey(MANGA_SOURCE_IDS.MANGADEX, `details:${id}`), async () => {
        try {
            const url = `${CONTENT_API_URL}/manga/${id}?includes[]=cover_art&includes[]=author`;
            const data = await requestMd(url);
            const item = data.data;
            const attributes = item.attributes;
            const coverRel = item.relationships.find((r: any) => r.type === "cover_art");
            const authorRel = item.relationships.find((r: any) => r.type === "author");
            const coverFileName = coverRel?.attributes?.fileName;

            return {
                id: item.id,
                title: attributes.title.en || Object.values(attributes.title)[0] || "Unknown Title",
                description: attributes.description.en || "",
                cover: coverFileName ? getCoverUrl(item.id, coverFileName) : "/placeholder.png",
                author: authorRel?.attributes?.name || "Unknown Author",
                authorId: authorRel?.id,
                tags: attributes.tags.map((t: any) => t.attributes.name.en),
                status: attributes.status,
                year: attributes.year,
            };
        } catch (error) {
            console.error("ContentSource Details Error:", error);
            return null;
        }
    });
}

// Get Chapters
export async function getChapters(mangaId: string, limit = 100, offset = 0): Promise<Chapter[]> {
    const cacheKey = buildSourceCacheKey(MANGA_SOURCE_IDS.MANGADEX, `chapters:${mangaId}:${limit}:${offset}`);
    return cacheWrap(cacheKey, async () => {
        try {
            const params = new URLSearchParams({
                limit: limit.toString(),
                offset: offset.toString(),
                manga: mangaId,
                "translatedLanguage[]": "en",
                "order[chapter]": "desc",
            });

            const url = `${CONTENT_API_URL}/chapter?${params.toString()}`;
            const data = await requestMd(url);

            const mapped = data.data
                .map((item: any) => {
                    const isBilibiliTakedown = item.relationships?.some(
                        (rel: any) => rel.type === 'scanlation_group' && rel.id === '17fb59e5-718c-4a1a-935d-d80dba70454a'
                    );

                    return {
                        id: item.id,
                        volume: item.attributes.volume,
                        chapter: item.attributes.chapter,
                        title: item.attributes.title,
                        publishAt: item.attributes.publishAt,
                        pages: item.attributes.pages,
                        externalUrl: isBilibiliTakedown ? "https://www.bilibilicomics.com" : item.attributes.externalUrl,
                    };
                })
                .filter((c: any) => {
                    if (c.pages <= 0 && !c.externalUrl) return false;
                    return true;
                });

            // De-duplicate chapters: when multiple uploads exist for the same chapter number, keep the one with the most pages
            const deduped = new Map<string, any>();
            for (const ch of mapped) {
                const key = ch.chapter ?? ch.id;
                const existing = deduped.get(key);
                if (!existing || ch.pages > (existing.pages || 0)) {
                    deduped.set(key, ch);
                }
            }

            return Array.from(deduped.values());
        } catch (error) {
            console.error("ContentSource Chapters Error:", error);
            return [];
        }
    });
}

// Get Single Chapter Details
export async function getChapterDetails(chapterId: string): Promise<Chapter | null> {
    try {
        const url = `${CONTENT_API_URL}/chapter/${chapterId}`;
        const data = await requestMd(url);
        const item = data.data;

        // Handle Bilibili Comics official takedowns
        const isBilibiliTakedown = item.relationships?.some(
            (rel: any) => rel.type === 'scanlation_group' && rel.id === '17fb59e5-718c-4a1a-935d-d80dba70454a'
        );

        return {
            id: item.id,
            volume: item.attributes.volume,
            chapter: item.attributes.chapter,
            title: item.attributes.title,
            publishAt: item.attributes.publishAt,
            pages: item.attributes.pages,
            externalUrl: isBilibiliTakedown ? "https://www.bilibilicomics.com" : item.attributes.externalUrl,
        };
    } catch (error) {
        console.error("ContentSource Chapter Details Error:", error);
        return null;
    }
}

// Get Chapter Pages
// Get Chapter Pages
export async function getChapterPages(chapterId: string): Promise<string[]> {
    try {
        // 1. Get Base URL
        const url = `${CONTENT_API_URL}/at-home/server/${chapterId}`;
        const data = await requestMd(url);
        const { baseUrl, chapter } = data;

        // 2. Check Data Saver Setting
        let useDataSaver = false;
        if (typeof window !== 'undefined') {
            try {
                const { getLocal, STORAGE_KEYS } = require("./storage");
                const settings = getLocal(STORAGE_KEYS.SETTINGS, { dataSaver: false });
                useDataSaver = settings.dataSaver;
            } catch (e) {
                // Ignore error, default to high quality
            }
        }

        const mode = useDataSaver ? "data-saver" : "data";
        const fileList = useDataSaver ? chapter.dataSaver : chapter.data;

        // 3. Construct Page URLs
        return fileList.map((filename: string) =>
            `${baseUrl}/${mode}/${chapter.hash}/${filename}`
        );
    } catch (error) {
        console.error("ContentSource Pages Error:", error);
        throw error; // Rethrow to let UI handle it
    }
}

export const MANGA_GENRES: { id: string; name: string }[] = [
    { id: "391b0423-d847-456f-aff0-8b0cfc03066b", name: "Action" },
    { id: "87cc87cd-a395-47af-b27a-93258283bbc6", name: "Adventure" },
    { id: "4d32cc48-9f00-4cca-9b5a-a839f0764984", name: "Comedy" },
    { id: "b9af3a63-f058-46de-a9a0-e0c13906197a", name: "Drama" },
    { id: "cdc58593-87dd-415e-bbc0-2ec27bf404cc", name: "Fantasy" },
    { id: "cdad7e68-1419-41dd-bdce-27753074a640", name: "Horror" },
    { id: "ee968100-4191-4968-93d3-f82d72be7e46", name: "Mystery" },
    { id: "423e2eae-a7a2-4a8b-ac03-a8351462d71d", name: "Romance" },
    { id: "256c8bd9-4904-4f7b-a3a0-b7f5f2f28f28", name: "Sci-Fi" },
    { id: "e5301a23-ebd9-49dd-a0cb-2add944c7fe9", name: "Slice of Life" },
    { id: "69964a64-2f90-4d33-beeb-f3ed2875eb4c", name: "Sports" },
    { id: "eabc5b4c-6aff-42f3-b657-3e90cbd00b75", name: "Supernatural" },
];

export async function searchMangaByGenre(tagId: string): Promise<Manga[]> {
    const cacheKey = buildSourceCacheKey(MANGA_SOURCE_IDS.MANGADEX, `genre:${tagId}`);
    return cacheWrap(cacheKey, async () => {
        try {
            const params = new URLSearchParams({
                limit: "20",
                offset: "0",
                "order[followedCount]": "desc",
                hasAvailableChapters: "true",
            });

            params.append("includes[]", "cover_art");
            params.append("includes[]", "author");
            params.append("contentRating[]", "safe");
            params.append("contentRating[]", "suggestive");
            params.append("availableTranslatedLanguage[]", "en");
            params.append("includedTags[]", tagId);

            const url = `${CONTENT_API_URL}/manga?${params.toString()}`;
            const data = await requestMd(url);

            const allManga: Manga[] = data.data.map((item: any) => {
                const attributes = item.attributes;
                const coverRel = item.relationships.find((r: any) => r.type === "cover_art");
                const authorRel = item.relationships.find((r: any) => r.type === "author");
                const coverFileName = coverRel?.attributes?.fileName;

                return {
                    id: item.id,
                    title: attributes.title.en || Object.values(attributes.title)[0] || "Unknown Title",
                    description: attributes.description.en || "",
                    cover: coverFileName ? getCoverUrl(item.id, coverFileName) : "/placeholder.png",
                    author: authorRel?.attributes?.name || "Unknown Author",
                    authorId: authorRel?.id,
                    tags: attributes.tags.map((t: any) => t.attributes.name.en),
                    status: attributes.status,
                    year: attributes.year,
                };
            });

            const readable = await filterReadableManga(allManga.map(m => m.id));
            const filtered = allManga.filter(m => readable.has(m.id));

            const stats = await getMangaStatistics(filtered.map(m => m.id));
            return filtered.map(m => ({
                ...m,
                rating: stats[m.id]?.rating?.average,
                follows: stats[m.id]?.follows,
            }));
        } catch (error) {
            console.error("ContentSource Genre Search Error:", error);
            return [];
        }
    });
}

// Get Featured Manga (Curated list for Home - Dynamic Top Followed)
export async function getFeaturedManga(): Promise<Manga[]> {
    return cacheWrap(buildSourceCacheKey(MANGA_SOURCE_IDS.MANGADEX, 'featured'), async () => {
        try {
            const params = new URLSearchParams({
                limit: "20",
                offset: "0",
                "order[followedCount]": "desc",
                hasAvailableChapters: "true",
            });

            params.append("includes[]", "cover_art");
            params.append("includes[]", "author");
            params.append("contentRating[]", "safe");
            params.append("contentRating[]", "suggestive");
            params.append("availableTranslatedLanguage[]", "en");

            const url = `${CONTENT_API_URL}/manga?${params.toString()}`;
            const data = await requestMd(url);

            const allManga = data.data.map((item: any) => {
                const attributes = item.attributes;
                const coverRel = item.relationships.find((r: any) => r.type === "cover_art");
                const authorRel = item.relationships.find((r: any) => r.type === "author");
                const coverFileName = coverRel?.attributes?.fileName;

                return {
                    id: item.id,
                    title: attributes.title.en || Object.values(attributes.title)[0] || "Unknown Title",
                    description: attributes.description.en || "",
                    cover: coverFileName ? getCoverUrl(item.id, coverFileName) : "/placeholder.png",
                    author: authorRel?.attributes?.name || "Unknown Author",
                    authorId: authorRel?.id,
                    tags: attributes.tags.map((t: any) => t.attributes.name.en),
                    status: attributes.status,
                    year: attributes.year,
                };
            });

            const readable = await filterReadableManga(allManga.map((m: any) => m.id));
            const filtered = allManga.filter((m: any) => readable.has(m.id));

            const stats = await getMangaStatistics(filtered.map((m: any) => m.id));
            return filtered.map((m: any) => ({
                ...m,
                rating: stats[m.id]?.rating?.average,
                follows: stats[m.id]?.follows
            }));

        } catch (error) {
            console.error("Featured Manga Error:", error);
            return [];
        }
    });
}

