import { Chapter, Manga, MangaSource } from "./types";
import { MANGA_SOURCE_IDS } from "./source-ids";
import { buildSourceCacheKey } from "./source-scope";
import { cacheWrap } from "../cache";
import { normalizeChaptersForReading } from "../chapter-order";

const ATSUMARU_BASE_URL = "https://atsu.moe";
const ATSUMARU_STATIC_BASE = `${ATSUMARU_BASE_URL}/static`;
const ATSUMARU_TYPES = "Manga,Manwha,Manhua,OEL";

type AtsumaruListItem = {
    id: string;
    title: string;
    image?: string;
    largeImage?: string;
    mediumImage?: string;
    type?: string;
};

type AtsumaruSearchHit = {
    document?: AtsumaruListItem;
} & AtsumaruListItem;

type AtsumaruChapter = {
    id: string;
    title?: string;
    number?: number;
    createdAt?: number;
    pageCount?: number;
    progress?: number | null;
};

function absoluteImageUrl(path?: string | null): string {
    if (!path) return "/placeholder.png";
    if (/^https?:\/\//i.test(path)) return path;
    return `${ATSUMARU_STATIC_BASE}/${path.replace(/^\/+/, "").replace(/^static\//, "")}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, {
        ...init,
        headers: {
            Accept: "application/json",
            Referer: ATSUMARU_BASE_URL,
            ...(init?.headers || {}),
        },
    });
    if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status}`);
    }
    return response.json() as Promise<T>;
}

function mapListItemToManga(item: AtsumaruListItem): Manga {
    return {
        id: item.id,
        title: item.title,
        description: "",
        cover: absoluteImageUrl(item.largeImage || item.mediumImage || item.image),
        author: "",
        tags: item.type ? [item.type] : [],
        status: "",
        year: 0,
        sourceStr: MANGA_SOURCE_IDS.ATSUMARU,
    };
}

function mapChapter(mangaId: string, chapter: AtsumaruChapter): Chapter {
    const chapterKey = `${mangaId}~${chapter.id}`;
    return {
        id: chapterKey,
        mangaId,
        volume: "",
        chapter: chapter.number != null ? String(chapter.number) : "",
        title: chapter.title || (chapter.number != null ? `Chapter ${chapter.number}` : "Chapter"),
        publishAt: chapter.createdAt ? new Date(chapter.createdAt).toISOString() : "",
        pages: chapter.pageCount || 0,
        sourceStr: MANGA_SOURCE_IDS.ATSUMARU,
    };
}

function parseAtsumaruChapterId(chapterId: string): { mangaId: string; chapterId: string } {
    const [mangaId, rawChapterId] = chapterId.split("~");
    if (!mangaId || !rawChapterId) {
        throw new Error("Invalid Atsumaru chapter id");
    }
    return { mangaId, chapterId: rawChapterId };
}

function mapSearchResults(payload: any): Manga[] {
    const hits: AtsumaruSearchHit[] = Array.isArray(payload?.hits)
        ? payload.hits
        : Array.isArray(payload?.items)
            ? payload.items
            : [];

    return hits
        .map((hit) => hit.document || hit)
        .filter((item): item is AtsumaruListItem => Boolean(item?.id && item?.title))
        .map(mapListItemToManga);
}

export class AtsumaruSource implements MangaSource {
    name = "Atsumaru";
    id = MANGA_SOURCE_IDS.ATSUMARU;
    baseUrl = ATSUMARU_BASE_URL;

    async searchManga(query: string, _limit = 20, _offset = 0): Promise<Manga[]> {
        const cacheKey = buildSourceCacheKey(this.id, `search:${query}`);
        return cacheWrap(cacheKey, async () => {
            const payload = {
                page: 0,
                filter: {
                    search: query.trim() || null,
                    types: ["Manga", "Manwha", "Manhua", "OEL"],
                    sortBy: "popularity",
                    showAdult: false,
                    officialTranslation: false,
                },
            };

            const data = await requestJson<any>(`${ATSUMARU_BASE_URL}/api/explore/filteredView`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
            });

            return mapSearchResults(data);
        });
    }

    async getMangaDetails(id: string): Promise<Manga | null> {
        const cacheKey = buildSourceCacheKey(this.id, `details:${id}`);
        return cacheWrap(cacheKey, async () => {
            const data = await requestJson<any>(`${ATSUMARU_BASE_URL}/api/manga/page?id=${encodeURIComponent(id)}`);
            const manga = data?.mangaPage;
            if (!manga) return null;

            return {
                id: manga.id || id,
                title: manga.title || manga.englishTitle || id,
                description: manga.synopsis || "",
                cover: absoluteImageUrl(manga.poster?.largeImage || manga.poster?.mediumImage || manga.poster?.image),
                author: Array.isArray(manga.authors) ? manga.authors.map((author: any) => author.name).filter(Boolean).join(", ") : "",
                tags: [
                    ...(Array.isArray(manga.genres) ? manga.genres.map((genre: any) => genre.name).filter(Boolean) : []),
                    ...(manga.type ? [manga.type] : []),
                ],
                status: manga.status || "",
                year: manga.released ? new Date(manga.released).getUTCFullYear() : 0,
                sourceStr: this.id,
            };
        });
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const cacheKey = buildSourceCacheKey(this.id, `chapters:v2:${mangaId}`);
        return cacheWrap(cacheKey, async () => {
            const data = await requestJson<{ chapters?: AtsumaruChapter[] }>(
                `${ATSUMARU_BASE_URL}/api/manga/allChapters?mangaId=${encodeURIComponent(mangaId)}`,
            );
            return normalizeChaptersForReading(
                (data.chapters || []).map((chapter) => mapChapter(mangaId, chapter)),
            );
        });
    }

    async getChapterPages(chapterId: string): Promise<string[]> {
        const { mangaId, chapterId: rawChapterId } = parseAtsumaruChapterId(chapterId);
        const cacheKey = buildSourceCacheKey(this.id, `pages:${chapterId}`);
        return cacheWrap(cacheKey, async () => {
            const data = await requestJson<any>(
                `${ATSUMARU_BASE_URL}/api/read/chapter?mangaId=${encodeURIComponent(mangaId)}&chapterId=${encodeURIComponent(rawChapterId)}`,
            );

            const pages = data?.readChapter?.pages || [];
            return pages.map((page: any) => {
                const image = page?.image || page;
                if (typeof image !== "string") return null;
                if (image.startsWith("http")) return image;
                if (image.startsWith("//")) return `https:${image}`;
                return absoluteImageUrl(image);
            }).filter(Boolean) as string[];
        });
    }

    async getTrending(limit = 20): Promise<Manga[]> {
        const cacheKey = buildSourceCacheKey(this.id, "featured");
        return cacheWrap(cacheKey, async () => {
            const data = await requestJson<{ items?: AtsumaruListItem[] }>(
                `${ATSUMARU_BASE_URL}/api/infinite/trending?page=0&types=${encodeURIComponent(ATSUMARU_TYPES)}`,
            );

            return (data.items || []).slice(0, limit).map(mapListItemToManga);
        });
    }
}
