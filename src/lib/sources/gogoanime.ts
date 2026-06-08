import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { isElectron } from "../platform";

/** Default HiAnime bridge (see electron/main.js HIANIME_PORT). Use 127.0.0.1 — in Electron, `localhost` often fails (IPv6/loopback quirks) while the Node child listens on IPv4. */
const DEFAULT_ELECTRON_HIANIME_BRIDGE = "http://127.0.0.1:4789";

type ElectronApi = { hianimeBridgeUrl?: string };

/**
 * Resolved at call time (not only import time) so Electron `app://` can apply fallbacks.
 * Episodes stay at 0 when this is empty: no local server URL → `isConfigured()` false → no HiAnime search/episodes.
 */
function getApiBase(): string {
    if (typeof window !== "undefined") {
        const fromPreload = (window as unknown as { electronAPI?: ElectronApi }).electronAPI?.hianimeBridgeUrl?.trim();
        if (fromPreload) {
            return fromPreload.replace(/\/+$/, "").replace(/localhost/g, "127.0.0.1");
        }
    }

    let base = (
        typeof process !== "undefined" && process.env?.NEXT_PUBLIC_CONSUMET_URL
            ? String(process.env.NEXT_PUBLIC_CONSUMET_URL)
            : ""
    ).trim().replace(/\/+$/, "");

    if (typeof window !== "undefined") {
        const proto = window.location?.protocol || "";
        const isElectronShell = proto === "app:" || proto === "file:";
        if (isElectronShell || isElectron()) {
            if (!base) {
                base = DEFAULT_ELECTRON_HIANIME_BRIDGE;
            } else if (base.includes("localhost")) {
                base = base.replace(/localhost/g, "127.0.0.1");
            }
        }
    }

    return base;
}

const HIANIME_BASE = "https://hianime.dk";

export interface AnimeSourceErrorPayload {
    message: string;
    code?: string;
    stage?: string;
    status?: number;
    details?: Record<string, unknown>;
}

export class AnimeSourceError extends Error {
    code?: string;
    stage?: string;
    status?: number;
    details?: Record<string, unknown>;

    constructor(payload: AnimeSourceErrorPayload) {
        super(payload.message);
        this.name = "AnimeSourceError";
        this.code = payload.code;
        this.stage = payload.stage;
        this.status = payload.status;
        this.details = payload.details;
    }
}

function toSourceError(value: unknown, fallback: AnimeSourceErrorPayload): AnimeSourceError {
    if (value instanceof AnimeSourceError) {
        return value;
    }
    if (value instanceof Error) {
        return new AnimeSourceError({
            ...fallback,
            message: value.message || fallback.message,
        });
    }
    return new AnimeSourceError(fallback);
}

async function parseFetchError(res: Response): Promise<AnimeSourceError> {
    let body: any = null;
    try {
        body = await res.json();
    } catch {
        body = null;
    }

    return new AnimeSourceError({
        message: body?.error || `HTTP ${res.status}`,
        code: body?.code,
        stage: body?.stage,
        status: res.status,
        details: body?.details,
    });
}

async function apiGet(path: string, timeout = 15000) {
    const API_BASE = getApiBase();
    if (!API_BASE) throw new Error("NEXT_PUBLIC_CONSUMET_URL not set");
    const url = `${API_BASE}${path}`;
    if (Capacitor.isNativePlatform()) {
        const response = await CapacitorHttp.get({ url, connectTimeout: timeout, readTimeout: timeout });
        if (response.status >= 400) {
            throw new AnimeSourceError({
                message: response.data?.error || `HTTP ${response.status}`,
                code: response.data?.code,
                stage: response.data?.stage,
                status: response.status,
                details: response.data?.details,
            });
        }
        return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    } else {
        const controller = new AbortController();
        const timer = setTimeout(() => {
            controller.abort(new Error(`HiAnime bridge request timed out after ${timeout}ms`));
        }, timeout);
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) throw await parseFetchError(res);
            return res.json();
        } catch (error: any) {
            if (error?.name === "AbortError" || controller.signal.aborted) {
                throw new AnimeSourceError({
                    message: `HiAnime bridge timed out while resolving the stream (${Math.round(timeout / 1000)}s).`,
                    code: "STREAM_REQUEST_TIMEOUT",
                    stage: "extractor",
                    details: { path, timeout },
                });
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}

export function isConfigured(): boolean {
    return !!getApiBase();
}

let _lastError = '';
let _lastErrorDetails: AnimeSourceErrorPayload | null = null;
export function getLastConsumetError(): string { return _lastError; }
export function getLastConsumetErrorDetails(): AnimeSourceErrorPayload | null { return _lastErrorDetails; }

export async function fetchHiAnimeTrending(): Promise<{ slug: string; title: string; poster: string }[]> {
    try {
        const data = await apiGet('/api/home');
        const results = data.results || [];
        return results.map((r: any) => ({
            slug: r.slug || '',
            title: r.name || '',
            poster: r.poster || '',
        })).filter((r: any) => r.slug && r.title);
    } catch (e) {
        console.error('[HiAnime] Home page fetch failed:', e);
        return [];
    }
}

export async function searchAnimeSource(query: string): Promise<{ id: string; title: string; slug?: string; animeId?: string; poster?: string }[]> {
    try {
        _lastError = '';
        _lastErrorDetails = null;
        const url = `/api/search?keyword=${encodeURIComponent(query)}`;
        console.log(`[HiAnime] Searching: ${getApiBase()}${url}`);
        const data = await apiGet(url);
        const results = data.results || data.animes || [];
        if (!Array.isArray(results) || results.length === 0) {
            _lastError = `No results for "${query}"`;
            _lastErrorDetails = { message: _lastError, code: "NO_SEARCH_RESULTS", stage: "search" };
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
    } catch (error: any) {
        const sourceError = toSourceError(error, {
            message: `Search "${query}" failed`,
            code: "SEARCH_FAILED",
            stage: "search",
            details: { query },
        });
        _lastError = `Search "${query}": ${sourceError.message}`;
        _lastErrorDetails = {
            message: sourceError.message,
            code: sourceError.code,
            stage: sourceError.stage,
            status: sourceError.status,
            details: sourceError.details,
        };
        console.error('[HiAnime] Search error:', sourceError);
        return [];
    }
}

export async function getAnimeInfo(slug: string): Promise<{ animeId: string; name: string; description: string; poster: string } | null> {
    try {
        _lastError = '';
        _lastErrorDetails = null;
        const data = await apiGet(`/api/info/${encodeURIComponent(slug)}`);
        if (!data.animeId) return null;
        setSlugForAnimeId(data.animeId, slug);
        return {
            animeId: data.animeId,
            name: data.name || '',
            description: data.description || '',
            poster: data.poster || '',
        };
    } catch (error) {
        const sourceError = toSourceError(error, {
            message: `Failed to resolve provider info for "${slug}"`,
            code: "INFO_FAILED",
            stage: "info",
            details: { slug },
        });
        _lastError = sourceError.message;
        _lastErrorDetails = {
            message: sourceError.message,
            code: sourceError.code,
            stage: sourceError.stage,
            status: sourceError.status,
            details: sourceError.details,
        };
        console.error('[HiAnime] Info error:', sourceError);
        return null;
    }
}

const _serverIdsCache = new Map<string, string>();
const _slugByAnimeId = new Map<string, string>();
const SLUG_STORAGE_PREFIX = "hianime_slug_";

export function setSlugForAnimeId(animeId: string, slug: string) {
    _slugByAnimeId.set(animeId, slug);
    try {
        if (typeof window !== "undefined") {
            localStorage.setItem(SLUG_STORAGE_PREFIX + animeId, slug);
        }
    } catch {}
}

function getPersistedSlug(animeId: string): string | null {
    const mem = _slugByAnimeId.get(animeId);
    if (mem) return mem;
    try {
        if (typeof window !== "undefined") {
            const stored = localStorage.getItem(SLUG_STORAGE_PREFIX + animeId);
            if (stored) {
                _slugByAnimeId.set(animeId, stored);
                return stored;
            }
        }
    } catch {}
    return null;
}

export async function getAnimeSourceEpisodes(animeIdOrSlug: string): Promise<{ id: string; number: number; title: string }[]> {
    try {
        _lastError = '';
        _lastErrorDetails = null;
        let animeId = animeIdOrSlug;

        if (!/^\d+$/.test(animeId)) {
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
    } catch (error) {
        const sourceError = toSourceError(error, {
            message: `Failed to fetch episode list for "${animeIdOrSlug}"`,
            code: "EPISODES_FAILED",
            stage: "episodes",
            details: { animeIdOrSlug },
        });
        _lastError = sourceError.message;
        _lastErrorDetails = {
            message: sourceError.message,
            code: sourceError.code,
            stage: sourceError.stage,
            status: sourceError.status,
            details: sourceError.details,
        };
        console.error('[HiAnime] Episodes error:', sourceError);
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
        _lastError = '';
        _lastErrorDetails = null;
        console.log(`[HiAnime] getStreamingSources called with: ${episodeId} category=${category}`);

        if (!episodeId.startsWith('hi-')) {
            throw new AnimeSourceError({
                message: `Unknown HiAnime episode format: ${episodeId}`,
                code: "INVALID_EPISODE_ID",
                stage: "mapping",
                details: { episodeId, category },
            });
        }

        const parts = episodeId.match(/^hi-(\d+)-(\d+)$/);
        if (!parts) {
            throw new AnimeSourceError({
                message: `Could not parse HiAnime episode id "${episodeId}"`,
                code: "INVALID_EPISODE_ID",
                stage: "mapping",
                details: { episodeId, category },
            });
        }
        const [, animeId, epNum] = parts;

        let resolvedSlug = getPersistedSlug(animeId);
        if (!resolvedSlug) {
            console.log(`[HiAnime] No slug cached for animeId=${animeId}, refetching...`);
            await getAnimeSourceEpisodes(animeId);
            resolvedSlug = getPersistedSlug(animeId);
        }

        if (!resolvedSlug) {
            throw new AnimeSourceError({
                message: `Could not resolve provider slug for anime ${animeId}`,
                code: "MISSING_SLUG",
                stage: "mapping",
                details: { animeId, episodeId, category },
            });
        }

        try {
            const data = await apiGet(`/api/m3u8/${encodeURIComponent(resolvedSlug)}/${epNum}?category=${category}`, 120000);
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
            throw new AnimeSourceError({
                message: `No stream sources returned for episode ${episodeId}`,
                code: "NO_STREAM_SOURCES",
                stage: "extractor",
                details: {
                    animeId,
                    slug: resolvedSlug,
                    episodeId,
                    category,
                    availableCategories: data?.availableCategories || ['sub'],
                },
            });
        } catch (error: any) {
            const sourceError = toSourceError(error, {
                message: `Stream extraction failed for episode ${episodeId}`,
                code: "STREAM_REQUEST_FAILED",
                stage: "extractor",
                details: { animeId, slug: resolvedSlug, episodeId, category },
            });
            console.warn(`[HiAnime] m3u8 extraction failed: ${sourceError.message}`);
            throw sourceError;
        }
    } catch (error) {
        const sourceError = toSourceError(error, {
            message: `Streaming sources failed for episode ${episodeId}`,
            code: "STREAMING_FAILED",
            stage: "extractor",
            details: { episodeId, category },
        });
        _lastError = sourceError.message;
        _lastErrorDetails = {
            message: sourceError.message,
            code: sourceError.code,
            stage: sourceError.stage,
            status: sourceError.status,
            details: sourceError.details,
        };
        console.error('[HiAnime] Streaming sources error:', sourceError);
        throw sourceError;
    }
}
