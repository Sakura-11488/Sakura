import { fetchJikanSearch, fetchJikanTrending, fetchJikanPopular, fetchJikanInfo, fetchJikanByGenre, ANIME_GENRES, type JikanAnime } from "./jikan";
export { ANIME_GENRES } from "./jikan";
import { alTrending, alPopular, alSearch, alByGenre, type SimpleAnime } from "./anilist";

function simpleToResult(a: SimpleAnime): AnimeResult {
    return { id: String(a.mal_id), title: a.title, image: a.image, type: a.type, score: a.score, year: a.year };
}
import {
    searchAnimeSource,
    getAnimeSourceEpisodes,
    getStreamingSources,
    getAnimeInfo,
    setSlugForAnimeId,
    isConfigured as isSourceConfigured,
    getLastConsumetError,
    getLastConsumetErrorDetails,
} from "./sources/gogoanime";
import { PSYOP_SEARCH_RESULT, PSYOP_INFO, PSYOP_ID, matchesPsyopQuery, isPsyopEpisode, getPsyopStreamUrl } from "./psyopAnime";

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
    /**
     * Populated when the streaming source could not be resolved or
     * returned no episodes. Surfaces the underlying diagnostic so the
     * details page can render an informative empty-state.
     */
    episodeLoadError?: string | null;
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

// Bumped to v8 to also wipe stale `srcmap_v4_*` entries written by the
// previous scoring algorithm, which couldn't read Roman numerals. Without
// the bump, a returning user would keep seeing "The Outcast 4th Season"
// pinned to MAL id 59708 because the cached mapping survives the must-
// have-token fix below. Touching the prefix recomputes every srcmap on
// first launch of the new build.
const CACHE_PREFIX = "sakura_anime_v8_";
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

// Map trailing Roman numerals (II, III, IV, …) to season numbers. HiAnime
// publishes sequels like "Classroom of the Elite IV" with no "4th Season"
// suffix, while Jikan's canonical title says "4th Season". Without this,
// the must-have-token gate in `scoreCandidate` rejects the correct slug
// because it lacks the synthetic `season4` token, and a wrong-but-numbered
// match like "The Outcast 4th Season" scores higher.
const ROMAN_NUMERALS: Record<string, number> = {
    ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
};

function extractRomanSeason(rawValue: string | null | undefined): number | undefined {
    if (!rawValue) return undefined;
    // Use the part of the title before the first colon ("base" title) and
    // require the Roman numeral to be the final token. This catches cases
    // like "Classroom of the Elite IV" and "Classroom of the Elite IV:
    // Year 2" while staying safe against mid-title V/X (rare anime word
    // tokens like "V" appearing in the middle of a name).
    const base = rawValue.split(":")[0].toLowerCase();
    const cleaned = base.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const trailing = cleaned.match(/(?:^|\s)(ii|iii|iv|v|vi|vii|viii|ix|x)$/);
    if (!trailing) return undefined;
    return ROMAN_NUMERALS[trailing[1]];
}

function extractTitleSignals(value: string | null | undefined): TitleSignals {
    const title = normalizeTitle(value);
    const seasonMatch = title.match(/\b(?:(\d+)(?:st|nd|rd|th)?|(first|second|third|fourth|fifth)) season\b/);
    const partMatch = title.match(/\bpart\s*(\d+)\b/);
    const courMatch = title.match(/\b(\d+)(?:st|nd|rd|th)? cour\b|\bcour\s*(\d+)\b/);
    const seasonFromWords = toOrdinalNumber(seasonMatch?.[1] || seasonMatch?.[2]);
    const seasonFromRoman = seasonFromWords ? undefined : extractRomanSeason(value);
    return {
        season: seasonFromWords ?? seasonFromRoman,
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

// Tokens that must appear in a candidate title for it to be a plausible
// match for sequels / continuations. Without this gate "naruto shippuden"
// gets matched against the plain "naruto" slug and the first 50 episodes
// look identical to the original series.
const SEQUEL_KEYWORDS = new Set([
    "shippuden",
    "shippuuden",
    "boruto",
    "next",
    "generations",
    "kai",
    "brotherhood",
    "afterstory",
    "aftermath",
    "rebellion",
    "ressurection",
    "resurrection",
    "redux",
    "remake",
    "remix",
    "reborn",
    "returns",
    "revolution",
    "advance",
    "advanced",
    "destiny",
    "frontier",
    "ultimate",
    "unlimited",
    "legacy",
    "legend",
    "reincarnated",
    "isekai",
    "zero",
]);

// Pull "must-have" tokens from the canonical Jikan title so that a
// candidate which lacks ALL of them gets a hard penalty. We look at three
// signals:
//   - any sequel keyword we recognise (e.g. shippuden, boruto)
//   - any non-ordinal token after a colon (e.g. "Part 2: Awakening" → "awakening")
//   - any explicit season/part number ("season 4", "part 2") encoded as a synthetic token
function getMustHaveTokens(jikanData: JikanAnime): string[] {
    const tokens = new Set<string>();
    for (const variant of getSourceTitleVariants(jikanData)) {
        const lower = (variant || "").toLowerCase();
        for (const tok of tokenizeTitle(variant)) {
            if (SEQUEL_KEYWORDS.has(tok)) tokens.add(tok);
        }
        const colonIdx = lower.indexOf(":");
        if (colonIdx >= 0) {
            const tail = lower.slice(colonIdx + 1);
            for (const tok of tokenizeTitle(tail)) {
                // Skip common ordinal words; keep the meaningful subtitle words.
                if (["first", "second", "third", "fourth", "fifth", "season", "part", "cour", "1", "2", "3", "4", "5"].includes(tok)) continue;
                if (tok.length >= 4) tokens.add(tok);
            }
        }
        const signals = extractTitleSignals(variant);
        if (signals.season && signals.season > 1) tokens.add(`season${signals.season}`);
        if (signals.part && signals.part > 1) tokens.add(`part${signals.part}`);
    }
    return [...tokens];
}

function candidateTokenSet(candidateTitle: string): Set<string> {
    const set = new Set(tokenizeTitle(candidateTitle));
    const signals = extractTitleSignals(candidateTitle);
    if (signals.season && signals.season > 1) set.add(`season${signals.season}`);
    if (signals.part && signals.part > 1) set.add(`part${signals.part}`);
    return set;
}

function getSourceTitleVariants(jikanData: JikanAnime): string[] {
    const variants = new Set<string>();
    const titles = [
        jikanData.title,
        jikanData.title_english,
        jikanData.title_japanese,
        ...(jikanData.title_synonyms || []),
    ];
    for (const raw of titles) {
        const title = raw?.trim();
        if (!title) continue;
        variants.add(title);
    }
    return [...variants];
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
    const queries = new Set<string>();
    for (const title of getSourceTitleVariants(jikanData)) {
        for (const variant of buildTitleFallbacks(title)) {
            queries.add(variant);
        }
    }
    return [...queries];
}

function scoreCandidate(jikanData: JikanAnime, candidateTitle: string, queryIndex: number): number {
    const normalizedCandidate = normalizeTitle(candidateTitle);
    const candidateTokens = tokenizeTitle(candidateTitle);
    const candidateSignals = extractTitleSignals(candidateTitle);
    const expectedSignals = getSourceTitleVariants(jikanData).map(extractTitleSignals);
    const expectedType = normalizeTitle(jikanData.type);
    const distinctiveTokens = getDistinctiveTokens(jikanData);
    const mustHaveTokens = getMustHaveTokens(jikanData);
    const candidateTokenLookup = candidateTokenSet(candidateTitle);

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

    // Must-have token gate: if Jikan's title carries a sequel keyword
    // (Shippuden, Boruto, Part 2 …), a candidate that contains NONE of
    // those tokens cannot be a real match. Cap its score so any
    // candidate that does contain at least one of them wins.
    if (mustHaveTokens.length > 0) {
        const matched = mustHaveTokens.filter((t) => candidateTokenLookup.has(t)).length;
        if (matched === 0) {
            score = Math.min(score, 100) - 80;
        } else {
            score += matched * 35;
        }
    }

    return score;
}

function getSuspiciousMatchReason(jikanData: JikanAnime, candidateTitle: string, episodeCount: number): string | null {
    if (episodeCount === 0) {
        return "provider entry returned no episodes";
    }

    const normalizedType = normalizeTitle(jikanData.type);
    const expectedEpisodes = jikanData.episodes || 0;
    const titleSignals = extractTitleSignals(candidateTitle);
    // Currently airing shows haven't aired all episodes yet; if HiAnime
    // is ahead of MAL with 4 of 24 episodes, we'd rather show those 4
    // than reject the match and display "0 episodes".
    const isAiring = /currently airing|airing/i.test(jikanData.status || "");

    if (normalizedType !== "movie" && titleSignals.movie) {
        return "tv series matched a movie listing";
    }

    if (normalizedType === "tv" && expectedEpisodes > 6 && (titleSignals.special || titleSignals.ova || titleSignals.ona)) {
        return "tv series matched a special/ova/ona listing";
    }

    if (expectedEpisodes > 3 && episodeCount === 1) {
        return "series matched a single-entry episode list";
    }

    if (!isAiring && expectedEpisodes >= 24 && episodeCount < 5) {
        return `expected a multi-episode series but only found ${episodeCount} episode(s)`;
    }

    if (!isAiring && expectedEpisodes >= 75 && episodeCount < 15) {
        return `expected a long-running series but only found ${episodeCount} episode(s)`;
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
    cacheRemove(`srcmap_v4_${malId}`);
    if (animeId) {
        cacheRemove(`episodes_${animeId}`);
    }
}

async function resolveSourceMatch(
    jikanData: JikanAnime,
    options: { forceRefresh?: boolean; rejectedSlugs?: Set<string> } = {},
): Promise<ResolvedSourceMatch | null> {
    const malId = String(jikanData.mal_id);
    const mapKey = `srcmap_v4_${malId}`;
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

    const ranked = [...candidates.values()]
        .filter((candidate) => candidate.score >= MIN_CANDIDATE_SCORE)
        .sort((left, right) => right.score - left.score)
        .slice(0, MAX_RANKED_CANDIDATES);

    if (ranked.length === 0) {
        _lastDiag += " -> no ranked provider candidates survived scoring";
        return null;
    }

    // Resolve episode counts for the top candidates so we can apply a soft
    // tiebreaker: prefer entries whose episode count is within ±20% of
    // Jikan's reported episode count. We resolve in declared order, then
    // sort by (score + episode-bonus). Episode lists are cached so the
    // chosen candidate's data is reused below.
    const expectedEpisodes = jikanData.episodes || 0;
    const enriched = await Promise.all(
        ranked.map(async (candidate) => {
            let animeId = candidate.animeId;
            if (!animeId) {
                const providerInfo = await getAnimeInfo(candidate.slug);
                animeId = providerInfo?.animeId || "";
            }
            if (!animeId) {
                return { candidate, animeId: "", episodes: [] as AnimeInfo["episodes"], finalScore: candidate.score };
            }
            setSlugForAnimeId(animeId, candidate.slug);
            const episodes = await loadEpisodesForAnimeId(animeId, { useCache: false });
            let bonus = 0;
            if (expectedEpisodes > 0 && episodes.length > 0) {
                const ratio = episodes.length / expectedEpisodes;
                if (ratio >= 0.8 && ratio <= 1.2) bonus += 30;
                else if (ratio >= 0.6 && ratio <= 1.4) bonus += 10;
                else if (ratio < 0.4 || ratio > 2.0) bonus -= 25;
            }
            return { candidate, animeId, episodes, finalScore: candidate.score + bonus };
        }),
    );

    enriched.sort((a, b) => b.finalScore - a.finalScore);

    const rejectedReasons: string[] = [];
    for (const entry of enriched) {
        const { candidate, animeId, episodes } = entry;
        if (!animeId) {
            rejectedReasons.push(`${candidate.slug}: missing animeId`);
            continue;
        }

        const suspiciousReason = getSuspiciousMatchReason(jikanData, candidate.title, episodes.length);

        if (suspiciousReason) {
            rejectedReasons.push(`${candidate.slug}: ${suspiciousReason}`);
            cacheRemove(`episodes_${animeId}`);
            continue;
        }

        const resolved: ResolvedSourceMatch = {
            slug: candidate.slug,
            animeId,
            matchedTitle: candidate.title,
            score: entry.finalScore,
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

function buildAnimeInfo(jikanData: JikanAnime, episodes: AnimeInfo["episodes"]): AnimeInfo {
    return {
        id: String(jikanData.mal_id),
        title: jikanData.title_english || jikanData.title,
        image: jikanData.images?.webp?.large_image_url || jikanData.images?.webp?.image_url,
        cover: jikanData.images?.webp?.large_image_url || jikanData.images?.webp?.image_url,
        description: jikanData.synopsis,
        status: jikanData.status,
        genres: jikanData.genres?.map((genre) => genre.name) || [],
        score: jikanData.score,
        episodes,
    };
}

async function loadAnimeInfo(id: string, options: AnimeInfoRefreshOptions = {}): Promise<AnimeInfo | null> {
    _lastDiag = "";

    if (id === PSYOP_ID) {
        _lastDiag = `[psyopanime] eps=${PSYOP_INFO.episodes.length}`;
        return PSYOP_INFO;
    }

    const cacheKey = `info_${id}`;
    if (!options.forceSourceRefresh) {
        const cached = cacheGet<AnimeInfo>(cacheKey);
        if (cached) {
            _lastDiag = `[cache hit] eps=${cached.episodes?.length || 0}`;
            return cached;
        }
    }

    const jikanData = await fetchJikanInfo(id);
    if (!jikanData) {
        _lastDiag = "[FAIL] Jikan returned null";
        return null;
    }

    _lastDiag = `Jikan OK: "${jikanData.title}" / "${jikanData.title_english || ""}"`;

    let sourceMatch = await resolveSourceMatch(jikanData, { forceRefresh: options.forceSourceRefresh });
    let episodes: AnimeInfo["episodes"] = [];

    if (sourceMatch?.animeId) {
        episodes = sourceMatch.episodes || await loadEpisodesForAnimeId(sourceMatch.animeId);
        const suspiciousReason = getSuspiciousMatchReason(jikanData, sourceMatch.matchedTitle, episodes.length);

        if (suspiciousReason) {
            _lastDiag += ` -> reject cached source (${suspiciousReason})`;
            clearAnimeInfoCache(id, sourceMatch.animeId);
            const rejected = new Set<string>([sourceMatch.slug]);
            sourceMatch = await resolveSourceMatch(jikanData, { forceRefresh: true, rejectedSlugs: rejected });
            episodes = sourceMatch?.episodes || (sourceMatch?.animeId ? await loadEpisodesForAnimeId(sourceMatch.animeId) : []);
        }
    } else {
        _lastDiag += " -> no source match";
    }

    const info = buildAnimeInfo(jikanData, episodes);
    if (episodes.length === 0) {
        // Surface the diagnostic on the details page instead of silently
        // showing "0 episodes". Callers can read this from `info.episodeLoadError`.
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

    let mapped: AnimeResult[] = [];

    try {
        const al = await alSearch(query);
        if (al.length > 0) mapped = al.map(simpleToResult);
    } catch (e) {
        console.warn("[searchAnime] AniList failed:", (e as any)?.message);
    }

    if (mapped.length === 0) {
        try {
            const results = await fetchJikanSearch(query);
            mapped = results.map((r) => ({
                id: String(r.mal_id), title: r.title_english || r.title,
                image: r.images?.webp?.large_image_url || r.images?.webp?.image_url,
                type: r.type, score: r.score, year: r.year ?? null,
            }));
        } catch (e) {
            console.warn("[searchAnime] Jikan also failed:", (e as any)?.message);
        }
    }

    if (matchesPsyopQuery(query)) {
        mapped.unshift(PSYOP_SEARCH_RESULT);
    }

    if (mapped.length > 0) cacheSet(cacheKey, mapped, TTL_SEARCH);
    return mapped;
}

export async function fetchAnimeByGenre(genreId: number): Promise<AnimeResult[]> {
    const cacheKey = `genre_${genreId}`;
    const cached = cacheGet<AnimeResult[]>(cacheKey);
    if (cached) return cached;

    const genreName = ANIME_GENRES.find(g => g.id === genreId)?.name;
    let mapped: AnimeResult[] = [];

    if (genreName) {
        try {
            const al = await alByGenre(genreName);
            if (al.length > 0) mapped = al.map(simpleToResult);
        } catch (e) {
            console.warn("[fetchAnimeByGenre] AniList failed:", (e as any)?.message);
        }
    }

    if (mapped.length === 0) {
        try {
            const results = await fetchJikanByGenre(genreId);
            mapped = results.map((r) => ({
                id: String(r.mal_id), title: r.title_english || r.title,
                image: r.images?.webp?.large_image_url || r.images?.webp?.image_url,
                type: r.type, score: r.score, year: r.year ?? null,
            }));
        } catch (e) {
            console.warn("[fetchAnimeByGenre] Jikan also failed:", (e as any)?.message);
        }
    }

    if (mapped.length > 0) cacheSet(cacheKey, mapped, TTL_SEARCH);
    return mapped;
}

export async function fetchAiringAnime(): Promise<AnimeResult[]> {
    const cacheKey = "trending";
    const cached = cacheGet<AnimeResult[]>(cacheKey);
    if (cached) return cached;

    let mapped: AnimeResult[] = [];

    try {
        const al = await alTrending();
        if (al.length > 0) mapped = al.map(simpleToResult);
    } catch (e) {
        console.warn("[fetchAiringAnime] AniList failed:", (e as any)?.message);
    }

    if (mapped.length === 0) {
        try {
            const results = await fetchJikanTrending();
            mapped = results.map((r) => ({
                id: String(r.mal_id), title: r.title_english || r.title,
                image: r.images?.webp?.large_image_url || r.images?.webp?.image_url,
                type: "Trending", score: r.score,
            }));
        } catch (e) {
            console.warn("[fetchAiringAnime] Jikan also failed:", (e as any)?.message);
        }
    }

    if (mapped.length > 0) cacheSet(cacheKey, mapped, TTL_TRENDING);
    return mapped;
}

export async function fetchPopularAnime(): Promise<AnimeResult[]> {
    const cacheKey = "popular";
    const cached = cacheGet<AnimeResult[]>(cacheKey);
    if (cached) return cached;

    let mapped: AnimeResult[] = [];

    try {
        const al = await alPopular();
        if (al.length > 0) mapped = al.map(simpleToResult);
    } catch (e) {
        console.warn("[fetchPopularAnime] AniList failed:", (e as any)?.message);
    }

    if (mapped.length === 0) {
        try {
            const results = await fetchJikanPopular();
            mapped = results.map((r) => ({
                id: String(r.mal_id), title: r.title_english || r.title,
                image: r.images?.webp?.large_image_url || r.images?.webp?.image_url,
                type: r.type, score: r.score, year: r.year ?? null,
            }));
        } catch (e) {
            console.warn("[fetchPopularAnime] Jikan also failed:", (e as any)?.message);
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

    try {
        const result = await getStreamingSources(episodeId, category);
        if (!result || result.sources.length === 0) {
            return null;
        }

        const source = result.sources[0];
        console.log(`[Anime] Got embed URL (${source.quality}, ${category}): ${source.url.substring(0, 80)}...`);
        return {
            url: source.url,
            isM3U8: source.isM3U8,
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
