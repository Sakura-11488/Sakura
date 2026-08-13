/**
 * Sakura Hentai (18+) scraper proxy.
 *
 * Runs on the DigitalOcean droplet behind nginx at /hentai/v1/*.
 * Mirrors the Comics scraper's endpoint contract and JSON envelopes so the
 * mobile client can reuse the same manga detail/reader screens — the only
 * difference is the upstream (HentaiFox) and its gallery-based model, which we
 * flatten onto the manga "one work, one chapter" shape.
 *
 * Responsibilities:
 *   - Fetch HTML from the upstream hentai source (HentaiFox primary) through an
 *     impersonating client (see upstream.js — Cloudflare blocks Node's TLS
 *     fingerprint, not our IP)
 *   - Parse with Cheerio into stable JSON envelopes consumed by the app
 *   - LRU cache every endpoint so repeat views are instant
 *   - Never cache, and never 200, an empty parse
 *   - Stream images through /img (free, direct — the CDN is unprotected)
 *
 * Endpoints (prefixed with /hentai/v1 by nginx):
 *   GET /search?q=<term>&limit=&offset=
 *   GET /popular?limit=
 *   GET /details?id=<galleryId>
 *   GET /chapters?id=<galleryId>            // always one synthetic "gallery" issue
 *   GET /pages?id=<galleryId>&chapterId=gallery
 *   GET /img?u=<encoded image url>          // streams bytes through the droplet
 *   GET /healthz                            // observed upstream state, 503 when dead
 *   GET /readyz                             // WALKS THE READ PATH, 503 when it fails
 *
 * Gallery -> manga mapping:
 *   HentaiFox galleries are single works with no chapters. `/chapters` returns
 *   exactly one issue `{ id: "gallery", ... }`; `/pages` ignores chapterId and
 *   returns every page image URL for the gallery, derived from the embedded
 *   `g_th` map (per-page extension code) + the CDN base dir scraped from the
 *   page thumbnails.
 */

import express from "express";
import { load as loadHtml } from "cheerio";
import { LRUCache } from "lru-cache";
import { fetch as undiciFetch } from "undici";
import { createUpstream, UpstreamError } from "./upstream.js";

const PORT = Number(process.env.HENTAI_SCRAPER_PORT || 3101);
const UPSTREAM_BASE = process.env.HENTAI_UPSTREAM_BASE || "https://hentaifox.com";
const CACHE_MAX = Number(process.env.HENTAI_CACHE_MAX || 1000);
const CACHE_TTL_MS = Number(process.env.HENTAI_CACHE_TTL_MS || 60 * 60 * 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.HENTAI_REQUEST_TIMEOUT_MS || 8_000);
const HTML_CACHE_BYTES = Number(process.env.HENTAI_HTML_CACHE_BYTES || 24 * 1024 * 1024);
const HTML_CACHE_TTL_MS = Number(process.env.HENTAI_HTML_CACHE_TTL_MS || 5 * 60 * 1000);
const READY_TTL_MS = Number(process.env.HENTAI_READY_TTL_MS || 60_000);
const DEBUG_TOKEN = String(process.env.HENTAI_DEBUG_TOKEN || "").trim();
const IMAGE_CDN_FALLBACK = (process.env.HENTAI_IMAGE_CDN || "https://i.hentaifox.com").replace(/\/+$/, "");

const upstream = createUpstream({
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxRetries: Number(process.env.HENTAI_UPSTREAM_MAX_RETRIES ?? 1),
    backoffMs: Number(process.env.HENTAI_UPSTREAM_BACKOFF_MS || 600),
    concurrency: Number(process.env.HENTAI_UPSTREAM_CONCURRENCY || 4),
    queueMax: Number(process.env.HENTAI_UPSTREAM_QUEUE_MAX || 24),
    blockCooldownMs: Number(process.env.HENTAI_BLOCK_COOLDOWN_MS || 90_000),
    proxyUrl: process.env.HENTAI_PROXY_URL || "",
});

// HentaiFox encodes each page's image format in the embedded `g_th` map as a
// single-letter code. Map it to the real file extension.
const CDN_EXT = { j: "jpg", p: "png", w: "webp", g: "gif", b: "bmp" };

const cache = new LRUCache({
    max: CACHE_MAX,
    ttl: CACHE_TTL_MS,
    // `allowStale` on the CONSTRUCTOR is a trap in lru-cache v11: a normal get()
    // returns the expired value AND deletes it, so data is served stale without
    // a refresh and the error path below finds nothing left. Verified against
    // lru-cache 11.0.2. This pair is the combination that actually works:
    // normal get() misses on expiry, and only the explicit error-path lookup
    // can reach the stale entry.
    allowStale: false,
    noDeleteOnStaleGet: true,
});

// Raw gallery HTML, shared by /details and /pages so opening a gallery costs ONE
// upstream fetch instead of two identical ones. BYTE-bounded on purpose: a
// 200-page gallery's HTML is ~300KB resident (V8 stores these as two-byte
// strings), so an entry-counted cache of 1000 would be ~150MB and trip pm2's
// max_memory_restart on a box with ~340MB free.
const htmlCache = new LRUCache({
    max: 64,
    maxSize: HTML_CACHE_BYTES,
    sizeCalculation: (v) => Math.max(1, String(v).length * 2),
    ttl: HTML_CACHE_TTL_MS,
});

/**
 * @param {(value:any) => boolean} shouldCache guard so an EMPTY result is never
 *        cached. Caching `[]` is how a one-off parse failure becomes an hour of
 *        blank screens that look like success.
 */
async function cacheWrap(key, producer, { shouldCache = () => true } = {}) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    try {
        const value = await producer();
        if (shouldCache(value)) cache.set(key, value);
        return value;
    } catch (err) {
        const stale = cache.get(key, { allowStale: true });
        if (stale !== undefined) {
            console.warn(`[cache] serving stale ${key} after ${err?.code || "error"}`);
            return stale;
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Validators. These assert the PRODUCT, not the byte count. A challenge page, an
// error page or a redesigned page can all be longer than any length threshold.

function isHentaiFoxPage(html) {
    return String(html || "").slice(0, 4000).toLowerCase().includes("hentaifox");
}

function validateListPage(html) {
    if (!isHentaiFoxPage(html)) return "response is not a HentaiFox page";
    if (parseListPage(html).length === 0) return "0 galleries parsed (markup drift?)";
    return true;
}

/**
 * A search can legitimately return zero results, so we cannot require items.
 * But a 0-item response must still prove we reached HentaiFox's search handler,
 * otherwise a markup regression answers HTTP 200 with an empty list and the
 * app's four home rows go quietly blank — success-shaped failure again.
 * Verified against a real zero-result page: it renders
 * `<title>Searching: <query> - HentaiFox</title>` and no gallery cards at all.
 */
function validateSearchPage(html) {
    if (!isHentaiFoxPage(html)) return "response is not a HentaiFox page";
    if (parseListPage(html).length > 0) return true;
    if (/<title>\s*Searching:/i.test(html)) return true;
    return "0 galleries and no search-results marker (markup drift?)";
}

function validateGalleryPage(html) {
    if (!isHentaiFoxPage(html)) return "response is not a HentaiFox page";
    if (!parseGth(html)) return "g_th page manifest missing";
    if (buildPageUrls(html).length === 0) return "0 page URLs derived (CDN base dir missing)";
    return true;
}

// ---------------------------------------------------------------------------

function fetchListHtml(url) {
    return upstream.fetchHtml(url, { validate: validateListPage });
}

function fetchSearchHtml(url) {
    return upstream.fetchHtml(url, { validate: validateSearchPage });
}

/**
 * One fetch per gallery, shared by /details and /pages. Validated before it is
 * cached, so a gallery page that cannot produce page URLs is never stored and
 * never served as a successful-looking empty reader.
 */
async function fetchGalleryHtml(id) {
    const key = `html:gallery:${id}`;
    const hit = htmlCache.get(key);
    if (hit !== undefined) return hit;
    const html = await upstream.fetchHtml(galleryUrl(encodeURIComponent(id)), {
        validate: validateGalleryPage,
    });
    htmlCache.set(key, html);
    return html;
}

function absolute(path) {
    if (!path) return null;
    if (path.startsWith("//")) return `https:${path}`;
    if (/^https?:\/\//i.test(path)) return path;
    return `${UPSTREAM_BASE.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function galleryUrl(id) {
    return `${UPSTREAM_BASE}/gallery/${id}/`;
}

function extractGalleryId(url) {
    if (!url) return null;
    const m = String(url).match(/\/gallery\/(\d+)\//);
    return m ? m[1] : null;
}

// Home/search/tag pages all render the same gallery card grid. Each gallery is
// linked twice per card (image anchor + caption anchor), so collect by id and
// merge: the caption anchor supplies the title, the image anchor supplies the
// cover thumbnail.
function parseListPage(html) {
    const $ = loadHtml(html);
    const byId = new Map();

    $('a[href*="/gallery/"]').each((_, a) => {
        const $a = $(a);
        const href = $a.attr("href") || "";
        const id = extractGalleryId(href);
        if (!id) return;

        const entry = byId.get(id) || { id, title: "", cover: null, url: galleryUrl(id) };

        const text = $a.text().trim();
        if (!entry.title && text) entry.title = text;

        if (!entry.cover) {
            const img = $a.find("img").first();
            const src = img.attr("data-src") || img.attr("data-original") || img.attr("src");
            // HentaiFox emits these protocol-relative (//i3.hentaifox.com/...).
            if (src && !src.startsWith("data:")) entry.cover = absolute(src);
            if (!entry.title) {
                const alt = (img.attr("alt") || "").trim();
                if (alt) entry.title = alt;
            }
        }

        byId.set(id, entry);
    });

    const out = [];
    for (const e of byId.values()) {
        if (!e.title) continue;
        out.push({ id: e.id, title: e.title, cover: e.cover || null, url: e.url });
    }
    return out;
}

// The reader bootstraps from `g_th = $.parseJSON('{"1":"w,1084,1540",...}')`
// where the key is the 1-based page number and the value is
// "<extCode>,<width>,<height>". This is the authoritative page list.
function parseGth(html) {
    const m = html.match(/g_th\s*=\s*\$\.parseJSON\('([^']+)'\)/);
    if (!m) return null;
    try {
        const obj = JSON.parse(m[1]);
        return obj && typeof obj === "object" ? obj : null;
    } catch {
        return null;
    }
}

function countPages(html) {
    const gth = parseGth(html);
    if (gth) return Object.keys(gth).length;
    const text = html.replace(/<[^>]+>/g, " ");
    const m = text.match(/Pages:\s*(\d+)/i);
    return m ? Number(m[1]) : 0;
}

// Every page image lives in one CDN directory; the page thumbnails on the
// gallery detail page expose it as `.../<shard>/<loadId>/<n>t.<ext>`. Strip the
// filename to get the base dir, then rebuild full-size URLs as `<base><n>.<ext>`
// using the per-page extension from g_th.
function parsePageBaseDir(html) {
    const $ = loadHtml(html);
    let base = null;
    $("img").each((_, img) => {
        if (base) return;
        const raw =
            $(img).attr("data-src") ||
            $(img).attr("data-original") ||
            $(img).attr("src") ||
            "";
        // Some HentaiFox URLs are protocol-relative (//i3.hentaifox.com/...);
        // without this the regex missed them and the reader came back empty.
        const src = raw.startsWith("//") ? `https:${raw}` : raw;
        const m = src.match(/^(https?:\/\/\S+\/)\d+t\.(?:jpg|png|webp|gif|bmp)$/i);
        if (m) base = m[1];
    });
    if (base) return base;

    // Fallback: the gallery page carries the CDN coordinates as hidden inputs
    // (#load_dir, #load_id). The i / i2 / i3 shards are aliases of one origin —
    // verified: i and i2 return byte-identical bodies for the same path — so any
    // shard works. This branch means a thumbnail markup change degrades to a
    // still-working reader instead of a silently empty one.
    const dir = ($("#load_dir").attr("value") || "").trim();
    const loadId = ($("#load_id").attr("value") || "").trim();
    if (/^[\w-]+$/.test(dir) && /^\d+$/.test(loadId)) {
        return `${IMAGE_CDN_FALLBACK}/${dir}/${loadId}/`;
    }
    return null;
}

function buildPageUrls(html) {
    const gth = parseGth(html);
    const base = parsePageBaseDir(html);
    if (!gth || !base) return [];
    const pages = [];
    const nums = Object.keys(gth)
        .map((k) => Number(k))
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => a - b);
    for (const n of nums) {
        const code = String(gth[String(n)]).split(",")[0].trim().toLowerCase();
        const ext = CDN_EXT[code] || "jpg";
        pages.push(`${base}${n}.${ext}`);
    }
    return pages;
}

function parseDetailPage(html, id) {
    const $ = loadHtml(html);

    const title =
        $("h1").first().text().trim() ||
        ($("title").text().split(" - ")[0] || "").trim() ||
        `Gallery ${id}`;

    let cover =
        $(".cover img").first().attr("data-src") ||
        $(".cover img").first().attr("data-original") ||
        $(".cover img").first().attr("src") ||
        null;
    if (cover && cover.startsWith("data:")) cover = null;

    // HentaiFox renders every taxonomy (tags, artists, groups, parodies,
    // characters, categories, languages) as <a class="tag_btn" href="/<kind>/<slug>/">.
    // NOTE: it emits class='tag_btn ' with single quotes and a trailing space —
    // a raw grep for class="tag_btn" finds nothing. Cheerio tokenizes correctly.
    // Do not "fix" this selector.
    const buckets = {
        tag: [],
        artist: [],
        group: [],
        parody: [],
        character: [],
        category: [],
        language: [],
    };
    $("a.tag_btn").each((_, a) => {
        const $a = $(a);
        const href = $a.attr("href") || "";
        const m = href.match(/^\/([a-z]+)\/[^/]+\/?$/);
        if (!m) return;
        const kind = m[1];
        if (!(kind in buckets)) return;
        // The visible label includes a <span class="t_badge"> count — drop it.
        const name = $a.clone().children("span").remove().end().text().trim();
        if (name) buckets[kind].push(name);
    });

    const authors = [...buckets.artist, ...buckets.group];
    const tags = buckets.tag.length ? buckets.tag : buckets.category;
    const pageCount = countPages(html);

    return {
        id,
        title,
        cover: cover ? absolute(cover) : null,
        description: "",
        author: authors.join(", "),
        authors,
        tags,
        status: "Completed",
        year: null,
        pageCount,
        url: galleryUrl(id),
    };
}

function clampInt(value, { min, max, def }) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
}

const IMAGE_PROXY_TIMEOUT_MS = Number(process.env.HENTAI_IMAGE_TIMEOUT_MS || 20_000);

// Trust the bytes, not the content-type: an impersonating or proxying client can
// hand back a genuine JPEG labelled text/plain. Returns null for anything that
// is not a recognised image (an HTML 404, a challenge page, an error blob).
// BMP is included because CDN_EXT can emit .bmp.
function sniffImageType(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
    if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
    if (
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) return "image/webp";
    return null;
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

// Never echo the upstream body back to the app: that is how a raw Cloudflare
// interstitial ended up rendered inside the 18+ tab. Log the detail, return a
// short stable message plus a machine-readable code.
const ERROR_TEXT = {
    BLOCKED: "upstream is bot-challenging this server; backing off",
    BUSY: "too many upstream requests in flight; retry shortly",
    TIMEOUT: "upstream timed out",
    HTTP: "upstream returned an error",
    INVALID: "upstream returned unusable HTML (parser or markup drift)",
    INTERNAL: "internal error",
};
const ERROR_STATUS = { BLOCKED: 503, BUSY: 503, TIMEOUT: 504, HTTP: 502, INVALID: 502, INTERNAL: 500 };

function clientError(res, err, where) {
    const code = err instanceof UpstreamError ? err.code : "INTERNAL";
    console.error(`[${where}] ${code}: ${String(err?.message || err).slice(0, 300)}`);
    res.status(ERROR_STATUS[code] || 502).json({ error: ERROR_TEXT[code] || "upstream unavailable", code });
}

const app = express();

app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
});

/**
 * NOT a liveness check any more. `ok: true` used to be a literal, which is
 * exactly what hid the Cloudflare block for as long as it did: the process was
 * up, the read path was dead, and every probe was green. This reports what real
 * traffic has actually observed, and 503s when the upstream is failing.
 * It makes no network call — during a block, a fetching /healthz would itself
 * hang past nginx's read timeout and become unreachable exactly when needed.
 * Use /readyz to prove the path works.
 */
app.get("/healthz", (_req, res) => {
    const fetchStats = upstream.stats();
    const ok = !fetchStats.blocked && fetchStats.consecutiveFailures < 3;
    res.status(ok ? 200 : 503).json({
        ok,
        upstream: UPSTREAM_BASE,
        observedTraffic: fetchStats.requests > 0,
        cacheSize: cache.size,
        htmlCacheBytes: htmlCache.calculatedSize,
        fetch: fetchStats,
    });
});

/**
 * Readiness = the read path actually works, end to end. Parses the home grid AND
 * derives page URLs from a real gallery, because a listing can parse perfectly
 * while every reader comes back empty. Cached briefly so probes cannot become a
 * load source against a bot-scored origin.
 */
let readyCache = { at: 0, payload: null };

async function runReadiness() {
    const checks = { listItems: 0, galleryId: null, title: null, pageUrls: 0, samplePage: null };
    const list = parseListPage(await fetchListHtml(`${UPSTREAM_BASE}/`));
    checks.listItems = list.length;
    if (list.length === 0) return { ok: false, reason: "home page parsed 0 galleries", checks };

    const galleryId = String(process.env.HENTAI_READY_GALLERY_ID || "").trim() || list[0].id;
    checks.galleryId = galleryId;
    const html = await fetchGalleryHtml(galleryId);
    const detail = parseDetailPage(html, galleryId);
    const pages = buildPageUrls(html);
    checks.title = detail.title;
    checks.pageUrls = pages.length;
    checks.samplePage = pages[0] || null;

    if (!detail.id || !detail.title) return { ok: false, reason: "detail parse produced no title", checks };
    if (pages.length === 0) return { ok: false, reason: "0 page URLs derived", checks };
    return { ok: true, checks };
}

app.get("/readyz", async (_req, res) => {
    const now = Date.now();
    if (readyCache.payload && now - readyCache.at < READY_TTL_MS) {
        return res.status(readyCache.payload.ok ? 200 : 503).json({ ...readyCache.payload, cached: true });
    }
    let payload;
    try {
        payload = await runReadiness();
    } catch (err) {
        payload = {
            ok: false,
            reason: err instanceof UpstreamError ? `${err.code}: ${err.message}` : String(err?.message || err),
            checks: null,
        };
    }
    readyCache = { at: now, payload };
    res.status(payload.ok ? 200 : 503).json(payload);
});

// Operator probe — NOT exposed to the app. Diagnoses selector / bot-detection
// issues without SSHing into a shell.
//
// Token-gated now. It was an unauthenticated arbitrary-path fetcher aimed at a
// Cloudflare-scored origin from our only IP: anyone could have looped it until
// hentaifox hard-blocked the droplet. nginx also denies the path outright (see
// nginx-snippet.conf) — run it against 127.0.0.1:3101 over SSH instead.
app.get("/debug/probe", async (req, res) => {
    if (!DEBUG_TOKEN || req.get("x-sakura-debug") !== DEBUG_TOKEN) {
        return res.status(404).json({ error: "not found" });
    }
    const p = String(req.query.path || "").trim();
    if (!p.startsWith("/")) {
        return res.status(400).json({ error: "missing or invalid path (must start with /)" });
    }
    try {
        const html = await upstream.fetchHtml(`${UPSTREAM_BASE}${p}`);
        res.json({
            length: html.length,
            titleSnippet: (html.match(/<title>([^<]*)<\/title>/i) || [, ""])[1].trim(),
            parsedItems: parseListPage(html).length,
            gth: parseGth(html) ? Object.keys(parseGth(html)).length : 0,
            baseDir: parsePageBaseDir(html),
            sampleHead: html.slice(0, 400),
        });
    } catch (err) {
        clientError(res, err, "probe");
    }
});

app.get("/popular", async (req, res) => {
    const limit = clampInt(req.query.limit, { min: 1, max: 60, def: 24 });
    try {
        const items = await cacheWrap(
            `popular:${limit}`,
            async () => {
                // HentaiFox has no dedicated popular endpoint; the home page is
                // the freshest gallery grid, which we surface as "trending".
                const html = await fetchListHtml(`${UPSTREAM_BASE}/`);
                return parseListPage(html).slice(0, limit);
            },
            { shouldCache: (v) => Array.isArray(v) && v.length > 0 },
        );
        // Unreachable in practice (the validator rejects a 0-item home page),
        // but an empty trending rail must never be a 200 — that is the exact
        // success-shaped-failure this service is being fixed for.
        if (!items.length) return res.status(502).json({ error: ERROR_TEXT.INVALID, code: "INVALID" });
        res.json({ items });
    } catch (err) {
        clientError(res, err, "popular");
    }
});

app.get("/search", async (req, res) => {
    const q = String(req.query.q || "").trim();
    const limit = clampInt(req.query.limit, { min: 1, max: 60, def: 20 });
    const offset = clampInt(req.query.offset, { min: 0, max: 500, def: 0 });
    if (!q) return res.json({ items: [] });
    try {
        const items = await cacheWrap(
            `search:${q.toLowerCase()}:${limit}:${offset}`,
            async () => {
                const url = `${UPSTREAM_BASE}/search/?q=${encodeURIComponent(q)}`;
                const html = await fetchSearchHtml(url);
                return parseListPage(html).slice(offset, offset + limit);
            },
            // A search can legitimately have no results, so 0 items is a valid
            // 200 — but it is never cached, so a parse regression self-heals in
            // seconds instead of being pinned for the full TTL.
            { shouldCache: (v) => Array.isArray(v) && v.length > 0 },
        );
        res.json({ items });
    } catch (err) {
        clientError(res, err, "search");
    }
});

app.get("/details", async (req, res) => {
    const id = String(req.query.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });
    try {
        const comic = await cacheWrap(
            `details:${id}`,
            async () => parseDetailPage(await fetchGalleryHtml(id), id),
            { shouldCache: (v) => Boolean(v && v.id && v.title) },
        );
        if (!comic || !comic.id || !comic.title) {
            return res.status(502).json({ error: ERROR_TEXT.INVALID, code: "INVALID" });
        }
        res.json({ comic });
    } catch (err) {
        clientError(res, err, "details");
    }
});

app.get("/chapters", async (req, res) => {
    const id = String(req.query.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });
    // A HentaiFox gallery is a single work; expose exactly one synthetic issue.
    // No upstream fetch needed — the reader's /pages call does the real work.
    res.json({
        issues: [
            { id: "gallery", title: "Read Gallery", number: "1", publishAt: null },
        ],
    });
});

app.get("/pages", async (req, res) => {
    const id = String(req.query.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });
    try {
        const result = await cacheWrap(
            `pages:v1:${id}`,
            async () => {
                const pages = buildPageUrls(await fetchGalleryHtml(id));
                return { pages, totalDiscovered: pages.length };
            },
            { shouldCache: (v) => Boolean(v && v.pages && v.pages.length > 0) },
        );
        // An existing gallery always has at least one page, so an empty array is
        // definitionally a parse failure — 502, never a 200 with a blank reader.
        if (!result.pages.length) {
            return res.status(502).json({ error: ERROR_TEXT.INVALID, code: "INVALID" });
        }
        res.json({
            pages: result.pages,
            droppedCount: 0,
            totalDiscovered: result.totalDiscovered,
            fallbackToRaw: false,
        });
    } catch (err) {
        clientError(res, err, "pages");
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

    const headers = {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: UPSTREAM_BASE,
    };

    try {
        // Direct and free. The image CDN (i*.hentaifox.com) is a plain static
        // Cloudflare cache: verified 200 image/jpeg, cf-cache-status HIT, to a
        // bare curl User-Agent with NO Referer. The hotlink protection this
        // endpoint was originally written for no longer exists — but keeping the
        // Referer costs nothing and covers us if it comes back.
        const direct = await upstream.fetchBinaryDirect(target.toString(), {
            timeoutMs: IMAGE_PROXY_TIMEOUT_MS,
            headers,
        });
        let type = direct.ok ? sniffImageType(direct.buf) : null;
        let buf = direct.buf;

        if (!type) {
            // Only if the CDN ever starts scoring us the way the HTML host does.
            // Still free — same impersonating client, no metered service.
            const alt = await upstream.fetchBinary(target.toString(), {
                timeoutMs: IMAGE_PROXY_TIMEOUT_MS,
            });
            type = sniffImageType(alt.buf);
            buf = alt.buf;
        }
        if (!type) return res.status(404).type("text/plain").send("not an image");

        res.set("Content-Type", type);
        res.set("Content-Length", String(buf.length));
        res.set("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable");
        res.set("Access-Control-Allow-Origin", "*");
        res.status(200).end(buf);
    } catch (err) {
        // 404 keeps the client's <img> fallback simple; the log carries detail.
        console.error(`[img] ${String(err?.message || err).slice(0, 200)}`);
        res.status(404).type("text/plain").send("not an image");
    }
});

app.use((_req, res) => res.status(404).json({ error: "not found" }));

// HENTAI_NO_LISTEN=1 imports the module without binding a port, so the parsers
// below can be regression-tested against saved HTML offline. Previously this
// required copy-pasting the functions into a throwaway harness.
if (process.env.HENTAI_NO_LISTEN !== "1") {
    app.listen(PORT, () => {
        console.log(`Sakura hentai scraper listening on :${PORT} (upstream=${UPSTREAM_BASE})`);
    });
}

export {
    parseListPage,
    parseGth,
    parsePageBaseDir,
    buildPageUrls,
    parseDetailPage,
    countPages,
    sniffImageType,
    validateListPage,
    validateSearchPage,
    validateGalleryPage,
};
