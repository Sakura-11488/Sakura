import { getCachedValue, setCachedValue } from '@/lib/cache';
import {
  consuGet,
  consumetCandidates,
  getActiveConsumetUrl,
  setActiveConsumetUrl,
} from '@/lib/consumet-client';
import {
  HIANIME_BASE,
  fetchUpstreamText,
  fetchUpstreamJson,
} from '@/lib/anime-upstream';

export function getConsumetUrl() {
  return getActiveConsumetUrl();
}

/** Ping streaming API from the device/simulator (use in Settings to verify connectivity). */
export async function pingStreamingServer(): Promise<{
  ok: boolean;
  url: string;
  message: string;
  latencyMs?: number;
}> {
  const candidates = consumetCandidates();
  if (candidates.length === 0) {
    return { ok: false, url: '', message: 'No server configured' };
  }

  const t0 = Date.now();
  try {
    const data = await consuGet('/');
    if (data?.status === 'ok') {
      return {
        ok: true,
        url: getActiveConsumetUrl(),
        message: `Connected (v${String(data.version || '?')})`,
        latencyMs: Date.now() - t0,
      };
    }
    return { ok: false, url: getActiveConsumetUrl(), message: 'Unexpected response' };
  } catch (e) {
    return {
      ok: false,
      url: getActiveConsumetUrl(),
      message: e instanceof Error ? e.message : 'Network request failed',
    };
  }
}
const ANILIST_URL = 'https://graphql.anilist.co';
const JIKAN_API = 'https://api.jikan.moe/v4';

// ─── In-memory cache ──────────────────────────────────────────────────────────
const _mem = new Map<string, { d: unknown; exp: number }>();
const _slugMap = new Map<string, string>(); // HiAnime animeId → slug

function cGet<T>(key: string): T | null {
  const hit = _mem.get(key);
  if (!hit || Date.now() > hit.exp) { _mem.delete(key); return null; }
  return hit.d as T;
}

function cSet<T>(key: string, data: T, ttl: number) {
  _mem.set(key, { d: data, exp: Date.now() + ttl });
}

function cDelete(key: string) {
  _mem.delete(key);
}

/** Clears in-memory anime maps (call from settings "Clear cache"). */
export function clearAnimeSessionCache() {
  _mem.clear();
  _slugMap.clear();
}

/** Drop cached streaming slug mapping for a MAL id (used when provider stream is stale). */
export function clearAnimeSourceCacheForMal(malId: string): void {
  cDelete(`srcmap_${malId}`);
  cDelete(`srcslug_${malId}`);
  cDelete(`info2_${malId}`);
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface AnimeResult {
  id: string;
  title: string;
  image: string;
  type?: string;
  score?: number | null;
  year?: number | null;
}

export interface AnimeEpisode {
  id: string;
  number: number;
  title: string;
  /** Episode still from AniList streaming metadata when available */
  thumbnail?: string;
}

export interface AnimeInfo extends AnimeResult {
  cover?: string;
  description?: string;
  status?: string;
  genres?: string[];
  episodes: AnimeEpisode[];
  episodeLoadError?: string;
  /** HiAnime slug used for m3u8 playback */
  streamingSlug?: string;
  streamingAnimeId?: string;
  /** Local require() image for Sakura Originals — pass directly to expo-image source */
  localCover?: any;
}

export interface StreamingSource {
  url: string;
  isM3U8: boolean;
  referer?: string;
  /** Headers from Consumet/CDN (Referer, Origin, etc.) — required for native download */
  requestHeaders?: Record<string, string>;
  /** Web embed player — required because CDN HLS URLs return 403 on native iOS players */
  embedUrl?: string;
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
  category?: string;
  availableCategories?: string[];
  allSources?: Array<{ url: string; quality: string; isM3U8: boolean }>;
}

const MOBILE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export function getAnimeStreamUserAgent() {
  return MOBILE_SAFARI_UA;
}

/** HiAnime web player — Megaplay embed often returns 410 inside WebView */
export function buildStreamEmbedUrl(
  malId: string,
  epNum: string,
  category: 'sub' | 'dub',
  referer?: string,
  slug?: string,
): string {
  let streamMalId = malId;
  if (referer) {
    const fromReferer = referer.match(/\/mal\/(\d+)\//)?.[1];
    if (fromReferer) streamMalId = fromReferer;
  }

  if (streamMalId && streamMalId !== '0') {
    return `${HIANIME_BASE}/player/mal/${streamMalId}/${epNum}/${category}`;
  }

  if (slug) {
    return `${HIANIME_BASE}/watch/${encodeURIComponent(slug)}?ep=${epNum}`;
  }

  return `${HIANIME_BASE}/player/mal/${malId}/${epNum}/${category}`;
}

export function buildPlaybackHeaders(referer?: string): Record<string, string> {
  const ref = referer || 'https://megaplay.buzz/';
  let origin = 'https://megaplay.buzz';
  try {
    origin = new URL(ref).origin;
  } catch {
    // keep default
  }
  return {
    Referer: ref,
    Origin: origin,
    'User-Agent': MOBILE_SAFARI_UA,
  };
}

function absolutePlayerUrl(src: string, baseUrl: string): string {
  if (/^\/\//.test(src)) return `https:${src}`;
  if (/^\//.test(src)) return `${new URL(baseUrl).origin}${src}`;
  return src;
}

function findPlayerIframe(html: string, baseUrl: string): string | null {
  const matches = html.match(/<iframe[^>]+src=["']([^"']+)["']/gi) || [];
  for (const tag of matches) {
    const src = tag.match(/src=["']([^"']+)["']/i)?.[1];
    if (!src) continue;
    if (/megaplay|megacloud|rapid-cloud|rabbitstream|\/stream\/s-\d+\//i.test(src)) {
      return absolutePlayerUrl(src, baseUrl);
    }
  }
  return null;
}

function findMegaplayDataId(html: string): string | null {
  return (
    html.match(/data-id\s*=\s*"(\d+)"/i)?.[1] ||
    html.match(/data-id\s*=\s*'(\d+)'/i)?.[1] ||
    html.match(/data-video-id\s*=\s*"(\d+)"/i)?.[1] ||
    html.match(/data-video-id\s*=\s*'(\d+)'/i)?.[1] ||
    html.match(/\/stream\/getSourcesNew\?id=(\d+)/i)?.[1] ||
    html.match(/\/stream\/getSources\?id=(\d+)/i)?.[1] ||
    html.match(/getSourcesNew\?id=(\d+)/i)?.[1] ||
    null
  );
}

function findMegaplayM3u8InHtml(html: string): string | null {
  const patterns = [
    /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i,
    /(https?:\/\/[^\s"'<>]*nekostream[^\s"'<>]*)/i,
    /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
  }
  return null;
}

function pickMegaplayFile(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const row = data as Record<string, any>;
  for (const key of ['file', 'url', 'link', 'hls']) {
    if (typeof row[key] === 'string' && row[key]) return row[key];
  }
  if (Array.isArray(row.sources) && row.sources.length > 0) {
    return pickMegaplayFile(row.sources[0]);
  }
  for (const key of ['sources', 'source', 'data', 'result']) {
    const nested = pickMegaplayFile(row[key]);
    if (nested) return nested;
  }
  return null;
}

async function fetchMegaplaySourceFromEmbed(
  embedUrl: string,
  category: 'sub' | 'dub',
  malId?: string,
  epNum?: string,
): Promise<StreamingSource | null> {
  let playerUrl = embedUrl;
  let html = await fetchUpstreamText(playerUrl, HIANIME_BASE + '/');
  const iframe = findPlayerIframe(html, playerUrl);
  if (iframe) {
    playerUrl = iframe;
    html = await fetchUpstreamText(playerUrl, embedUrl);
  }

  const dataId = findMegaplayDataId(html);
  const origin = new URL(playerUrl).origin;

  let payload: Record<string, unknown> | null = null;
  if (dataId) {
    const endpoints = [
      `${origin}/stream/getSourcesNew?id=${encodeURIComponent(dataId)}`,
      `${origin}/stream/getSources?id=${encodeURIComponent(dataId)}`,
      `${origin}/getSourcesNew?id=${encodeURIComponent(dataId)}`,
      `${origin}/getSources?id=${encodeURIComponent(dataId)}`,
      `${origin}/ajax/getSourcesNew?id=${encodeURIComponent(dataId)}`,
      `${origin}/ajax/getSources?id=${encodeURIComponent(dataId)}`,
      `${origin}/stream/sources?id=${encodeURIComponent(dataId)}`,
    ];

    for (const endpoint of endpoints) {
      try {
        payload = await fetchUpstreamJson(endpoint, playerUrl, origin);
        if (pickMegaplayFile(payload)) break;
      } catch {
        // try the next known Megaplay source endpoint
      }
    }
  }

  let url = pickMegaplayFile(payload);
  if (!url) {
    url = findMegaplayM3u8InHtml(html);
  }
  if (!url) return null;

  const intro = (payload?.intro || (payload?.data as any)?.intro) as { start: number; end: number } | undefined;
  const outro = (payload?.outro || (payload?.data as any)?.outro) as { start: number; end: number } | undefined;

  return {
    url,
    isM3U8: /\.m3u8(?:[?#]|$)/i.test(url),
    referer: playerUrl,
    requestHeaders: buildPlaybackHeaders(playerUrl),
    embedUrl: malId && epNum ? buildStreamEmbedUrl(malId, epNum, category, playerUrl) : embedUrl,
    intro,
    outro,
    category,
    availableCategories: ['sub', 'dub'],
    allSources: [{ url, quality: 'auto', isM3U8: /\.m3u8(?:[?#]|$)/i.test(url) }],
  };
}

async function fetchDirectMalSource(
  malId: string,
  epNum: string,
  category: 'sub' | 'dub',
): Promise<StreamingSource | null> {
  const embedUrl = buildStreamEmbedUrl(malId, epNum, category);
  try {
    const source = await fetchMegaplaySourceFromEmbed(embedUrl, category, malId, epNum);
    if (source?.url || source?.embedUrl) return source;
  } catch {
    // The MAL player page can still be embedded even when direct HLS extraction fails.
  }
  return {
    url: '',
    isM3U8: false,
    embedUrl,
    category,
    availableCategories: ['sub', 'dub'],
  };
}

export const ANIME_GENRES: { id: number; name: string }[] = [
  { id: 1, name: 'Action' },
  { id: 2, name: 'Adventure' },
  { id: 4, name: 'Comedy' },
  { id: 8, name: 'Drama' },
  { id: 10, name: 'Fantasy' },
  { id: 14, name: 'Horror' },
  { id: 7, name: 'Mystery' },
  { id: 22, name: 'Romance' },
  { id: 24, name: 'Sci-Fi' },
  { id: 36, name: 'Slice of Life' },
  { id: 30, name: 'Sports' },
  { id: 37, name: 'Supernatural' },
];

// ─── AniList ──────────────────────────────────────────────────────────────────
const AL_FIELDS =
  `id idMal title{english romaji} coverImage{extraLarge large} averageScore episodes format seasonYear`;

function escGql(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function runAL(q: string): Promise<unknown> {
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json?.errors?.length) throw new Error(json.errors[0]?.message);
  return json;
}

function alToResult(m: Record<string, unknown>): AnimeResult | null {
  if (!m?.idMal) return null;
  const title = m.title as Record<string, string> | null;
  const cover = m.coverImage as Record<string, string> | null;
  return {
    id: String(m.idMal),
    title: title?.english || title?.romaji || 'Unknown',
    image: cover?.extraLarge || cover?.large || '',
    type: (m.format as string) || 'TV',
    score: m.averageScore ? +((m.averageScore as number) / 10).toFixed(1) : null,
    year: (m.seasonYear as number) || null,
  };
}

function alPageResults(data: unknown): AnimeResult[] {
  const media = (data as Record<string, unknown>)?.data as Record<string, unknown>;
  const page = media?.Page as Record<string, unknown>;
  const list = page?.media as Record<string, unknown>[];
  if (!Array.isArray(list)) return [];
  return list.map(alToResult).filter((x): x is AnimeResult => x !== null);
}

async function alTrending(): Promise<AnimeResult[]> {
  const q = `{Page(page:1,perPage:15){media(type:ANIME,sort:TRENDING_DESC,status:RELEASING){${AL_FIELDS}}}}`;
  return alPageResults(await runAL(q));
}

async function alPopular(): Promise<AnimeResult[]> {
  const q = `{Page(page:1,perPage:15){media(type:ANIME,sort:POPULARITY_DESC){${AL_FIELDS}}}}`;
  return alPageResults(await runAL(q));
}

async function alSearch(query: string): Promise<AnimeResult[]> {
  const q = `{Page(page:1,perPage:20){media(type:ANIME,search:"${escGql(query)}",sort:SEARCH_MATCH){${AL_FIELDS}}}}`;
  return alPageResults(await runAL(q));
}

async function alByGenre(genre: string): Promise<AnimeResult[]> {
  const q = `{Page(page:1,perPage:15){media(type:ANIME,genre:"${escGql(genre)}",sort:POPULARITY_DESC){${AL_FIELDS}}}}`;
  return alPageResults(await runAL(q));
}

// ─── Jikan ────────────────────────────────────────────────────────────────────
interface JikanFull {
  mal_id: number;
  title: string;
  title_english: string | null;
  title_japanese?: string | null;
  title_synonyms?: string[];
  images: { webp: { image_url: string; large_image_url: string } };
  synopsis: string | null;
  status: string;
  type: string;
  year: number | null;
  episodes: number | null;
  score: number | null;
  genres: { name: string }[];
}

/**
 * Jikan allows roughly 3 requests a second and 60 a minute, and returns 429
 * once you pass that. Requests used to go out unthrottled with no retry, so
 * opening a detail page while trending or search calls were still in flight
 * would burst past the limit — and because the caller treats any failure as
 * "no such anime", a 429 rendered a dead "Could not load anime" page. It looked
 * random because it depended entirely on what else was loading.
 *
 * Requests are serialised through one chain with a minimum gap, and a 429 is
 * retried rather than reported as missing.
 */
const JIKAN_MIN_GAP_MS = 400;
const JIKAN_MAX_ATTEMPTS = 3;
let jikanChain: Promise<unknown> = Promise.resolve();
let jikanLastAt = 0;

/**
 * Endpoints that have exhausted their retries recently.
 *
 * Some Jikan endpoints stay down for long stretches — /anime/{id}/episodes has
 * been 504ing persistently — and retrying a dead endpoint on every page open
 * costs seconds of load time and fills the console with failed requests that
 * look like a bug in the app. Once a path has exhausted its retries, skip it
 * outright for a while and let the caller take its fallback immediately.
 */
const JIKAN_BREAKER_MS = 5 * 60 * 1000;
const jikanBreaker = new Map<string, number>();

function breakerOpen(path: string): boolean {
  const until = jikanBreaker.get(path) ?? 0;
  if (Date.now() < until) return true;
  if (until) jikanBreaker.delete(path);
  return false;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function jikanRequest(path: string): Promise<Record<string, unknown>> {
  if (breakerOpen(path)) throw new Error(`Jikan unavailable: ${path}`);

  for (let attempt = 0; attempt < JIKAN_MAX_ATTEMPTS; attempt += 1) {
    const gap = JIKAN_MIN_GAP_MS - (Date.now() - jikanLastAt);
    if (gap > 0) await delay(gap);
    jikanLastAt = Date.now();

    const res = await fetch(`${JIKAN_API}${path}`);

    // Retry rate limits AND upstream 5xx. Jikan is a free community API that
    // 504s regularly under its own load — the /episodes and search endpoints
    // were doing so consistently while direct id lookups were fine. Retrying
    // only 429 meant a transient gateway timeout surfaced to the caller as a
    // hard failure, which the anime screen reports as "Could not load anime".
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      await delay(retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
    return res.json();
  }
  // Every attempt failed — stop asking this endpoint for a while.
  jikanBreaker.set(path, Date.now() + JIKAN_BREAKER_MS);
  throw new Error(`Jikan unavailable: ${path}`);
}

async function jikanGet(path: string): Promise<Record<string, unknown>> {
  // Queue behind whatever is already in flight so concurrent screens can't
  // burst. Failures must not break the chain for everyone after them.
  const next = jikanChain.then(
    () => jikanRequest(path),
    () => jikanRequest(path),
  );
  jikanChain = next.catch(() => undefined);
  return next;
}

function jikanToResult(r: Record<string, unknown>): AnimeResult {
  const images = (r.images as Record<string, Record<string, string>>)?.webp;
  return {
    id: String(r.mal_id),
    title: (r.title_english as string) || (r.title as string),
    image: images?.large_image_url || images?.image_url || '',
    type: (r.type as string) || 'TV',
    score: (r.score as number) ?? null,
    year: (r.year as number) ?? null,
  };
}

async function jikanTrending(): Promise<AnimeResult[]> {
  const d = await jikanGet(`/top/anime?filter=airing&limit=15`);
  return ((d.data as Record<string, unknown>[]) || []).map(jikanToResult);
}

async function jikanPopular(): Promise<AnimeResult[]> {
  const d = await jikanGet(`/top/anime?filter=bypopularity&limit=15`);
  return ((d.data as Record<string, unknown>[]) || []).map(jikanToResult);
}

async function jikanSearch(query: string): Promise<AnimeResult[]> {
  const d = await jikanGet(`/anime?q=${encodeURIComponent(query)}&order_by=popularity&sort=asc&sfw=true`);
  return ((d.data as Record<string, unknown>[]) || []).map(jikanToResult);
}

async function jikanByGenre(genreId: number): Promise<AnimeResult[]> {
  const d = await jikanGet(`/anime?genres=${genreId}&order_by=popularity&sort=asc&sfw=true&limit=15`);
  return ((d.data as Record<string, unknown>[]) || []).map(jikanToResult);
}

async function jikanFull(id: string): Promise<JikanFull | null> {
  try {
    const d = await jikanGet(`/anime/${id}/full`);
    return (d.data as JikanFull) || null;
  } catch {
    return null;
  }
}

// ─── Consumet / HiAnime ──────────────────────────────────────────────────────
async function consuSearch(
  query: string,
): Promise<{ slug: string; animeId: string; title: string }[]> {
  try {
    // Strip apostrophes — the Consumet server returns HTTP 500 for %27-encoded queries
    const safeQuery = query.replace(/[''`]/g, '').replace(/\s+/g, ' ').trim();
    if (!safeQuery) return [];
    const d = await consuGet(`/api/search?keyword=${encodeURIComponent(safeQuery)}`);
    const results = (d.results || d.animes) as Record<string, unknown>[];
    if (!Array.isArray(results)) return [];
    return results
      .map((r) => {
        const slug = String(r.slug || r.id || '')
          .replace(/^watch\//, '')
          .replace(/\/ep-\d+$/, '');
        return { slug, animeId: String(r.animeId || ''), title: String(r.name || r.title || '') };
      })
      .filter((r) => r.slug && r.title);
  } catch {
    return [];
  }
}

async function consuResolveInfo(
  slug: string,
): Promise<{ slug: string; animeId: string; name: string } | null> {
  try {
    const d = await consuGet(`/api/info/${encodeURIComponent(slug)}`, 20_000);
    const animeId = String(d.animeId || '').trim();
    if (!animeId) return null;
    return { slug, animeId, name: String(d.name || '').trim() };
  } catch {
    return null;
  }
}

async function probeM3u8(slug: string, epNum = '1'): Promise<boolean> {
  try {
    const d = await consuGet(
      `/api/m3u8/${encodeURIComponent(slug)}/${epNum}?category=sub`,
      35_000,
    );
    const sources = d.sources as unknown[];
    return Array.isArray(sources) && sources.length > 0;
  } catch {
    return false;
  }
}

function registerStreamingSource(slug: string, animeId: string, malId?: string) {
  _slugMap.set(animeId, slug);
  cSet(`slug_${animeId}`, slug, 48 * 3_600_000);
  if (malId) {
    cSet(`srcslug_${malId}`, slug, 48 * 3_600_000);
    void setCachedValue(`anime:srcslug_${malId}`, slug, 48 * 3_600_000);
  }
}

async function consuEpisodes(animeId: string): Promise<AnimeEpisode[]> {
  try {
    const d = await consuGet(`/api/episodes/${animeId}`);
    const eps = d.episodes as Record<string, unknown>[];
    if (!Array.isArray(eps)) return [];
    return eps
      .filter((ep) => Number(ep.number) > 0)
      .map((ep) => ({
        id: `hi-${animeId}-${ep.number}`,
        number: Number(ep.number),
        title: String(ep.title || `Episode ${ep.number}`),
      }));
  } catch {
    return [];
  }
}

function parseStreamingEpisodeNumber(title: string): number | null {
  const m = title.match(/(?:episode|ep\.?)\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

async function fetchAniListEpisodeThumbnails(malId: string): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const malIdNum = Number(malId);
  if (!malIdNum) return map;

  const cacheKey = `epthumbs_${malId}`;
  const cached = cGet<Map<number, string>>(cacheKey);
  if (cached) return cached;

  try {
    const json = (await runAL(`{
      Media(idMal: ${malIdNum}, type: ANIME) {
        streamingEpisodes { title thumbnail }
      }
    }`)) as {
      data?: { Media?: { streamingEpisodes?: Array<{ title?: string; thumbnail?: string }> } };
    };

    const list = json?.data?.Media?.streamingEpisodes;
    if (!Array.isArray(list)) return map;

    for (const item of list) {
      const thumb = item.thumbnail?.trim();
      if (!thumb) continue;
      const num = parseStreamingEpisodeNumber(String(item.title || ''));
      if (num && num > 0) map.set(num, thumb);
    }

    if (map.size > 0) cSet(cacheKey, map, 7 * 24 * 3_600_000);
  } catch {
    // optional enrichment — ignore failures
  }

  return map;
}

function mergeEpisodeThumbnails(
  episodes: AnimeEpisode[],
  thumbs: Map<number, string>,
): AnimeEpisode[] {
  if (thumbs.size === 0) return episodes;
  return episodes.map((ep) => {
    const thumbnail = thumbs.get(ep.number);
    return thumbnail ? { ...ep, thumbnail } : ep;
  });
}

async function enrichEpisodeThumbnails(episodes: AnimeEpisode[], malId: string) {
  if (episodes.length === 0) return;
  const thumbs = await fetchAniListEpisodeThumbnails(malId);
  if (thumbs.size === 0) return;
  for (const ep of episodes) {
    const thumbnail = thumbs.get(ep.number);
    if (thumbnail) ep.thumbnail = thumbnail;
  }
}

async function estimateJikanEpisodeCount(jikan: JikanFull): Promise<number> {
  if (jikan.episodes && jikan.episodes > 0) return jikan.episodes;
  try {
    const data = await jikanGet(`/anime/${jikan.mal_id}/episodes`);
    const pagination = data.pagination as Record<string, unknown> | undefined;
    const lastPage = Number(pagination?.last_visible_page || 0);
    const list = data.data as unknown[];
    if (lastPage <= 1 && Array.isArray(list)) return list.length;
    // Jikan serves 100 episodes per page. This intentionally overestimates
    // airing long-runners slightly so users can still open later episodes.
    if (lastPage > 1) return lastPage * 100;
  } catch {
    // optional fallback
  }
  return 0;
}

function makeMalEpisodes(malId: string, count: number): AnimeEpisode[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => {
    const number = index + 1;
    return {
      id: `mal-${malId}-${number}`,
      number,
      title: `Episode ${number}`,
    };
  });
}

// ─── Source matching ──────────────────────────────────────────────────────────
function normTitle(s: string): string {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleSim(a: string, b: string): number {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (nb.startsWith(na) || na.startsWith(nb)) return 0.9;
  if (nb.includes(na) || na.includes(nb)) return 0.8;
  const aToks = new Set(na.split(' ').filter((t) => t.length > 1));
  const bToks = new Set(nb.split(' ').filter((t) => t.length > 1));
  let overlap = 0;
  aToks.forEach((t) => { if (bToks.has(t)) overlap++; });
  return (overlap / Math.max(aToks.size, bToks.size, 1)) * 0.7;
}

async function findSourceMatch(
  jikan: JikanFull,
): Promise<{ slug: string; animeId: string } | null> {
  const titleVariants = [
    jikan.title_english,
    jikan.title,
    jikan.title_japanese,
    ...(jikan.title_synonyms || []),
  ].filter((t): t is string => !!t);

  const seenQueries = new Set<string>();
  const candidates = new Map<string, { slug: string; animeId: string; score: number; title: string }>();

  const isMovie = jikan.type === 'Movie';

  for (const title of titleVariants.slice(0, 5)) {
    const nk = normTitle(title);
    if (!nk || seenQueries.has(nk)) continue;
    seenQueries.add(nk);

    const results = await consuSearch(title);
    for (const r of results) {
      const score = Math.max(
        titleSim(title, r.title),
        jikan.title_english ? titleSim(jikan.title_english, r.title) : 0,
        titleSim(jikan.title, r.title),
      );

      const cl = r.title.toLowerCase();
      const spinoffPenalty =
        !isMovie &&
        (cl.includes('movie') ||
          cl.includes('film') ||
          cl.includes('special') ||
          cl.includes('ova') ||
          cl.includes('spin-off') ||
          cl.includes('spin off'));

      const colonPenalty =
        !isMovie &&
        cl.includes(':') &&
        !(jikan.title_english || jikan.title).toLowerCase().includes(':');

      let final = score;
      if (spinoffPenalty) final *= 0.35;
      if (colonPenalty) final *= 0.55;
      const existing = candidates.get(r.slug);
      if (!existing || final > existing.score) {
        candidates.set(r.slug, { slug: r.slug, animeId: r.animeId, score: final, title: r.title });
      }
    }
    if (candidates.size >= 10) break;
  }

  if (candidates.size === 0) return null;

  const expectedEpisodes = jikan.episodes || await estimateJikanEpisodeCount(jikan);

  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);
  const validated: { slug: string; animeId: string; score: number; episodeCount: number }[] = [];

  // Validate top candidates against /api/info (parallel batches)
  const toCheck = sorted.filter((c) => c.score >= 0.22).slice(0, 12);
  for (let i = 0; i < toCheck.length; i += 4) {
    const batch = toCheck.slice(i, i + 4);
    const results = await Promise.all(
      batch.map(async (candidate) => {
        const resolved = await consuResolveInfo(candidate.slug);
        if (!resolved) return null;
        const eps = await consuEpisodes(resolved.animeId);
        const episodeCount = eps.length;
        if (expectedEpisodes > 12 && episodeCount > 0 && episodeCount < Math.min(12, expectedEpisodes * 0.35)) {
          return null;
        }
        const countBoost = expectedEpisodes > 0
          ? Math.min(0.3, (episodeCount / Math.max(expectedEpisodes, 1)) * 0.3)
          : Math.min(0.25, episodeCount / 200);
        return { ...resolved, score: candidate.score + countBoost, episodeCount };
      }),
    );
    for (const r of results) {
      if (r) validated.push({ slug: r.slug, animeId: r.animeId, score: r.score, episodeCount: r.episodeCount });
    }
    if (validated.length > 0) break;
  }

  if (validated.length === 0) return null;

  validated.sort((a, b) => b.score - a.score);
  const best = validated[0];
  registerStreamingSource(best.slug, best.animeId, String(jikan.mal_id));
  return { slug: best.slug, animeId: best.animeId };
}

// ─── Public exports ───────────────────────────────────────────────────────────
export async function searchAnime(query: string): Promise<AnimeResult[]> {
  const key = `search_${query.toLowerCase().trim()}`;
  const diskKey = `anime:${key}`;
  const cached = cGet<AnimeResult[]>(key);
  if (cached) return cached;
  const diskCached = await getCachedValue<AnimeResult[]>(diskKey);
  if (diskCached) {
    cSet(key, diskCached, 30 * 60_000);
    return diskCached;
  }

  try {
    const al = await alSearch(query);
    if (al.length > 0) {
      cSet(key, al, 30 * 60_000);
      await setCachedValue(diskKey, al, 30 * 60_000);
      return al;
    }
  } catch {}

  try {
    const r = await jikanSearch(query);
    if (r.length > 0) {
      cSet(key, r, 30 * 60_000);
      await setCachedValue(diskKey, r, 30 * 60_000);
      return r;
    }
  } catch {}

  return [];
}

export async function fetchAiringAnime(): Promise<AnimeResult[]> {
  const key = 'trending';
  const diskKey = `anime:${key}`;
  const cached = cGet<AnimeResult[]>(key);
  if (cached) return cached;
  const diskCached = await getCachedValue<AnimeResult[]>(diskKey);
  if (diskCached) {
    cSet(key, diskCached, 2 * 3_600_000);
    return diskCached;
  }

  try {
    const al = await alTrending();
    if (al.length > 0) {
      cSet(key, al, 2 * 3_600_000);
      await setCachedValue(diskKey, al, 2 * 3_600_000);
      return al;
    }
  } catch {}

  try {
    const r = await jikanTrending();
    if (r.length > 0) {
      cSet(key, r, 2 * 3_600_000);
      await setCachedValue(diskKey, r, 2 * 3_600_000);
      return r;
    }
  } catch {}

  return [];
}

export async function fetchPopularAnime(): Promise<AnimeResult[]> {
  const key = 'popular';
  const diskKey = `anime:${key}`;
  const cached = cGet<AnimeResult[]>(key);
  if (cached) return cached;
  const diskCached = await getCachedValue<AnimeResult[]>(diskKey);
  if (diskCached) {
    cSet(key, diskCached, 2 * 3_600_000);
    return diskCached;
  }

  try {
    const al = await alPopular();
    if (al.length > 0) {
      cSet(key, al, 2 * 3_600_000);
      await setCachedValue(diskKey, al, 2 * 3_600_000);
      return al;
    }
  } catch {}

  try {
    const r = await jikanPopular();
    if (r.length > 0) {
      cSet(key, r, 2 * 3_600_000);
      await setCachedValue(diskKey, r, 2 * 3_600_000);
      return r;
    }
  } catch {}

  return [];
}

export async function fetchAnimeByGenre(genreId: number): Promise<AnimeResult[]> {
  const key = `genre_${genreId}`;
  const diskKey = `anime:${key}`;
  const cached = cGet<AnimeResult[]>(key);
  if (cached) return cached;
  const diskCached = await getCachedValue<AnimeResult[]>(diskKey);
  if (diskCached) {
    cSet(key, diskCached, 30 * 60_000);
    return diskCached;
  }

  const genreName = ANIME_GENRES.find((g) => g.id === genreId)?.name;

  if (genreName) {
    try {
      const al = await alByGenre(genreName);
      if (al.length > 0) {
        cSet(key, al, 30 * 60_000);
        await setCachedValue(diskKey, al, 30 * 60_000);
        return al;
      }
    } catch {}
  }

  try {
    const r = await jikanByGenre(genreId);
    if (r.length > 0) {
      cSet(key, r, 30 * 60_000);
      await setCachedValue(diskKey, r, 30 * 60_000);
      return r;
    }
  } catch {}

  return [];
}

function hasPlaceholderEpisodes(info: AnimeInfo): boolean {
  return info.episodes.some((e) => e.id.startsWith('hi-0-'));
}

function hasPlayableEpisodes(info: AnimeInfo): boolean {
  return info.episodes.some((e) => /^hi-\d+-\d+$/.test(e.id));
}

function hasSuspiciousEpisodeCount(info: AnimeInfo): boolean {
  const title = normTitle(info.title);
  return title === 'one piece' && info.episodes.length < 100;
}

function hydrateStreamingFromInfo(info: AnimeInfo, malId: string) {
  if (info.streamingSlug && info.streamingAnimeId) {
    registerStreamingSource(info.streamingSlug, info.streamingAnimeId, malId);
    return;
  }
  const srcmap = cGet<{ slug: string; animeId: string }>(`srcmap_${malId}`);
  if (srcmap) {
    registerStreamingSource(srcmap.slug, srcmap.animeId, malId);
    info.streamingSlug = srcmap.slug;
    info.streamingAnimeId = srcmap.animeId;
    return;
  }
  const epMatch = info.episodes[0]?.id.match(/^hi-(\d+)-\d+$/);
  if (!epMatch) return;
  const animeId = epMatch[1];
  const slug = _slugMap.get(animeId) || cGet<string>(`slug_${animeId}`) || cGet<string>(`srcslug_${malId}`);
  if (slug) {
    registerStreamingSource(slug, animeId, malId);
    info.streamingSlug = slug;
    info.streamingAnimeId = animeId;
  }
}

async function hydrateStreamingFromDisk(info: AnimeInfo, malId: string) {
  const srcmap = await getCachedValue<{ slug: string; animeId: string }>(`anime:srcmap_${malId}`);
  if (srcmap) {
    registerStreamingSource(srcmap.slug, srcmap.animeId, malId);
    info.streamingSlug = srcmap.slug;
    info.streamingAnimeId = srcmap.animeId;
    return;
  }
  const slug = await getCachedValue<string>(`anime:srcslug_${malId}`);
  if (slug && info.streamingAnimeId) {
    registerStreamingSource(slug, info.streamingAnimeId, malId);
    info.streamingSlug = slug;
    return;
  }
  hydrateStreamingFromInfo(info, malId);
}

export async function resolveStreamingByMalId(malId: string): Promise<{ slug: string; animeId: string } | null> {
  const cachedSlug = cGet<string>(`srcslug_${malId}`) || (await getCachedValue<string>(`anime:srcslug_${malId}`));
  const srcmap = cGet<{ slug: string; animeId: string }>(`srcmap_${malId}`)
    || (await getCachedValue<{ slug: string; animeId: string }>(`anime:srcmap_${malId}`));
  if (srcmap?.slug && srcmap.animeId) {
    registerStreamingSource(srcmap.slug, srcmap.animeId, malId);
    return srcmap;
  }
  if (cachedSlug) {
    const resolved = await consuResolveInfo(cachedSlug);
    if (resolved) {
      registerStreamingSource(resolved.slug, resolved.animeId, malId);
      cSet(`srcmap_${malId}`, { slug: resolved.slug, animeId: resolved.animeId }, 48 * 3_600_000);
      return { slug: resolved.slug, animeId: resolved.animeId };
    }
  }
  const jikan = await jikanFull(malId);
  if (!jikan) return null;
  return findSourceMatch(jikan);
}

export async function fetchAnimeInfo(
  id: string,
  opts?: { force?: boolean },
): Promise<AnimeInfo | null> {
  // Sakura Originals are served locally — no network fetch needed
  const { fetchSakuraOriginalInfo, isSakuraOriginal } = await import('./sakura-originals');
  if (isSakuraOriginal(id)) return fetchSakuraOriginalInfo(id, opts);

  const key = `info2_${id}`;
  const diskKey = `anime:${key}`;

  if (opts?.force) {
    cDelete(key);
    cDelete(`srcmap_${id}`);
    cDelete(`srcslug_${id}`);
  }

  const cached = cGet<AnimeInfo>(key);
  if (cached && !opts?.force && hasPlayableEpisodes(cached) && !hasPlaceholderEpisodes(cached) && !hasSuspiciousEpisodeCount(cached)) {
    hydrateStreamingFromInfo(cached, id);
    if (!cached.episodes.some((e) => e.thumbnail)) {
      await enrichEpisodeThumbnails(cached.episodes, id);
    }
    return cached;
  }
  let diskCached = await getCachedValue<AnimeInfo>(diskKey);
  if (!diskCached) {
    diskCached = await getCachedValue<AnimeInfo>(`anime:info_${id}`);
  }
  if (diskCached && !opts?.force && hasPlayableEpisodes(diskCached) && !hasPlaceholderEpisodes(diskCached) && !hasSuspiciousEpisodeCount(diskCached)) {
    cSet(key, diskCached, 24 * 3_600_000);
    await hydrateStreamingFromDisk(diskCached, id);
    if (!diskCached.episodes.some((e) => e.thumbnail)) {
      await enrichEpisodeThumbnails(diskCached.episodes, id);
    }
    return diskCached;
  }

  const jikan = await jikanFull(id);
  if (!jikan) return null;

  const img =
    jikan.images?.webp?.large_image_url || jikan.images?.webp?.image_url || '';

  const info: AnimeInfo = {
    id: String(jikan.mal_id),
    title: jikan.title_english || jikan.title,
    image: img,
    cover: img,
    description: jikan.synopsis || '',
    status: jikan.status,
    genres: jikan.genres?.map((g) => g.name) || [],
    score: jikan.score,
    type: jikan.type,
    year: jikan.year,
    episodes: [],
  };

  try {
    const srcKey = `srcmap_${id}`;
    let srcmap = cGet<{ slug: string; animeId: string }>(srcKey);
    const expectedEpisodes = await estimateJikanEpisodeCount(jikan);

    if (!srcmap) {
      const match = await findSourceMatch(jikan);
      if (match) {
        srcmap = match;
        cSet(srcKey, match, 48 * 3_600_000);
        await setCachedValue(`anime:${srcKey}`, match, 48 * 3_600_000);
      }
    }

    if (srcmap) {
      registerStreamingSource(srcmap.slug, srcmap.animeId, id);
      info.streamingSlug = srcmap.slug;
      info.streamingAnimeId = srcmap.animeId;
      let eps = await consuEpisodes(srcmap.animeId);
      if (expectedEpisodes > 12 && eps.length > 0 && eps.length < Math.min(12, expectedEpisodes * 0.35)) {
        eps = [];
        cDelete(srcKey);
        cDelete(`srcslug_${id}`);
        info.streamingSlug = undefined;
        info.streamingAnimeId = undefined;
      }
      const thumbs = await fetchAniListEpisodeThumbnails(id);
      eps = mergeEpisodeThumbnails(eps, thumbs);
      info.episodes = eps;
      if (eps.length > 0) cSet(`episodes_${srcmap.animeId}`, eps, 6 * 3_600_000);
    }
  } catch (e) {
    console.warn('[anime] source match failed:', e);
  }

  if (info.episodes.length === 0) {
    const fallbackCount = await estimateJikanEpisodeCount(jikan);
    if (fallbackCount > 0) {
      info.episodes = makeMalEpisodes(id, fallbackCount);
      await enrichEpisodeThumbnails(info.episodes, id);
    }
  }

  if (info.episodes.length === 0) {
    info.episodeLoadError = getActiveConsumetUrl()
      ? 'Streaming source unavailable for this title.'
      : 'Streaming server is not configured.';
  }

  if (info.episodes.length > 0) {
    cSet(key, info, 24 * 3_600_000);
    await setCachedValue(diskKey, info, 24 * 3_600_000);
  }

  return info;
}

async function resolveSlugForPlayback(
  animeId: string,
  malId?: string,
): Promise<string | null> {
  let slug = _slugMap.get(animeId) || cGet<string>(`slug_${animeId}`) || null;
  if (slug) {
    _slugMap.set(animeId, slug);
    return slug;
  }
  if (malId) {
    slug = cGet<string>(`srcslug_${malId}`) || (await getCachedValue<string>(`anime:srcslug_${malId}`)) || null;
    if (slug) {
      _slugMap.set(animeId, slug);
      cSet(`slug_${animeId}`, slug, 48 * 3_600_000);
      return slug;
    }
  }
  return null;
}

async function fetchM3u8Source(
  slug: string,
  epNum: string,
  category: 'sub' | 'dub',
  malId?: string,
): Promise<StreamingSource | null> {
  const d = await consuGet(
    `/api/m3u8/${encodeURIComponent(slug)}/${epNum}?category=${category}`,
    45_000,
  );

  const sources = d.sources as Record<string, unknown>[];
  if (!Array.isArray(sources) || sources.length === 0) return null;

  const headers = d.headers as Record<string, string> | undefined;
  const intro = d.intro as { start: number; end: number } | null;
  const outro = d.outro as { start: number; end: number } | null;

  const preferred =
    sources.find((s) => String(s.quality || '') === 'auto') ||
    sources.find((s) => String(s.quality || '') === '1080p') ||
    sources[0];

  const url = String(preferred.url || '');
  if (!url) return null;

  const referer = headers?.Referer || headers?.referer || '';
  const embedUrl = buildStreamEmbedUrl(malId || '0', epNum, category, referer, slug);

  const requestHeaders: Record<string, string> = {};
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string' && v.trim()) requestHeaders[k] = v;
    }
  }

  return {
    url,
    isM3U8: preferred.isM3U8 !== false,
    referer,
    requestHeaders: Object.keys(requestHeaders).length ? requestHeaders : undefined,
    embedUrl,
    intro: intro || undefined,
    outro: outro || undefined,
    category: String(d.category || category),
    availableCategories: (d.availableCategories as string[]) || ['sub', 'dub'],
    allSources: sources.map((s) => ({
      url: String(s.url || ''),
      quality: String(s.quality || 'unknown'),
      isM3U8: s.isM3U8 !== false,
    })),
  };
}

export async function fetchEpisodeSources(
  episodeId: string,
  category: 'sub' | 'dub' = 'sub',
  malId?: string,
  opts?: { force?: boolean },
): Promise<StreamingSource | null> {
  if (opts?.force && malId) {
    clearAnimeSourceCacheForMal(malId);
  }
  // Sakura Originals stream from our own media server
  const { resolveSakuraOriginalStreamUrl } = await import('./sakura-originals');
  const origUrl = await resolveSakuraOriginalStreamUrl(episodeId);
  if (origUrl) {
    return { url: origUrl, isM3U8: false };
  }

  if (!getActiveConsumetUrl() && consumetCandidates().length === 0) return null;

  const parts = episodeId.match(/^hi-(\d+)-(\d+)$/);
  const malParts = episodeId.match(/^mal-(\d+)-(\d+)$/);
  if (!parts) {
    if (malParts) {
      const [, directMalId, directEpNum] = malParts;
      const categories: Array<'sub' | 'dub'> = category === 'dub' ? ['dub', 'sub'] : ['sub', 'dub'];

      const resolved = await resolveStreamingByMalId(directMalId).catch(() => null);
      if (resolved?.slug) {
        for (const cat of categories) {
          try {
            const src = await fetchM3u8Source(resolved.slug, directEpNum, cat, directMalId);
            if (src?.url) return src;
          } catch {
            // try alternate category or Megaplay fallback
          }
        }
      }

      for (const cat of categories) {
        const src = await fetchDirectMalSource(directMalId, directEpNum, cat).catch(() => null);
        if (src?.url || src?.embedUrl) return src;
      }
    }
    return null;
  }

  const [, animeId, epNum] = parts;
  if (animeId === '0') return null;

  let slug = await resolveSlugForPlayback(animeId, malId);
  if (!slug && malId) {
    const resolved = await resolveStreamingByMalId(malId);
    if (resolved) slug = resolved.slug;
  }
  if (!slug) {
    console.warn(`[anime] fetchEpisodeSources: no slug for animeId=${animeId}.`);
    return null;
  }

  const categories: Array<'sub' | 'dub'> = category === 'dub' ? ['dub', 'sub'] : ['sub', 'dub'];

  for (const cat of categories) {
    try {
      const src = await fetchM3u8Source(slug, epNum, cat, malId);
      if (src?.embedUrl || src?.url) return src;
    } catch {
      // try alternate category
    }
  }

  if (malId) {
    for (const cat of categories) {
      const src = await fetchDirectMalSource(malId, epNum, cat).catch(() => null);
      if (src?.url || src?.embedUrl) return src;
    }
  }

  return null;
}
