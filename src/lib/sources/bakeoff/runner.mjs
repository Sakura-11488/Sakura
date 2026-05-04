import * as cheerio from "cheerio";

const DEFAULT_QUERIES = [
    "One Piece",
    "Solo Leveling",
    "Chainsaw Man",
    "The Greatest Estate Developer",
];

const DEFAULT_HEADERS = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    accept: "text/html,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

function normalizeTitle(value = "") {
    return value
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\b(the|a|an|of|and|part|chapter|vol|volume)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenize(value = "") {
    return normalizeTitle(value).split(" ").filter(Boolean);
}

function scoreTitleMatch(query, candidate) {
    const q = normalizeTitle(query);
    const c = normalizeTitle(candidate);
    if (!q || !c) return 0;
    if (q === c) return 100;
    if (c.includes(q)) return 90;
    const qTokens = new Set(tokenize(query));
    const cTokens = new Set(tokenize(candidate));
    let overlap = 0;
    for (const token of qTokens) {
        if (cTokens.has(token)) overlap += 1;
    }
    return Math.round((overlap / Math.max(qTokens.size, 1)) * 80);
}

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(response) {
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return text;
}

async function fetchText(url, options = {}) {
    const response = await fetch(url, {
        redirect: "follow",
        ...options,
        headers: {
            ...DEFAULT_HEADERS,
            ...(options.headers || {}),
        },
    });
    return readBody(response);
}

async function fetchJson(url, options = {}) {
    const text = await fetchText(url, options);
    return JSON.parse(text);
}

class CookieSession {
    constructor(baseHeaders = {}) {
        this.baseHeaders = baseHeaders;
        this.cookies = new Map();
    }

    updateCookies(response) {
        const setCookies = typeof response.headers.getSetCookie === "function"
            ? response.headers.getSetCookie()
            : (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);

        for (const cookie of setCookies) {
            if (!cookie) continue;
            const [pair] = cookie.split(";");
            const separator = pair.indexOf("=");
            if (separator === -1) continue;
            const key = pair.slice(0, separator).trim();
            const value = pair.slice(separator + 1).trim();
            if (key) {
                this.cookies.set(key, value);
            }
        }
    }

    cookieHeader() {
        return Array.from(this.cookies.entries())
            .map(([key, value]) => `${key}=${value}`)
            .join("; ");
    }

    async request(url, options = {}) {
        const headers = {
            ...DEFAULT_HEADERS,
            ...this.baseHeaders,
            ...(options.headers || {}),
        };
        const cookieHeader = this.cookieHeader();
        if (cookieHeader) {
            headers.Cookie = cookieHeader;
        }

        const response = await fetch(url, {
            redirect: "follow",
            ...options,
            headers,
        });
        this.updateCookies(response);
        return response;
    }

    async text(url, options = {}) {
        const response = await this.request(url, options);
        return readBody(response);
    }

    async json(url, options = {}) {
        const text = await this.text(url, options);
        return JSON.parse(text);
    }
}

function summarizeDetails(details) {
    return {
        hasTitle: Boolean(details?.title),
        hasAuthor: Boolean(details?.author),
        hasDescription: Boolean(details?.description),
        hasTags: Array.isArray(details?.tags) && details.tags.length > 0,
        hasStatus: Boolean(details?.status),
        hasYear: Number.isFinite(details?.year),
    };
}

function scoreDetails(details) {
    const summary = summarizeDetails(details);
    const values = Object.values(summary);
    const filled = values.filter(Boolean).length;
    return Math.round((filled / values.length) * 100);
}

function summarizeCandidate(candidate) {
    const attempts = candidate.attempts;
    const total = attempts.length || 1;
    const searchHits = attempts.filter((attempt) => attempt.search.hit).length;
    const detailHits = attempts.filter((attempt) => attempt.details.success).length;
    const chapterHits = attempts.filter((attempt) => attempt.chapters.success).length;
    const pageHits = attempts.filter((attempt) => attempt.pages.success).length;
    const avgMatchScore = Math.round(attempts.reduce((sum, attempt) => sum + attempt.search.matchScore, 0) / total);
    const avgDetailsScore = Math.round(attempts.reduce((sum, attempt) => sum + attempt.details.score, 0) / total);
    const avgChapterCount = Math.round(attempts.reduce((sum, attempt) => sum + (attempt.chapters.count || 0), 0) / total);
    const avgPageCount = Math.round(attempts.reduce((sum, attempt) => sum + (attempt.pages.count || 0), 0) / total);
    const blockers = Array.from(new Set(attempts.flatMap((attempt) => attempt.errors)));
    const score =
        Math.round(
            (searchHits / total) * 35 +
            (detailHits / total) * 15 +
            (chapterHits / total) * 25 +
            (pageHits / total) * 20 +
            (avgMatchScore / 100) * 5,
        );

    return {
        id: candidate.id,
        name: candidate.name,
        score,
        searchHitRate: `${searchHits}/${total}`,
        detailSuccessRate: `${detailHits}/${total}`,
        chapterSuccessRate: `${chapterHits}/${total}`,
        pageSuccessRate: `${pageHits}/${total}`,
        avgMatchScore,
        avgDetailsScore,
        avgChapterCount,
        avgPageCount,
        blockers,
    };
}

function chooseRollout(summary) {
    const candidates = summary
        .filter((item) => item.id !== "mangadex")
        .sort((a, b) => b.score - a.score);

    const fallbackOrder = candidates
        .filter((item) => item.pageSuccessRate !== "0/4")
        .map((item) => item.id);

    return {
        mode: "fallback",
        primarySource: "mangadex",
        fallbackSources: fallbackOrder.slice(0, 2),
        blockedSources: candidates
            .filter((item) => item.pageSuccessRate === "0/4" && item.searchHitRate === "0/4")
            .map((item) => item.id),
        rationale: "Keep MangaDex as primary because it already powers creator metadata and genre/stats flows. Use the best-performing non-MangaDex candidates as controlled fallbacks instead of a full swap.",
    };
}

function pickBestHit(query, items) {
    if (!Array.isArray(items) || items.length === 0) {
        return { hit: null, score: 0 };
    }

    let best = null;
    let bestScore = 0;
    for (const item of items) {
        const score = scoreTitleMatch(query, item.title || item.name || "");
        if (score > bestScore) {
            best = item;
            bestScore = score;
        }
    }
    return { hit: best, score: bestScore };
}

function base64UrlEncode(bytes) {
    return Buffer.from(bytes)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

const COMIX_KEYS = [
    "13YDu67uDgFczo3DnuTIURqas4lfMEPADY6Jaeqky+w=",
    "yEy7wBfBc+gsYPiQL/4Dfd0pIBZFzMwrtlRQGwMXy3Q=",
    "yrP+EVA1Dw==",
    "vZ23RT7pbSlxwiygkHd1dhToIku8SNHPC6V36L4cnwM=",
    "QX0sLahOByWLcWGnv6l98vQudWqdRI3DOXBdit9bxCE=",
    "WJwgqCmf",
    "BkWI8feqSlDZKMq6awfzWlUypl88nz65KVRmpH0RWIc=",
    "v7EIpiQQjd2BGuJzMbBA0qPWDSS+wTJRQ7uGzZ6rJKs=",
    "1SUReYlCRA==",
    "RougjiFHkSKs20DZ6BWXiWwQUGZXtseZIyQWKz5eG34=",
    "LL97cwoDoG5cw8QmhI+KSWzfW+8VehIh+inTxnVJ2ps=",
    "52iDqjzlqe8=",
    "U9LRYFL2zXU4TtALIYDj+lCATRk/EJtH7/y7qYYNlh8=",
    "e/GtffFDTvnw7LBRixAD+iGixjqTq9kIZ1m0Hj+s6fY=",
    "xb2XwHNB",
];

function getComixKeyBytes(index) {
    const key = COMIX_KEYS[index];
    return key ? Array.from(Buffer.from(key, "base64")) : [];
}

function rc4(key, data) {
    if (!key.length) return data;
    const s = Array.from({ length: 256 }, (_, index) => index);
    let j = 0;
    for (let i = 0; i < 256; i += 1) {
        j = (j + s[i] + key[i % key.length]) % 256;
        [s[i], s[j]] = [s[j], s[i]];
    }
    let i = 0;
    j = 0;
    return data.map((value) => {
        i = (i + 1) % 256;
        j = (j + s[i]) % 256;
        [s[i], s[j]] = [s[j], s[i]];
        return value ^ s[(s[i] + s[j]) % 256];
    });
}

const comixMutators = {
    s: (value) => (value + 143) % 256,
    l: (value) => ((value >>> 1) | (value << 7)) & 255,
    c: (value) => (value + 115) % 256,
    m: (value) => value ^ 177,
    f: (value) => (value - 188 + 256) % 256,
    g: (value) => ((value << 2) | (value >>> 6)) & 255,
    h: (value) => (value - 42 + 256) % 256,
    dollar: (value) => ((value << 4) | (value >>> 4)) & 255,
    b: (value) => (value - 12 + 256) % 256,
    underscore: (value) => (value - 20 + 256) % 256,
    y: (value) => ((value >>> 1) | (value << 7)) & 255,
    k: (value) => (value - 241 + 256) % 256,
};

function comixMutKey(mutKey, index) {
    return mutKey.length && (index % 32) < mutKey.length ? mutKey[index % 32] : 0;
}

function comixRound(data, { rc4Index, mutIndex, prefIndex, prefCount, map }) {
    const encrypted = rc4(getComixKeyBytes(rc4Index), data);
    const mutKey = getComixKeyBytes(mutIndex);
    const prefKey = getComixKeyBytes(prefIndex);
    const output = [];
    encrypted.forEach((value, index) => {
        if (index < prefCount && index < prefKey.length) {
            output.push(prefKey[index]);
        }
        let next = value ^ comixMutKey(mutKey, index);
        const transform = map[index % 10];
        if (transform) {
            next = comixMutators[transform](next);
        }
        output.push(next & 255);
    });
    return output;
}

function generateComixHash(path, bodySize = 0, time = 1) {
    const baseString = `${path}:${bodySize}:${time}`;
    const encoded = encodeURIComponent(baseString)
        .replace(/\+/g, "%20")
        .replace(/\*/g, "%2A")
        .replace(/%7E/g, "~");
    const initial = Array.from(Buffer.from(encoded, "ascii"));
    const round1 = comixRound(initial, {
        rc4Index: 0,
        mutIndex: 1,
        prefIndex: 2,
        prefCount: 7,
        map: { 0: "c", 1: "b", 2: "y", 3: "dollar", 4: "h", 5: "s", 6: "h", 7: "k", 8: "l", 9: "c" },
    });
    const round2 = comixRound(round1, {
        rc4Index: 3,
        mutIndex: 4,
        prefIndex: 5,
        prefCount: 6,
        map: { 0: "c", 1: "b", 2: "dollar", 3: "h", 4: "s", 5: "k", 6: "dollar", 7: "underscore", 8: "c", 9: "s" },
    });
    const round3 = comixRound(round2, {
        rc4Index: 6,
        mutIndex: 7,
        prefIndex: 8,
        prefCount: 7,
        map: { 0: "c", 1: "f", 2: "s", 3: "g", 4: "y", 5: "m", 6: "dollar", 7: "k", 8: "s", 9: "b" },
    });
    const round4 = comixRound(round3, {
        rc4Index: 9,
        mutIndex: 10,
        prefIndex: 11,
        prefCount: 8,
        map: { 0: "b", 1: "m", 2: "l", 3: "s", 4: "underscore", 5: "s", 6: "underscore", 7: "l", 8: "y", 9: "m" },
    });
    const round5 = comixRound(round4, {
        rc4Index: 12,
        mutIndex: 13,
        prefIndex: 14,
        prefCount: 6,
        map: { 0: "underscore", 1: "s", 2: "c", 3: "m", 4: "b", 5: "m", 6: "f", 7: "s", 8: "dollar", 9: "g" },
    });
    return base64UrlEncode(round5);
}

const providers = {
    mangadex: {
        id: "mangadex",
        name: "MangaDex",
        async search(query) {
            const data = await fetchJson(`https://api.mangadex.org/manga?title=${encodeURIComponent(query)}&limit=10&includes[]=author&includes[]=cover_art`);
            return (data.data || []).map((item) => {
                const title = item.attributes?.title?.en || Object.values(item.attributes?.title || {})[0] || item.id;
                return { id: item.id, title };
            });
        },
        async details(id) {
            const data = await fetchJson(`https://api.mangadex.org/manga/${id}?includes[]=author&includes[]=cover_art`);
            const item = data.data;
            const title = item.attributes?.title?.en || Object.values(item.attributes?.title || {})[0] || id;
            const author = item.relationships?.find((entry) => entry.type === "author")?.attributes?.name || "";
            const tags = (item.attributes?.tags || []).map((tag) => tag.attributes?.name?.en).filter(Boolean);
            return {
                id: item.id,
                title,
                author,
                description: item.attributes?.description?.en || "",
                tags,
                status: item.attributes?.status || "",
                year: item.attributes?.year || null,
            };
        },
        async chapters(id) {
            const data = await fetchJson(`https://api.mangadex.org/chapter?manga=${id}&translatedLanguage[]=en&order[chapter]=desc&limit=100`);
            return (data.data || []).map((item) => ({
                id: item.id,
                chapterId: item.id,
                title: item.attributes?.title || "",
                number: item.attributes?.chapter || "",
            }));
        },
        async pages(chapter) {
            const data = await fetchJson(`https://api.mangadex.org/at-home/server/${chapter.chapterId}`);
            return data.chapter?.data?.length || data.chapter?.dataSaver?.length || 0;
        },
    },
    comix: {
        id: "comix",
        name: "Comix",
        async search(query) {
            const data = await fetchJson(`https://comix.to/api/v2/manga?keyword=${encodeURIComponent(query)}&order[relevance]=desc&limit=10&page=1`, {
                headers: { referer: "https://comix.to/" },
            });
            const items = data?.result?.items || [];
            return items.map((item) => ({
                id: item.slug || item.url || item.hashid,
                title: item.title || item.name || item.slug || "",
            }));
        },
        async details(id) {
            const data = await fetchJson(`https://comix.to/api/v2/manga/${id}?includes[]=demographic&includes[]=genre&includes[]=theme&includes[]=author&includes[]=artist&includes[]=publisher`, {
                headers: { referer: "https://comix.to/" },
            });
            const result = data?.result || {};
            const tags = [
                ...(result.genre || []).map((item) => item.name),
                ...(result.theme || []).map((item) => item.name),
                ...(result.demographic || []).map((item) => item.name),
            ].filter(Boolean);
            const author = [
                ...(result.author || []).map((item) => item.name),
                ...(result.artist || []).map((item) => item.name),
            ].filter(Boolean).join(", ");
            return {
                id,
                title: result.title || result.name || id,
                author,
                description: result.description || result.summary || "",
                tags,
                status: result.status || "",
                year: result.year || null,
            };
        },
        async chapters(id) {
            const path = `/manga/${id}/chapters`;
            const hash = generateComixHash(path, 0, 1);
            const data = await fetchJson(`https://comix.to/api/v2/manga/${id}/chapters?order[number]=desc&limit=100&page=1&time=1&_=${encodeURIComponent(hash)}`, {
                headers: { referer: "https://comix.to/" },
            });
            return (data?.result?.items || []).map((item) => ({
                id: item.chapter_id || item.id || item.hashid,
                chapterId: item.chapter_id || item.id || item.hashid,
                title: item.name || item.title || "",
                number: item.number || "",
            }));
        },
        async pages(chapter) {
            const data = await fetchJson(`https://comix.to/api/v2/chapters/${chapter.chapterId}`, {
                headers: { referer: "https://comix.to/" },
            });
            return data?.result?.images?.length || 0;
        },
    },
    atsumaru: {
        id: "atsumaru",
        name: "Atsumaru",
        async search(query) {
            const payload = {
                page: 0,
                filter: {
                    search: query,
                    types: ["Manga", "Manwha", "Manhua", "OEL"],
                    sortBy: "popularity",
                    showAdult: false,
                    officialTranslation: false,
                },
            };
            const data = await fetchJson("https://atsu.moe/api/explore/filteredView", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    referer: "https://atsu.moe",
                },
                body: JSON.stringify(payload),
            });
            const items = data?.hits || data?.items || [];
            return items.map((item) => {
                const doc = item.document || item;
                return {
                    id: doc.id,
                    title: doc.title || doc.name || doc.slug || "",
                };
            });
        },
        async details(id) {
            const data = await fetchJson(`https://atsu.moe/api/manga/page?id=${encodeURIComponent(id)}`, {
                headers: { referer: "https://atsu.moe" },
            });
            const manga = data?.mangaPage || {};
            return {
                id,
                title: manga.title || manga.name || id,
                author: (manga.authors || []).map((item) => item.name).join(", "),
                description: manga.description || "",
                tags: (manga.tags || []).map((item) => item.name),
                status: manga.status || "",
                year: manga.year || null,
            };
        },
        async chapters(id) {
            const data = await fetchJson(`https://atsu.moe/api/manga/allChapters?mangaId=${encodeURIComponent(id)}`, {
                headers: { referer: "https://atsu.moe" },
            });
            return (data?.chapters || []).map((item) => ({
                id: item.id,
                chapterId: item.id,
                title: item.name || item.title || "",
                number: item.number || "",
            }));
        },
        async pages(chapter, details) {
            const data = await fetchJson(`https://atsu.moe/api/read/chapter?mangaId=${encodeURIComponent(details.id)}&chapterId=${encodeURIComponent(chapter.chapterId)}`, {
                headers: { referer: "https://atsu.moe" },
            });
            return data?.readChapter?.pages?.length || 0;
        },
    },
    mangaball: {
        id: "mangaball",
        name: "MangaBall",
        async createSession() {
            const session = new CookieSession({
                referer: "https://mangaball.net/",
                origin: "https://mangaball.net",
                "x-requested-with": "XMLHttpRequest",
            });
            const html = await session.text("https://mangaball.net/");
            const $ = cheerio.load(html);
            const csrf = $('meta[name="csrf-token"]').attr("content");
            if (!csrf) throw new Error("CSRF token not found");
            session.csrf = csrf;
            return session;
        },
        async search(query) {
            const session = await this.createSession();
            const data = await session.json("https://mangaball.net/api/v1/smart-search/search/", {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "x-csrf-token": session.csrf,
                },
                body: new URLSearchParams({ search_input: query }).toString(),
            });
            const items = data?.data?.manga || [];
            return items.map((item) => ({
                id: item.url?.split("/").filter(Boolean)[1] || item.url,
                title: item.title || item.name || "",
            }));
        },
        async details(id) {
            const html = await fetchText(`https://mangaball.net/title-detail/${id}/`, {
                headers: { referer: "https://mangaball.net/" },
            });
            const $ = cheerio.load(html);
            const tags = $('#comicDetail span[data-tag-id]').map((_, element) => $(element).text().trim()).get().filter(Boolean);
            return {
                id,
                title: $("#comicDetail h6").first().contents().first().text().trim() || id,
                author: $('#comicDetail span[data-person-id]').map((_, element) => $(element).text().trim()).get().filter(Boolean).join(", "),
                description: $("#descriptionContent p").first().text().trim(),
                tags,
                status: $(".badge-status").first().text().trim(),
                year: null,
            };
        },
        async chapters(id) {
            const session = await this.createSession();
            const titleId = id.split("-").pop();
            const data = await session.json("https://mangaball.net/api/v1/chapter/chapter-listing-by-title-id/", {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "x-csrf-token": session.csrf,
                },
                body: new URLSearchParams({ title_id: titleId }).toString(),
            });
            return (data?.chapters || []).flatMap((chapter) =>
                (chapter.translations || []).map((translation) => ({
                    id: translation.id,
                    chapterId: translation.id,
                    title: translation.name || "",
                    number: chapter.number || "",
                })),
            );
        },
        async pages(chapter) {
            const html = await fetchText(`https://mangaball.net/chapter-detail/${chapter.chapterId}/`, {
                headers: { referer: "https://mangaball.net/" },
            });
            const match = html.match(/const\s+chapterImages\s*=\s*JSON\.parse\(`([^`]+)`\)/);
            if (!match) throw new Error("chapterImages payload missing");
            return JSON.parse(match[1]).length;
        },
    },
    mangafire: {
        id: "mangafire",
        name: "MangaFire",
        async search() {
            throw new Error("Search requires VRF/WebView interception and is not stable enough for Sakura replacement yet");
        },
        async details() {
            throw new Error("Search must succeed before details can be fetched");
        },
        async chapters() {
            throw new Error("Search must succeed before chapter probing can be fetched");
        },
        async pages() {
            throw new Error("Search must succeed before page probing can be fetched");
        },
    },
};

async function evaluateProvider(provider, queries) {
    const attempts = [];
    for (const query of queries) {
        const attempt = {
            query,
            search: { hit: false, matchScore: 0, candidate: null, count: 0 },
            details: { success: false, score: 0, summary: null },
            chapters: { success: false, count: 0 },
            pages: { success: false, count: 0 },
            errors: [],
        };

        try {
            const hits = await provider.search(query);
            attempt.search.count = hits.length;
            const best = pickBestHit(query, hits);
            attempt.search.candidate = best.hit?.title || null;
            attempt.search.matchScore = best.score;
            attempt.search.hit = Boolean(best.hit && best.score >= 50);

            if (!best.hit) {
                attempts.push(attempt);
                continue;
            }

            const details = await provider.details(best.hit.id);
            attempt.details.success = Boolean(details);
            attempt.details.score = scoreDetails(details || {});
            attempt.details.summary = summarizeDetails(details || {});

            const chapters = await provider.chapters(best.hit.id, details || {});
            attempt.chapters.success = Array.isArray(chapters) && chapters.length > 0;
            attempt.chapters.count = chapters.length;

            if (chapters.length > 0) {
                const pageCount = await provider.pages(chapters[0], details || {});
                attempt.pages.success = pageCount > 0;
                attempt.pages.count = pageCount;
            }
        } catch (error) {
            attempt.errors.push(error instanceof Error ? error.message : String(error));
        }

        attempts.push(attempt);
        await sleep(250);
    }

    return {
        id: provider.id,
        name: provider.name,
        attempts,
    };
}

export async function runMangaSourceBakeoff(options = {}) {
    const queries = options.queries || DEFAULT_QUERIES;
    const candidates = [];
    for (const provider of Object.values(providers)) {
        candidates.push(await evaluateProvider(provider, queries));
    }

    const summary = candidates.map(summarizeCandidate).sort((a, b) => b.score - a.score);
    return {
        generatedAt: new Date().toISOString(),
        queries,
        summary,
        rollout: chooseRollout(summary),
        attempts: candidates,
    };
}

export const SOURCE_BAKEOFF_QUERIES = DEFAULT_QUERIES;
