import { fetchJikanSearch, fetchJikanTrending, fetchJikanPopular, fetchJikanInfo, fetchJikanByGenre, ANIME_GENRES, type JikanAnime } from "./jikan";
export { ANIME_GENRES } from "./jikan";
import { alPopular, type SimpleAnime } from "./anilist";
import {
    searchAnimeSource,
    getAnimeSourceEpisodes,
    getStreamingSources,
    getAnimeInfo,
    setSlugForAnimeId,
    isConfigured as isSourceConfigured,
    getLastConsumetError,
    getLastConsumetErrorDetails,
    fetchHiAnimeTrending,
} from "./sources/gogoanime";
import { PSYOP_SEARCH_RESULT, PSYOP_INFO, PSYOP_ID, matchesPsyopQuery, isPsyopEpisode, getPsyopStreamUrl } from "./psyopAnime";
import {
    TWO_HE_ANIME_ID,
    TWO_HE_ANIME_INFO,
    TWO_HE_ANIME_SEARCH_RESULT,
    getTwoHeAnimeStreamUrl,
    isTwoHeAnimeEpisode,
    matchesTwoHeAnimeQuery,
} from "./2heAnime";

function simpleAnimeToResult(a: SimpleAnime): AnimeResult {
    return {
        id: String(a.mal_id),
        title: a.title,
        image: a.image,
        type: a.type,
        score: a.score,
        year: a.year,
        releaseDate: a.year != null ? String(a.year) : undefined,
    };
}

export interface AnimeResult {
    id: string;
    title: string;
    image?: string;
    type?: string;
    releaseDate?: string;
    score?: number | null;
    year?: number | null;
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
    episodeLoadError?: string | null;
}

/** Bridge may omit isM3U8 for master URLs without ".m3u8" in the path (common on uwucdn / vault hosts). */
function inferStreamingIsM3U8(url: string, fromBridge: boolean | undefined): boolean {
    if (/\.mp4(\?|$)/i.test(url)) return false;
    if (fromBridge === true) return true;
    if (/\.m3u8(\?|$)/i.test(url)) return true;
    if (/uwucdn|vault-\d|rapid-cloud|rabbitstream|biananset|megacloud\.tv/i.test(url)) return true;
    return false;
}

export interface StreamingSource {
    url: string;
    isM3U8: boolean;
    referer?: string;
    tracks?: { file: string; label?: string; kind?: string }[];
    intro?: { start: number; end: number };
    outro?: { start: number; end: number };
    category?: string;
    availableCategories?: string[];
}

interface SourceMapping {
    slug: string;
    animeId: string;
    matchedTitle: string;
    score: number;
    query: string;
}

interface SourceCandidate {
    slug: string;
    animeId: string;
    title: string;
    query: string;
    queryIndex: number;
    score: number;
}

interface ResolvedSourceMatch {
    slug: string;
    animeId: string;
    matchedTitle: string;
    score: number;
    query: string;
    cacheHit: boolean;
    episodes?: AnimeInfo["episodes"];
}

interface AnimeInfoRefreshOptions {
    forceSourceRefresh?: boolean;
}

interface TitleSignals {
    season?: number;
    part?: number;
    cour?: number;
    movie: boolean;
    ova: boolean;
    ona: boolean;
    special: boolean;
}

const CACHE_PREFIX = "sakura_anime_v9_";
const TTL_SEARCH = 30 * 60 * 1000;
const TTL_TRENDING = 2 * 60 * 60 * 1000;
const TTL_INFO = 24 * 60 * 60 * 1000;
const TTL_EPISODES = 6 * 60 * 60 * 1000;
const TTL_SOURCE_MAP = 48 * 60 * 60 * 1000;
const MIN_CANDIDATE_SCORE = 25;
const MAX_RANKED_CANDIDATES = 5;
const STOP_WORDS = new Set([
    "the",
    "a",
    "an",
    "of",
    "to",
    "and",
    "or",
    "no",
    "wa",
    "ga",
    "tv",
]);

let _lastDiag = "";

function cacheGet<T>(key: string): T | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = localStorage.getItem(CACHE_PREFIX + key);
        if (!raw) return null;
        const { data, exp } = JSON.parse(raw);
        if (Date.now() > exp) {
            localStorage.removeItem(CACHE_PREFIX + key);
            return null;
        }
        return data as T;
    } catch {
        return null;
    }
}

function cacheSet<T>(key: string, data: T, ttl: number): void {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data, exp: Date.now() + ttl }));
    } catch {
        // Ignore quota failures for local caches.
    }
}

function cacheRemove(key: string): void {
    if (typeof window === "undefined") return;
    try {
        localStorage.removeItem(CACHE_PREFIX + key);
    } catch {
        // Ignore removal failures.
    }
}

function normalizeTitle(value: string | null | undefined): string {
    if (!value) return "";
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[’'`"]/g, "")
        .replace(/[:;,.!?()[\]{}]/g, " ")
        .replace(/\bvs\b/g, " ")
        .replace(/-/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenizeTitle(value: string | null | undefined): string[] {
    return normalizeTitle(value)
        .split(" ")
        .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function toOrdinalNumber(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const lower = value.toLowerCase();
    if (lower === "first") return 1;
    if (lower === "second") return 2;
    if (lower === "third") return 3;
    if (lower === "fourth") return 4;
    if (lower === "fifth") return 5;
    const parsed = parseInt(lower, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function extractTitleSignals(value: string | null | undefined): TitleSignals {
    const title = normalizeTitle(value);
    const seasonMatch = title.match(/\b(?:(\d+)(?:st|nd|rd|th)?|(first|second|third|fourth|fifth)) season\b/);
    const partMatch = title.match(/\bpart\s*(\d+)\b/);
    const courMatch = title.match(/\b(\d+)(?:st|nd|rd|th)? cour\b|\bcour\s*(\d+)\b/);
    return {
        season: toOrdinalNumber(seasonMatch?.[1] || seasonMatch?.[2]),
        part: partMatch ? parseInt(partMatch[1], 10) : undefined,
        cour: courMatch ? parseInt(courMatch[1] || courMatch[2], 10) : undefined,
        movie: /\bmovie\b|\bfilm\b/.test(title),
        ova: /\bova\b/.test(title),
        ona: /\bona\b/.test(title),
        special: /\bspecials?\b/.test(title),
    };
}

function tokenOverlapScore(expectedTokens: string[], candidateTokens: string[]): number {
    if (expectedTokens.length === 0 || candidateTokens.length === 0) return 0;
    const candidateSet = new Set(candidateTokens);
    const overlap = expectedTokens.filter((token) => candidateSet.has(token)).length;
    return overlap / Math.max(expectedTokens.length, candidateTokens.length);
}

function getDistinctiveTokens(jikanData: JikanAnime): string[] {
    const variants = getSourceTitleVariants(jikanData);
    const unique = new Set<string>();
    for (const variant of variants) {
        for (const token of tokenizeTitle(variant)) {
            if (token.length >= 4) unique.add(token);
        }
    }
    return [...unique];
}

/** Jikan often sets title_english to "Season 4" / "Part 2" only — useless for HiAnime search and bad as the main UI title. */
function isWeakSeasonStyleTitle(s: string | null | undefined): boolean {
    if (!s) return false;
    const t = s.trim();
    if (t.length < 2) return true;
    if (/^season\s*\d+$/i.test(t)) return true;
    if (/^part\s*\d+$/i.test(t)) return true;
    if (/^cour\s*\d+$/i.test(t)) return true;
    return false;
}

/** Prefer Japanese/main title for display when English is only a season/part label. */
function pickDisplayTitle(jikanData: Pick<JikanAnime, "title" | "title_english">): string {
    const jp = jikanData.title?.trim() || "";
    const en = jikanData.title_english?.trim();
    if (!en) return jp;
    if (isWeakSeasonStyleTitle(en)) return jp || en;
    return en;
}

/** Order matters: HiAnime search runs main `title` first (romaji), not a useless "Season 4". */
function getSourceTitleVariants(jikanData: JikanAnime): string[] {
    const out: string[] = [];
    const add = (raw: string | null | undefined) => {
        const t = raw?.trim();
        if (t && !out.includes(t)) out.push(t);
    };
    add(jikanData.title);
    add(jikanData.title_japanese);
    if (!isWeakSeasonStyleTitle(jikanData.title_english)) {
        add(jikanData.title_english);
    }
    for (const s of jikanData.title_synonyms || []) add(s);
    if (isWeakSeasonStyleTitle(jikanData.title_english)) {
        add(jikanData.title_english);
    }
    return out;
}

function buildTitleFallbacks(title: string): string[] {
    const variants = new Set<string>();
    const trimmed = title.trim();
    if (!trimmed) return [];

    variants.add(trimmed);
    variants.add(trimmed.replace(/\s*\((tv|ova|ona|movie)\)\s*/gi, " ").replace(/\s+/g, " ").trim());
    variants.add(trimmed.replace(/\s*:\s*[^:]+$/, "").trim());
    variants.add(trimmed.replace(/\s+\d+(?:st|nd|rd|th)\s+season\b/gi, "").trim());
    variants.add(trimmed.replace(/\s+season\s*\d+\b/gi, "").trim());
    variants.add(trimmed.replace(/\s+part\s*\d+\b/gi, "").trim());
    variants.add(trimmed.replace(/\s+\d+(?:st|nd|rd|th)\s+cour\b/gi, "").trim());
    variants.add(trimmed.replace(/\s+cour\s*\d+\b/gi, "").trim());

    return [...variants].filter((value) => value && value.length > 1);
}

function buildSourceQueries(jikanData: JikanAnime): string[] {
    const queries: string[] = [];
    const seen = new Set<string>();
    for (const title of getSourceTitleVariants(jikanData)) {
        for (const variant of buildTitleFallbacks(title)) {
            const k = variant.trim().toLowerCase();
            if (!k || seen.has(k)) continue;
            seen.add(k);
            queries.push(variant);
        }
    }
    return queries;
}

function scoreCandidate(jikanData: JikanAnime, candidateTitle: string, queryIndex: number): number {
    const normalizedCandidate = normalizeTitle(candidateTitle);
    const candidateTokens = tokenizeTitle(candidateTitle);
    const candidateSignals = extractTitleSignals(candidateTitle);
    const expectedSignals = getSourceTitleVariants(jikanData).map(extractTitleSignals);
    const expectedType = normalizeTitle(jikanData.type);
    const distinctiveTokens = getDistinctiveTokens(jikanData);

    let bestTitleScore = -100;
    for (const title of getSourceTitleVariants(jikanData)) {
        const normalizedExpected = normalizeTitle(title);
        const expectedTokens = tokenizeTitle(title);
        let score = 0;

        if (normalizedCandidate === normalizedExpected) {
            score += 240;
        } else if (normalizedCandidate.startsWith(normalizedExpected) || normalizedExpected.startsWith(normalizedCandidate)) {
            score += 150;
        } else if (normalizedCandidate.includes(normalizedExpected) || normalizedExpected.includes(normalizedCandidate)) {
            score += 90;
        }

        score += Math.round(tokenOverlapScore(expectedTokens, candidateTokens) * 140);
        bestTitleScore = Math.max(bestTitleScore, score);
    }

    let score = bestTitleScore - queryIndex * 6;

    if (distinctiveTokens.length > 0) {
        const candidateSet = new Set(candidateTokens);
        const matchingDistinctive = distinctiveTokens.filter((token) => candidateSet.has(token)).length;
        score += matchingDistinctive * 10;
        if (matchingDistinctive === 0) {
            score -= 40;
        }
    }

    if (expectedType === "movie") {
        if (candidateSignals.movie) score += 40;
        if (candidateSignals.special || candidateSignals.ova || candidateSignals.ona) score -= 15;
    } else {
        if (candidateSignals.movie) score -= 140;
        if (candidateSignals.special) score -= 90;
        if (candidateSignals.ova) score -= 85;
        if (candidateSignals.ona && (jikanData.episodes || 0) > 6) score -= 75;
    }

    for (const expected of expectedSignals) {
        if (expected.part) {
            if (candidateSignals.part === expected.part) score += 45;
            else if (candidateSignals.part && candidateSignals.part !== expected.part) score -= 95;
            else score -= 35;
        }
        if (expected.season) {
            if (candidateSignals.season === expected.season) score += 40;
            else if (candidateSignals.season && candidateSignals.season !== expected.season) score -= 90;
            else score -= 25;
        }
        if (expected.cour) {
            if (candidateSignals.cour === expected.cour) score += 20;
            else if (candidateSignals.cour && candidateSignals.cour !== expected.cour) score -= 35;
        }
    }

    return score;
}

/** Only reject matches that are clearly wrong (wrong format or no data). Do not compare Jikan's total episode count to HiAnime's list length — the site may paginate or list a subset, and those heuristics caused valid series to show 0 episodes after a failed rematch. */
function getStructuralMismatchReason(jikanData: JikanAnime, candidateTitle: string, episodeCount: number): string | null {
    if (episodeCount === 0) {
        return "provider entry returned no episodes";
    }

    const normalizedType = normalizeTitle(jikanData.type);
    const titleSignals = extractTitleSignals(candidateTitle);

    if (normalizedType !== "movie" && titleSignals.movie) {
        return "tv series matched a movie listing";
    }

    return null;
}

async function loadEpisodesForAnimeId(
    animeId: string,
    options: { useCache?: boolean } = {},
): Promise<AnimeInfo["episodes"]> {
    const useCache = options.useCache !== false;
    const epKey = `episodes_${animeId}`;
    if (useCache) {
        const cached = cacheGet<AnimeInfo["episodes"]>(epKey);
        if (cached) return cached;
    }

    const episodes = await getAnimeSourceEpisodes(animeId);
    if (episodes.length > 0) {
        cacheSet(epKey, episodes, TTL_EPISODES);
    } else if (!useCache) {
        cacheRemove(epKey);
    }
    return episodes;
}

function clearAnimeInfoCache(malId: string, animeId?: string): void {
    cacheRemove(`info_${malId}`);
    cacheRemove(`srcmap_v3_${malId}`);
    if (animeId) {
        cacheRemove(`episodes_${animeId}`);
    }
}

async function resolveSourceMatch(
    jikanData: JikanAnime,
    options: { forceRefresh?: boolean; rejectedSlugs?: Set<string> } = {},
): Promise<ResolvedSourceMatch | null> {
    const malId = String(jikanData.mal_id);
    const mapKey = `srcmap_v3_${malId}`;
    const rejectedSlugs = options.rejectedSlugs || new Set<string>();

    if (!options.forceRefresh) {
        const cachedMapping = cacheGet<SourceMapping>(mapKey);
        if (cachedMapping?.animeId && cachedMapping.slug && !rejectedSlugs.has(cachedMapping.slug)) {
            setSlugForAnimeId(cachedMapping.animeId, cachedMapping.slug);
            _lastDiag += ` -> src(cache:${cachedMapping.slug}, score=${cachedMapping.score})`;
            return {
                slug: cachedMapping.slug,
                animeId: cachedMapping.animeId,
                matchedTitle: cachedMapping.matchedTitle,
                score: cachedMapping.score,
                query: cachedMapping.query,
                cacheHit: true,
            };
        }
    }

    if (!isSourceConfigured()) {
        _lastDiag += " -> source not configured";
        return null;
    }

    const queries = buildSourceQueries(jikanData);
    const seenQueries = new Set<string>();
    const candidates = new Map<string, SourceCandidate>();

    for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
        const query = queries[queryIndex];
        const queryKey = normalizeTitle(query);
        if (!queryKey || seenQueries.has(queryKey)) continue;
        seenQueries.add(queryKey);

        const results = await searchAnimeSource(query);
        if (!results.length) continue;

        for (const result of results) {
            const slug = result.slug || result.id;
            if (!slug || rejectedSlugs.has(slug)) continue;
            const score = scoreCandidate(jikanData, result.title, queryIndex);
            const existing = candidates.get(slug);
            if (!existing || score > existing.score) {
                candidates.set(slug, {
                    slug,
                    animeId: result.animeId || "",
                    title: result.title,
                    query,
                    queryIndex,
                    score,
                });
            }
        }

        if (candidates.size >= 12) {
            break;
        }
    }

    if (candidates.size === 0) {
        const err = getLastConsumetError();
        _lastDiag += ` -> search fail(${queries.length} queries): ${err || "no provider results"}`;
        return null;
    }

    let ranked = [...candidates.values()]
        .filter((candidate) => candidate.score >= MIN_CANDIDATE_SCORE)
        .sort((left, right) => right.score - left.score)
        .slice(0, MAX_RANKED_CANDIDATES);

    if (ranked.length === 0 && candidates.size > 0) {
        _lastDiag += " -> no candidates above min score; trying best available match";
        ranked = [...candidates.values()]
            .sort((left, right) => right.score - left.score)
            .slice(0, MAX_RANKED_CANDIDATES);
    }

    if (ranked.length === 0) {
        _lastDiag += " -> no ranked provider candidates survived scoring";
        return null;
    }

    const rejectedReasons: string[] = [];
    for (const candidate of ranked) {
        let animeId = candidate.animeId;
        if (!animeId) {
            const providerInfo = await getAnimeInfo(candidate.slug);
            animeId = providerInfo?.animeId || "";
        }

        if (!animeId) {
            rejectedReasons.push(`${candidate.slug}: missing animeId`);
            continue;
        }

        setSlugForAnimeId(animeId, candidate.slug);
        const episodes = await loadEpisodesForAnimeId(animeId, { useCache: false });
        const structuralReason = getStructuralMismatchReason(jikanData, candidate.title, episodes.length);

        if (structuralReason) {
            rejectedReasons.push(`${candidate.slug}: ${structuralReason}`);
            cacheRemove(`episodes_${animeId}`);
            continue;
        }

        const resolved: ResolvedSourceMatch = {
            slug: candidate.slug,
            animeId,
            matchedTitle: candidate.title,
            score: candidate.score,
            query: candidate.query,
            cacheHit: false,
            episodes,
        };

        cacheSet(mapKey, {
            slug: resolved.slug,
            animeId: resolved.animeId,
            matchedTitle: resolved.matchedTitle,
            score: resolved.score,
            query: resolved.query,
        }, TTL_SOURCE_MAP);

        _lastDiag += ` -> src(${resolved.slug}, score=${resolved.score}, query="${resolved.query}")`;
        return resolved;
    }

    _lastDiag += ` -> rejected ${ranked.length} candidate(s): ${rejectedReasons.join(" | ")}`;
    return null;
}

/** When strict scoring finds no match, try the first HiAnime search hits per title variant until one returns episodes (common after Jikan/HiAnime title drift). */
async function resolveSourceMatchLoose(jikanData: JikanAnime, malId: string): Promise<ResolvedSourceMatch | null> {
    if (!isSourceConfigured()) return null;
    const queries = buildSourceQueries(jikanData).slice(0, 10);
    const mapKey = `srcmap_v3_${malId}`;
    for (const query of queries) {
        const results = await searchAnimeSource(query);
        const take = Math.min(4, results.length);
        for (let i = 0; i < take; i += 1) {
            const r = results[i];
            const slug = r.slug || r.id;
            if (!slug) continue;
            let animeId = r.animeId;
            if (!animeId) {
                const info = await getAnimeInfo(slug);
                animeId = info?.animeId || "";
            }
            if (!animeId) continue;
            setSlugForAnimeId(animeId, slug);
            const episodes = await loadEpisodesForAnimeId(animeId, { useCache: false });
            if (episodes.length === 0) continue;

            const resolved: ResolvedSourceMatch = {
                slug,
                animeId,
                matchedTitle: r.title,
                score: 0,
                query,
                cacheHit: false,
                episodes,
            };
            cacheSet(mapKey, {
                slug: resolved.slug,
                animeId: resolved.animeId,
                matchedTitle: resolved.matchedTitle,
                score: 1,
                query: resolved.query,
            }, TTL_SOURCE_MAP);
            _lastDiag += ` -> loose title fallback (${slug}, ${episodes.length} eps)`;
            return resolved;
        }
    }
    return null;
}

function buildAnimeInfo(jikanData: JikanAnime, episodes: AnimeInfo["episodes"]): AnimeInfo {
    return {
        id: String(jikanData.mal_id),
        title: pickDisplayTitle(jikanData),
        image: jikanData.images?.webp?.large_image_url || jikanData.images?.webp?.image_url,
        cover: jikanData.images?.webp?.large_image_url || jikanData.images?.webp?.image_url,
        description: jikanData.synopsis,
        status: jikanData.status,
        genres: jikanData.genres?.map((genre) => genre.name) || [],
        score: jikanData.score,
        episodes,
    };
}

async function loadAnimeInfoFromSlug(slug: string): Promise<AnimeInfo | null> {
    _lastDiag = `[HiAnime direct] slug=${slug}`;
    const cacheKey = `info_hi-slug:${slug}`;
    const cached = cacheGet<AnimeInfo>(cacheKey);
    if (cached) {
        const mapKey = `srcmap_v3_hi-slug:${slug}`;
        const cachedMapping = cacheGet<SourceMapping>(mapKey);
        if (cachedMapping?.animeId && cachedMapping.slug) {
            setSlugForAnimeId(cachedMapping.animeId, cachedMapping.slug);
        }
        _lastDiag += ` [cache hit] eps=${cached.episodes?.length || 0}`;
        return cached;
    }

    const providerInfo = await getAnimeInfo(slug);
    if (!providerInfo?.animeId) {
        _lastDiag += " -> HiAnime info failed";
        return null;
    }

    setSlugForAnimeId(providerInfo.animeId, slug);
    const episodes = await loadEpisodesForAnimeId(providerInfo.animeId, { useCache: false });

    const info: AnimeInfo = {
        id: `hi-slug:${slug}`,
        title: providerInfo.name || slug,
        image: providerInfo.poster || "/sakura.png",
        cover: providerInfo.poster || "/sakura.png",
        description: providerInfo.description || "",
        status: "Airing",
        genres: [],
        score: null,
        episodes,
    };

    if (episodes.length > 0) {
        cacheSet(cacheKey, info, TTL_INFO);
        cacheSet(`srcmap_v3_hi-slug:${slug}`, {
            slug,
            animeId: providerInfo.animeId,
            matchedTitle: providerInfo.name,
            score: 100,
            query: slug,
        }, TTL_SOURCE_MAP);
    }

    _lastDiag += ` -> OK eps=${episodes.length}`;
    return info;
}

async function loadAnimeInfo(id: string, options: AnimeInfoRefreshOptions = {}): Promise<AnimeInfo | null> {
    _lastDiag = "";

    if (id === PSYOP_ID) {
        _lastDiag = `[psyopanime] eps=${PSYOP_INFO.episodes.length}`;
        return PSYOP_INFO;
    }

    if (id === TWO_HE_ANIME_ID) {
        _lastDiag = `[2heanime] eps=${TWO_HE_ANIME_INFO.episodes.length}`;
        return TWO_HE_ANIME_INFO;
    }

    // Direct HiAnime slug path (from fallback trending data)
    if (id.startsWith("hi-slug:")) {
        return loadAnimeInfoFromSlug(id.slice(8));
    }

    const cacheKey = `info_${id}`;
    if (!options.forceSourceRefresh) {
        const cached = cacheGet<AnimeInfo>(cacheKey);
        if (cached) {
            if (!cached.episodes || cached.episodes.length === 0) {
                cacheRemove(cacheKey);
                _lastDiag = "[cache] dropped stale info with 0 episodes";
            } else {
                _lastDiag = `[cache hit] eps=${cached.episodes?.length || 0}`;
                const mapKey = `srcmap_v3_${id}`;
                const cachedMapping = cacheGet<SourceMapping>(mapKey);
                if (cachedMapping?.animeId && cachedMapping.slug) {
                    setSlugForAnimeId(cachedMapping.animeId, cachedMapping.slug);
                    _lastDiag += ` slug restored(${cachedMapping.slug})`;
                }
                return cached;
            }
        }
    }

    let jikanData = await fetchJikanInfo(id);
    if (!jikanData) {
        await new Promise(r => setTimeout(r, 1200));
        jikanData = await fetchJikanInfo(id);
    }
    if (!jikanData) {
        _lastDiag = "[FAIL] Jikan returned null";
        return null;
    }

    _lastDiag = `Jikan OK: "${jikanData.title}" / "${jikanData.title_english || ""}"`;

    let sourceMatch = await resolveSourceMatch(jikanData, { forceRefresh: options.forceSourceRefresh });
    let episodes: AnimeInfo["episodes"] = [];

    if (sourceMatch?.animeId) {
        episodes = sourceMatch.episodes || await loadEpisodesForAnimeId(sourceMatch.animeId);
        const structuralReason = getStructuralMismatchReason(jikanData, sourceMatch.matchedTitle, episodes.length);

        // Only rematch on structural problems (0 eps or TV↔movie). Never rematch on episode-count heuristics — that could discard a working slug and leave 0 episodes.
        if (structuralReason) {
            _lastDiag += ` -> rematch (${structuralReason})`;
            clearAnimeInfoCache(id, sourceMatch.animeId);
            const rejected = new Set<string>([sourceMatch.slug]);
            sourceMatch = await resolveSourceMatch(jikanData, { forceRefresh: true, rejectedSlugs: rejected });
            episodes = sourceMatch?.episodes || (sourceMatch?.animeId ? await loadEpisodesForAnimeId(sourceMatch.animeId) : []);
        }
    } else {
        _lastDiag += " -> no source match";
    }

    if (episodes.length === 0 && isSourceConfigured()) {
        const loose = await resolveSourceMatchLoose(jikanData, id);
        if (loose?.animeId) {
            sourceMatch = loose;
            episodes = loose.episodes || (await loadEpisodesForAnimeId(loose.animeId));
        }
    }

    const info = buildAnimeInfo(jikanData, episodes);
    if (episodes.length === 0) {
        const tail = _lastDiag.split(" -> ").slice(-1)[0]?.trim();
        info.episodeLoadError = tail || "Streaming source unavailable for this title.";
    }
    if (episodes.length > 0) {
        cacheSet(cacheKey, info, TTL_INFO);
    }
    return info;
}

export function getLastDiagnostic(): string {
    return _lastDiag;
}

export async function searchAnime(query: string): Promise<AnimeResult[]> {
    const cacheKey = `search_${query.toLowerCase().trim()}`;
    const cached = cacheGet<AnimeResult[]>(cacheKey);
    if (cached) return cached;

    const results = await fetchJikanSearch(query);
    const mapped: AnimeResult[] = results.map((result) => ({
        id: String(result.mal_id),
        title: pickDisplayTitle(result),
        image: result.images?.webp?.large_image_url || result.images?.webp?.image_url,
        type: result.type,
        releaseDate: result.year ? String(result.year) : undefined,
        score: result.score,
    }));

    if (matchesPsyopQuery(query)) {
        mapped.unshift(PSYOP_SEARCH_RESULT);
    }

    if (matchesTwoHeAnimeQuery(query)) {
        mapped.unshift(TWO_HE_ANIME_SEARCH_RESULT);
    }

    cacheSet(cacheKey, mapped, TTL_SEARCH);
    return mapped;
}

export async function fetchAnimeByGenre(genreId: number): Promise<AnimeResult[]> {
    const cacheKey = `genre_${genreId}`;
    const cached = cacheGet<AnimeResult[]>(cacheKey);
    if (cached) return cached;

    const results = await fetchJikanByGenre(genreId);
    const mapped = results.map((result) => ({
        id: String(result.mal_id),
        title: pickDisplayTitle(result),
        image: result.images?.webp?.large_image_url || result.images?.webp?.image_url,
        type: result.type,
        score: result.score,
    }));
    cacheSet(cacheKey, mapped, TTL_SEARCH);
    return mapped;
}

export async function fetchAiringAnime(): Promise<AnimeResult[]> {
    const cacheKey = "trending";
    const cached = cacheGet<AnimeResult[]>(cacheKey);
    if (cached && cached.length > 0) return cached;

    // Try Jikan first
    const results = await fetchJikanTrending();
    if (results.length > 0) {
        const mapped = results.map((result) => ({
            id: String(result.mal_id),
            title: pickDisplayTitle(result),
            image: result.images?.webp?.large_image_url || result.images?.webp?.image_url,
            type: result.type || "TV",
            score: result.score,
        }));
        cacheSet(cacheKey, mapped, TTL_TRENDING);
        return mapped;
    }

    // Fallback: scrape HiAnime home page
    console.log("[Anime] Jikan unavailable, falling back to HiAnime home page");
    const hiResults = await fetchHiAnimeTrending();
    if (hiResults.length > 0) {
        const mapped: AnimeResult[] = hiResults.map((r) => ({
            id: `hi-slug:${r.slug}`,
            title: r.title,
            image: r.poster,
            type: "TV",
        }));
        cacheSet(cacheKey, mapped, 30 * 60 * 1000);
        return mapped;
    }

    return [];
}

export async function fetchPopularAnime(): Promise<AnimeResult[]> {
    const cacheKey = "popular";
    const cached = cacheGet<AnimeResult[]>(cacheKey);
    if (cached) return cached;

    let mapped: AnimeResult[] = [];

    try {
        const al = await alPopular();
        if (al.length > 0) mapped = al.map(simpleAnimeToResult);
    } catch (e) {
        console.warn("[fetchPopularAnime] AniList failed:", (e as Error)?.message);
    }

    if (mapped.length === 0) {
        try {
            const results = await fetchJikanPopular();
            mapped = results.map((r) => ({
                id: String(r.mal_id),
                title: pickDisplayTitle(r),
                image: r.images?.webp?.large_image_url || r.images?.webp?.image_url,
                type: r.type,
                score: r.score,
                releaseDate: r.year != null ? String(r.year) : undefined,
            }));
        } catch (e) {
            console.warn("[fetchPopularAnime] Jikan also failed:", (e as Error)?.message);
        }
    }

    if (mapped.length > 0) cacheSet(cacheKey, mapped, TTL_TRENDING);
    return mapped;
}

export async function fetchAnimeInfo(id: string): Promise<AnimeInfo | null> {
    return loadAnimeInfo(id);
}

export function getCachedAnimeInfo(id: string): AnimeInfo | null {
    return cacheGet<AnimeInfo>(`info_${id}`);
}

export async function refreshAnimeInfo(
    id: string,
    options: AnimeInfoRefreshOptions = {},
): Promise<AnimeInfo | null> {
    clearAnimeInfoCache(id);
    return loadAnimeInfo(id, options);
}

export async function fetchEpisodeSources(
    episodeId: string,
    category: "sub" | "dub" = "sub",
): Promise<StreamingSource | null> {
    if (isPsyopEpisode(episodeId)) {
        const url = getPsyopStreamUrl(episodeId);
        if (!url) return null;
        return { url, isM3U8: false };
    }

    if (isTwoHeAnimeEpisode(episodeId)) {
        const url = getTwoHeAnimeStreamUrl(episodeId);
        if (!url) return null;
        return { url, isM3U8: false };
    }

    try {
        const result = await getStreamingSources(episodeId, category);
        if (!result || result.sources.length === 0) {
            return null;
        }

        const source = result.sources[0];
        console.log(`[Anime] Got embed URL (${source.quality}, ${category}): ${source.url.substring(0, 80)}...`);
        return {
            url: source.url,
            isM3U8: inferStreamingIsM3U8(source.url, source.isM3U8),
            referer: result.referer,
            tracks: result.subtitles.map((subtitle) => ({ file: subtitle.file, label: subtitle.label })),
            category: result.category,
            availableCategories: result.availableCategories,
        };
    } catch (error: any) {
        const details = error?.details && typeof error.details === "object" ? error.details : {};
        error.details = {
            ...details,
            animeDiagnostic: _lastDiag,
            providerError: getLastConsumetError(),
            providerDetails: getLastConsumetErrorDetails(),
        };
        console.error("[Anime] Stream extraction failed:", error);
        throw error;
    }
}
