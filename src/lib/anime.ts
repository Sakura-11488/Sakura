import { fetchJikanSearch, fetchJikanTrending, fetchJikanInfo, fetchJikanByGenre, ANIME_GENRES } from "./jikan";
export { ANIME_GENRES } from "./jikan";
import {
    searchAnimeSource,
    getAnimeSourceEpisodes,
    getStreamingSources,
    getAnimeInfo,
    getServerIdsForEpisode,
    setSlugForAnimeId,
    isConfigured as isSourceConfigured,
    getLastConsumetError,
} from "./sources/gogoanime";
import { PSYOP_SEARCH_RESULT, matchesPsyopQuery } from "./psyopAnime";

export interface AnimeResult {
    id: string;
    title: string;
    image?: string;
    type?: string;
    releaseDate?: string;
    score?: number;
}

export interface AnimeInfo extends AnimeResult {
    cover?: string;
    description?: string;
    status?: string;
    genres?: string[];
    episodes: {
        id: string;
        number: number;
        title: string;
        image?: string;
    }[];
}

export interface StreamingSource {
    url: string;
    isM3U8: boolean;
    referer?: string;
    tracks?: { file: string; label?: string; kind?: string }[];
    intro?: { start: number; end: number };
    outro?: { start: number; end: number };
}

/* ─── Cache Helpers ─── */

const CACHE_PREFIX = "sakura_anime_v4_";
const TTL_SEARCH = 30 * 60 * 1000;       // 30 min
const TTL_TRENDING = 2 * 60 * 60 * 1000; // 2 hours
const TTL_INFO = 24 * 60 * 60 * 1000;    // 24 hours
const TTL_EPISODES = 6 * 60 * 60 * 1000; // 6 hours
const TTL_SOURCE_MAP = 7 * 24 * 60 * 60 * 1000; // 7 days

function cacheGet<T>(key: string): T | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = localStorage.getItem(CACHE_PREFIX + key);
        if (!raw) return null;
        const { data, exp } = JSON.parse(raw);
        if (Date.now() > exp) {
            localStorage.removeItem(CACHE_PREFIX + key);
            return null;
        }
        return data as T;
    } catch { return null; }
}

function cacheSet<T>(key: string, data: T, ttl: number): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data, exp: Date.now() + ttl }));
    } catch { /* quota exceeded — ignore */ }
}

export async function searchAnime(query: string): Promise<AnimeResult[]> {
    const cacheKey = `search_${query.toLowerCase().trim()}`;
    const cached = cacheGet<AnimeResult[]>(cacheKey);
    if (cached) return cached;

    const results = await fetchJikanSearch(query);
    const mapped: AnimeResult[] = results.map(r => ({
        id: String(r.mal_id),
        title: r.title_english || r.title,
        image: r.images?.webp?.large_image_url || r.images?.webp?.image_url,
        type: r.type,
        releaseDate: r.year ? String(r.year) : undefined,
        score: r.score
    }));

    if (matchesPsyopQuery(query)) {
        mapped.unshift(PSYOP_SEARCH_RESULT);
    }

    cacheSet(cacheKey, mapped, TTL_SEARCH);
    return mapped;
}

export async function fetchAnimeByGenre(genreId: number): Promise<AnimeResult[]> {
    const cacheKey = `genre_${genreId}`;
    const cached = cacheGet<AnimeResult[]>(cacheKey);
    if (cached) return cached;

    const results = await fetchJikanByGenre(genreId);
    const mapped = results.map(r => ({
        id: String(r.mal_id),
        title: r.title_english || r.title,
        image: r.images?.webp?.large_image_url || r.images?.webp?.image_url,
        type: r.type,
        score: r.score
    }));
    cacheSet(cacheKey, mapped, TTL_SEARCH);
    return mapped;
}

export async function fetchAiringAnime(): Promise<AnimeResult[]> {
    const cacheKey = "trending";
    const cached = cacheGet<AnimeResult[]>(cacheKey);
    if (cached) return cached;

    const results = await fetchJikanTrending();
    const mapped = results.map(r => ({
        id: String(r.mal_id),
        title: r.title_english || r.title,
        image: r.images?.webp?.large_image_url || r.images?.webp?.image_url,
        type: 'Trending',
        score: r.score
    }));
    cacheSet(cacheKey, mapped, TTL_TRENDING);
    return mapped;
}

function simplifyTitle(title: string): string[] {
    const variants: string[] = [title];

    const cleaned = title
        .replace(/\s*(2nd|3rd|4th|5th|\d+th)\s+Season/i, '')
        .replace(/\s*Season\s*\d+/i, '')
        .replace(/\s*Part\s*\d+/i, '')
        .replace(/\s*Cour\s*\d+/i, '')
        .replace(/\s*\d+(?:st|nd|rd|th)\s+Cour/i, '')
        .replace(/\s*Movie\s*\d*/i, '')
        .replace(/\s*OVA\s*\d*/i, '')
        .replace(/\s*Specials?\s*$/i, '')
        .replace(/\s*\(TV\)/i, '')
        .replace(/\s*:\s*[^:]+$/, '')
        .trim();

    if (cleaned !== title && cleaned.length > 2) {
        variants.push(cleaned);
    }

    const colonIdx = title.indexOf(':');
    if (colonIdx > 2) {
        variants.push(title.substring(0, colonIdx).trim());
    }

    return [...new Set(variants)];
}

interface SourceMapping {
    slug: string;
    animeId: string;
}

async function resolveSourceId(romajiTitle: string, engTitle: string | null, malId: string): Promise<string> {
    const mapKey = `srcmap_v2_${malId}`;
    const cachedMapping = cacheGet<SourceMapping>(mapKey);
    if (cachedMapping) {
        if (cachedMapping.slug && cachedMapping.animeId) {
            setSlugForAnimeId(cachedMapping.animeId, cachedMapping.slug);
        }
        return cachedMapping.animeId;
    }

    if (!isSourceConfigured()) {
        console.warn('[resolveSourceId] Source not configured — CONSUMET_URL missing');
        return '';
    }

    const queries = [
        ...simplifyTitle(romajiTitle),
        ...(engTitle ? simplifyTitle(engTitle) : []),
    ];
    const seen = new Set<string>();

    let results: { id: string; title: string; slug?: string; animeId?: string }[] = [];
    let usedQuery = '';

    for (const q of queries) {
        const key = q.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        results = await searchAnimeSource(q);
        if (results && results.length > 0) {
            usedQuery = q;
            break;
        }
    }

    if (!results || results.length === 0) {
        const err = getLastConsumetError();
        console.warn(`[resolveSourceId] No source results for "${romajiTitle}" / "${engTitle}" — ${err}`);
        _lastDiag += ` → search FAIL(tried ${seen.size} queries): ${err || 'no results'}`;
        return '';
    }

    const lowerRomaji = romajiTitle.toLowerCase();
    const lowerEng = engTitle?.toLowerCase() || '';
    const match = results.find((p) => {
        const lt = p.title.toLowerCase();
        return lt === lowerRomaji || lt === lowerEng;
    });
    const best = match || results[0];
    const slug = best.slug || best.id;

    let animeId = best.animeId || '';
    if (!animeId && slug) {
        const info = await getAnimeInfo(slug);
        animeId = info?.animeId || '';
    }

    if (!animeId) {
        _lastDiag += ` → search OK but no animeId for slug="${slug}"`;
        return '';
    }

    setSlugForAnimeId(animeId, slug);
    console.log(`[resolveSourceId] Resolved "${romajiTitle}" (query="${usedQuery}") → slug="${slug}" animeId=${animeId}`);
    _lastDiag += ` → slug="${slug}" animeId=${animeId} (via "${usedQuery}")`;
    cacheSet(mapKey, { slug, animeId }, TTL_SOURCE_MAP);
    return animeId;
}

let _lastDiag = '';
export function getLastDiagnostic(): string { return _lastDiag; }

export async function fetchAnimeInfo(id: string): Promise<AnimeInfo | null> {
    _lastDiag = '';
    const cacheKey = `info_${id}`;
    const cached = cacheGet<AnimeInfo>(cacheKey);
    if (cached) {
        _lastDiag = `[cache hit] eps=${cached.episodes?.length}`;
        return cached;
    }

    const jikanData = await fetchJikanInfo(id);
    if (!jikanData) {
        _lastDiag = '[FAIL] Jikan returned null';
        return null;
    }

    const romajiTitle = jikanData.title;
    const engTitle = jikanData.title_english;
    _lastDiag = `Jikan OK: "${romajiTitle}" / "${engTitle}"`;

    const sourceId = await resolveSourceId(romajiTitle, engTitle, id);
    _lastDiag += ` → sourceId="${sourceId || '(empty)'}"`;

    let episodes: AnimeInfo['episodes'] = [];

    if (sourceId) {
        const epKey = `episodes_${sourceId}`;
        const cachedEps = cacheGet<AnimeInfo['episodes']>(epKey);
        if (cachedEps) {
            episodes = cachedEps;
            _lastDiag += ` → eps(cached)=${episodes.length}`;
        } else {
            episodes = await getAnimeSourceEpisodes(sourceId);
            _lastDiag += ` → eps(fetched)=${episodes.length}`;
            if (episodes.length > 0) cacheSet(epKey, episodes, TTL_EPISODES);
        }
    } else {
        _lastDiag += ' → SKIP episodes (no sourceId)';
    }

    const info: AnimeInfo = {
        id: String(jikanData.mal_id),
        title: jikanData.title_english || jikanData.title,
        image: jikanData.images?.webp?.large_image_url || jikanData.images?.webp?.image_url,
        cover: jikanData.images?.webp?.large_image_url || jikanData.images?.webp?.image_url,
        description: jikanData.synopsis,
        status: jikanData.status,
        genres: jikanData.genres?.map(g => g.name) || [],
        score: jikanData.score,
        episodes
    };
    if (episodes.length > 0) {
        cacheSet(cacheKey, info, TTL_INFO);
    }
    return info;
}

/** Returns cached anime info instantly (no network calls). */
export function getCachedAnimeInfo(id: string): AnimeInfo | null {
    return cacheGet<AnimeInfo>(`info_${id}`);
}

/** Fetches fresh anime info, bypassing cache. Updates cache on success. */
export async function refreshAnimeInfo(id: string): Promise<AnimeInfo | null> {
    const jikanData = await fetchJikanInfo(id);
    if (!jikanData) return null;

    const romajiTitle = jikanData.title;
    const engTitle = jikanData.title_english;

    const sourceId = await resolveSourceId(romajiTitle, engTitle, id);

    let episodes: AnimeInfo['episodes'] = [];
    if (sourceId) {
        episodes = await getAnimeSourceEpisodes(sourceId);
        if (episodes.length > 0) cacheSet(`episodes_${sourceId}`, episodes, TTL_EPISODES);
    }

    const info: AnimeInfo = {
        id: String(jikanData.mal_id),
        title: jikanData.title_english || jikanData.title,
        image: jikanData.images?.webp?.large_image_url || jikanData.images?.webp?.image_url,
        cover: jikanData.images?.webp?.large_image_url || jikanData.images?.webp?.image_url,
        description: jikanData.synopsis,
        status: jikanData.status,
        genres: jikanData.genres?.map(g => g.name) || [],
        score: jikanData.score,
        episodes
    };
    if (episodes.length > 0) {
        cacheSet(`info_${id}`, info, TTL_INFO);
    }
    return info;
}

export async function fetchEpisodeSources(episodeId: string): Promise<StreamingSource | null> {
    try {
        const result = await getStreamingSources(episodeId);
        if (result && result.sources.length > 0) {
            const src = result.sources[0];
            console.log(`[Anime] Got embed URL (${src.quality}): ${src.url.substring(0, 80)}...`);
            return {
                url: src.url,
                isM3U8: src.isM3U8,
                referer: result.referer,
                tracks: result.subtitles.map(s => ({ file: s.file, label: s.label })),
            };
        }
    } catch (e) {
        console.error('[Anime] Stream extraction failed:', e);
    }

    return null;
}
