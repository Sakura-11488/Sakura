/**
 * Sakura Comics scraper proxy.
 *
 * Runs on the DigitalOcean droplet behind nginx at /comics/v1/*.
 * Responsibilities:
 *   - Fetch HTML from upstream comic source (XOXO Comics primary)
 *   - Parse with Cheerio into stable JSON envelopes consumed by the app
 *   - LRU cache every endpoint so repeat views are instant
 *   - Rotate user agents and retry on transient failures
 *
 * Endpoints (prefixed with /comics/v1 by nginx):
 *   GET /search?q=<term>&limit=&offset=
 *   GET /popular?limit=
 *   GET /details?id=<slug>
 *   GET /chapters?id=<slug>&limit=&offset=
 *   GET /pages?id=<slug>&chapterId=<issueSlug>
 *   GET /img?u=<encoded image url>      // streams bytes through the droplet
 *   GET /healthz
 */

import express from "express";
import { load as loadHtml } from "cheerio";
import { LRUCache } from "lru-cache";
import { fetch as undiciFetch } from "undici";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.COMICS_SCRAPER_PORT || 3100);
const UPSTREAM_BASE = process.env.COMICS_UPSTREAM_BASE || "https://xoxocomic.com";
const CACHE_MAX = Number(process.env.COMICS_CACHE_MAX || 1000);
const CACHE_TTL_MS = Number(process.env.COMICS_CACHE_TTL_MS || 15 * 60 * 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.COMICS_REQUEST_TIMEOUT_MS || 20_000);

// Cloudflare-bypass proxy for upstream *page* fetches.
//
// xoxocomic.com (and every free mirror we've found) sits behind a Cloudflare
// "managed challenge" (`cf-mitigated: challenge`, HTTP 403 "Just a moment...")
// that blocks this droplet's datacenter IP. Plain fetches — even with rotated
// UAs or TLS impersonation — get the challenge page instead of HTML, so the
// Cheerio parsers find nothing and every endpoint returns empty.
//
// When COMICS_FETCH_PROXY_TEMPLATE is set, upstream page fetches are routed
// through a scraping/CF-bypass API that solves the challenge on residential
// IPs and returns the real HTML. The template must contain the literal token
// {{url}}, which is replaced with the URL-encoded upstream URL. Examples:
//   ScraperAPI:  https://api.scraperapi.com/?api_key=KEY&render=true&url={{url}}
//   ZenRows:     https://api.zenrows.com/v1/?apikey=KEY&js_render=true&antibot=true&url={{url}}
//   ScrapingBee: https://app.scrapingbee.com/api/v1/?api_key=KEY&render_js=true&url={{url}}
const FETCH_PROXY_TEMPLATE = process.env.COMICS_FETCH_PROXY_TEMPLATE || "";

function proxiedPageUrl(url) {
    if (!FETCH_PROXY_TEMPLATE) return url;
    return FETCH_PROXY_TEMPLATE.replace("{{url}}", encodeURIComponent(url));
}

// The covers and page images live on the same Cloudflare-protected host, so
// they 403 from the droplet too. They need residential-IP fetching as well —
// but they DON'T need JS rendering, so a cheaper "antibot only" template keeps
// the credit cost down (e.g. ZenRows `antibot=true` without `js_render`).
// Every unique image is fetched through this proxy at most once and then cached
// on disk (see IMG_CACHE_DIR), so repeat views and re-reads cost nothing.
//   ZenRows: https://api.zenrows.com/v1/?apikey=KEY&antibot=true&url={{url}}
// If unset, image fetches fall back to COMICS_FETCH_PROXY_TEMPLATE, and if that
// is also unset they go direct (which currently 403s — covers/pages will break).
const IMAGE_PROXY_TEMPLATE =
    process.env.COMICS_IMAGE_PROXY_TEMPLATE || FETCH_PROXY_TEMPLATE || "";

function proxiedImageUrl(url) {
    if (!IMAGE_PROXY_TEMPLATE) return url;
    return IMAGE_PROXY_TEMPLATE.replace("{{url}}", encodeURIComponent(url));
}

// Persistent on-disk cache for proxied image bytes. Bounds ZenRows credit usage
// to "unique images ever viewed" — a chapter is paid for once, globally, then
// served from disk forever. The droplet has ~20 GB free.
const IMG_CACHE_DIR = process.env.COMICS_IMG_CACHE_DIR || path.join(process.cwd(), "img-cache");
try {
    mkdirSync(IMG_CACHE_DIR, { recursive: true });
} catch {
    // best effort; /img still works without the disk cache
}

function imgCachePath(url) {
    const h = createHash("sha256").update(url).digest("hex");
    // Two-level fan-out keeps directories from growing to millions of entries.
    return path.join(IMG_CACHE_DIR, h.slice(0, 2), h);
}

// Sniff the real image type from magic bytes. Needed because ZenRows returns
// proxied binary bodies as `text/plain`, so we can't trust the content-type
// header — but the bytes themselves are a genuine JPEG/PNG/GIF/WebP. Returns
// null when the body isn't a recognised image (e.g. an upstream HTML 404).
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

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
];

function pickUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const cache = new LRUCache({
    max: CACHE_MAX,
    ttl: CACHE_TTL_MS,
});

async function cacheWrap(key, producer) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = await producer();
    cache.set(key, value);
    return value;
}

async function fetchHtml(url, { retries = 2 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await undiciFetch(proxiedPageUrl(url), {
            signal: controller.signal,
            headers: {
                "User-Agent": pickUserAgent(),
                Accept: "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
                "Cache-Control": "no-cache",
                Referer: UPSTREAM_BASE,
            },
            redirect: "follow",
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            // `url` (not the proxied form) keeps the key out of logs/responses.
            throw new Error(`Upstream HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
        }
        return await res.text();
    } catch (err) {
        if (retries > 0 && (err?.name === "AbortError" || String(err).includes("ECONNRESET"))) {
            return fetchHtml(url, { retries: retries - 1 });
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function absolute(path) {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    return `${UPSTREAM_BASE.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
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

function parseDetailPage(html, slug) {
    const $ = loadHtml(html);
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

function parseChapters(html, slug) {
    const $ = loadHtml(html);
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

// XOXO's image hosting is unreliable: many <img data-original> URLs return HTML
// instead of an image (Cloudflare cached the reader page, not the bytes).
// Before handing URLs to the app we HEAD each one in parallel and only keep
// the ones that respond with an image content type. A short timeout keeps the
// /pages endpoint snappy even when origin is slow.
const HEAD_CONCURRENCY = Number(process.env.COMICS_HEAD_CONCURRENCY || 12);
const HEAD_TIMEOUT_MS = Number(process.env.COMICS_HEAD_TIMEOUT_MS || 7_000);

async function headIsImage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
    try {
        const res = await undiciFetch(url, {
            method: "HEAD",
            signal: controller.signal,
            headers: {
                "User-Agent": pickUserAgent(),
                Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
                Referer: UPSTREAM_BASE,
            },
            redirect: "follow",
        });
        if (!res.ok) return false;
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        return ct.startsWith("image/");
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

async function filterBrokenPages(urls) {
    const results = new Array(urls.length).fill(false);
    let cursor = 0;
    async function worker() {
        while (true) {
            const idx = cursor++;
            if (idx >= urls.length) return;
            results[idx] = await headIsImage(urls[idx]);
        }
    }
    const workers = Array.from({ length: Math.min(HEAD_CONCURRENCY, urls.length) }, worker);
    await Promise.all(workers);
    const kept = [];
    let dropped = 0;
    for (let i = 0; i < urls.length; i++) {
        if (results[i]) kept.push(urls[i]);
        else dropped++;
    }
    return { pages: kept, droppedCount: dropped };
}

function clampInt(value, { min, max, def }) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
}

// Image proxy. Cloudflare in front of xoxocomic.com sometimes serves a
// different response (HTML 404, AdBlock detector page) at edge nodes far
// from the upstream than at edges close to it. So even URLs that HEAD as
// `image/*` from this droplet may resolve to HTML on a user device in a
// different region. To make image loading bulletproof, the app routes every
// cover/page through this endpoint: we fetch from upstream with proper
// headers and stream image bytes back, or 404 if the upstream gave HTML.
const IMAGE_PROXY_TIMEOUT_MS = Number(process.env.COMICS_IMAGE_TIMEOUT_MS || 20_000);

function isPrivateOrLocalHost(hostname) {
    if (!hostname) return true;
    const h = hostname.toLowerCase();
    if (h === "localhost" || h === "0.0.0.0") return true;
    if (h.endsWith(".local") || h.endsWith(".internal")) return true;
    // Block IP literals in private ranges
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
        upstream: UPSTREAM_BASE,
        cacheSize: cache.size,
        // Booleans only — never echo the template/key.
        fetchProxy: FETCH_PROXY_TEMPLATE ? true : false,
        imageProxy: IMAGE_PROXY_TEMPLATE ? true : false,
    });
});

// Operator probe — NEVER exposed to the app. Helps diagnose selector / bot
// detection issues without SSHing. Returns raw HTML length, a small sample,
// and the parsed item count for a given upstream path.
app.get("/debug/probe", async (req, res) => {
    const p = String(req.query.path || "").trim();
    if (!p || !p.startsWith("/")) {
        return res.status(400).json({ error: "missing or invalid path (must start with /)" });
    }
    try {
        const html = await fetchHtml(`${UPSTREAM_BASE}${p}`);
        const parsed = parseListPage(html);
        res.json({
            length: html.length,
            titleSnippet: (html.match(/<title>([^<]*)<\/title>/i) || [, ""])[1].trim(),
            parsedItems: parsed.length,
            sampleHead: html.slice(0, 400),
            sampleMiddle: html.slice(Math.floor(html.length / 2), Math.floor(html.length / 2) + 400),
        });
    } catch (err) {
        res.status(502).json({ error: String(err?.message || err) });
    }
});

app.get("/popular", async (req, res) => {
    const limit = clampInt(req.query.limit, { min: 1, max: 60, def: 24 });
    try {
        const items = await cacheWrap(`popular:${limit}`, async () => {
            const html = await fetchHtml(`${UPSTREAM_BASE}/popular-comic`);
            return parseListPage(html).slice(0, limit);
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
    if (!q) {
        return res.json({ items: [] });
    }
    try {
        const items = await cacheWrap(`search:${q.toLowerCase()}:${limit}:${offset}`, async () => {
            const url = `${UPSTREAM_BASE}/search-comic?keyword=${encodeURIComponent(q)}`;
            const html = await fetchHtml(url);
            const parsed = parseListPage(html);
            return parsed.slice(offset, offset + limit);
        });
        res.json({ items });
    } catch (err) {
        console.error("search failed", err);
        res.status(502).json({ error: String(err?.message || err) });
    }
});

app.get("/details", async (req, res) => {
    const slug = String(req.query.id || "").trim();
    if (!slug) return res.status(400).json({ error: "missing id" });
    try {
        const comic = await cacheWrap(`details:${slug}`, async () => {
            const html = await fetchHtml(`${UPSTREAM_BASE}/comic/${encodeURIComponent(slug)}`);
            return parseDetailPage(html, slug);
        });
        if (!comic) return res.status(404).json({ error: "not found" });
        res.json({ comic });
    } catch (err) {
        console.error("details failed", err);
        res.status(502).json({ error: String(err?.message || err) });
    }
});

app.get("/chapters", async (req, res) => {
    const slug = String(req.query.id || "").trim();
    const limit = clampInt(req.query.limit, { min: 1, max: 2000, def: 500 });
    const offset = clampInt(req.query.offset, { min: 0, max: 5000, def: 0 });
    if (!slug) return res.status(400).json({ error: "missing id" });
    try {
        const issues = await cacheWrap(`chapters:${slug}:${limit}:${offset}`, async () => {
            const html = await fetchHtml(`${UPSTREAM_BASE}/comic/${encodeURIComponent(slug)}`);
            const parsed = parseChapters(html, slug);
            return parsed.slice(offset, offset + limit);
        });
        res.json({ issues });
    } catch (err) {
        console.error("chapters failed", err);
        res.status(502).json({ error: String(err?.message || err) });
    }
});

app.get("/pages", async (req, res) => {
    const slug = String(req.query.id || "").trim();
    const chapterId = String(req.query.chapterId || "").trim();
    // Validation HEADs each candidate page URL on the droplet so we hand the
    // app only URLs that actually serve image bytes upstream — many xoxo
    // chapters have a stale data-original entry whose path returns HTML.
    //
    // Skipped entirely when an image proxy is configured: a direct HEAD from
    // this droplet always 403s (Cloudflare), and re-checking every page through
    // the metered proxy would cost one API credit per page for no real benefit
    // — the /img proxy already 404s broken images at fetch time.
    //
    // Set `validate=0` to disable explicitly.
    const validate = req.query.validate !== "0" && !IMAGE_PROXY_TEMPLATE;
    if (!slug || !chapterId) return res.status(400).json({ error: "missing id or chapterId" });
    try {
        const result = await cacheWrap(`pages:v3:${slug}:${chapterId}:${validate ? "checked" : "raw"}`, async () => {
            const url = `${UPSTREAM_BASE}/comic/${encodeURIComponent(slug)}/${encodeURIComponent(chapterId)}/all`;
            const html = await fetchHtml(url);
            const raw = parsePages(html);
            if (!validate) {
                return { pages: raw, droppedCount: 0, totalDiscovered: raw.length };
            }
            const filtered = await filterBrokenPages(raw);
            // Defensive fallback: if validation dropped *every* page (often
            // a transient Cloudflare edge or upstream HEAD quirk rather than
            // a permanently dead chapter), surface the raw list so the user
            // can still attempt to read — broken pages will show as image
            // load failures, but that's strictly better than an empty
            // "Error Loading Chapter" screen.
            if (filtered.pages.length === 0 && raw.length > 0) {
                return {
                    pages: raw,
                    droppedCount: 0,
                    totalDiscovered: raw.length,
                    fallbackToRaw: true,
                };
            }
            return { ...filtered, totalDiscovered: raw.length };
        });
        res.json({
            pages: result.pages,
            droppedCount: result.droppedCount,
            totalDiscovered: result.totalDiscovered,
            fallbackToRaw: result.fallbackToRaw || false,
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

    function serve(buf, ct) {
        res.set("Content-Type", ct);
        res.set("Content-Length", String(buf.length));
        res.set("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable");
        res.set("Access-Control-Allow-Origin", "*");
        res.status(200).end(buf);
    }

    // 1) Serve from the persistent disk cache if we've fetched this URL before.
    const cachePath = imgCachePath(target.toString());
    try {
        const cached = await readFile(cachePath);
        const ct = sniffImageType(cached);
        if (ct) return serve(cached, ct);
    } catch {
        // cache miss — fall through to fetch
    }

    // 2) Fetch through the (residential-IP) image proxy so we get past
    //    Cloudflare, then trust the bytes (magic-sniffed) over the content-type,
    //    since ZenRows returns proxied binaries as text/plain.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_PROXY_TIMEOUT_MS);
    try {
        const upstream = await undiciFetch(proxiedImageUrl(target.toString()), {
            method: "GET",
            signal: controller.signal,
            headers: {
                "User-Agent": pickUserAgent(),
                Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                Referer: UPSTREAM_BASE,
            },
            redirect: "follow",
        });
        if (!upstream.ok) {
            return res.status(404).type("text/plain").send("not an image");
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        const ct = sniffImageType(buf);
        if (!ct) {
            // Upstream/proxy returned HTML (dead image, challenge, or error).
            return res.status(404).type("text/plain").send("not an image");
        }
        // Persist for next time (best effort — never block the response on it).
        writeFile(cachePath, buf).catch(async () => {
            try {
                mkdirSync(path.dirname(cachePath), { recursive: true });
                await writeFile(cachePath, buf);
            } catch {
                /* disk cache unavailable; still serve the image */
            }
        });
        serve(buf, ct);
    } catch (err) {
        res.status(502).type("text/plain").send(String(err?.message || err).slice(0, 200));
    } finally {
        clearTimeout(timer);
    }
});

app.use((_req, res) => res.status(404).json({ error: "not found" }));

app.listen(PORT, () => {
    console.log(`Sakura comics scraper listening on :${PORT} (upstream=${UPSTREAM_BASE})`);
});
