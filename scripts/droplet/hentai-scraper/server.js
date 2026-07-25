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
 *   - Fetch HTML from the upstream hentai source (HentaiFox primary)
 *   - Parse with Cheerio into stable JSON envelopes consumed by the app
 *   - LRU cache every endpoint so repeat views are instant
 *   - Rotate user agents and retry on transient failures
 *   - Stream images through /img with a Referer header (defeats hotlink block)
 *
 * Endpoints (prefixed with /hentai/v1 by nginx):
 *   GET /search?q=<term>&limit=&offset=
 *   GET /popular?limit=
 *   GET /details?id=<galleryId>
 *   GET /chapters?id=<galleryId>            // always one synthetic "gallery" issue
 *   GET /pages?id=<galleryId>&chapterId=gallery
 *   GET /img?u=<encoded image url>          // streams bytes through the droplet
 *   GET /healthz
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

const PORT = Number(process.env.HENTAI_SCRAPER_PORT || 3101);
const UPSTREAM_BASE = process.env.HENTAI_UPSTREAM_BASE || "https://hentaifox.com";
const CACHE_MAX = Number(process.env.HENTAI_CACHE_MAX || 1000);
const CACHE_TTL_MS = Number(process.env.HENTAI_CACHE_TTL_MS || 15 * 60 * 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.HENTAI_REQUEST_TIMEOUT_MS || 20_000);

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
];

function pickUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// HentaiFox encodes each page's image format in the embedded `g_th` map as a
// single-letter code. Map it to the real file extension.
const CDN_EXT = { j: "jpg", p: "png", w: "webp", g: "gif", b: "bmp" };

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
        const res = await undiciFetch(url, {
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
            if (src && !src.startsWith("data:")) entry.cover = src;
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
        const src =
            $(img).attr("data-src") ||
            $(img).attr("data-original") ||
            $(img).attr("src") ||
            "";
        const m = src.match(/^(https?:\/\/\S+\/)\d+t\.(?:jpg|png|webp|gif|bmp)$/i);
        if (m) base = m[1];
    });
    return base;
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

// Image proxy. HentaiFox's CDN (i*.hentaifox.com) enforces hotlink protection
// via the Referer header, so a device fetching the image URL directly gets a
// 403 / placeholder. The app routes every cover/page through this endpoint;
// we refetch with a proper Referer and stream the bytes back.
const IMAGE_PROXY_TIMEOUT_MS = Number(process.env.HENTAI_IMAGE_TIMEOUT_MS || 20_000);

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

const app = express();

app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
});

app.get("/healthz", (_req, res) => {
    res.json({ ok: true, upstream: UPSTREAM_BASE, cacheSize: cache.size });
});

// Operator probe — NOT exposed to the app. Diagnoses selector / bot-detection
// issues without SSHing.
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
        });
    } catch (err) {
        res.status(502).json({ error: String(err?.message || err) });
    }
});

app.get("/popular", async (req, res) => {
    const limit = clampInt(req.query.limit, { min: 1, max: 60, def: 24 });
    try {
        const items = await cacheWrap(`popular:${limit}`, async () => {
            // HentaiFox has no dedicated popular endpoint; the home page is the
            // freshest gallery grid, which we surface as "trending".
            const html = await fetchHtml(`${UPSTREAM_BASE}/`);
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
    if (!q) return res.json({ items: [] });
    try {
        const items = await cacheWrap(`search:${q.toLowerCase()}:${limit}:${offset}`, async () => {
            const url = `${UPSTREAM_BASE}/search/?q=${encodeURIComponent(q)}`;
            const html = await fetchHtml(url);
            return parseListPage(html).slice(offset, offset + limit);
        });
        res.json({ items });
    } catch (err) {
        console.error("search failed", err);
        res.status(502).json({ error: String(err?.message || err) });
    }
});

app.get("/details", async (req, res) => {
    const id = String(req.query.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });
    try {
        const comic = await cacheWrap(`details:${id}`, async () => {
            const html = await fetchHtml(galleryUrl(encodeURIComponent(id)));
            return parseDetailPage(html, id);
        });
        if (!comic) return res.status(404).json({ error: "not found" });
        res.json({ comic });
    } catch (err) {
        console.error("details failed", err);
        res.status(502).json({ error: String(err?.message || err) });
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
        const result = await cacheWrap(`pages:v1:${id}`, async () => {
            const html = await fetchHtml(galleryUrl(encodeURIComponent(id)));
            const pages = buildPageUrls(html);
            return { pages, totalDiscovered: pages.length };
        });
        res.json({
            pages: result.pages,
            droppedCount: 0,
            totalDiscovered: result.totalDiscovered,
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
                Referer: UPSTREAM_BASE,
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
    console.log(`Sakura hentai scraper listening on :${PORT} (upstream=${UPSTREAM_BASE})`);
});
