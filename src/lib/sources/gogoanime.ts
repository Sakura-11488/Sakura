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
        return results.map((r: any) => ({
            id: r.slug || r.id || '',
            title: r.name || r.title || '',
            slug: r.slug || r.id || '',
            animeId: r.animeId || '',
            poster: r.poster || '',
        })).filter((r: any) => r.id && r.title);
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

async function getEpisodeServers(serverIds: string): Promise<{ type: string; svId: string; linkId: string; name: string }[]> {
    try {
        const data = await apiGet(`/api/servers?ids=${encodeURIComponent(serverIds)}`);
        return data.servers || [];
    } catch (e) {
        console.error('[HiAnime] Servers error:', e);
        return [];
    }
}

async function getEmbedUrl(linkId: string): Promise<string | null> {
    try {
        const data = await apiGet(`/api/source/${encodeURIComponent(linkId)}`);
        return data.url || null;
    } catch (e) {
        console.error('[HiAnime] Source error:', e);
        return null;
    }
}

export async function getStreamingSources(episodeId: string): Promise<{
    sources: { url: string; isM3U8: boolean; quality: string }[];
    subtitles: { file: string; label?: string }[];
    referer?: string;
} | null> {
    try {
        console.log(`[HiAnime] getStreamingSources called with: ${episodeId}`);

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
        if (slug) {
            const watchUrl = `${HIANIME_BASE}/watch/${slug}/ep-${epNum}`;
            console.log(`[HiAnime] SUCCESS: Watch URL → ${watchUrl}`);
            return {
                sources: [{ url: watchUrl, isM3U8: false, quality: 'default' }],
                subtitles: [],
                referer: HIANIME_BASE + '/',
            };
        }

        console.log(`[HiAnime] No slug cached for animeId=${animeId}, trying embed URL chain...`);

        let serverIds = _serverIdsCache.get(episodeId);
        if (!serverIds) {
            console.log(`[HiAnime] serverIds cache miss, refetching episodes for animeId=${animeId}`);
            await getAnimeSourceEpisodes(animeId);
            serverIds = _serverIdsCache.get(episodeId) || undefined;
            if (!serverIds) {
                console.error(`[HiAnime] FAIL: No serverIds for ${episodeId}`);
                return null;
            }
        }

        const slugAfterRefetch = _slugByAnimeId.get(animeId);
        if (slugAfterRefetch) {
            const watchUrl = `${HIANIME_BASE}/watch/${slugAfterRefetch}/ep-${epNum}`;
            console.log(`[HiAnime] SUCCESS (after refetch): Watch URL → ${watchUrl}`);
            return {
                sources: [{ url: watchUrl, isM3U8: false, quality: 'default' }],
                subtitles: [],
                referer: HIANIME_BASE + '/',
            };
        }

        console.log(`[HiAnime] Falling back to embed URL extraction...`);
        const servers = await getEpisodeServers(serverIds);
        if (servers.length === 0) {
            console.error(`[HiAnime] FAIL: No servers returned`);
            return null;
        }

        const subServers = servers.filter(s => s.type === 's-sub');
        const target = subServers[0] || servers[0];

        const embedUrl = await getEmbedUrl(target.linkId);
        if (!embedUrl) {
            console.error(`[HiAnime] FAIL: getEmbedUrl returned null`);
            return null;
        }

        console.log(`[HiAnime] SUCCESS (embed): ${embedUrl}`);
        return {
            sources: [{ url: embedUrl, isM3U8: false, quality: target.name || 'default' }],
            subtitles: [],
            referer: HIANIME_BASE + '/',
        };
    } catch (e) {
        console.error('[HiAnime] Streaming sources error:', e);
        return null;
    }
}
