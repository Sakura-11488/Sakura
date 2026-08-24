/**
 * Sakura Comics scraper proxy.
 *
 * Runs on the DigitalOcean droplet behind nginx at /comics/v1/*.
 * Responsibilities:
 *   - Fetch HTML from upstream comic source (XOXO Comics primary) via the
 *     direct-first ladder in upstream.js (free undici; ZenRows only on a real
 *     Cloudflare challenge or a transport failure, and even then rate-limited)
 *   - Parse with Cheerio into stable JSON envelopes consumed by the app
 *   - LRU cache every endpoint so repeat views are instant
 *   - Never cache, and never 200, an empty parse
 *   - Persist image bytes to disk so an image is fetched at most once, ever
 *
 * Endpoints (prefixed with /comics/v1 by nginx):
 *   GET /search?q=<term>&limit=&offset=
 *   GET /popular?limit=
 *   GET /details?id=<slug>
 *   GET /chapters?id=<slug>&limit=&offset=
 *   GET /pages?id=<slug>&chapterId=<issueSlug>
 *   GET /img?u=<encoded image url>      // streams bytes through the droplet
 *   GET /healthz                        // observed state, no network call, 503 when dead
 *   GET /readyz                         // WALKS the read path (denied publicly by nginx)
 *
 * KNOWN UPSTREAM OUTAGE (re-measured 2026-08-13, predates this rewrite):
 * xoxocomic serves every chapter page image (/comic/<slug>/<issue>/<id>/N.jpg)
 * as HTTP 200 + the site homepage instead of bytes — 105,995 bytes, magic
 * 3c21444f ("<!DO"), title "Read Comics Online | Free Comics at Xoxocomic". A
 * cache-buster forces cf-cache-status: MISS and still returns HTML, so it is the
 * ORIGIN's decision, not a stale edge object. Verified identical from the
 * droplet, from a residential IP, and through ZenRows. It is an upstream content
 * regression, not a block, and no proxy fixes it. Covers (/images/series/*.jpg)
 * are unaffected. /readyz reports it; see COMICS_PAGES_VERIFY below.
 */

import express from "express";
import { load as loadHtml } from "cheerio";
import { LRUCache } from "lru-cache";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createUpstream, UpstreamError } from "./upstream.js";
import { createComicBookPlus, isCbpId, CBP_REFERER } from "./comicbookplus.js";

const PORT = Number(process.env.COMICS_SCRAPER_PORT || 3100);
const UPSTREAM_BASE = process.env.COMICS_UPSTREAM_BASE || "https://xoxocomic.com";
const CACHE_MAX = Number(process.env.COMICS_CACHE_MAX || 1000);
const CACHE_BYTES = Number(process.env.COMICS_CACHE_BYTES || 12 * 1024 * 1024);
const CACHE_TTL_MS = Number(process.env.COMICS_CACHE_TTL_MS || 15 * 60 * 1000);
// A "the reader is broken" verdict must expire far sooner than a success, or a
// chapter probed while the upstream was down keeps 502ing for an hour after it
// heals.
const NEGATIVE_TTL_MS = Number(process.env.COMICS_NEGATIVE_TTL_MS || 5 * 60 * 1000);
const HTML_CACHE_BYTES = Number(process.env.COMICS_HTML_CACHE_BYTES || 16 * 1024 * 1024);
const HTML_CACHE_TTL_MS = Number(process.env.COMICS_HTML_CACHE_TTL_MS || 5 * 60 * 1000);
const READY_TTL_MS = Number(process.env.COMICS_READY_TTL_MS || 60_000);
const READY_FAIL_TTL_MS = Number(process.env.COMICS_READY_FAIL_TTL_MS || 10_000);
const DEBUG_TOKEN = String(process.env.COMICS_DEBUG_TOKEN || "").trim();

// Sample chapter page images before answering /pages, so a reader that cannot
// possibly render gets an honest error instead of ~29 broken <img> tags. The
// check is free (disk cache, then direct — never metered). Set to "0" for an
// instant rollback to returning the raw URL list unverified.
const PAGES_VERIFY = String(process.env.COMICS_PAGES_VERIFY ?? "1") !== "0";

// Hosts /img is allowed to fetch from. /img takes a caller-supplied URL and is
// reachable both through nginx and through the Vercel media-proxy allowlist
// (`/^\/comics\/v1\/img\?u=https?:\/\/\S+$/i`), which accepts ANY http(s) URL.
// Without this list the droplet is an open fetch-anything proxy. Every image URL
// this scraper can legitimately emit is on xoxocomic.com or the two blog CDNs
// its reader falls back to.
const IMG_HOST_ALLOW = String(
    process.env.COMICS_IMG_HOSTS
    // comicbookplus.com covers box01.comicbookplus.com by suffix — both host
    // reader images, and which one an issue uses is not predictable.
    || "xoxocomic.com,comicbookplus.com,bp.blogspot.com,blogspot.com,blogger.googleusercontent.com",
)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

function hostAllowed(hostname) {
    const h = String(hostname || "").toLowerCase();
    return IMG_HOST_ALLOW.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

// The proxy templates carry an API key. They are read from untracked files by
// ecosystem.config.cjs and handed to upstream.js, which is the ONLY thing that
// ever sees them. Nothing here logs, echoes or serialises them — /healthz
// reports booleans only.
const upstream = createUpstream({
    upstreamBase: UPSTREAM_BASE,
    // Rule 9 in upstream.js: this must stay under nginx's proxy_read_timeout,
    // which is 30s live and stays 30s (see nginx-snippet.conf).
    totalBudgetMs: Number(process.env.COMICS_TOTAL_BUDGET_MS || 25_000),
    directTimeoutMs: Number(process.env.COMICS_DIRECT_TIMEOUT_MS || 8_000),
    directConcurrency: Number(process.env.COMICS_DIRECT_CONCURRENCY || 6),
    directQueueMax: Number(process.env.COMICS_DIRECT_QUEUE_MAX || 24),
    blockCooldownMs: Number(process.env.COMICS_BLOCK_COOLDOWN_MS || 10 * 60 * 1000),
    maxHtmlBytes: Number(process.env.COMICS_MAX_HTML_BYTES || 3 * 1024 * 1024),
    maxImageBytes: Number(process.env.COMICS_MAX_IMAGE_BYTES || 8 * 1024 * 1024),
    fetchProxyTemplate: process.env.COMICS_FETCH_PROXY_TEMPLATE || "",
    imageProxyTemplate: process.env.COMICS_IMAGE_PROXY_TEMPLATE || "",
    proxyTimeoutMs: Number(process.env.COMICS_REQUEST_TIMEOUT_MS || 9_000),
    proxyImageTimeoutMs: Number(process.env.COMICS_IMAGE_TIMEOUT_MS || 9_000),
    proxyConcurrency: Number(process.env.COMICS_PROXY_CONCURRENCY || 2),
    proxyQueueMax: Number(process.env.COMICS_PROXY_QUEUE_MAX || 16),
    proxyMaxRetries: Number(process.env.COMICS_PROXY_MAX_RETRIES ?? 1),
    proxyBackoffMs: Number(process.env.COMICS_PROXY_BACKOFF_MS || 600),
    quotaCooldownMs: Number(process.env.COMICS_QUOTA_COOLDOWN_MS || 6 * 60 * 60 * 1000),
    escalationBudget: Number(process.env.COMICS_ESCALATION_BUDGET || 8),
    escalationWindowMs: Number(process.env.COMICS_ESCALATION_WINDOW_MS || 10 * 60 * 1000),
    deadImageTtlMs: Number(process.env.COMICS_DEAD_IMAGE_TTL_MS || 30 * 60 * 1000),
});

// Persistent on-disk cache for image bytes. Bounds proxy credit usage to
// "unique images ever viewed" — an image is paid for once, globally, then
// served from disk forever. Keyed by the UPSTREAM url, never the proxied form,
// so entries written through ZenRows and entries written direct are
// interchangeable: switching tiers needs no invalidation or re-keying, in either
// direction. That is what makes the rollback below free.
const IMG_CACHE_DIR = process.env.COMICS_IMG_CACHE_DIR || path.join(process.cwd(), "img-cache");
let imgCacheWritable = true;
try {
    mkdirSync(IMG_CACHE_DIR, { recursive: true });
} catch {
    imgCacheWritable = false; // /img still works without the disk cache
}

// Counters only — /healthz must never walk the cache directory (26 MB / 179
// files today, and there is still no eviction; see README) on a request path.
const imgCacheStats = { hits: 0, writes: 0, bytesWritten: 0, writeErrors: 0 };

function imgCachePath(url) {
    const h = createHash("sha256").update(url).digest("hex");
    // Two-level fan-out keeps directories from growing to millions of entries.
    return path.join(IMG_CACHE_DIR, h.slice(0, 2), h);
}

// Sniff the real image type from magic bytes. Needed because the content-type
// header lies in both directions: ZenRows returns proxied binaries as
// `text/plain`, and xoxocomic returns dead page images as `text/html` with
// HTTP 200. The bytes are the only trustworthy signal.
function sniffImageType(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
    if (
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) return "image/webp";
    return null;
}

const isImageBuf = (buf) => sniffImageType(buf) !== null;

/**
 * Is this plausibly a real comic PAGE, or a placeholder wearing image bytes?
 *
 * sniffImageType only proves "these bytes are an image". That is enough against
 * xoxocomic, which returns 106KB of HTML for dead pages and is caught on the
 * magic bytes. It is NOT enough in general: comichubfree.com serves a valid
 * 2,462-byte 80x104 PNG for every page of a chapter — byte-identical across
 * pages, identical from a residential IP, so it is unconditional rather than IP
 * filtering. Verified against this file's own sniffImageType: an 88-byte
 * synthetic PNG of those dimensions is certified `image/png`.
 *
 * Left unguarded, that is the worst failure this service can have. /pages would
 * verify the chapter, /readyz would go green, and the reader would render a
 * wall of identical grey tiles with nothing anywhere reporting a problem — the
 * exact silent-success shape the rest of this file is built to refuse.
 *
 * Returns null when the buffer looks like a real page, or a reason string.
 *
 * ONLY apply this where a PAGE is expected. Covers are legitimately small
 * (xoxocomic covers measure ~16.9KB) and are served by the same /img route, so
 * a global floor would break them. minBytes is passed by the /pages sampler and
 * the /readyz image leg, and by nothing else.
 */
const MIN_PAGE_IMAGE_BYTES = Number(process.env.COMICS_MIN_PAGE_BYTES || 8192);
// Below this in either axis nothing is a readable comic page; real scans are
// ~600-1600px wide. Generous on purpose — this is a floor, not a quality bar.
const MIN_PAGE_IMAGE_EDGE = 200;

function plausiblePageImage(buf, { minBytes = MIN_PAGE_IMAGE_BYTES } = {}) {
    const type = sniffImageType(buf);
    if (!type) return "not an image";
    if (buf.length < minBytes) {
        return `only ${buf.length} bytes — placeholder, not a page`;
    }
    // PNG carries its dimensions at a fixed offset, so this costs nothing.
    // JPEG needs a segment walk and its byte floor already does the work.
    if (type === "image/png" && buf.length >= 24) {
        const width = buf.readUInt32BE(16);
        const height = buf.readUInt32BE(20);
        if (width < MIN_PAGE_IMAGE_EDGE || height < MIN_PAGE_IMAGE_EDGE) {
            return `${width}x${height} — placeholder, not a page`;
        }
    }
    return null;
}

// BYTE-bounded, not entry-bounded. A 36-item list entry serialises to ~13.7 KB
// and a /pages entry with 189 URLs to ~17.7 KB, so `max: 1000` alone is a
// 14-18 MB JSON budget and considerably more as a live V8 object graph — on a
// 1 GB box with no swap and max_memory_restart: 256M. `max` is now just a sanity
// ceiling; `maxSize` is the real bound.
const cache = new LRUCache({
    max: CACHE_MAX,
    maxSize: CACHE_BYTES,
    sizeCalculation: (v) => {
        try {
            return Math.max(64, JSON.stringify(v).length * 2);
        } catch {
            return 1024;
        }
    },
    ttl: CACHE_TTL_MS,
    // `allowStale` on the CONSTRUCTOR is a trap in lru-cache v11: a normal get()
    // returns the expired value AND deletes it, so data is served stale without
    // a refresh and the error path below finds nothing left. Verified against
    // lru-cache 11.0.2 (the version pinned in package.json). This pair is the
    // combination that actually works: normal get() misses on expiry, and only
    // the explicit error-path lookup can reach the stale entry.
    allowStale: false,
    noDeleteOnStaleGet: true,
});

// Raw comic HTML, shared by /details and /chapters so opening a comic costs ONE
// upstream fetch instead of the two identical ones it used to. BYTE-bounded on
// purpose: the popular page is ~631 KB and V8 holds these as two-byte strings
// (~1.26 MB resident each), so an entry-counted cache would trip pm2's
// max_memory_restart.
const htmlCache = new LRUCache({
    max: 24,
    maxSize: HTML_CACHE_BYTES,
    sizeCalculation: (v) => Math.max(1, String(v).length * 2),
    ttl: HTML_CACHE_TTL_MS,
});

// ---------------------------------------------------------------------------
// Sources.
//
// XOXO is the original path and stays wired exactly as it was; its ids are
// slugs (`invincible`). Comic Book Plus is the second source and its ids are
// namespaced (`cbp-1325`), so an id alone says which source owns it and a
// client that stored an id before this change keeps resolving to XOXO.
//
// The default only decides where a SOURCELESS request (/popular, /search) goes.
// It is `cbp` because XOXO's reader is dead: browse still works there, so
// defaulting to it would hand users a catalogue they cannot read. Flip
// COMICS_DEFAULT_SOURCE back to `xoxo` the day their images return.
// ---------------------------------------------------------------------------
const DEFAULT_SOURCE = String(process.env.COMICS_DEFAULT_SOURCE || "cbp").toLowerCase();

const cbp = createComicBookPlus({
    upstream,
    htmlCache,
    minGapMs: Number(process.env.COMICS_CBP_MIN_GAP_MS || 1000),
});

/** Which source owns this id? `null` means the legacy XOXO path. */
function sourceForId(id) {
    return isCbpId(id) ? cbp : null;
}

/** Which source should a sourceless list request use? */
function sourceForRequest(req) {
    const q = String(req.query.source || "").trim().toLowerCase();
    if (q === "cbp" || q === "comicbookplus") return cbp;
    if (q === "xoxo" || q === "xoxocomic") return null;
    return DEFAULT_SOURCE === "cbp" ? cbp : null;
}

/**
 * Hotlink protection is per-host: Comic Book Plus answers 403 to an image
 * request with no Referer, and would answer it to one carrying xoxocomic's.
 */
function refererForImage(url) {
    try {
        const h = new URL(url).hostname.toLowerCase();
        if (h === "comicbookplus.com" || h.endsWith(".comicbookplus.com")) return CBP_REFERER;
    } catch {
        /* fall through to the ladder's default */
    }
    return undefined;
}

/**
 * @param {(value:any) => boolean} shouldCache guard so an EMPTY result is never
 *        cached. Caching `[]` or `null` is how a one-off parse failure becomes
 *        an hour of blank screens that look like success — and `null !==
 *        undefined`, so a cached null used to be served as a hit for the full
 *        TTL, 404ing a comic that exists.
 * @param {(value:any) => number|undefined} [ttlFor] per-value TTL override, so a
 *        "this is broken" verdict expires in minutes while a success keeps the
 *        full hour. Without it, a chapter probed during an outage keeps 502ing
 *        for an hour after the upstream heals.
 */
async function cacheWrap(key, producer, { shouldCache = () => true, ttlFor = () => undefined } = {}) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    try {
        const value = await producer();
        if (shouldCache(value)) {
            const ttl = ttlFor(value);
            cache.set(key, value, ttl ? { ttl } : undefined);
        }
        return value;
    } catch (err) {
        // Serving a stale entry beats erroring — especially on BUSY, which is
        // our own load shedding, and especially on /popular, whose failure the
        // client amplifies into four more searches.
        const stale = cache.get(key, { allowStale: true });
        if (stale !== undefined) {
            console.warn(`[cache] serving stale ${key} after ${err?.code || "error"}`);
            return stale;
        }
        throw err;
    }
}

function absolute(p) {
    if (!p) return null;
    if (p.startsWith("//")) return `https:${p}`;
    if (/^https?:\/\//i.test(p)) return p;
    return `${UPSTREAM_BASE.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
}

function extractSlugFromUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url, UPSTREAM_BASE);
        const parts = u.pathname.split("/").filter(Boolean);
        // Paths like /comic/spawn or /comic/spawn/issue-1
        if (parts[0] === "comic" && parts[1]) return parts[1];
        return null;
    } catch {
        return null;
    }
}

function extractIssueSlugFromUrl(url) {
    try {
        const u = new URL(url, UPSTREAM_BASE);
        const parts = u.pathname.split("/").filter(Boolean);
        // /comic/<slug>/<issue-slug>[/pageN]
        if (parts[0] === "comic" && parts[1] && parts[2]) return parts[2];
        return null;
    } catch {
        return null;
    }
}

function parseListPage(html) {
    const $ = loadHtml(html);
    const out = [];
    const seen = new Set();

    // XOXO's different pages (popular, search, genre) all render comic cards,
    // but the exact wrapper element shifts between "article.item",
    // ".items .item", ".list-truyen-item-wrap", etc. Collect every candidate,
    // then pull the first <a> that points at /comic/<slug>. This is resilient
    // to small theme changes.
    const candidateSelectors = [
        "article.item",
        ".items .item",
        ".list-truyen-item-wrap",
        ".ModuleContent .item",
        ".list-items .item",
        ".list-comic .item",
    ];
    const items = new Set();
    for (const sel of candidateSelectors) {
        $(sel).each((_, el) => items.add(el));
    }

    // Final fallback: every link that looks like /comic/<slug>. Group them
    // by their nearest "item"-ish ancestor so we don't double-count siblings
    // in the same card.
    if (items.size === 0) {
        $("a[href*='/comic/']").each((_, a) => {
            const $a = $(a);
            const href = $a.attr("href") || "";
            const slug = extractSlugFromUrl(href);
            if (!slug) return;
            // Skip issue links (/comic/slug/issue-1) at this stage.
            if (extractIssueSlugFromUrl(href)) return;
            const container = $a.closest("article, li, .item, .list-truyen-item-wrap, div")[0];
            if (container) items.add(container);
        });
    }

    items.forEach((el) => {
        const $el = $(el);
        // Prefer the titled anchor; fall back to first /comic/ anchor.
        const linkEl = $el.find("figcaption h3 a, h3 a, .title-book a, a[data-jtip]").filter((_, a) => {
            const h = $(a).attr("href") || "";
            return /\/comic\/[^/]+\/?$/.test(h) || /\/comic\/[^/]+/.test(h);
        }).first();
        const anchor = linkEl.length ? linkEl : $el.find("a[href*='/comic/']").first();
        if (!anchor.length) return;

        const href = anchor.attr("href");
        const slug = extractSlugFromUrl(href);
        if (!slug || seen.has(slug)) return;

        const title = (anchor.attr("title")
            || anchor.text().trim()
            || $el.find("h3").first().text().trim());
        if (!title) return;

        const imageEl = $el.find("img").first();
        const cover = absolute(
            imageEl.attr("data-original")
            || imageEl.attr("data-src")
            || imageEl.attr("src"),
        );

        const tipId = anchor.attr("data-jtip");
        let description = "";
        const tags = [];
        let status = "";
        let year = null;
        if (tipId) {
            const tip = $(tipId);
            description = tip.find(".box_text, .box-description").text().trim();
            tip.find(".message_main p, .message_main li, p").each((__, p) => {
                const $p = $(p);
                const label = $p.find("strong, label").first().text().trim().toLowerCase();
                const value = $p.clone().find("strong, label").remove().end().text().trim();
                if (!label || !value) return;
                if (label.startsWith("genres")) {
                    value.split(/[,/]/).forEach((g) => {
                        const t = g.trim();
                        if (t) tags.push(t);
                    });
                } else if (label.startsWith("status")) {
                    status = value;
                } else if (label.startsWith("released") || label.startsWith("release")) {
                    const yr = parseInt(value, 10);
                    if (!Number.isNaN(yr)) year = yr;
                }
            });
        }

        seen.add(slug);
        out.push({
            id: slug,
            title,
            cover: cover || null,
            url: absolute(href),
            description,
            tags,
            status,
            year,
        });
    });
    return out;
}

function parseDetailPage(html, slug, $pre) {
    const $ = $pre || loadHtml(html);
    const info = $(".list-info");
    if (info.length === 0) return null;

    const cover = absolute($(".col-image img").attr("src"));
    const title = $(".breadcrumb li.active").text().trim()
        || $("h1.title-detail").text().trim()
        || slug;

    const authors = [];
    info.find("li.author .col-xs-8")
        .text()
        .split(/[-,]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((a) => authors.push(a));

    let status = "";
    let year = null;
    const genres = [];

    info.find("li").each((_, li) => {
        const $li = $(li);
        const label = $li.find("strong").text().trim().toLowerCase();
        const value = $li.find(".col-xs-8");
        if (label.startsWith("status")) {
            status = value.text().trim();
        } else if (label.startsWith("released")) {
            const y = parseInt(value.text().trim(), 10);
            if (!Number.isNaN(y)) year = y;
        } else if (label.startsWith("genres")) {
            value.find("a").each((__, a) => {
                const g = $(a).text().trim();
                if (g) genres.push(g);
            });
        }
    });

    const description = $(".detail-content p").first().text().trim();

    return {
        id: slug,
        title,
        cover: cover || null,
        description,
        author: authors.join(", "),
        authors,
        tags: genres,
        status,
        year,
        url: `${UPSTREAM_BASE}/comic/${slug}`,
    };
}

function parseChapters(html, slug, $pre) {
    const $ = $pre || loadHtml(html);
    const list = [];
    $(".list-chapter li.row").each((_, li) => {
        const $li = $(li);
        if ($li.hasClass("heading")) return;
        const a = $li.find(".col-xs-9.chapter a").first();
        const href = a.attr("href");
        const issueSlug = extractIssueSlugFromUrl(href);
        if (!issueSlug) return;
        const label = a.text().trim();
        const date = $li.find(".col-xs-3").first().text().trim();
        // Try to extract a numeric "issue N" from the label
        const match = label.match(/(?:issue|#|chapter)[^\d]*(\d+(?:\.\d+)?)/i);
        const number = match ? match[1] : null;
        list.push({
            id: issueSlug,
            title: label,
            number,
            publishAt: date || null,
        });
    });
    return list;
}

// NOTE: the reader markup uses SINGLE-quoted attributes
// (`<div id='page_1' class='page-chapter'>`, `data-original='https://…'`).
// Cheerio tokenizes that correctly; a regex-based scrape would not.
function parsePages(html) {
    const $ = loadHtml(html);
    const pages = [];
    const seen = new Set();
    $(".page-chapter img").each((_, img) => {
        const $img = $(img);
        const src = $img.attr("data-original") || $img.attr("data-src") || $img.attr("src");
        if (!src) return;
        if (src.startsWith("data:")) return;
        const abs = absolute(src);
        if (!abs || seen.has(abs)) return;
        seen.add(abs);
        pages.push(abs);
    });
    // Fallback: some XOXO themes use .reading-detail img
    if (pages.length === 0) {
        $(".reading-detail img").each((_, img) => {
            const $img = $(img);
            const src = $img.attr("data-original") || $img.attr("data-src") || $img.attr("src");
            if (!src || src.startsWith("data:")) return;
            const abs = absolute(src);
            if (!abs || seen.has(abs)) return;
            seen.add(abs);
            pages.push(abs);
        });
    }
    return pages;
}

// ---------------------------------------------------------------------------
// Validators. These assert the PRODUCT, not the byte count — a challenge page,
// an error page and a redesigned page can all be longer than any length
// threshold. They run BEFORE anything is cached, and a failure is never stored.
//
// They RETURN THE PARSED PRODUCT (`{ok:true, value}`) so the handler does not
// re-parse the same document. That matters here: cheerio on the 631 KB popular
// page measures ~65-80 ms on a fast desktop, and the droplet is a single shared
// vCPU at load ~3 — parsing it twice per uncached request blocks the event loop
// for everything else, /healthz included.

function validateListPage(html) {
    const items = parseListPage(html);
    if (items.length === 0) return { ok: false, reason: "0 comics parsed (markup drift?)" };
    return { ok: true, value: items };
}

/**
 * A search can legitimately return zero results, so we cannot require items.
 * But a 0-item response must still prove we reached XOXO's search handler,
 * otherwise a markup regression answers 200 with an empty list and the app's
 * home rows go quietly blank. Verified against the live page: the search
 * template renders the STATIC title below and does NOT echo the keyword into
 * <title>, so this marker cannot be spoofed by a user's query.
 */
function validateSearchPage(html) {
    const items = parseListPage(html);
    if (items.length > 0) return { ok: true, value: items };
    if (/<title>\s*Search Comics Online/i.test(html)) return { ok: true, value: [] };
    return { ok: false, reason: "0 comics and no search-results marker (markup drift?)" };
}

/**
 * The comic page feeds BOTH /details and /chapters, and they key off different
 * selectors (.list-info vs .list-chapter li.row) that drift independently. Parse
 * once, hand both products back, and let each endpoint assert its own.
 *
 * Only `.list-info` gates the fetch. Requiring chapters here would 502 /details
 * for any comic that legitimately has no issues yet, and "must not regress" wins
 * over elegance — /chapters does its own assertion below.
 */
function validateComicPage(html, slug = "") {
    const $ = loadHtml(html);
    if (!$(".list-info").length) return { ok: false, reason: "detail page has no .list-info block" };
    return {
        ok: true,
        value: { detail: parseDetailPage(html, slug, $), chapters: parseChapters(html, slug, $) },
    };
}

function validateChapterPage(html) {
    const pages = parsePages(html);
    if (pages.length === 0) return { ok: false, reason: "0 page URLs parsed (markup drift?)" };
    return { ok: true, value: pages };
}

// ---------------------------------------------------------------------------

async function fetchList(url, opts = {}) {
    return (await upstream.fetchHtml(url, { validate: validateListPage, ...opts })).value;
}

async function fetchSearch(url, opts = {}) {
    return (await upstream.fetchHtml(url, { validate: validateSearchPage, ...opts })).value;
}

/**
 * One fetch per comic, shared by /details and /chapters. These two endpoints
 * used to fetch the identical ~152 KB page separately, so every comic the user
 * opened cost two upstream hits.
 *
 * `noCache: true` bypasses htmlCache — /readyz uses it, because a readiness
 * probe that reads a 5-minute-old memory entry is not proof of anything.
 */
async function fetchComic(slug, { noCache = false, ...opts } = {}) {
    const key = `comic:${slug}`;
    if (!noCache) {
        const hit = htmlCache.get(key);
        if (hit !== undefined) return validateComicPage(hit, slug).value;
    }
    const { html, value } = await upstream.fetchHtml(
        `${UPSTREAM_BASE}/comic/${encodeURIComponent(slug)}`,
        { validate: (h) => validateComicPage(h, slug), ...opts },
    );
    htmlCache.set(key, html);
    return value;
}

async function fetchChapterPages(slug, chapterId, { noCache = false, ...opts } = {}) {
    const key = `chapter:${slug}:${chapterId}`;
    if (!noCache) {
        const hit = htmlCache.get(key);
        if (hit !== undefined) return parsePages(hit);
    }
    const url = `${UPSTREAM_BASE}/comic/${encodeURIComponent(slug)}/${encodeURIComponent(chapterId)}/all`;
    const { html, value } = await upstream.fetchHtml(url, { validate: validateChapterPage, ...opts });
    htmlCache.set(key, html);
    return value;
}

/**
 * Load image bytes: disk cache, then the ladder. Shared by /img, /pages and
 * /readyz.
 *
 * `allowProxy: false` guarantees a call cannot spend money — the /pages sampler
 * and the /readyz image leg both use it, so validation is always free.
 */
async function loadImage(url, { allowProxy = true, probe = false, minBytes = 0, skipDiskCache = false } = {}) {
    const cachePath = imgCachePath(url);
    try {
        // `skipDiskCache` is for readiness: that leg exists to prove the NETWORK
        // path works, and the disk cache has no eviction, so the first probe of
        // a pinned page would otherwise cache it and every later walk would
        // grade itself against its own artifact — reporting healthy forever,
        // including through a total upstream outage. Reading past the cache is
        // what makes the check mean anything.
        if (skipDiskCache) throw new Error("bypassing disk cache");
        const cached = await readFile(cachePath);
        const ct = sniffImageType(cached);
        if (ct) {
            // The disk path needs the placeholder check too. Entries written
            // before this guard existed were only magic-verified, so a cached
            // placeholder would otherwise sail straight past it — and the cache
            // has no eviction, so it would do so indefinitely.
            const bad = minBytes ? plausiblePageImage(cached, { minBytes }) : null;
            if (bad) throw new UpstreamError("INVALID", bad);
            imgCacheStats.hits += 1;
            return { buf: cached, contentType: ct, via: "disk" };
        }
    } catch (err) {
        if (err instanceof UpstreamError) throw err;
        // cache miss — fall through to the network
    }

    const { buf, via, finalUrl } = await upstream.fetchImage(url, {
        isImage: isImageBuf,
        allowProxy,
        probe,
        referer: refererForImage(url),
    });
    // `redirect: follow` can land us somewhere we never vetted. Re-check.
    if (finalUrl && finalUrl !== url) {
        try {
            const f = new URL(finalUrl);
            if (!hostAllowed(f.hostname)) {
                throw new UpstreamError("INVALID", `image redirected to a disallowed host: ${f.hostname}`);
            }
        } catch (err) {
            if (err instanceof UpstreamError) throw err;
        }
    }
    const contentType = sniffImageType(buf);

    // Reject a placeholder BEFORE it reaches the cache. Throwing INVALID here
    // reuses the ladder's existing classification: INVALID is `final`, so it is
    // memoised dead and never escalated to the paid tier — a placeholder is the
    // origin working as designed, not us being blocked, and there is nothing to
    // buy our way past.
    const implausible = minBytes ? plausiblePageImage(buf, { minBytes }) : null;
    if (implausible) throw new UpstreamError("INVALID", implausible);

    // Persist for next time (best effort — never block the response on it).
    // Only magic-verified image bytes are ever written, so an HTML soft-404 can
    // never poison the cache.
    if (imgCacheWritable) {
        writeFile(cachePath, buf).then(
            () => {
                imgCacheStats.writes += 1;
                imgCacheStats.bytesWritten += buf.length;
            },
            async () => {
                try {
                    mkdirSync(path.dirname(cachePath), { recursive: true });
                    await writeFile(cachePath, buf);
                    imgCacheStats.writes += 1;
                    imgCacheStats.bytesWritten += buf.length;
                } catch {
                    imgCacheStats.writeErrors += 1;
                }
            },
        );
    }
    return { buf, contentType, via };
}

function clampInt(value, { min, max, def }) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
}

// Never echo the upstream body back to the app. The old handlers returned
// `String(err.message)`, which carried `body.slice(0, 200)` of the proxy's
// response — that is how the vendor's dunning notice ("Purchase a new
// subscription to continue using the service") ended up one toast away from a
// user's screen. Log the detail, return a short stable message plus a
// machine-readable code.
const ERROR_TEXT = {
    BLOCKED: "upstream is bot-challenging this server; backing off",
    QUOTA: "upstream fallback is unavailable (proxy quota exhausted)",
    BUSY: "too many upstream requests in flight; retry shortly",
    TIMEOUT: "upstream timed out",
    HTTP: "upstream returned an error",
    INVALID: "upstream returned unusable HTML (parser or markup drift)",
    INTERNAL: "internal error",
};
const ERROR_STATUS = {
    BLOCKED: 503, QUOTA: 503, BUSY: 503, TIMEOUT: 504, HTTP: 502, INVALID: 502, INTERNAL: 500,
};

function clientError(res, err, where) {
    const code = err instanceof UpstreamError ? err.code : "INTERNAL";
    console.error(`[${where}] ${code}: ${String(err?.message || err).slice(0, 300)}`);
    const body = { error: ERROR_TEXT[code] || "upstream unavailable", code };
    if (code === "BUSY") res.set("Retry-After", "2");
    res.status(ERROR_STATUS[code] || 502).json(body);
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
 * NOT a liveness check. `ok: true` used to be a hardcoded literal, which is
 * exactly what let a totally dead reader report green for three weeks: the
 * process was up, every page image 404'd, and the probe never noticed. This
 * reports what real traffic has actually observed and 503s when OUR path to the
 * upstream is failing.
 *
 * Makes NO network call, by design — during a block a fetching /healthz would
 * itself hang past nginx's read timeout and become unreachable exactly when it
 * is needed. Use /readyz to prove the path works.
 *
 * `consecutiveFailures` deliberately excludes INVALID (see recordFailure in
 * upstream.js): a caller-supplied bogus slug produces INVALID, and this endpoint
 * is public — three crafted requests must not be able to paint the service red.
 *
 * `mode` is the live tier ("direct" | "proxy" | "blocked"). The credentialed
 * template is never serialised — only booleans and counters.
 */
app.get("/healthz", (_req, res) => {
    const fetchStats = upstream.stats();
    const pathUsable = fetchStats.mode === "direct"
        || (fetchStats.proxyConfigured && !fetchStats.proxyQuotaExhausted);
    const healthy = pathUsable && fetchStats.consecutiveFailures < 3;
    res.status(healthy ? 200 : 503).json({
        ok: healthy,
        upstream: UPSTREAM_BASE,
        defaultSource: DEFAULT_SOURCE,
        // Zero after a restart and until the first list request — the catalogue
        // is built lazily, so this is "has it been built", not "is it healthy".
        cbpCatalogSize: cbp.catalogSize(),
        mode: fetchStats.mode,
        observedTraffic: fetchStats.requests > 0,
        cacheEntries: cache.size,
        cacheBytes: cache.calculatedSize,
        htmlCacheBytes: htmlCache.calculatedSize,
        imgCache: {
            dir: IMG_CACHE_DIR,
            writable: imgCacheWritable,
            ...imgCacheStats,
        },
        fetch: fetchStats,
    });
});

/**
 * Readiness = the read path actually works, end to end.
 *
 * Comics has a chapters/pages model on top of the list/detail one, so this
 * walks FIVE links, not two:
 *     list -> details -> chapters -> pages -> IMAGE BYTES
 *
 * The last leg is the one that matters most: everything above it passes right
 * now while the reader is dead, because xoxocomic answers page images with an
 * HTTP 200 homepage. Assert the MAGIC BYTES — never the status code, never the
 * content-type. Both lie on this upstream. And require the bytes to have come
 * off the NETWORK: the disk cache holds 41 real page images from 2026-07-22, so
 * a disk hit would certify a chapter that is 99% dead.
 *
 * Guards, all of them load-bearing on a 1 vCPU box:
 *   - single-flight: concurrent probes share one walk instead of starting N
 *   - htmlCache bypassed: a probe that reads a 5-minute-old string proves nothing
 *   - the image leg is NEVER metered
 *   - probe:true keeps failures out of /healthz's consecutiveFailures
 *   - nginx denies this path publicly; deploy.sh polls 127.0.0.1 directly
 */
let readyCache = { at: 0, payload: null };
let readyInFlight = null;

/**
 * The decisive leg, shared by both sources: does a sampled page return real
 * image BYTES, off the network?
 *
 * It reads PAST the disk cache. The cache has no eviction and still holds real
 * page images from before the XOXO reader died, so a disk hit would certify a
 * chapter that is entirely dead — and on a working source the first probe would
 * cache the sample and every later walk would grade itself against its own
 * artifact. `via !== "disk"` then stays as a cheap invariant on top.
 * `minBytes` is the other half: this leg exists to prove a PAGE is readable, so
 * a placeholder tile that is technically valid JPEG must fail it.
 */
async function proveSamplePage(pages, checks) {
    const sample = pages[Math.min(pages.length - 1, Math.floor(pages.length / 2))] || pages[0];
    checks.samplePage = sample;
    try {
        const img = await loadImage(sample, {
            allowProxy: false, probe: true, minBytes: MIN_PAGE_IMAGE_BYTES, skipDiskCache: true,
        });
        checks.pageImageVia = img.via;
        checks.pageImageOk = Boolean(img.contentType) && img.via !== "disk";
        if (!checks.pageImageOk) checks.pageImageReason = "served from the disk cache, not proven live";
    } catch (err) {
        checks.pageImageOk = false;
        checks.pageImageReason = err instanceof UpstreamError
            ? `${err.code}: ${err.message}`
            : String(err?.message || err).slice(0, 160);
    }
}

/**
 * Readiness for the Comic Book Plus path — the one the app actually reads from
 * now, so this is what deploy.sh must gate on. Walks the same five links.
 *
 * UNLIKE the XOXO walk, a dead image leg here is a HARD FAIL. That asymmetry is
 * the point: XOXO's images are broken upstream for everyone, so gating on them
 * would mean no deploy could ever pass until a third party fixed their site.
 * Comic Book Plus serves bytes today, so if it stops, the deploy should stop.
 *
 * The HTML legs may be served from htmlCache (up to 5 minutes stale). The image
 * leg may not — `proveSamplePage` rejects a disk hit — and that is the leg that
 * decides the verdict.
 */
async function runReadinessCbp() {
    const checks = {
        source: "cbp",
        listItems: 0, slug: null, title: null,
        chapters: 0, chapterId: null, pageUrls: 0, samplePage: null,
        pageImageOk: false, pageImageVia: null, pageImageReason: null,
    };

    const list = await cbp.popular(24);
    checks.listItems = list.length;
    if (!list.length) return { ok: false, reason: "comicbookplus catalogue parsed 0 titles", checks };

    // Pinned, for the same reason COMICS_READY_SLUG is: a gate that follows
    // whatever leads the list today fails for reasons unrelated to the deploy.
    // Default is a 22-issue run whose reader was verified by hand on 2026-08-24.
    const id = String(process.env.COMICS_READY_CBP_ID || "").trim() || list[0].id;
    checks.slug = id;

    const detail = await cbp.details(id);
    if (!detail || !detail.title) return { ok: false, reason: "detail parse produced no title", checks };
    checks.title = detail.title;

    const chapters = await cbp.chapters(id);
    checks.chapters = chapters.length;
    if (!chapters.length) return { ok: false, reason: "0 issues parsed", checks };

    checks.chapterId = chapters[0].id;
    const pages = await cbp.pages(id, chapters[0].id);
    checks.pageUrls = pages.length;
    if (!pages.length) return { ok: false, reason: "0 page URLs parsed", checks };

    await proveSamplePage(pages, checks);
    if (!checks.pageImageOk) {
        if (String(process.env.COMICS_READY_REQUIRE_IMAGE_CBP || "1") === "1") {
            return { ok: false, reason: `sampled page did not return live image bytes (${checks.pageImageReason})`, checks };
        }
        return { ok: true, degraded: true, mode: upstream.mode(), reason: "reader degraded", checks };
    }
    return { ok: true, degraded: false, mode: upstream.mode(), checks };
}

async function runReadiness() {
    // Gate on the source that actually answers users. Readiness that walks a
    // path the default no longer uses is a green light for the wrong thing.
    if (DEFAULT_SOURCE === "cbp") return runReadinessCbp();
    const checks = {
        listItems: 0, slug: null, title: null,
        chapters: 0, chapterId: null, pageUrls: 0, samplePage: null,
        pageImageOk: false, pageImageVia: null, pageImageReason: null,
    };
    // During a block the proxy IS the read path, so readiness must be allowed to
    // use it or the one scenario this whole design exists for reports NOT READY
    // and blocks the deploy of the fix. At most one walk per READY_TTL_MS, and
    // only the three HTML legs — the image leg stays free forever.
    const blocked = upstream.mode() !== "direct";
    const allowProxy = blocked && String(process.env.COMICS_READY_ALLOW_PROXY || "1") === "1";
    const html = { allowProxy, probe: true, noCache: true, budgetMs: 12_000 };

    const list = await fetchList(`${UPSTREAM_BASE}/popular-comic`, html);
    checks.listItems = list.length;
    if (list.length === 0) return { ok: false, reason: "popular page parsed 0 comics", checks };

    // Pinned by default. Using list[0].id makes the deploy gate depend on
    // whatever comic happens to lead the popular page today — one comic with an
    // odd detail page and the gate fails for reasons unrelated to the deploy.
    const slug = String(process.env.COMICS_READY_SLUG || "").trim() || list[0].id;
    checks.slug = slug;

    const { detail, chapters } = await fetchComic(slug, html);
    if (!detail || !detail.title) return { ok: false, reason: "detail parse produced no title", checks };
    checks.title = detail.title;
    checks.chapters = chapters.length;
    if (chapters.length === 0) return { ok: false, reason: "0 chapters parsed", checks };

    const chapterId = chapters[0].id;
    checks.chapterId = chapterId;
    const pages = await fetchChapterPages(slug, chapterId, html);
    checks.pageUrls = pages.length;
    if (pages.length === 0) return { ok: false, reason: "0 page URLs parsed", checks };

    // The leg that would have caught the outage three weeks ago.
    await proveSamplePage(pages, checks);

    if (!checks.pageImageOk) {
        // Reported ALWAYS, gating only when asked. Page images are broken
        // upstream for everyone right now (see the header note), and hard-
        // failing here would mean no deploy of this service could ever pass its
        // own gate until a third party fixes their site. Flip
        // COMICS_READY_REQUIRE_IMAGE=1 the moment page images come back — then
        // this becomes the hard gate it deserves to be.
        if (String(process.env.COMICS_READY_REQUIRE_IMAGE || "0") === "1") {
            return { ok: false, reason: "sampled page did not return live image bytes", checks };
        }
        return {
            ok: true,
            degraded: true,
            mode: upstream.mode(),
            reason: "READER DEGRADED: page images return no bytes (known upstream outage). "
                + "Browse works; chapter reading does not.",
            checks,
        };
    }
    return { ok: true, degraded: false, mode: upstream.mode(), checks };
}

app.get("/readyz", async (_req, res) => {
    const now = Date.now();
    const ttl = readyCache.payload?.ok ? READY_TTL_MS : READY_FAIL_TTL_MS;
    if (readyCache.payload && now - readyCache.at < ttl) {
        return res.status(readyCache.payload.ok ? 200 : 503).json({ ...readyCache.payload, cached: true });
    }
    // Single-flight. Without this, N concurrent probes run N complete walks —
    // each one ~1.1 MB of upstream HTML and several hundred ms of blocked event
    // loop. deploy.sh polls in a loop, so the deploy script itself was the most
    // likely thing to trigger it.
    if (!readyInFlight) {
        readyInFlight = (async () => {
            let payload;
            try {
                payload = await runReadiness();
            } catch (err) {
                payload = {
                    ok: false,
                    reason: err instanceof UpstreamError
                        ? `${err.code}: ${err.message}`
                        : String(err?.message || err).slice(0, 200),
                    checks: null,
                };
            }
            readyCache = { at: Date.now(), payload };
            return payload;
        })().finally(() => { readyInFlight = null; });
    }
    const payload = await readyInFlight;
    res.status(payload.ok ? 200 : 503).json(payload);
});

// Operator probe — NOT exposed to the app. Diagnoses selector / bot-detection
// issues without SSHing into a shell.
//
// Token-gated now. It was an unauthenticated arbitrary-path fetcher aimed at the
// upstream from our only IP, and every hit used to cost proxy credits: anyone
// who found it could have looped it until the account hit its quota wall.
// nginx also denies the path outright (see nginx-snippet.conf) — run it against
// 127.0.0.1:3100 over SSH instead.
app.get("/debug/probe", async (req, res) => {
    if (!DEBUG_TOKEN || req.get("x-sakura-debug") !== DEBUG_TOKEN) {
        return res.status(404).json({ error: "not found" });
    }
    const p = String(req.query.path || "").trim();
    if (!p.startsWith("/")) {
        return res.status(400).json({ error: "missing or invalid path (must start with /)" });
    }
    try {
        const { html, via } = await upstream.fetchHtml(`${UPSTREAM_BASE}${p}`, {
            allowProxy: req.query.proxy === "1",
            probe: true,
        });
        res.json({
            via,
            length: html.length,
            titleSnippet: (html.match(/<title>([^<]*)<\/title>/i) || [, ""])[1].trim(),
            parsedItems: parseListPage(html).length,
            parsedChapters: parseChapters(html, "probe").length,
            parsedPages: parsePages(html).length,
            sampleHead: html.slice(0, 400),
        });
    } catch (err) {
        clientError(res, err, "probe");
    }
});

app.get("/popular", async (req, res) => {
    const limit = clampInt(req.query.limit, { min: 1, max: 60, def: 24 });
    const src = sourceForRequest(req);
    try {
        if (src) {
            const items = await cacheWrap(
                `popular:${src.id}:${limit}`,
                () => src.popular(limit),
                { shouldCache: (v) => Array.isArray(v) && v.length > 0 },
            );
            if (!items.length) return res.status(502).json({ error: ERROR_TEXT.INVALID, code: "INVALID" });
            return res.json({ items });
        }
        const items = await cacheWrap(
            `popular:${limit}`,
            async () => (await fetchList(`${UPSTREAM_BASE}/popular-comic`)).slice(0, limit),
            { shouldCache: (v) => Array.isArray(v) && v.length > 0 },
        );
        // Unreachable in practice (the validator rejects a 0-item page), but an
        // empty trending rail must never be a 200: the client swallows /popular
        // errors and fans out into four more searches, so a silent [] renders as
        // "there are no comics" instead of an error state.
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
    const src = sourceForRequest(req);
    try {
        if (src) {
            const items = await cacheWrap(
                `search:${src.id}:${q.toLowerCase()}:${limit}:${offset}`,
                () => src.search(q, limit, offset),
                { shouldCache: (v) => Array.isArray(v) && v.length > 0 },
            );
            return res.json({ items });
        }
        const items = await cacheWrap(
            `search:${q.toLowerCase()}:${limit}:${offset}`,
            async () => {
                const url = `${UPSTREAM_BASE}/search-comic?keyword=${encodeURIComponent(q)}`;
                return (await fetchSearch(url)).slice(offset, offset + limit);
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
    const slug = String(req.query.id || "").trim();
    if (!slug) return res.status(400).json({ error: "missing id" });
    const src = sourceForId(slug);
    try {
        if (src) {
            const comic = await cacheWrap(
                `details:${src.id}:${slug}`,
                () => src.details(slug),
                { shouldCache: (v) => Boolean(v && v.id && v.title) },
            );
            if (!comic) return res.status(502).json({ error: ERROR_TEXT.INVALID, code: "INVALID" });
            return res.json({ comic });
        }
        const comic = await cacheWrap(
            `details:${slug}`,
            async () => (await fetchComic(slug)).detail,
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
    const slug = String(req.query.id || "").trim();
    const limit = clampInt(req.query.limit, { min: 1, max: 2000, def: 500 });
    const offset = clampInt(req.query.offset, { min: 0, max: 5000, def: 0 });
    if (!slug) return res.status(400).json({ error: "missing id" });
    const src = sourceForId(slug);
    try {
        if (src) {
            const issues = await cacheWrap(
                `chapters:${src.id}:${slug}`,
                () => src.chapters(slug),
                { shouldCache: (v) => Array.isArray(v) && v.length > 0 },
            );
            if (offset === 0 && !issues.length) {
                return res.status(502).json({ error: ERROR_TEXT.INVALID, code: "INVALID" });
            }
            return res.json({ issues: issues.slice(offset, offset + limit) });
        }
        const all = await cacheWrap(
            `chapters:${slug}`,
            async () => (await fetchComic(slug)).chapters,
            { shouldCache: (v) => Array.isArray(v) && v.length > 0 },
        );
        // `.list-chapter li.row .col-xs-9.chapter a` is a DIFFERENT selector from
        // the `.list-info` the fetch validator asserts, and it drifts
        // independently. Without this guard a chapter-list regression answers
        // 200 {"issues":[]} and every comic renders as "exists, zero issues" —
        // the client returns [] on success and shows no error anywhere.
        if (offset === 0 && all.length === 0) {
            console.error(`[chapters] ${slug}: .list-info parsed but 0 chapter rows — selector drift?`);
            return res.status(502).json({ error: ERROR_TEXT.INVALID, code: "INVALID" });
        }
        res.json({ issues: all.slice(offset, offset + limit) });
    } catch (err) {
        clientError(res, err, "chapters");
    }
});

app.get("/pages", async (req, res) => {
    const slug = String(req.query.id || "").trim();
    const chapterId = String(req.query.chapterId || "").trim();
    if (!slug || !chapterId) return res.status(400).json({ error: "missing id or chapterId" });
    // The old `validate` mode HEAD-checked all ~29 page URLs. It was dead code
    // in production (disabled whenever an image proxy was configured) and a
    // guaranteed no-op if re-enabled: every page image HEADs as text/html, so
    // it dropped all of them and the fallbackToRaw branch handed the same dead
    // list back anyway — 29 wasted requests for nothing. Replaced by two sampled
    // byte-checks below.
    const verify = req.query.validate !== "0" && PAGES_VERIFY;
    // The chapter id is the authoritative one: it is what actually addresses the
    // images. Falling back to the series id keeps a mixed pair working.
    const src = sourceForId(chapterId) || sourceForId(slug);
    try {
        const result = await cacheWrap(
            `pages:v5:${src ? src.id : "xoxo"}:${slug}:${chapterId}:${verify ? "checked" : "raw"}`,
            async () => {
                // Whichever source produced the list, it goes through the SAME
                // sampled byte-check below — that check is what turns a
                // non-viewable issue into an honest error instead of a wall of
                // broken images, and no source gets to skip it.
                const pages = src
                    ? await src.pages(slug, chapterId)
                    : await fetchChapterPages(slug, chapterId);
                if (!verify || pages.length === 0) {
                    return { pages, droppedCount: 0, totalDiscovered: pages.length, verified: false };
                }
                // Sample TWO pages through the same path /img uses — disk cache
                // first, then direct, NEVER metered. Two, not one, because the
                // disk cache holds 41 real page-1 images from before the upstream
                // broke: sampling only page 1 would certify a chapter where the
                // other 188 pages are dead.
                const candidates = [pages[0]];
                if (pages.length > 2) candidates.push(pages[Math.floor(pages.length / 2)]);
                let liveHits = 0;
                let invalid = 0;
                for (const candidate of candidates) {
                    try {
                        await loadImage(candidate, { allowProxy: false, minBytes: MIN_PAGE_IMAGE_BYTES });
                        liveHits += 1;
                    } catch (err) {
                        if (err instanceof UpstreamError && err.code === "INVALID") invalid += 1;
                        else return { pages, droppedCount: 0, totalDiscovered: pages.length, verified: false, soft: true };
                    }
                }
                if (liveHits === 0 && invalid > 0) {
                    return {
                        pages: [], droppedCount: pages.length, totalDiscovered: pages.length,
                        verified: true, readerBroken: true,
                    };
                }
                return { pages, droppedCount: 0, totalDiscovered: pages.length, verified: true };
            },
            {
                // Never cache an UNVERIFIED page list: during a block the sampler
                // cannot reach the origin, and storing "here are 189 URLs, we
                // have no idea if they work" for an hour is how a transient
                // failure becomes a stuck reader.
                shouldCache: (v) => Boolean(v && (v.readerBroken || (v.pages.length > 0 && v.verified !== false))),
                // Negative verdicts expire fast so recovery is minutes, not an hour.
                ttlFor: (v) => (v.readerBroken ? NEGATIVE_TTL_MS : undefined),
            },
        );
        if (result.readerBroken) {
            return res.status(502).json({
                error: "this chapter's pages are not available from the source right now",
                code: "READER_UPSTREAM_BROKEN",
                totalDiscovered: result.totalDiscovered,
            });
        }
        if (!result.pages.length) {
            return res.status(502).json({ error: ERROR_TEXT.INVALID, code: "INVALID" });
        }
        res.json({
            pages: result.pages,
            droppedCount: result.droppedCount,
            totalDiscovered: result.totalDiscovered,
            verified: Boolean(result.verified),
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
    // Allowlist, not a private-range blocklist. This endpoint takes a
    // caller-supplied URL and the Vercel media-proxy allowlist forwards ANY
    // http(s) URL to it, so a blocklist makes the droplet a general-purpose
    // fetch proxy for whoever finds it.
    if (!hostAllowed(target.hostname)) {
        return res.status(403).type("text/plain").send("host not allowed");
    }

    try {
        const { buf, contentType } = await loadImage(target.toString());
        res.set("Content-Type", contentType);
        res.set("Content-Length", String(buf.length));
        res.set("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable");
        res.set("Access-Control-Allow-Origin", "*");
        res.status(200).end(buf);
    } catch (err) {
        const code = err instanceof UpstreamError ? err.code : "INTERNAL";
        // INVALID means "upstream gave us something that isn't an image" — a
        // genuinely dead image, so 404 keeps the client's <img> fallback simple.
        // Everything else is OUR side being unable to fetch, which must not be
        // reported as "this image does not exist": a billing failure showing up
        // as a 404 is how the last outage stayed invisible.
        const status = code === "INVALID" ? 404 : (ERROR_STATUS[code] || 502);
        if (code !== "INVALID") {
            console.error(`[img] ${code}: ${String(err?.message || err).slice(0, 200)}`);
        }
        if (code === "BUSY") res.set("Retry-After", "2");
        // Never echo the upstream/vendor body — it carried the proxy's dunning
        // notice into the app the last time this happened.
        res.status(status).type("text/plain").send(code === "INVALID" ? "not an image" : "image unavailable");
    }
});

app.use((_req, res) => res.status(404).json({ error: "not found" }));

// COMICS_NO_LISTEN=1 imports the module without binding a port so the parsers
// and validators can be regression-tested against saved HTML offline.
if (process.env.COMICS_NO_LISTEN !== "1") {
    app.listen(PORT, () => {
        console.log(
            `Sakura comics scraper listening on :${PORT} (upstream=${UPSTREAM_BASE}, mode=${upstream.mode()})`,
        );
    });
}

export {
    app,
    parseListPage,
    parseDetailPage,
    parseChapters,
    parsePages,
    sniffImageType,
    plausiblePageImage,
    MIN_PAGE_IMAGE_BYTES,
    hostAllowed,
    validateListPage,
    validateSearchPage,
    validateComicPage,
    validateChapterPage,
};
