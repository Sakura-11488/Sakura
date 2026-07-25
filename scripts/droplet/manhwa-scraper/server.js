/**
 * Sakura Manhwa scraper proxy.
 *
 * Runs on the DigitalOcean droplet behind nginx at /manhwa/v1/*.
 * Mirrors the Comics / Hentai scrapers' endpoint contract and JSON envelopes so
 * the mobile client reuses the same manga detail + reader screens.
 *
 * Unlike its siblings this service fronts TWO upstreams, because neither one
 * covers the catalogue on its own:
 *
 *   mangaread.org  - complete chapter lists in a single AJAX call, self-hosted
 *                    images, no hotlink protection. The preferred source.
 *   comizy.io      - server-renders only a ~50 chapter window, and its CDN
 *                    requires a Referer. Used where mangaread has nothing.
 *
 * The two are NOT a failover pair. Which upstream serves a series is decided
 * once, at search time, and then baked into the id:
 *
 *   mr:<slug>   ->  mangaread.org      e.g. mr:god-of-blackfield-manhwa
 *   cz:<slug>   ->  comizy.io          e.g. cz:red-shirt
 *
 * That prefix matters because ids are persisted by the client - offline
 * manifests, reading progress, history. A bare slug could silently resolve to a
 * different site weeks later if coverage changed, and the stored chapter ids
 * would then match nothing, producing an empty reader with no error. Chapter
 * scoped routes therefore never fall back across upstreams: an mr: chapter id
 * is meaningless to comizy.
 *
 * Endpoints (prefixed with /manhwa/v1 by nginx):
 *   GET /search?q=<term>&limit=&offset=
 *   GET /popular?limit=
 *   GET /details?id=<prefixed id>
 *   GET /chapters?id=<prefixed id>&limit=&offset=
 *   GET /pages?id=<prefixed id>&chapterId=<chapter slug>
 *   GET /img?u=<encoded image url>
 *   GET /healthz
 */

import express from "express";
import { load as loadHtml } from "cheerio";
import { LRUCache } from "lru-cache";
import { fetch as undiciFetch } from "undici";

const PORT = Number(process.env.MANHWA_SCRAPER_PORT || 3102);

// Must be the www host. The apex 301s to www AND drops the /ajax/chapters/
// suffix on the way, so with redirect:follow a chapter-list request quietly
// lands on the series page instead - which still contains chapter links, so it
// looks like it worked while returning the wrong document.
const MANGAREAD_BASE = process.env.MANHWA_MANGAREAD_BASE || "https://www.mangaread.org";
const COMIZY_BASE = process.env.MANHWA_COMIZY_BASE || "https://comizy.io";

// A mangaread chapter-list response is ~60-110KB, so the comics/hentai default
// of 1000 entries would be ~100MB of LRU on a 961MB box already running two
// other scrapers. Keep it well under that.
const CACHE_MAX = Number(process.env.MANHWA_CACHE_MAX || 400);
const CACHE_TTL_MS = Number(process.env.MANHWA_CACHE_TTL_MS || 15 * 60 * 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.MANHWA_REQUEST_TIMEOUT_MS || 25_000);
const IMAGE_PROXY_TIMEOUT_MS = Number(process.env.MANHWA_IMAGE_TIMEOUT_MS || 20_000);

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
];

function pickUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const cache = new LRUCache({ max: CACHE_MAX, ttl: CACHE_TTL_MS });

async function cacheWrap(key, producer) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = await producer();
    cache.set(key, value);
    return value;
}

async function fetchUpstream(url, { method = "GET", referer, ajax = false, retries = 2 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const headers = {
            "User-Agent": pickUserAgent(),
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
        };
        if (referer) headers.Referer = referer;
        if (ajax) headers["X-Requested-With"] = "XMLHttpRequest";
        const res = await undiciFetch(url, {
            method,
            signal: controller.signal,
            headers,
            redirect: "follow",
            ...(method === "POST" ? { body: "" } : {}),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`Upstream HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
        }
        return await res.text();
    } catch (err) {
        if (retries > 0 && (err?.name === "AbortError" || String(err).includes("ECONNRESET"))) {
            return fetchUpstream(url, { method, referer, ajax, retries: retries - 1 });
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function clampInt(value, { min, max, def }) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
}

function isPrivateOrLocalHost(hostname) {
    if (!hostname) return true;
    const h = hostname.toLowerCase();
    if (h === "localhost" || h === "0.0.0.0") return true;
    if (h.endsWith(".local") || h.endsWith(".internal")) return true;
    const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
        if (a === 10) return true;
        if (a === 127) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 0) return true;
    }
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
    return false;
}

/**
 * Pull a JSON array out of an SSR payload by bracket-matching from its key.
 *
 * comizy embeds its state as a raw JSON blob in the HTML. A non-greedy regex
 * stops at the first "]", which lands mid-array as soon as any entry contains a
 * nested array, so match brackets properly and skip over string literals.
 */
function extractJsonArray(html, key) {
    const marker = `"${key}":[`;
    const at = html.indexOf(marker);
    if (at < 0) return null;
    const start = at + marker.length - 1;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < html.length; i += 1) {
        const ch = html[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "[") depth += 1;
        else if (ch === "]") {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(html.slice(start, i + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

/**
 * Collapse a title to a comparison key so the same series from both upstreams
 * merges onto one entry.
 *
 * Has to be forgiving about leading articles and parenthetical author notes,
 * because the upstreams disagree on both: mangaread lists "The Executioner (Lee
 * Jehwan)" where comizy has plain "Executioner". Treating those as two series
 * shows the reader a duplicate and, worse, lets comizy's truncated 50-chapter
 * copy outrank mangaread's complete 68-chapter one.
 */
function titleKey(title) {
    return String(title || "")
        .toLowerCase()
        .replace(/\(.*?\)/g, " ")
        .replace(/^\s*(?:the|a|an)\s+/, "")
        .replace(/[^a-z0-9]+/g, "")
        .replace(/manhwa$|manga$|webtoon$/, "");
}

/**
 * How well a result answers the query.
 *
 * Needed because the two upstreams can't be concatenated by source: mangaread's
 * search is fuzzy and happily returns loosely-related series, so for a title it
 * doesn't carry at all ("red shirt") its noise would otherwise bury comizy's
 * exact match. Rank by match quality first, and let source preference only
 * break ties.
 */
function relevance(title, query) {
    const t = titleKey(title);
    const q = titleKey(query);
    if (!t || !q) return 0;
    if (t === q) return 100;
    if (t.startsWith(q)) return 70;
    if (t.includes(q)) return 50;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    const lower = String(title).toLowerCase();
    const hits = words.filter((w) => lower.includes(w)).length;
    return Math.round((hits / words.length) * 30);
}

// ─────────────────────────────────────────────────────────────────────────────
// mangaread.org adapter
// ─────────────────────────────────────────────────────────────────────────────

/** WordPress appends -WxH to resized uploads; strip it to get the full-size file. */
function upgradeWpImage(url) {
    if (!url) return null;
    return url.replace(/-\d{2,4}x\d{2,4}(\.[a-z]{3,4})$/i, "$1");
}

function mangareadSlugFromHref(href) {
    const m = String(href || "").match(/\/manga\/([^/?#]+)/);
    if (!m) return null;
    const slug = m[1];
    // /manga/feed/ is the site's RSS route and matches a naive /manga/ collector.
    if (slug === "feed") return null;
    return slug;
}

// The site prefixes its image alt text with SEO boilerplate, e.g. an alt of
// "Read Manhwa Baek XX" for the series "Baek XX".
const TITLE_BOILERPLATE = /^\s*(?:read\s+)?(?:manhwa|manga|manhua|webtoon)(?:\s+read)?\s+/i;

function cleanTitle(value) {
    return String(value || "")
        .replace(TITLE_BOILERPLATE, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Search results and the catalogue grid use different wrappers but both hang a
 * thumbnail anchor and a title anchor off each card, so collect every /manga/
 * anchor and merge by slug rather than maintaining two selector sets.
 *
 * Titles are chosen by source precedence, not by length. Each card links the
 * series twice: the thumbnail anchor carries only an SEO alt ("Read Manhwa Baek
 * XX") while the caption anchor carries the real title ("Baek XX"). Preferring
 * the longer string picks the boilerplate and then blocks the good title from
 * replacing it.
 */
function mangareadParseList(html) {
    const $ = loadHtml(html);
    const bySlug = new Map();

    $('a[href*="/manga/"]').each((_, a) => {
        const $a = $(a);
        const slug = mangareadSlugFromHref($a.attr("href"));
        if (!slug) return;
        // Chapter links live under /manga/<slug>/<chapter>/ - only want series.
        const href = $a.attr("href") || "";
        if (/\/manga\/[^/]+\/[^/]+/.test(href.replace(/\/+$/, "") + "/")) {
            const tail = href.replace(/\/+$/, "").split("/").slice(-1)[0];
            if (tail !== slug) return;
        }

        const entry = bySlug.get(slug) || {
            id: `mr:${slug}`,
            title: "",
            titleRank: 0,
            cover: null,
            url: `${MANGAREAD_BASE}/manga/${slug}/`,
            description: "",
            tags: [],
            status: "",
            year: null,
        };

        const img = $a.find("img").first();
        if (img.length) {
            const raw = (img.attr("data-src") || img.attr("src") || "").trim();
            if (raw && !raw.startsWith("data:")) entry.cover = upgradeWpImage(raw);
        }

        // Highest-ranked available source wins, so the alt-text fallback can
        // never displace the caption anchor's real title.
        const candidates = [
            [3, $a.text()],
            [2, $a.attr("title")],
            [1, img.attr("alt")],
        ];
        for (const [rank, raw] of candidates) {
            const value = cleanTitle(raw);
            if (value && rank > entry.titleRank) {
                entry.title = value;
                entry.titleRank = rank;
            }
        }

        bySlug.set(slug, entry);
    });

    return [...bySlug.values()]
        .filter((e) => e.title)
        .map(({ titleRank, ...rest }) => rest);
}

function mangareadParseDetail(html, slug) {
    const $ = loadHtml(html);

    const title =
        $(".post-title h1").first().text().trim() ||
        $("h1").first().text().trim() ||
        slug;

    const img = $(".summary_image img").first();
    const cover = upgradeWpImage((img.attr("data-src") || img.attr("src") || "").trim() || null);

    // Every metadata row is <div class="post-content_item"> with a
    // .summary-heading <h5> label and a .summary-content value.
    const fields = {};
    $(".post-content_item, .post-status .post-content_item").each((_, el) => {
        const $el = $(el);
        const label = $el.find(".summary-heading").text().trim().toLowerCase();
        const value = $el.find(".summary-content").text().replace(/\s+/g, " ").trim();
        if (label && value) fields[label] = value;
    });

    const splitList = (v) =>
        (v || "")
            .split(/\s*,\s*/)
            .map((s) => s.trim())
            .filter(Boolean);

    const authors = [
        ...splitList(fields["author(s)"]),
        ...splitList(fields["artist(s)"]),
    ].filter((v, i, a) => a.indexOf(v) === i);

    const description =
        $(".description-summary .summary__content").text().replace(/\s+/g, " ").trim() ||
        $(".description-summary").text().replace(/\s+/g, " ").trim() ||
        "";

    const yearMatch = (fields["release"] || "").match(/\d{4}/);

    return {
        id: `mr:${slug}`,
        title,
        cover,
        description,
        author: authors.join(", "),
        authors,
        tags: splitList(fields["genre(s)"]),
        status: fields["status"] || "",
        year: yearMatch ? Number(yearMatch[0]) : null,
        url: `${MANGAREAD_BASE}/manga/${slug}/`,
    };
}

function mangareadParseChapters(html) {
    const $ = loadHtml(html);
    const issues = [];
    $("li.wp-manga-chapter").each((_, li) => {
        const $li = $(li);
        const $a = $li.find("a").first();
        const href = ($a.attr("href") || "").trim();
        if (!href) return;
        const chapterSlug = href.replace(/\/+$/, "").split("/").pop();
        if (!chapterSlug) return;
        const label = $a.text().replace(/\s+/g, " ").trim();
        const numMatch = chapterSlug.match(/chapter-(\d+(?:[.-]\d+)?)/i) || label.match(/(\d+(?:\.\d+)?)/);
        issues.push({
            id: chapterSlug,
            title: label || chapterSlug,
            number: numMatch ? numMatch[1].replace("-", ".") : null,
            // The site only renders relative dates ("2 days ago"), which aren't
            // worth mis-parsing into a wrong absolute timestamp.
            publishAt: null,
        });
    });
    // Upstream lists newest-first; the client expects reading order.
    return issues.reverse();
}

function mangareadParsePages(html) {
    const $ = loadHtml(html);
    const pages = [];
    $("img.wp-manga-chapter-img").each((_, img) => {
        // These src attributes are padded with tabs and newlines - cheerio does
        // not trim, and an untrimmed URL fetches as a 0-page chapter.
        const raw = ($(img).attr("data-src") || $(img).attr("src") || "").trim();
        if (raw && /^https?:\/\//i.test(raw)) pages.push(raw);
    });
    return pages;
}

const mangaread = {
    prefix: "mr",
    base: MANGAREAD_BASE,
    async search(q) {
        const url = `${MANGAREAD_BASE}/?s=${encodeURIComponent(q)}&post_type=wp-manga`;
        return mangareadParseList(await fetchUpstream(url, { referer: MANGAREAD_BASE }));
    },
    async popular() {
        const url = `${MANGAREAD_BASE}/manga/?m_orderby=views`;
        return mangareadParseList(await fetchUpstream(url, { referer: MANGAREAD_BASE }));
    },
    async details(slug) {
        const url = `${MANGAREAD_BASE}/manga/${encodeURIComponent(slug)}/`;
        return mangareadParseDetail(await fetchUpstream(url, { referer: MANGAREAD_BASE }), slug);
    },
    async chapters(slug) {
        const url = `${MANGAREAD_BASE}/manga/${encodeURIComponent(slug)}/ajax/chapters/`;
        const html = await fetchUpstream(url, {
            method: "POST",
            ajax: true,
            referer: `${MANGAREAD_BASE}/manga/${slug}/`,
        });
        return mangareadParseChapters(html);
    },
    async pages(slug, chapterSlug) {
        const url = `${MANGAREAD_BASE}/manga/${encodeURIComponent(slug)}/${encodeURIComponent(chapterSlug)}/`;
        return mangareadParsePages(await fetchUpstream(url, { referer: MANGAREAD_BASE }));
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// comizy.io adapter
// ─────────────────────────────────────────────────────────────────────────────

function comizyListItem(raw) {
    const slug = raw?.slug || String(raw?.url || "").replace(/^\/+/, "");
    if (!slug) return null;
    return {
        id: `cz:${slug}`,
        title: raw.name || slug,
        cover: raw.cover || null,
        url: `${COMIZY_BASE}/${slug}`,
        description: "",
        tags: [],
        status: raw.status || "",
        year: null,
    };
}

/** First integer after "chapter-" is the displayed chapter number. */
function comizyChapterNumber(slug) {
    const m = String(slug || "").match(/chapter-(\d+)/i);
    return m ? Number(m[1]) : null;
}

/**
 * comizy server-renders only the ~50 newest chapters plus chapter 1, and paging
 * the URL returns the same window, so the middle of a long series is missing
 * from the markup entirely. Those chapters do exist and their pages load fine -
 * only the index is truncated - so fill the holes by synthesising slugs.
 *
 * The ceiling comes from the integers observed in real slugs, never from
 * "chaptersCount": that field is an internal ordinal high-water mark, not a
 * count. For Red Shirt it reads 74 while the newest real chapter is 67, and
 * chapter-68 upward 404. The per-entry "number" field disagrees too (slug
 * chapter-67 has number 74).
 *
 * The floor is always 1, not the lowest slug seen. The window slides: chapter 1
 * is sometimes rendered and sometimes not, and anchoring on the lowest observed
 * slug meant Red Shirt silently began at chapter 24 whenever it dropped out.
 * Over-guessing is safe -- a synthesised slug that doesn't exist simply yields
 * no images and the reader reports the chapter unavailable -- whereas
 * under-guessing hides real chapters with no signal at all.
 */
function comizySynthesiseChapters(real) {
    const seen = new Map();
    for (const c of real) {
        const n = comizyChapterNumber(c.id);
        if (n != null && !seen.has(n)) seen.set(n, c);
    }
    const nums = [...seen.keys()].sort((a, b) => a - b);
    if (!nums.length) return real;

    const out = [];
    for (let n = 1; n <= nums[nums.length - 1]; n += 1) {
        const hit = seen.get(n);
        if (hit) {
            out.push(hit);
        } else {
            out.push({
                id: `chapter-${n}`,
                title: `Chapter ${n}`,
                number: String(n),
                publishAt: null,
                synthesised: true,
            });
        }
    }
    return out;
}

function comizyParseSeries(html, slug) {
    const raw = extractJsonArray(html, "chapters") || [];
    const real = raw
        .map((c) => {
            const chapterSlug = c?.slug || String(c?.url || "").split("/").pop();
            if (!chapterSlug) return null;
            return {
                id: chapterSlug,
                title: c.name || chapterSlug,
                number:
                    comizyChapterNumber(chapterSlug) != null
                        ? String(comizyChapterNumber(chapterSlug))
                        : null,
                publishAt: c.updatedAt || null,
            };
        })
        .filter(Boolean);

    const name =
        (html.match(/"name":"([^"]{1,120})","altName"/) || [])[1] ||
        (html.match(/<title>([^<]*)<\/title>/i) || [, ""])[1].split("|")[0].trim() ||
        slug;
    const cover = (html.match(/"cover":"(https:\/\/[^"]+)"/) || [])[1] || null;
    const status = (html.match(/"status":"([a-z]+)"/i) || [])[1] || "";

    return { name, cover, status, chapters: comizySynthesiseChapters(real) };
}

const comizy = {
    prefix: "cz",
    base: COMIZY_BASE,
    async search(q) {
        const url = `${COMIZY_BASE}/search?q=${encodeURIComponent(q)}`;
        const html = await fetchUpstream(url, { referer: COMIZY_BASE });
        const items = extractJsonArray(html, "ssrItems") || [];
        return items.map(comizyListItem).filter(Boolean);
    },
    async popular() {
        const html = await fetchUpstream(`${COMIZY_BASE}/`, { referer: COMIZY_BASE });
        const items = extractJsonArray(html, "ssrItems") || [];
        return items.map(comizyListItem).filter(Boolean);
    },
    async details(slug) {
        const html = await fetchUpstream(`${COMIZY_BASE}/${encodeURIComponent(slug)}`, {
            referer: COMIZY_BASE,
        });
        const s = comizyParseSeries(html, slug);
        return {
            id: `cz:${slug}`,
            title: s.name,
            cover: s.cover,
            description: "",
            author: "",
            authors: [],
            tags: [],
            status: s.status,
            year: null,
            url: `${COMIZY_BASE}/${slug}`,
        };
    },
    async chapters(slug) {
        const html = await fetchUpstream(`${COMIZY_BASE}/${encodeURIComponent(slug)}`, {
            referer: COMIZY_BASE,
        });
        return comizyParseSeries(html, slug).chapters;
    },
    async pages(slug, chapterSlug) {
        // Synthesised slugs are unverified by design (HEAD-checking every hole
        // at /chapters time would cost dozens of requests on a 1-CPU box), so
        // resolve them here. Irregular series disambiguate with a -1 suffix.
        const candidates = [chapterSlug];
        if (/^chapter-\d+$/i.test(chapterSlug)) candidates.push(`${chapterSlug}-1`);
        for (const cand of candidates) {
            try {
                const html = await fetchUpstream(
                    `${COMIZY_BASE}/${encodeURIComponent(slug)}/${encodeURIComponent(cand)}`,
                    { referer: `${COMIZY_BASE}/${slug}` },
                );
                const images = extractJsonArray(html, "images") || [];
                if (images.length) return images;
            } catch {
                // 404 on a synthesised guess - try the next shape.
            }
        }
        return [];
    },
};

const ADAPTERS = { mr: mangaread, cz: comizy };

/** Split a prefixed id. Unprefixed ids are rejected rather than guessed at. */
function parseId(id) {
    const m = String(id || "").match(/^(mr|cz):(.+)$/);
    if (!m) return null;
    return { adapter: ADAPTERS[m[1]], slug: m[2] };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP surface
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
});

app.get("/healthz", (_req, res) => {
    res.json({
        ok: true,
        upstream: { mangaread: MANGAREAD_BASE, comizy: COMIZY_BASE },
        cacheSize: cache.size,
    });
});

// Operator probe - not used by the app.
app.get("/debug/probe", async (req, res) => {
    const which = String(req.query.adapter || "mr");
    const p = String(req.query.path || "").trim();
    const adapter = ADAPTERS[which];
    if (!adapter) return res.status(400).json({ error: "adapter must be mr or cz" });
    if (!p.startsWith("/")) return res.status(400).json({ error: "path must start with /" });
    try {
        const html = await fetchUpstream(`${adapter.base}${p}`, { referer: adapter.base });
        res.json({
            length: html.length,
            titleSnippet: (html.match(/<title>([^<]*)<\/title>/i) || [, ""])[1].trim(),
            sampleHead: html.slice(0, 400),
        });
    } catch (err) {
        res.status(502).json({ error: String(err?.message || err) });
    }
});

app.get("/popular", async (req, res) => {
    const limit = clampInt(req.query.limit, { min: 1, max: 60, def: 24 });
    try {
        const items = await cacheWrap(`popular:${limit}`, async () => {
            const primary = await mangaread.popular().catch(() => []);
            if (primary.length >= limit) return primary.slice(0, limit);
            // Pad rather than replace, so a mangaread hiccup still shows a shelf.
            const extra = await comizy.popular().catch(() => []);
            const seen = new Set(primary.map((i) => titleKey(i.title)));
            return [...primary, ...extra.filter((i) => !seen.has(titleKey(i.title)))].slice(0, limit);
        });
        res.json({ items });
    } catch (err) {
        console.error("popular failed", err);
        res.status(502).json({ error: String(err?.message || err) });
    }
});

app.get("/search", async (req, res) => {
    const q = String(req.query.q || "").trim();
    const limit = clampInt(req.query.limit, { min: 1, max: 60, def: 20 });
    const offset = clampInt(req.query.offset, { min: 0, max: 500, def: 0 });
    if (!q) return res.json({ items: [] });
    try {
        const items = await cacheWrap(`search:${q.toLowerCase()}:${limit}:${offset}`, async () => {
            // Merge, don't fail over: mangaread wins collisions because its
            // chapter lists are complete, and comizy supplies the titles
            // mangaread simply doesn't carry. One upstream erroring must not
            // suppress the other's results.
            const [mr, cz] = await Promise.allSettled([mangaread.search(q), comizy.search(q)]);
            const merged = [];
            const seen = new Set();
            for (const settled of [mr, cz]) {
                if (settled.status !== "fulfilled") continue;
                for (const item of settled.value) {
                    const key = titleKey(item.title);
                    // Deduped mangaread-first, so when both carry a series the
                    // one with the complete chapter list is what survives.
                    if (!key || seen.has(key)) continue;
                    seen.add(key);
                    merged.push(item);
                }
            }
            if (!merged.length && mr.status === "rejected" && cz.status === "rejected") {
                throw mr.reason;
            }
            // Sort is stable, so equally-relevant results keep the mangaread-
            // first order established above.
            merged.sort((a, b) => relevance(b.title, q) - relevance(a.title, q));
            return merged.slice(offset, offset + limit);
        });
        res.json({ items });
    } catch (err) {
        console.error("search failed", err);
        res.status(502).json({ error: String(err?.message || err) });
    }
});

app.get("/details", async (req, res) => {
    const id = String(req.query.id || "").trim();
    const parsed = parseId(id);
    if (!id) return res.status(400).json({ error: "missing id" });
    if (!parsed) return res.status(400).json({ error: "id must be prefixed mr: or cz:" });
    try {
        const comic = await cacheWrap(`details:${id}`, () =>
            parsed.adapter.details(parsed.slug),
        );
        if (!comic) return res.status(404).json({ error: "not found" });
        res.json({ comic });
    } catch (err) {
        console.error("details failed", err);
        res.status(502).json({ error: String(err?.message || err) });
    }
});

app.get("/chapters", async (req, res) => {
    const id = String(req.query.id || "").trim();
    const parsed = parseId(id);
    const limit = clampInt(req.query.limit, { min: 1, max: 2000, def: 2000 });
    const offset = clampInt(req.query.offset, { min: 0, max: 5000, def: 0 });
    if (!id) return res.status(400).json({ error: "missing id" });
    if (!parsed) return res.status(400).json({ error: "id must be prefixed mr: or cz:" });
    try {
        const all = await cacheWrap(`chapters:${id}`, () => parsed.adapter.chapters(parsed.slug));
        res.json({ issues: all.slice(offset, offset + limit) });
    } catch (err) {
        console.error("chapters failed", err);
        res.status(502).json({ error: String(err?.message || err) });
    }
});

app.get("/pages", async (req, res) => {
    const id = String(req.query.id || "").trim();
    const chapterId = String(req.query.chapterId || "").trim();
    const parsed = parseId(id);
    if (!id || !chapterId) return res.status(400).json({ error: "missing id or chapterId" });
    if (!parsed) return res.status(400).json({ error: "id must be prefixed mr: or cz:" });
    try {
        const pages = await cacheWrap(`pages:v1:${id}:${chapterId}`, () =>
            parsed.adapter.pages(parsed.slug, chapterId),
        );
        // Neither upstream serves HTML at image URLs the way xoxocomic does, so
        // there is nothing to HEAD-validate - keep the envelope shape anyway so
        // the client's optional-field reads behave identically across sources.
        res.json({
            pages,
            droppedCount: 0,
            totalDiscovered: pages.length,
            fallbackToRaw: false,
        });
    } catch (err) {
        console.error("pages failed", err);
        res.status(502).json({ error: String(err?.message || err) });
    }
});

app.get("/img", async (req, res) => {
    const u = String(req.query.u || "").trim();
    if (!u) return res.status(400).type("text/plain").send("missing u");

    let target;
    try {
        target = new URL(u);
    } catch {
        return res.status(400).type("text/plain").send("invalid url");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
        return res.status(400).type("text/plain").send("invalid scheme");
    }
    if (isPrivateOrLocalHost(target.hostname)) {
        return res.status(403).type("text/plain").send("forbidden host");
    }

    // Referer is chosen by image host, not by whichever adapter produced the
    // page list. comizy's CDN hard-403s without it; mangaread doesn't care.
    // Sending the wrong one is the difference between a page and a blank.
    const referer = /(^|\.)cmzcdn\.org$/i.test(target.hostname)
        ? `${COMIZY_BASE}/`
        : `${MANGAREAD_BASE}/`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_PROXY_TIMEOUT_MS);
    try {
        const upstream = await undiciFetch(target.toString(), {
            method: "GET",
            signal: controller.signal,
            headers: {
                "User-Agent": pickUserAgent(),
                Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                Referer: referer,
            },
            redirect: "follow",
        });
        const ct = (upstream.headers.get("content-type") || "").toLowerCase();
        if (!upstream.ok || !ct.startsWith("image/")) {
            return res.status(404).type("text/plain").send("not an image");
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.set("Content-Type", ct);
        res.set("Content-Length", String(buf.length));
        res.set("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable");
        res.set("Access-Control-Allow-Origin", "*");
        res.status(200).end(buf);
    } catch (err) {
        res.status(502).type("text/plain").send(String(err?.message || err).slice(0, 200));
    } finally {
        clearTimeout(timer);
    }
});

app.use((_req, res) => res.status(404).json({ error: "not found" }));

app.listen(PORT, () => {
    console.log(
        `Sakura manhwa scraper listening on :${PORT} ` +
            `(mangaread=${MANGAREAD_BASE}, comizy=${COMIZY_BASE})`,
    );
});
