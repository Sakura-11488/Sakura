import { Capacitor, CapacitorHttp } from '@capacitor/core';

const API_BASE = (
    process.env.NEXT_PUBLIC_CONSUMET_URL || ""
).replace(/\/+$/, '');

const HIANIME_BASE = "https://hianime.dk";

async function apiGet(path: string, timeout = 15000) {
    if (!API_BASE) throw new Error("NEXT_PUBLIC_CONSUMET_URL not set");
    const url = `${API_BASE}${path}`;
    if (Capacitor.isNativePlatform()) {
        const response = await CapacitorHttp.get({ url, connectTimeout: timeout, readTimeout: timeout });
        if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
        return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        } finally {
            clearTimeout(timer);
        }
    }
}

export function isConfigured(): boolean {
    return !!API_BASE;
}

let _lastError = '';
export function getLastConsumetError(): string { return _lastError; }

export async function searchAnimeSource(query: string): Promise<{ id: string; title: string; slug?: string; animeId?: string; poster?: string }[]> {
    try {
        _lastError = '';
        const url = `/api/search?keyword=${encodeURIComponent(query)}`;
        console.log(`[HiAnime] Searching: ${API_BASE}${url}`);
        const data = await apiGet(url);
        const results = data.results || data.animes || [];
        if (!Array.isArray(results) || results.length === 0) {
            _lastError = `No results for "${query}"`;
            return [];
        }
        console.log(`[HiAnime] Found ${results.length} results for "${query}"`);
        return results.map((r: any) => {
            let rawSlug = r.slug || r.id || '';
            // hianime search may return full paths like "watch/slug/ep-1" — normalize to clean slug
            rawSlug = rawSlug.replace(/^watch\//, '').replace(/\/ep-\d+$/, '');
            return {
                id: rawSlug,
                title: r.name || r.title || '',
                slug: rawSlug,
                animeId: r.animeId || '',
                poster: r.poster || '',
            };
        }).filter((r: any) => r.id && r.title);
    } catch (e: any) {
        _lastError = `Search "${query}": ${e.message || e}`;
        console.error('[HiAnime] Search error:', e);
        return [];
    }
}

export async function getAnimeInfo(slug: string): Promise<{ animeId: string; name: string; description: string; poster: string } | null> {
    try {
        const data = await apiGet(`/api/info/${encodeURIComponent(slug)}`);
        if (!data.animeId) return null;
        if (data.animeId) {
            _slugByAnimeId.set(data.animeId, slug);
        }
        return {
            animeId: data.animeId,
            name: data.name || '',
            description: data.description || '',
            poster: data.poster || '',
        };
    } catch (e) {
        console.error('[HiAnime] Info error:', e);
        return null;
    }
}

const _serverIdsCache = new Map<string, string>();
const _slugByAnimeId = new Map<string, string>();

export function setSlugForAnimeId(animeId: string, slug: string) {
    _slugByAnimeId.set(animeId, slug);
}

export async function getAnimeSourceEpisodes(animeIdOrSlug: string): Promise<{ id: string; number: number; title: string }[]> {
    try {
        let animeId = animeIdOrSlug;

        if (!/^\d+$/.test(animeId)) {
            _slugByAnimeId.set('_pending', animeIdOrSlug);
            const info = await getAnimeInfo(animeId);
            if (!info?.animeId) {
                console.warn(`[HiAnime] Could not resolve animeId for slug "${animeIdOrSlug}"`);
                return [];
            }
            animeId = info.animeId;
        }

        console.log(`[HiAnime] Fetching episodes for animeId=${animeId}`);
        const data = await apiGet(`/api/episodes/${animeId}`);
        if (!data.episodes || !Array.isArray(data.episodes)) return [];

        console.log(`[HiAnime] Got ${data.episodes.length} episodes`);
        return data.episodes
            .filter((ep: any) => ep.number > 0)
            .map((ep: any) => {
                const compactId = `hi-${animeId}-${ep.number}`;
                if (ep.serverIds) {
                    _serverIdsCache.set(compactId, ep.serverIds);
                }
                return {
                    id: compactId,
                    number: ep.number ?? 0,
                    title: ep.title || `Episode ${ep.number ?? '?'}`,
                };
            });
    } catch (e) {
        console.error('[HiAnime] Episodes error:', e);
        return [];
    }
}

export function getServerIdsForEpisode(episodeId: string): string | null {
    return _serverIdsCache.get(episodeId) || null;
}

export async function getStreamingSources(episodeId: string, category: 'sub' | 'dub' = 'sub'): Promise<{
    sources: { url: string; isM3U8: boolean; quality: string }[];
    subtitles: { file: string; label?: string }[];
    referer?: string;
    intro?: { start: number; end: number } | null;
    outro?: { start: number; end: number } | null;
    category?: string;
    availableCategories?: string[];
} | null> {
    try {
        console.log(`[HiAnime] getStreamingSources called with: ${episodeId} category=${category}`);

        if (!episodeId.startsWith('hi-')) {
            console.error(`[HiAnime] Unknown episode ID format: ${episodeId}`);
            return null;
        }

        const parts = episodeId.match(/^hi-(\d+)-(\d+)$/);
        if (!parts) {
            console.error(`[HiAnime] Could not parse episode ID: ${episodeId}`);
            return null;
        }
        const [, animeId, epNum] = parts;

        const slug = _slugByAnimeId.get(animeId);
        if (!slug) {
            console.log(`[HiAnime] No slug cached for animeId=${animeId}, refetching...`);
            await getAnimeSourceEpisodes(animeId);
        }

        const resolvedSlug = _slugByAnimeId.get(animeId);
        if (!resolvedSlug) {
            console.error(`[HiAnime] FAIL: Could not resolve slug for animeId=${animeId}`);
            return null;
        }

        try {
            const data = await apiGet(`/api/m3u8/${encodeURIComponent(resolvedSlug)}/${epNum}?category=${category}`, 30000);
            if (data?.sources?.length > 0) {
                const src = data.sources[0];
                console.log(`[HiAnime] SUCCESS (m3u8, ${category}): ${src.url.substring(0, 80)}...`);
                return {
                    sources: [{
                        url: src.url,
                        isM3U8: src.isM3U8 !== false,
                        quality: src.quality || 'auto',
                    }],
                    subtitles: (data.subtitles || []).map((s: any) => ({
                        file: s.url || s.file || '',
                        label: s.lang || s.label || 'Unknown',
                    })),
                    referer: data.headers?.Referer || HIANIME_BASE + '/',
                    intro: data.intro || null,
                    outro: data.outro || null,
                    category: data.category || category,
                    availableCategories: data.availableCategories || ['sub'],
                };
            }
        } catch (e: any) {
            console.warn(`[HiAnime] m3u8 extraction failed: ${e.message}`);
        }

        console.error(`[HiAnime] FAIL: No stream sources available for ${episodeId}`);
        return null;
    } catch (e) {
        console.error('[HiAnime] Streaming sources error:', e);
        return null;
    }
}
