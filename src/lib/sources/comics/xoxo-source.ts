import { Chapter, Manga, MangaSource } from "../types";
import { MANGA_SOURCE_IDS } from "../source-ids";
import { buildSourceCacheKey } from "../source-scope";
import { cacheWrap } from "../../cache";
/**
 * Sakura Comics source adapter (XOXO Comics-backed).
 *
 * The client never hits the upstream site directly — it talks to the Sakura
 * comics scraper proxy running on the DigitalOcean droplet (see
 * `scripts/droplet/comics-scraper`). The proxy handles HTML parsing,
 * caching, and upstream rotation (XOXO Comics primary, ReadComicOnline
 * planned as fallback), so swapping scrapers doesn't require an APK push.
 */

const COMICS_PROXY_REMOTE =
    process.env.NEXT_PUBLIC_COMICS_PROXY || "http://165.232.83.159/comics/v1";

export function getComicsProxyBase(): string {
    return COMICS_PROXY_REMOTE;
}

type ProxyListItem = {
    id: string;
    title: string;
    cover?: string | null;
    url?: string | null;
};

type ProxyDetail = ProxyListItem & {
    description?: string | null;
    author?: string | null;
    authors?: string[] | null;
    tags?: string[] | null;
    status?: string | null;
    year?: number | null;
};

type ProxyChapter = {
    id: string;
    title?: string | null;
    number?: number | string | null;
    publishAt?: string | null;
    pages?: number | null;
};

type ProxyListResponse = { items?: ProxyListItem[]; results?: ProxyListItem[] };
type ProxyDetailResponse = { comic?: ProxyDetail | null; manga?: ProxyDetail | null } | ProxyDetail;
type ProxyChaptersResponse = { chapters?: ProxyChapter[]; issues?: ProxyChapter[] };
type ProxyPagesResponse = { pages?: string[]; images?: string[] };

async function requestProxy<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${getComicsProxyBase().replace(/\/+$/, "")}${path}`;
    const headers = {
        Accept: "application/json",
        ...(init?.headers || {}),
    };
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
        // The droplet returns 502 with `{error: "Upstream HTTP 403 ..."}` when
        // its upstream (xoxocomic.com) trips a Cloudflare challenge — surface
        // a human-readable hint instead of a bare status code.
        let detail = "";
        try {
            const text = await res.text();
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed.error === "string") {
                if (/Upstream HTTP 4\d\d/.test(parsed.error) || /Just a moment/i.test(parsed.error)) {
                    throw new Error(
                        "Comics catalog is temporarily unavailable while the upstream provider is being rotated. Please try again later."
                    );
                }
                detail = `: ${parsed.error.slice(0, 160)}`;
            }
        } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message.startsWith("Comics catalog")) {
                throw parseErr;
            }
        }
        throw new Error(`Comics proxy HTTP ${res.status} for ${path}${detail}`);
    }
    return (await res.json()) as T;
}

// Cloudflare in front of xoxocomic.com sometimes serves HTML at edge nodes
// far from upstream even for valid image URLs. Routing every cover/page
// through the droplet's /img endpoint guarantees that what the user sees is
// what the droplet successfully fetched, regardless of their region.
function proxyImage(url?: string | null): string {
    if (!url) return "/placeholder.png";
    if (url.startsWith("/")) return url;
    if (url.startsWith("data:")) return url;
    if (!/^https?:\/\//i.test(url)) return url;
    const base = getComicsProxyBase().replace(/\/+$/, "");
    if (url.startsWith(`${base}/img?`)) return url;
    return `${base}/img?u=${encodeURIComponent(url)}`;
}

function mapListItem(item: ProxyListItem): Manga {
    return {
        id: item.id,
        title: item.title || item.id,
        description: "",
        cover: proxyImage(item.cover),
        author: "",
        tags: [],
        status: "",
        year: 0,
        sourceStr: MANGA_SOURCE_IDS.XOXOCOMIC,
    };
}

function mapDetail(item: ProxyDetail): Manga {
    const authors = Array.isArray(item.authors) && item.authors.length
        ? item.authors.join(", ")
        : item.author || "";

    return {
        id: item.id,
        title: item.title || item.id,
        description: item.description || "",
        cover: proxyImage(item.cover),
        author: authors,
        tags: Array.isArray(item.tags) ? item.tags.filter(Boolean) : [],
        status: item.status || "",
        year: typeof item.year === "number" ? item.year : 0,
        sourceStr: MANGA_SOURCE_IDS.XOXOCOMIC,
    };
}

function mapChapter(mangaId: string, chapter: ProxyChapter): Chapter {
    const numberStr = chapter.number != null ? String(chapter.number) : "";
    const chapterKey = `${mangaId}~${chapter.id}`;
    return {
        id: chapterKey,
        mangaId,
        volume: "",
        chapter: numberStr,
        title: chapter.title || (numberStr ? `Issue ${numberStr}` : chapter.id),
        publishAt: chapter.publishAt || "",
        pages: chapter.pages || 0,
        sourceStr: MANGA_SOURCE_IDS.XOXOCOMIC,
    };
}

function parseScopedChapterId(chapterId: string): { mangaId: string; rawChapterId: string } {
    const [mangaId, ...rest] = chapterId.split("~");
    const rawChapterId = rest.join("~");
    if (!mangaId || !rawChapterId) {
        throw new Error(`Invalid Sakura Comics chapter id: ${chapterId}`);
    }
    return { mangaId, rawChapterId };
}

export class XoxoComicSource implements MangaSource {
    name = "Sakura Comics";
    id = MANGA_SOURCE_IDS.XOXOCOMIC;
    get baseUrl(): string {
        return getComicsProxyBase();
    }

    async searchManga(query: string, limit = 20, offset = 0): Promise<Manga[]> {
        const cacheKey = buildSourceCacheKey(this.id, `search:${query}:${limit}:${offset}`);
        return cacheWrap(cacheKey, async () => {
            const params = new URLSearchParams({
                q: query.trim(),
                limit: String(limit),
                offset: String(offset),
            });
            const data = await requestProxy<ProxyListResponse>(`/search?${params.toString()}`);
            const items = data.items || data.results || [];
            return items.map(mapListItem);
        });
    }

    async getMangaDetails(id: string): Promise<Manga | null> {
        const cacheKey = buildSourceCacheKey(this.id, `details:${id}`);
        return cacheWrap(cacheKey, async () => {
            const params = new URLSearchParams({ id });
            const data = await requestProxy<ProxyDetailResponse>(`/details?${params.toString()}`);
            const detail = (data as any)?.comic || (data as any)?.manga || (data as ProxyDetail);
            if (!detail || !detail.id) return null;
            return mapDetail(detail as ProxyDetail);
        });
    }

    async getChapters(mangaId: string, limit = 500, offset = 0): Promise<Chapter[]> {
        const cacheKey = buildSourceCacheKey(this.id, `chapters:${mangaId}:${limit}:${offset}`);
        return cacheWrap(cacheKey, async () => {
            const params = new URLSearchParams({
                id: mangaId,
                limit: String(limit),
                offset: String(offset),
            });
            const data = await requestProxy<ProxyChaptersResponse>(`/chapters?${params.toString()}`);
            const chapters = data.issues || data.chapters || [];
            return chapters.map((c) => mapChapter(mangaId, c));
        });
    }

    async getChapterPages(chapterId: string): Promise<string[]> {
        const { mangaId, rawChapterId } = parseScopedChapterId(chapterId);
        const cacheKey = buildSourceCacheKey(this.id, `pages:v4:${chapterId}`);
        return cacheWrap(cacheKey, async () => {
            const params = new URLSearchParams({
                id: mangaId,
                chapterId: rawChapterId,
            });
            const data = await requestProxy<ProxyPagesResponse>(`/pages?${params.toString()}`);
            const pages = data.pages || data.images || [];
            return pages
                .filter((p): p is string => typeof p === "string" && p.length > 0)
                .map((p) => proxyImage(p));
        });
    }

    async getTrending(limit = 24): Promise<Manga[]> {
        const cacheKey = buildSourceCacheKey(this.id, `featured:${limit}`);
        return cacheWrap(cacheKey, async () => {
            const params = new URLSearchParams({ limit: String(limit) });
            const data = await requestProxy<ProxyListResponse>(`/popular?${params.toString()}`);
            const items = data.items || data.results || [];
            return items.map(mapListItem);
        });
    }
}
