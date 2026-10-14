import { withAnimeTimeout } from './anime-network';
import { fetchBrowserAnimeStream, prewarmBrowserAnimeStream, usesBrowserAnimeStream } from './anime-stream-client';
import { primeAnimeDiscovery } from './anime-discovery';
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
  cDelete(`info3_${malId}`);
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
  /** Per-episode synopsis (Sakura Originals manifests provide these). */
  description?: string;
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
  /**
   * Where the title metadata came from. Only AniList records are complete
   * (English title, synopsis, real genres, episode titles and stills); records
   * built from the Jikan or offline-index fallbacks are cached briefly so the
   * next visit upgrades them instead of showing a degraded page for a day.
   */
  metaSource?: 'anilist' | 'jikan' | 'index';
  /** Wide key art from AniList, when the title has one. */
  banner?: string;
  /** The next scheduled broadcast (airingAt in ms) for a show that is still airing. */
  nextAiringEpisode?: { episode: number; airingAt: number };
  /** Typical episode runtime in minutes. */
  durationMinutes?: number;
  studios?: string[];
  /** Romanised Japanese title, shown under an English title when they differ. */
  titleRomaji?: string;
}

export interface StreamingSource {
  url: string;
  isM3U8: boolean;
  referer?: string;
  /** Headers from Consumet/CDN (Referer, Origin, etc.) — required for native download */
  requestHeaders?: Record<string, string>;
  /** Provider player URL; web exposes it only as an explicit external fallback. */
  embedUrl?: string;
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
  category?: string;
  availableCategories?: string[];
  /** The provider has explicitly reported no episode in this language. */
  unavailableCategory?: 'sub' | 'dub';
  allSources?: Array<{ url: string; quality: string; isM3U8: boolean }>;
  /** Browser-safe subtitle URLs returned by the signed stream resolver. */
  subtitles?: Array<{ url: string; lang: string; label: string }>;
}

const MOBILE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export function getAnimeStreamUserAgent() {
  return MOBILE_SAFARI_UA;
}

/** HiAnime web player — Megaplay embed often returns 410 inside WebView */
/**
 * The player hianime's wrapper page embeds.
 *
 * `hianime.dk/player/...` is a 595-byte page whose entire body is an iframe
 * pointing here. On native that indirection is harmless — a WebView is not a
 * frame and is not subject to framing policy. On web it is fatal: the wrapper
 * serves `x-frame-options: SAMEORIGIN`, so any origin that is not hianime.dk is
 * refused, and the result is a player area that loads without error and renders
 * nothing. That is precisely the blank screen this was reported as.
 *
 * The inner player has no framing restrictions at all — verified against its
 * response headers — so on web we address it directly and skip the wrapper.
 */
const MEGAPLAY_BASE = 'https://megaplay.buzz';

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
    /**
     * BOTH platforms get megaplay's bare player. Native used to get hianime's
     * /player/mal/ wrapper instead, and that wrapper is where the ads were.
     *
     * Measured, same episode, same minute:
     *     megaplay /stream/mal/  ->   3,704 bytes, 3 external scripts,
     *                                 0 popup markers. Its only third party is
     *                                 statlytic.net, which carries data-domain=
     *                                 and is Plausible analytics, not an ad net.
     *     hianime  /player/mal/  -> 208,380 bytes, 60 scripts, 4 _blank links.
     *
     * A 56x heavier page from a full ad-supported site, loaded only on native.
     * That is why the app showed ads and the website largely did not.
     *
     * The old comment here claimed native "keeps the wrapper, which is what its
     * injected shield and progress scripts are written against". That was not
     * true: buildAnimePlayerShieldScript nulls window.open and blocks clicks by
     * host pattern, and the progress poll just looks for a <video> — neither
     * knows anything about hianime's DOM.
     *
     * This is the fallback path only. With the Referer fix in place the player
     * should resolve the stream directly and never reach an iframe at all; this
     * makes the iframe harmless on the occasions it still appears.
     */
    return `${MEGAPLAY_BASE}/stream/mal/${streamMalId}/${epNum}/${category}`;
  }

  if (slug) {
    return `${HIANIME_BASE}/watch/${encodeURIComponent(slug)}?ep=${epNum}`;
  }

  // Same reasoning as the branch above: megaplay's bare player on both
  // platforms, never hianime's 208KB ad-carrying wrapper.
  return `${MEGAPLAY_BASE}/stream/mal/${malId}/${epNum}/${category}`;
}

export function buildPlaybackHeaders(referer?: string): Record<string, string> {
  const ref = referer || 'https://megaplay.buzz/';
  let origin = 'https://megaplay.buzz';
  try {
    origin = new URL(ref).origin;
  } catch {
    // keep default
  }
  /**
   * Referer must be the ORIGIN with a trailing slash — never the player path.
   *
   * The CDN gates the playlists and every segment on an exact Referer string.
   * Measured against one URL in one minute, varying nothing else:
   *
   *     https://megaplay.buzz/                       -> 200
   *     https://megaplay.buzz                        -> 403  (no trailing slash)
   *     https://megaplay.buzz/stream/mal/57334/1/sub -> 403  (a player path)
   *
   * This function already computed `origin` and then used it only for the
   * Origin header, passing the full path through as Referer — so callers got a
   * 403, direct playback failed, and the player fell back to the megaplay
   * iframe. That iframe is where the ads are. The ads were never the price of
   * access; they were the symptom of sending a Referer the CDN rejects.
   */
  return {
    Referer: `${origin}/`,
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
        if (pickMegaplayFile(payload) || (typeof payload.enc === 'string' && payload.enc)) break;
      } catch {
        // try the next known Megaplay source endpoint
      }
    }
  }

  let url = pickMegaplayFile(payload);
  if (!url) {
    url = findMegaplayM3u8InHtml(html);
  }
  if (!url && !(typeof payload?.enc === 'string' && payload.enc)) return null;

  const intro = (payload?.intro || (payload?.data as any)?.intro) as { start: number; end: number } | undefined;
  const outro = (payload?.outro || (payload?.data as any)?.outro) as { start: number; end: number } | undefined;

  return {
    url: url || '',
    isM3U8: !!url && /\.m3u8(?:[?#]|$)/i.test(url),
    referer: playerUrl,
    requestHeaders: buildPlaybackHeaders(playerUrl),
    embedUrl: playerUrl,
    intro,
    outro,
    category,
    availableCategories: ['sub', 'dub'],
    allSources: url ? [{ url, quality: 'auto', isM3U8: /\.m3u8(?:[?#]|$)/i.test(url) }] : [],
  };
}

async function fetchDirectMalSource(
  malId: string,
  epNum: string,
  category: 'sub' | 'dub',
): Promise<StreamingSource | null> {
  const embedUrl = buildStreamEmbedUrl(malId, epNum, category);
  try {
    const source = await fetchMegaplaySourceFromEmbed(embedUrl, category);
    if (source?.url || source?.embedUrl) return source;
  } catch {
    // Removed/error pages are not playable fallback sources.
  }
  return null;
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
/**
 * Card fields. Only `coverImage.large` is requested: shelves and grids draw
 * posters 108–170 px wide, and `extraLarge` (the original upload, up to 676 KB
 * a poster) made the Anime tab download 2–2.6 MB of artwork for 15 cards, so
 * posters appeared seconds after their titles. `large` is ~230 px wide and
 * about a third of the bytes. The detail hero still asks for `extraLarge`.
 */
const AL_FIELDS =
  `id idMal title{english romaji} coverImage{large} averageScore episodes format seasonYear`;

/**
 * AniList names its sizes one step off from its URLs: `extraLarge` is served
 * from /cover/large/, `large` from /cover/medium/. Lists cached before cards
 * switched to `large` still hold extraLarge URLs for up to two hours; this
 * rewrites them so a returning visitor gets the small posters at once.
 */
export function cardCoverUrl(url: string): string {
  return /^https:\/\/s\d+\.anilist\.co\/file\/anilistcdn\/media\/anime\/cover\/large\//.test(url)
    ? url.replace('/media/anime/cover/large/', '/media/anime/cover/medium/')
    : url;
}

function cardResults(results: AnimeResult[]): AnimeResult[] {
  return results.map((result) => {
    const image = cardCoverUrl(result.image);
    return image === result.image ? result : { ...result, image };
  });
}

// ─── Previews for instant detail pages ───────────────────────────────────────
/**
 * The card a user tapped already carries the title, poster, score and year.
 * Remembering it lets the detail page draw its hero immediately and show
 * skeleton episodes while the full record loads, instead of a blank shimmer.
 */
const _previews = new Map<string, AnimeResult>();
const PREVIEW_LIMIT = 400;

export function rememberAnimePreviews(results: readonly AnimeResult[]): void {
  for (const result of results) {
    if (!result?.id || !result.title) continue;
    _previews.delete(result.id);
    _previews.set(result.id, result);
  }
  while (_previews.size > PREVIEW_LIMIT) _previews.delete(_previews.keys().next().value!);
}

export function getAnimePreview(id: string): AnimeResult | null {
  return _previews.get(id) ?? null;
}

function escGql(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function runAL(q: string, timeoutMs = 6000): Promise<unknown> {
  return withAnimeTimeout(async (signal) => {
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: q }),
      signal,
    });
    if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
    const json = await res.json();
    if (json?.errors?.length) throw new Error(json.errors[0]?.message);
    return json;
  }, timeoutMs);
}

function alToResult(m: Record<string, unknown>): AnimeResult | null {
  if (!m?.idMal) return null;
  const title = m.title as Record<string, string> | null;
  const cover = m.coverImage as Record<string, string> | null;
  return {
    id: String(m.idMal),
    title: title?.english || title?.romaji || 'Unknown',
    image: cover?.large || cover?.extraLarge || '',
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

// `isAdult:false` on every catalog list: the discovery shelves already reject
// adult media, and the general anime catalog should not surface it either.
async function alTrending(): Promise<AnimeResult[]> {
  const q = `{Page(page:1,perPage:15){media(type:ANIME,isAdult:false,sort:TRENDING_DESC,status:RELEASING){${AL_FIELDS}}}}`;
  return alPageResults(await runAL(q));
}

async function alPopular(): Promise<AnimeResult[]> {
  const q = `{Page(page:1,perPage:15){media(type:ANIME,isAdult:false,sort:POPULARITY_DESC){${AL_FIELDS}}}}`;
  return alPageResults(await runAL(q));
}

async function alSearch(query: string): Promise<AnimeResult[]> {
  const q = `{Page(page:1,perPage:20){media(type:ANIME,isAdult:false,search:"${escGql(query)}",sort:SEARCH_MATCH){${AL_FIELDS}}}}`;
  return alPageResults(await runAL(q));
}

async function alByGenre(genre: string): Promise<AnimeResult[]> {
  const q = `{Page(page:1,perPage:15){media(type:ANIME,isAdult:false,genre:"${escGql(genre)}",sort:POPULARITY_DESC){${AL_FIELDS}}}}`;
  return alPageResults(await runAL(q));
}

// ─── AniList title record (detail + watch pages) ─────────────────────────────
/**
 * One query carries everything the title page needs: English and romaji
 * titles, synopsis, real genres, status and schedule, episode titles with
 * stills, and the related/recommended shelves.
 *
 * It replaces Jikan as the primary source. Jikan stopped answering (it never
 * completes a TCP connect from several networks), and every cold detail page
 * and watch link sat on its 6 s timeout before anything rendered; AniList
 * answers the same title in ~0.5–0.8 s. It also replaces three separate
 * AniList calls (episode stills, the aired-episode bound, discovery), which
 * matters because AniList currently allows 30 requests a minute per IP.
 */
const AL_CARD_FIELDS = 'idMal type isAdult title{english romaji} coverImage{large} format averageScore seasonYear';
const AL_TITLE_QUERY = `query SakuraTitle($id:Int){Media(idMal:$id,type:ANIME){idMal isAdult status episodes duration format seasonYear startDate{year} averageScore genres title{english romaji native} synonyms description(asHtml:false) coverImage{extraLarge large} bannerImage nextAiringEpisode{episode airingAt} streamingEpisodes{title thumbnail} studios(isMain:true){nodes{name}} recommendations(sort:RATING_DESC,perPage:25){nodes{rating mediaRecommendation{${AL_CARD_FIELDS}}}} relations{edges{relationType node{${AL_CARD_FIELDS}}}}}}`;
/** AniList usually answers in under a second; past this the fallbacks are already racing it. */
const AL_TITLE_TIMEOUT_MS = 5000;
/** Head start AniList gets before the slower fallbacks are started alongside it. */
const AL_TITLE_HEDGE_MS = 1500;

export interface AniListTitleMedia {
  idMal: number;
  isAdult?: boolean;
  status?: string;
  episodes?: number | null;
  duration?: number | null;
  format?: string | null;
  seasonYear?: number | null;
  startDate?: { year?: number | null } | null;
  averageScore?: number | null;
  genres?: string[] | null;
  title?: { english?: string | null; romaji?: string | null; native?: string | null } | null;
  synonyms?: string[] | null;
  description?: string | null;
  coverImage?: { extraLarge?: string | null; large?: string | null } | null;
  bannerImage?: string | null;
  nextAiringEpisode?: { episode?: number; airingAt?: number } | null;
  streamingEpisodes?: Array<{ title?: string | null; thumbnail?: string | null }> | null;
  studios?: { nodes?: Array<{ name?: string | null }> | null } | null;
}

const _alTitles = new Map<string, { media: AniListTitleMedia; exp: number }>();
const _alTitleRequests = new Map<string, Promise<AniListTitleMedia | null>>();

/** One AniList title request per id at a time; the detail and watch pages share it. */
function fetchAniListTitle(malId: string, force = false): Promise<AniListTitleMedia | null> {
  if (!/^[1-9]\d{0,8}$/.test(malId)) return Promise.resolve(null);
  const hit = _alTitles.get(malId);
  if (!force && hit && hit.exp > Date.now()) return Promise.resolve(hit.media);
  const pending = _alTitleRequests.get(malId);
  if (pending && !force) return pending;
  const request = (async () => {
    try {
      const json = await withAnimeTimeout(async (signal) => {
        const res = await fetch(ANILIST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query: AL_TITLE_QUERY, variables: { id: Number(malId) } }),
          signal,
        });
        if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
        return res.json() as Promise<{ data?: { Media?: AniListTitleMedia } }>;
      }, AL_TITLE_TIMEOUT_MS);
      const media = json?.data?.Media;
      if (!media || String(media.idMal) !== malId || !aniListDisplayTitle(media)) return null;
      _alTitles.set(malId, { media, exp: Date.now() + 60 * 60_000 });
      primeAnimeDiscovery(malId, json);
      return media;
    } catch {
      return null;
    }
  })();
  _alTitleRequests.set(malId, request);
  void request.then(() => { if (_alTitleRequests.get(malId) === request) _alTitleRequests.delete(malId); });
  return request;
}

function aniListDisplayTitle(media: AniListTitleMedia): string {
  return (media.title?.english || media.title?.romaji || media.title?.native || '').trim();
}

const ANILIST_STATUS: Record<string, string> = {
  FINISHED: 'Finished Airing',
  RELEASING: 'Currently Airing',
  NOT_YET_RELEASED: 'Not yet aired',
  CANCELLED: 'Cancelled',
  HIATUS: 'On hiatus',
};
const ANILIST_FORMAT: Record<string, string> = {
  TV: 'TV', TV_SHORT: 'TV Short', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music',
};
const ENTITIES: Record<string, string> = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
};

/** AniList synopses are HTML fragments (`<br>`, `<i>`, entities); the UI shows plain text. */
export function cleanAnimeDescription(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === '#') {
        const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match;
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Real episode titles and stills from AniList's streaming list, keyed by
 * episode number. Titles arrive as "Episode 1 - The Journey's End"; the number
 * is only the key, the remainder is the title. Some multi-cour entries number
 * their streaming episodes from the series start (25–48 for a 24-episode
 * season); when no number falls inside the season they are shifted down.
 */
export function parseStreamingEpisodes(
  list: AniListTitleMedia['streamingEpisodes'],
  episodeCount: number,
): Map<number, { title?: string; thumbnail?: string }> {
  const parsed: Array<{ number: number; title?: string; thumbnail?: string }> = [];
  for (const item of Array.isArray(list) ? list : []) {
    const raw = String(item?.title ?? '').trim();
    const match = raw.match(/^(?:episode|ep\.?)\s*(\d+)(?:\s*[-–—:.]\s*(.*))?$/i);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    const title = match[2]?.trim().slice(0, 200) || undefined;
    let thumbnail: string | undefined;
    try {
      const url = new URL(String(item?.thumbnail ?? ''));
      if (url.protocol === 'https:') thumbnail = url.href;
    } catch { /* no usable still */ }
    if (title || thumbnail) parsed.push({ number, title, thumbnail });
  }
  const map = new Map<number, { title?: string; thumbnail?: string }>();
  if (!parsed.length) return map;
  const min = Math.min(...parsed.map((row) => row.number));
  const offset = episodeCount > 0 && min > episodeCount ? min - 1 : 0;
  for (const row of parsed) {
    const number = row.number - offset;
    if (number < 1 || map.has(number)) continue;
    map.set(number, { title: row.title, thumbnail: row.thumbnail });
  }
  return map;
}

/**
 * How many episodes have actually aired, or null when AniList cannot say.
 * Finished shows use their total; airing shows the episode before the next
 * broadcast (which also covers long runners like One Piece whose total is
 * unknown); unaired shows have none.
 */
export function airedEpisodeCount(media: AniListTitleMedia, now = Date.now()): number | null {
  const next = media.nextAiringEpisode;
  const nextEpisode = Number(next?.episode);
  const nextAt = Number(next?.airingAt) * 1000;
  const scheduled = Number.isSafeInteger(nextEpisode) && nextEpisode >= 1 && nextEpisode <= 50_001
    && Number.isSafeInteger(nextAt / 1000) && nextAt > now;
  const total = typeof media.episodes === 'number' && Number.isSafeInteger(media.episodes) && media.episodes > 0
    ? media.episodes : null;
  switch (media.status) {
    case 'FINISHED':
    case 'CANCELLED':
      return total;
    case 'NOT_YET_RELEASED':
      return scheduled ? nextEpisode - 1 : 0;
    default:
      return scheduled ? nextEpisode - 1 : null;
  }
}

/**
 * Builds the title page record from one AniList answer. `episodes` is empty
 * with `episodeLoadError` set for a show that has not aired; it is empty
 * without an error when the aired count is unknown and the provider must be
 * asked (see fetchAnimeInfo).
 */
export function animeInfoFromAniList(malId: string, media: AniListTitleMedia, now = Date.now()): { info: AnimeInfo; airedCount: number | null } {
  const titleEnglish = (media.title?.english || '').trim();
  const titleRomaji = (media.title?.romaji || '').trim();
  const image = media.coverImage?.extraLarge || media.coverImage?.large || '';
  const next = media.nextAiringEpisode;
  const nextAt = Number(next?.airingAt) * 1000;
  const airedCount = airedEpisodeCount(media, now);
  const info: AnimeInfo = {
    id: malId,
    title: aniListDisplayTitle(media),
    titleRomaji: titleEnglish && titleRomaji && titleRomaji !== titleEnglish ? titleRomaji : undefined,
    image,
    cover: image,
    banner: media.bannerImage || undefined,
    description: cleanAnimeDescription(media.description),
    status: ANILIST_STATUS[media.status ?? ''] ?? (media.status || undefined),
    genres: Array.isArray(media.genres) ? media.genres.filter((genre) => typeof genre === 'string').slice(0, 12) : [],
    score: typeof media.averageScore === 'number' && media.averageScore > 0 ? +(media.averageScore / 10).toFixed(1) : null,
    type: ANILIST_FORMAT[media.format ?? ''] ?? (media.format || 'TV'),
    year: media.seasonYear ?? media.startDate?.year ?? null,
    durationMinutes: typeof media.duration === 'number' && media.duration > 0 ? media.duration : undefined,
    studios: (media.studios?.nodes ?? []).map((node) => (node?.name || '').trim()).filter(Boolean).slice(0, 3),
    nextAiringEpisode: Number.isSafeInteger(Number(next?.episode)) && nextAt > now
      ? { episode: Number(next!.episode), airingAt: nextAt } : undefined,
    metaSource: 'anilist',
    episodes: [],
  };
  if (airedCount !== null && airedCount > 0) {
    info.episodes = withStreamingDetails(makeMalEpisodes(malId, airedCount), media, airedCount);
  } else if (airedCount === 0) {
    info.episodeLoadError = 'The first episode has not aired yet.';
  }
  return { info, airedCount };
}

/** Titles and stills from AniList, applied to any episode list (MAL or provider ids). */
function withStreamingDetails(episodes: AnimeEpisode[], media: AniListTitleMedia, count: number): AnimeEpisode[] {
  const details = parseStreamingEpisodes(media.streamingEpisodes, count);
  if (!details.size) return episodes;
  return episodes.map((episode) => {
    const extra = details.get(episode.number);
    if (!extra) return episode;
    const generic = !episode.title || /^episode\s*\d+$/i.test(episode.title.trim());
    return {
      ...episode,
      title: generic && extra.title ? extra.title : episode.title,
      thumbnail: episode.thumbnail || extra.thumbnail,
    };
  });
}

/** The shape provider matching was written against, built from AniList titles. */
function jikanFromAniList(malId: string, media: AniListTitleMedia): JikanFull {
  const latin = (value: string) => /^[\x20-\x7EÀ-ɏ‘-”–—]+$/.test(value);
  const image = media.coverImage?.extraLarge || media.coverImage?.large || '';
  return {
    mal_id: Number(malId),
    title: media.title?.romaji || aniListDisplayTitle(media),
    title_english: media.title?.english || null,
    title_japanese: media.title?.native || null,
    title_synonyms: (media.synonyms ?? []).filter((value) => typeof value === 'string' && latin(value)).slice(0, 4),
    images: { webp: { image_url: image, large_image_url: image } },
    synopsis: cleanAnimeDescription(media.description),
    status: ANILIST_STATUS[media.status ?? ''] ?? '',
    type: ANILIST_FORMAT[media.format ?? ''] ?? 'TV',
    year: media.seasonYear ?? null,
    episodes: typeof media.episodes === 'number' && media.episodes > 0 ? media.episodes : null,
    score: typeof media.averageScore === 'number' ? media.averageScore / 10 : null,
    genres: (media.genres ?? []).map((name) => ({ name })),
  };
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

/**
 * A breaker for the whole Jikan host, persisted across reloads.
 *
 * The per-path breaker above only helps the second request for the SAME path,
 * so while Jikan was down every new title paid the full timeout again, and the
 * memory-only breaker reset on every app start. A timeout or network failure
 * means the host itself is unreachable: skip all of Jikan for ten minutes, and
 * remember that across a reload so a dead Jikan costs one wait, not one per
 * page. A 404 or 429 is an answer from a live host and does not trip it.
 */
const JIKAN_HOST_KEY = 'anime:jikan_host_down_until';
const JIKAN_HOST_BREAKER_MS = 10 * 60 * 1000;
let jikanHostDownUntil = 0;
let jikanHostChecked = false;

async function jikanHostAvailable(): Promise<boolean> {
  if (Date.now() < jikanHostDownUntil) return false;
  if (!jikanHostChecked) {
    jikanHostChecked = true;
    const persisted = await getCachedValue<number>(JIKAN_HOST_KEY).catch(() => null);
    if (typeof persisted === 'number' && persisted > Date.now()) jikanHostDownUntil = persisted;
  }
  return Date.now() >= jikanHostDownUntil;
}

function markJikanHostDown(): void {
  jikanHostDownUntil = Date.now() + JIKAN_HOST_BREAKER_MS;
  void setCachedValue(JIKAN_HOST_KEY, jikanHostDownUntil, JIKAN_HOST_BREAKER_MS).catch(() => undefined);
}

async function jikanRequest(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (breakerOpen(path)) throw new Error(`Jikan unavailable: ${path}`);

  for (let attempt = 0; attempt < JIKAN_MAX_ATTEMPTS; attempt += 1) {
    const gap = JIKAN_MIN_GAP_MS - (Date.now() - jikanLastAt);
    if (gap > 0) await delay(gap);
    jikanLastAt = Date.now();

    if (signal.aborted) throw new Error('Anime request timed out.');
    let res: Response;
    try {
      res = await fetch(`${JIKAN_API}${path}`, { signal });
    } catch (error) {
      // No HTTP answer at all: DNS, refused connection or abort. The host is down.
      markJikanHostDown();
      throw error;
    }

    // Retry rate limits AND upstream 5xx. Jikan is a free community API that
    // 504s regularly under its own load — the /episodes and search endpoints
    // were doing so consistently while direct id lookups were fine. Retrying
    // only 429 meant a transient gateway timeout surfaced to the caller as a
    // hard failure, which the anime screen reports as "Could not load anime".
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      if (attempt + 1 < JIKAN_MAX_ATTEMPTS) {
        await delay(Math.min(2000, retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1)));
      }
      continue;
    }
    if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
    return res.json();
  }
  // Every attempt failed — stop asking this endpoint for a while.
  jikanBreaker.set(path, Date.now() + JIKAN_BREAKER_MS);
  throw new Error(`Jikan unavailable: ${path}`);
}

async function jikanGet(path: string, timeoutMs = 4000): Promise<Record<string, unknown>> {
  if (!(await jikanHostAvailable())) throw new Error('Jikan is unreachable; using fallbacks.');
  // Deliberately NOT serialised through a shared chain.
  //
  // An earlier version queued every Jikan request behind a single promise to
  // avoid bursting past the rate limit. That created head-of-line blocking: a
  // persistently dead endpoint (/episodes has 504'd for hours) took ~6s to
  // exhaust its retries, and every other Jikan call in the app — including the
  // ones needed to start playback — waited behind it. Episodes appeared but
  // never played.
  //
  // Burst protection now comes from the per-path circuit breaker plus the gap
  // inside jikanRequest, neither of which can stall an unrelated request.
  let timedOut = false;
  try {
    return await withAnimeTimeout((signal) => {
      signal.addEventListener('abort', () => { timedOut = true; }, { once: true });
      return jikanRequest(path, signal);
    }, timeoutMs);
  } catch (error) {
    // A request that outlived its budget means the host is not answering.
    if (timedOut) markJikanHostDown();
    jikanBreaker.set(path, Date.now() + JIKAN_BREAKER_MS);
    throw error;
  }
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
    const d = await jikanGet(`/anime/${id}/full`, 2500);
    const data = (d.data as JikanFull) || null;
    if (data) return data;
  } catch {
    // fall through to the offline index
  }
  return offlineMetaFull(id);
}

type FallbackMeta = { source: 'jikan' | 'index'; jikan: JikanFull };

/**
 * Jikan and the offline index raced, first usable answer wins. They used to
 * run one after the other, so a dead Jikan cost its whole timeout before the
 * index (which always answers) was even asked.
 */
async function loadFallbackMeta(id: string): Promise<FallbackMeta | null> {
  const jikan = jikanGet(`/anime/${id}/full`, 2500)
    .then((d) => (d.data as JikanFull) || null)
    .then((data): FallbackMeta | null => (data ? { source: 'jikan', jikan: data } : null))
    .catch(() => null);
  const index = offlineMetaFull(id)
    .then((data): FallbackMeta | null => (data ? { source: 'index', jikan: data } : null));
  return firstUsable([jikan, index]);
}

/** Resolves with the first non-null value, or null once every promise has settled empty. */
function firstUsable<T>(promises: Array<Promise<T | null>>): Promise<T | null> {
  return new Promise((resolve) => {
    let remaining = promises.length;
    if (!remaining) resolve(null);
    for (const promise of promises) {
      promise.then(
        (value) => { if (value !== null && value !== undefined) resolve(value); else if (--remaining === 0) resolve(null); },
        () => { if (--remaining === 0) resolve(null); },
      );
    }
  });
}

type TitleMeta = { source: 'anilist'; media: AniListTitleMedia } | FallbackMeta;

/**
 * AniList first, with a hedge. AniList gets a short head start; if it has not
 * answered by then (or has already failed), the fallbacks start alongside it
 * and whichever usable answer arrives first is used. A slow AniList that wins
 * late still lands in the cache so the next visit gets the full record.
 */
async function loadTitleMeta(id: string, force: boolean, onLateAniList: (media: AniListTitleMedia) => void): Promise<TitleMeta | null> {
  const anilist = fetchAniListTitle(id, force);
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  const hedge = new Promise<'hedge'>((resolve) => { hedgeTimer = setTimeout(() => resolve('hedge'), AL_TITLE_HEDGE_MS); });
  const early = await Promise.race([anilist, hedge]);
  clearTimeout(hedgeTimer);
  if (early && early !== 'hedge') return { source: 'anilist', media: early };
  const fromAniList = anilist.then((media): TitleMeta | null => (media ? { source: 'anilist', media } : null));
  const winner = await firstUsable<TitleMeta>([fromAniList, loadFallbackMeta(id)]);
  if (winner && winner.source !== 'anilist') {
    void anilist.then((media) => { if (media) onLateAniList(media); });
  }
  return winner;
}

/**
 * Anime metadata from our own offline index, for when Jikan will not answer.
 *
 * Jikan is fetched directly, with no proxy in between, and a failure here used
 * to return null — which fetchAnimeInfo turns into "Could not load anime — No
 * data returned for this title" on a show that is perfectly available. It fails
 * PER ID rather than wholesale: on 2026-08-22, MAL 38883 (Haikyuu!! To the Top,
 * finished, 13 episodes, and playable) returned 504 on every attempt while MAL
 * 60636 returned 200 in the same second. A retry does not help, and neither
 * does a health check.
 *
 * The droplet serves the same 30,561 shows from a file built out of
 * anime-offline-database, so this fallback cannot itself go down. It carries no
 * synopsis — the dump has none — so the description stays empty rather than
 * being invented, and everything else the detail page needs is present.
 */
async function offlineMetaFull(id: string): Promise<JikanFull | null> {
  try {
    const m = await consuGet(`/api/meta/${encodeURIComponent(id)}`, 6000, 0);
    if (!m || typeof m !== 'object' || !m.malId) return null;
    const image = String(m.image || '');
    return {
      mal_id: Number(m.malId),
      title: String(m.title || ''),
      title_english: String(m.title || ''),
      synopsis: '',
      status: String(m.status || '') === 'UPCOMING' ? 'Not yet aired' : String(m.status || ''),
      type: String(m.type || 'TV'),
      year: (m.year as number) ?? undefined,
      // The dump carries this and dropping it was silently fatal.
      //
      // This whole function exists because Jikan fails; it 504s for individual
      // titles while serving others fine — Haikyuu!! Second Season (MAL 28891)
      // 504s on both `/anime/28891` and `/anime/28891/episodes` while Attack on
      // Titan answers immediately, and the comment in `jikanGet` records
      // `/episodes` having 504'd for hours. So this is the normal path for an
      // unlucky title, not an edge case.
      //
      // Without `episodes`, `estimateJikanEpisodeCount` finds nothing here, asks
      // the same dead Jikan endpoint, and returns 0. Zero expected episodes means
      // no fallback list is built, and the detail page renders "0 eps" and
      // "No streaming source found" for a title this very response says has 25.
      // The fallback that exists to survive an outage was dropping the one field
      // that decides whether the page works.
      episodes: typeof m.episodes === 'number' && m.episodes > 0 ? m.episodes : undefined,
      // Rounded. The dump stores a raw arithmetic mean, and passing it straight
      // through rendered "8.370108431251289 /10" on the detail page.
      score: typeof m.score === 'number' ? Math.round(m.score * 100) / 100 : null,
      images: { webp: { large_image_url: image, image_url: image } },
      genres: Array.isArray(m.genres)
        ? (m.genres as string[]).map((name) => ({ name: String(name) }))
        : [],
    } as unknown as JikanFull;
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

async function findSourceMatch(jikan: JikanFull): Promise<{ slug: string; animeId: string } | null> {
  return withAnimeTimeout((signal) => findSourceMatchWithinBudget(jikan, signal), 8000);
}

async function findSourceMatchWithinBudget(
  jikan: JikanFull,
  signal: AbortSignal,
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
    if (signal.aborted) return null;
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
    if (signal.aborted) return null;
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

  if (signal.aborted || validated.length === 0) return null;

  validated.sort((a, b) => b.score - a.score);
  const best = validated[0];
  registerStreamingSource(best.slug, best.animeId, String(jikan.mal_id));
  return { slug: best.slug, animeId: best.animeId };
}

// ─── Public exports ───────────────────────────────────────────────────────────
/**
 * Every catalog list goes through here: cached lists get small poster URLs
 * (see cardCoverUrl) and each card is remembered so its detail page can draw
 * the hero immediately.
 */
function catalogResults(results: AnimeResult[]): AnimeResult[] {
  const cards = cardResults(results);
  rememberAnimePreviews(cards);
  return cards;
}

/**
 * `throwIfAllFailed`: by default every source failing resolves [] — the anime
 * tab's shelves treat an empty shelf as "nothing to show" and must not reject.
 * Search opts in, because there an outage and "no matches" need different
 * words: it shows "Anime didn't respond" with Try again instead of an empty
 * section that looks like a real answer.
 */
async function cachedCatalog(
  key: string,
  ttl: number,
  sources: Array<() => Promise<AnimeResult[]>>,
  { throwIfAllFailed = false }: { throwIfAllFailed?: boolean } = {},
): Promise<AnimeResult[]> {
  const diskKey = `anime:${key}`;
  const cached = cGet<AnimeResult[]>(key);
  if (cached) return catalogResults(cached);
  const diskCached = await getCachedValue<AnimeResult[]>(diskKey);
  if (diskCached) {
    const cards = catalogResults(diskCached);
    cSet(key, cards, ttl);
    return cards;
  }
  let failures = 0;
  let lastError: unknown = null;
  for (const source of sources) {
    try {
      const results = await source();
      if (results.length > 0) {
        const cards = catalogResults(results);
        cSet(key, cards, ttl);
        await setCachedValue(diskKey, cards, ttl);
        return cards;
      }
    } catch (error) {
      // try the next source
      failures += 1;
      lastError = error;
    }
  }
  if (throwIfAllFailed && sources.length > 0 && failures === sources.length) {
    throw lastError instanceof Error ? lastError : new Error('Anime search is unavailable right now.');
  }
  return [];
}

export async function searchAnime(query: string): Promise<AnimeResult[]> {
  return cachedCatalog(`search_${query.toLowerCase().trim()}`, 30 * 60_000, [
    () => alSearch(query),
    () => jikanSearch(query),
  ], { throwIfAllFailed: true });
}

export async function fetchAiringAnime(): Promise<AnimeResult[]> {
  return cachedCatalog('trending', 2 * 3_600_000, [alTrending, jikanTrending]);
}

export async function fetchPopularAnime(): Promise<AnimeResult[]> {
  return cachedCatalog('popular', 2 * 3_600_000, [alPopular, jikanPopular]);
}

export async function fetchAnimeByGenre(genreId: number): Promise<AnimeResult[]> {
  const genreName = ANIME_GENRES.find((g) => g.id === genreId)?.name;
  return cachedCatalog(`genre_${genreId}`, 30 * 60_000, [
    ...(genreName ? [() => alByGenre(genreName)] : []),
    () => jikanByGenre(genreId),
  ]);
}

function hasPlaceholderEpisodes(info: AnimeInfo): boolean {
  return info.episodes.some((e) => e.id.startsWith('hi-0-'));
}

function hasPlayableEpisodes(info: AnimeInfo): boolean {
  return info.episodes.some((e) => /^(?:hi|mal)-\d+-\d+$/.test(e.id));
}

function hasSuspiciousEpisodeCount(info: AnimeInfo): boolean {
  const title = normTitle(info.title);
  return title === 'one piece' && info.episodes.length < 100;
}

type AiredEpisodeBound = { count: number; nextAiringAt: number };

async function applyAiredEpisodeBound(info: AnimeInfo): Promise<AnimeInfo> {
  // Provider episode lists and completed shows already have their own counts.
  // Only metadata-generated MAL lists can contain a season's planned total.
  if (/^(?:finished airing|finished)$/i.test(info.status?.trim() || '')
    || !/^[1-9]\d*$/.test(info.id) || !info.episodes.length
    || !info.episodes.every((episode) => Number.isSafeInteger(episode.number) && episode.number > 0
      && episode.id === `mal-${info.id}-${episode.number}`)) return info;

  const key = `aired_bound_${info.id}`;
  let bound = cGet<AiredEpisodeBound>(key);
  if (bound && bound.nextAiringAt <= Date.now()) bound = null;
  if (!bound) {
    try {
      const json = await runAL(`{
        Media(idMal: ${Number(info.id)}, type: ANIME) {
          idMal status nextAiringEpisode { episode airingAt }
        }
      }`, 2500) as { data?: { Media?: {
        idMal?: number; status?: string;
        nextAiringEpisode?: { episode?: number; airingAt?: number };
      } } };
      const media = json?.data?.Media;
      const next = media?.nextAiringEpisode;
      const nextEpisode = next?.episode;
      const nextAiringSeconds = next?.airingAt;
      const nextAiringAt = typeof nextAiringSeconds === 'number' && Number.isSafeInteger(nextAiringSeconds)
        ? nextAiringSeconds * 1000 : 0;
      if (media?.idMal !== Number(info.id) || media.status !== 'RELEASING'
        || !Number.isSafeInteger(nextEpisode) || Number(nextEpisode) < 1 || Number(nextEpisode) > 50_001
        || !Number.isSafeInteger(nextAiringAt) || nextAiringAt <= Date.now()) return info;
      bound = { count: Number(nextEpisode) - 1, nextAiringAt };
      cSet(key, bound, Math.min(5 * 60_000, nextAiringAt - Date.now()));
    } catch {
      // Metadata outages or missing schedules must never hide playable episodes.
      return info;
    }
  }
  // Keep the original list in both content caches. Once the schedule expires,
  // a newly aired episode must be able to return without rebuilding that list.
  const episodes = info.episodes.filter((episode) => episode.number <= bound.count);
  return { ...info, status: 'Currently Airing', episodes,
    ...(episodes.length ? {} : { episodeLoadError: 'The first episode has not aired yet.' }) };
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
  // Provider matching needs title variants. AniList has them (and is shared
  // with the title page through the in-flight request); Jikan is the fallback.
  const media = await fetchAniListTitle(malId);
  const jikan = media ? jikanFromAniList(malId, media) : await jikanFull(malId);
  if (!jikan) return null;
  return findSourceMatch(jikan);
}

const INFO_PREFIX = 'info3_';
const FALLBACK_INFO_TTL = 30 * 60_000;
const FINISHED_INFO_TTL = 24 * 3_600_000;
const AIRING_INFO_TTL = 6 * 3_600_000;
const _infoRequests = new Map<string, Promise<AnimeInfo | null>>();

const isFinishedStatus = (status?: string) => /^(?:finished airing|finished)$/i.test(status?.trim() || '');

/**
 * How long a title record may be reused. AniList records last until the next
 * broadcast (so a newly aired episode appears), or a day once the show has
 * finished. Fallback records — no synopsis, romaji title, tag-dump genres —
 * last 30 minutes, so an AniList outage cannot pin a degraded page for 24 h.
 */
export function animeInfoTtl(info: AnimeInfo, now = Date.now()): number {
  if (info.metaSource !== 'anilist') return FALLBACK_INFO_TTL;
  const next = info.nextAiringEpisode?.airingAt;
  if (next) return Math.min(AIRING_INFO_TTL, Math.max(2 * 60_000, next - now));
  return isFinishedStatus(info.status) ? FINISHED_INFO_TTL : AIRING_INFO_TTL;
}

function usableCachedInfo(info: AnimeInfo | null): info is AnimeInfo {
  if (!info || !Array.isArray(info.episodes)) return false;
  // The record predates a broadcast that has since happened: rebuild it.
  if (info.metaSource === 'anilist' && info.nextAiringEpisode && info.nextAiringEpisode.airingAt <= Date.now()) return false;
  if (info.metaSource === 'anilist' && !info.episodes.length && info.episodeLoadError) return true;
  return hasPlayableEpisodes(info) && !hasPlaceholderEpisodes(info) && !hasSuspiciousEpisodeCount(info);
}

async function storeInfo(info: AnimeInfo): Promise<void> {
  const ttl = animeInfoTtl(info);
  const key = `${INFO_PREFIX}${info.id}`;
  // A late AniList answer may already have upgraded this title; never downgrade it.
  if (info.metaSource !== 'anilist' && cGet<AnimeInfo>(key)?.metaSource === 'anilist') return;
  cSet(key, info, ttl);
  await setCachedValue(`anime:${key}`, info, ttl);
}

export type FetchAnimeInfoOptions = {
  force?: boolean;
  /**
   * Called once with the title's metadata when the episode list still needs a
   * slow provider lookup, so the page can draw the hero and synopsis first.
   */
  onMetadata?: (info: AnimeInfo) => void;
};

export async function fetchAnimeInfo(
  id: string,
  opts?: FetchAnimeInfoOptions,
): Promise<AnimeInfo | null> {
  // Sakura Originals are served locally — no network fetch needed
  const { fetchSakuraOriginalInfo, isSakuraOriginal } = await import('./sakura-originals');
  if (isSakuraOriginal(id)) return fetchSakuraOriginalInfo(id, opts);

  // The detail page and a quick tap on Play ask for the same title; share one load.
  if (!opts?.force) {
    const pending = _infoRequests.get(id);
    if (pending) return pending;
  }
  const request = loadAnimeInfo(id, opts);
  if (!opts?.force) {
    _infoRequests.set(id, request);
    const clear = () => { if (_infoRequests.get(id) === request) _infoRequests.delete(id); };
    request.then(clear, clear);
  }
  return request;
}

async function loadAnimeInfo(id: string, opts?: FetchAnimeInfoOptions): Promise<AnimeInfo | null> {
  const key = `${INFO_PREFIX}${id}`;
  const diskKey = `anime:${key}`;

  if (opts?.force) {
    cDelete(key);
    cDelete(`srcmap_${id}`);
    cDelete(`srcslug_${id}`);
    cDelete(`aired_bound_${id}`);
  } else {
    const cached = cGet<AnimeInfo>(key);
    if (usableCachedInfo(cached)) {
      hydrateStreamingFromInfo(cached, id);
      return cached.metaSource === 'anilist' ? cached : applyAiredEpisodeBound(cached);
    }
    const diskCached = await getCachedValue<AnimeInfo>(diskKey);
    if (usableCachedInfo(diskCached)) {
      cSet(key, diskCached, animeInfoTtl(diskCached));
      await hydrateStreamingFromDisk(diskCached, id);
      return diskCached.metaSource === 'anilist' ? diskCached : applyAiredEpisodeBound(diskCached);
    }
  }

  const meta = await loadTitleMeta(id, !!opts?.force, (media) => {
    // AniList answered after a fallback won the race. Keep its record for the
    // next visit when it is complete on its own (no provider lookup needed).
    const late = animeInfoFromAniList(id, media);
    if (late.airedCount !== null) void storeInfo(late.info).catch(() => undefined);
  });
  if (!meta) return null;

  if (meta.source === 'anilist') {
    const { info, airedCount } = animeInfoFromAniList(id, meta.media);
    rememberAnimePreviews([{ id, title: info.title, image: info.image, type: info.type, score: info.score, year: info.year }]);
    if (airedCount === null) {
      // Airing with no published schedule, or on hiatus: only the provider knows
      // how many episodes exist. Show everything else while it is asked.
      opts?.onMetadata?.({ ...info, episodes: [] });
      const jikanLike = jikanFromAniList(id, meta.media);
      let episodes = await providerEpisodes(id, jikanLike, info);
      if (!episodes.length) {
        const fallbackCount = await estimateJikanEpisodeCount(jikanLike);
        if (fallbackCount > 0) episodes = makeMalEpisodes(id, fallbackCount);
      }
      info.episodes = withStreamingDetails(episodes, meta.media, episodes.length);
      if (!info.episodes.length) {
        info.episodeLoadError = getActiveConsumetUrl()
          ? 'Streaming source unavailable for this title.'
          : 'Streaming server is not configured.';
        return info;
      }
    }
    hydrateStreamingFromInfo(info, id);
    if (info.episodes.length > 0 || info.episodeLoadError) await storeInfo(info);
    return info;
  }

  return infoFromFallback(id, meta.jikan, meta.source, opts);
}

/** The previous Jikan-shaped path, used only when AniList could not answer. */
async function infoFromFallback(
  id: string,
  jikan: JikanFull,
  source: 'jikan' | 'index',
  opts?: FetchAnimeInfoOptions,
): Promise<AnimeInfo | null> {
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
    metaSource: source,
  };

  // Metadata already gives an exact episode count for completed shows. Render
  // those MAL-addressed episodes immediately; provider matching belongs to the
  // play action.
  if (jikan.episodes && jikan.episodes > 0 && isFinishedStatus(jikan.status)) {
    info.episodes = makeMalEpisodes(id, jikan.episodes);
    hydrateStreamingFromInfo(info, id);
    await storeInfo(info);
    return info;
  }

  opts?.onMetadata?.({ ...info, episodes: [] });
  info.episodes = await providerEpisodes(id, jikan, info);

  if (info.episodes.length === 0) {
    const fallbackCount = await estimateJikanEpisodeCount(jikan);
    if (fallbackCount > 0) info.episodes = makeMalEpisodes(id, fallbackCount);
  }

  if (info.episodes.length === 0) {
    info.episodeLoadError = getActiveConsumetUrl()
      ? 'Streaming source unavailable for this title.'
      : 'Streaming server is not configured.';
  }

  if (info.episodes.length > 0) await storeInfo(info);

  return applyAiredEpisodeBound(info);
}

/** Provider (HiAnime) episode list for a title whose aired count is not known. */
async function providerEpisodes(id: string, jikan: JikanFull, info: AnimeInfo): Promise<AnimeEpisode[]> {
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
      if (eps.length > 0) cSet(`episodes_${srcmap.animeId}`, eps, 6 * 3_600_000);
      return eps;
    }
  } catch (e) {
    console.warn('[anime] source match failed:', e);
  }
  return [];
}

// ─── Stream prewarming ───────────────────────────────────────────────────────
/**
 * Start resolving an episode's stream before the viewer presses play: from
 * the detail page (hover, focus, or the main button settling into view) and
 * near the end of the current episode for the next one. The watch page's own
 * request then takes the finished answer instead of starting from zero.
 * Native resolves through the provider at play time and ignores this.
 */
export function prewarmEpisodeStream(
  episodeId: string,
  category: 'sub' | 'dub',
  malId?: string,
): void {
  if (!usesBrowserAnimeStream) return;
  const malParts = episodeId.match(/^mal-(\d+)-(\d+)$/);
  const hiParts = episodeId.match(/^hi-(\d+)-(\d+)$/);
  const streamMalId = malParts?.[1] || (hiParts && malId && /^[1-9]\d*$/.test(malId) ? malId : undefined);
  const episode = Number(malParts?.[2] || hiParts?.[2]);
  if (!streamMalId || !Number.isSafeInteger(episode) || episode < 1) return;
  prewarmBrowserAnimeStream({ malId: streamMalId, episode, category });
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
    12_000,
    0,
  );

  const sources = Array.isArray(d.sources) ? d.sources as Record<string, unknown>[] : [];
  const suppliedEmbed = typeof d.embedUrl === 'string' && /^https:\/\//.test(d.embedUrl) ? d.embedUrl : '';
  if (!sources.length && !suppliedEmbed) return null;

  const headers = d.headers as Record<string, string> | undefined;
  const intro = d.intro as { start: number; end: number } | null;
  const outro = d.outro as { start: number; end: number } | null;

  const preferred =
    sources.find((s) => String(s.quality || '') === 'auto') ||
    sources.find((s) => String(s.quality || '') === '1080p') ||
    sources[0];

  const url = String(preferred?.url || '');
  if (!url && !suppliedEmbed) return null;

  const referer = headers?.Referer || headers?.referer || '';
  const embedUrl = suppliedEmbed || buildStreamEmbedUrl(malId || '0', epNum, category, referer, slug);

  const requestHeaders: Record<string, string> = {};
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string' && v.trim()) requestHeaders[k] = v;
    }
  }

  return {
    url,
    isM3U8: !!url && preferred?.isM3U8 !== false,
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

  const parts = episodeId.match(/^hi-(\d+)-(\d+)$/);
  const malParts = episodeId.match(/^mal-(\d+)-(\d+)$/);
  const streamMalId = malParts?.[1] || (parts && malId && /^[1-9]\d*$/.test(malId) ? malId : undefined);
  const streamEpisode = Number(malParts?.[2] || parts?.[2]);
  let browserFallback: StreamingSource | null = null;
  if (usesBrowserAnimeStream && streamMalId && Number.isSafeInteger(streamEpisode) && streamEpisode > 0) {
    const browserSource = await fetchBrowserAnimeStream({
      malId: streamMalId, episode: streamEpisode, category, force: opts?.force,
    });
    const embedUrl = buildStreamEmbedUrl(streamMalId, String(streamEpisode), category);
    if (browserSource?.unavailableCategory) return browserSource;
    if (browserSource) return { ...browserSource, embedUrl: browserSource.embedUrl || embedUrl };
    browserFallback = { url: '', isM3U8: false, embedUrl, category, availableCategories: [category] };
  }

  // The browser resolver does not depend on the legacy Consumet server being set.
  if (!getActiveConsumetUrl() && consumetCandidates().length === 0) return browserFallback;

  if (!parts) {
    if (malParts) {
      const [, directMalId, directEpNum] = malParts;
      const categories: Array<'sub' | 'dub'> = category === 'dub' ? ['dub', 'sub'] : ['sub', 'dub'];

      const direct = await fetchDirectMalSource(directMalId, directEpNum, category).catch(() => null);
      if (direct?.url || direct?.embedUrl) return direct;

      const resolved = await resolveStreamingByMalId(directMalId).catch(() => null);
      if (resolved?.slug) {
        for (const cat of categories) {
          try {
            const src = await fetchM3u8Source(resolved.slug, directEpNum, cat, directMalId);
            if (src?.url || src?.embedUrl) return src;
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
    return browserFallback;
  }

  const [, animeId, epNum] = parts;
  if (animeId === '0') return browserFallback;

  let slug = await resolveSlugForPlayback(animeId, malId);
  if (!slug && malId) {
    const resolved = await resolveStreamingByMalId(malId).catch((error: unknown) => {
      if (!usesBrowserAnimeStream) throw error;
      return null;
    });
    if (resolved) slug = resolved.slug;
  }
  if (!slug) {
    console.warn(`[anime] fetchEpisodeSources: no slug for animeId=${animeId}.`);
    return browserFallback;
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

  return browserFallback;
}
