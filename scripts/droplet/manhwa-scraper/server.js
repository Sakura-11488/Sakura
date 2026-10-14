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

import { lookup as dnsLookup } from "node:dns";
import { lookup } from "node:dns/promises";
import net from "node:net";
import express from "express";
import { load as loadHtml } from "cheerio";
import { LRUCache } from "lru-cache";
import { Agent, fetch as undiciFetch } from "undici";

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
// The entry count alone does not bound memory. A parsed chapter list costs
// ~1.8x its JSON in heap - Martial Peak's 3,864 rows are ~370KB of JSON and
// ~670KB of heap - so 400 long series would be ~270MB, far past PM2's 160M
// restart line. Sized by JSON length, which tracks heap closely enough.
const CACHE_MAX_BYTES = Number(process.env.MANHWA_CACHE_MAX_BYTES || 24 * 1024 * 1024);
const CACHE_TTL_MS = Number(process.env.MANHWA_CACHE_TTL_MS || 15 * 60 * 1000);
// A search that only one upstream answered is cached briefly, so the missing
// half comes back within a minute instead of a quarter of an hour.
const PARTIAL_CACHE_TTL_MS = Number(process.env.MANHWA_PARTIAL_CACHE_TTL_MS || 60 * 1000);
// Per attempt. Retries share REQUEST_BUDGET_MS, which must stay under nginx's
// proxy_read_timeout (30s): with 25s per attempt and two retries, one slow
// upstream call could run 75s, so nginx answered 504 HTML at 30s while this
// process kept working for nobody.
const REQUEST_TIMEOUT_MS = Number(process.env.MANHWA_REQUEST_TIMEOUT_MS || 12_000);
const REQUEST_BUDGET_MS = Number(process.env.MANHWA_REQUEST_BUDGET_MS || 26_000);
const IMAGE_PROXY_TIMEOUT_MS = Number(process.env.MANHWA_IMAGE_TIMEOUT_MS || 20_000);
// /img buffers the whole image before answering (so a truncated body is never
// sent with a day-long cache header). Without a cap, any public URL serving
// image/* - or an endless stream - was read into memory for up to 20s.
const IMAGE_MAX_BYTES = Number(process.env.MANHWA_IMAGE_MAX_BYTES || 16 * 1024 * 1024);
// mangaread's view-ordered catalogue adds 12 new series a page (page 1 parses
// to 19, with a 7-series sidebar widget every page repeats), so the app's
// limit=60 needs 5 pages: 19 + 4 x 12 = 67. Bounds /popular's fan-out on a
// public endpoint; pages are cached per page, so this is per cache lifetime.
const POPULAR_MAX_PAGES = Number(process.env.MANHWA_POPULAR_MAX_PAGES || 5);

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
    maxSize: CACHE_MAX_BYTES,
    sizeCalculation: (value, key) => Math.max(1, (JSON.stringify(value) || "").length + String(key).length),
});

// Producers already running, by cache key. Without this, N clients opening
// the same long series on a cold cache (every PM2 restart) each fetched and
// parsed its ~900KB chapter list at once - N x the upstream load and N x the
// transient heap on a box that restarts at 160M.
const inflight = new Map();

/**
 * Cache only answers worth repeating. Every route used to cache whatever came
 * back, so an empty chapter list or a 0-page chapter (an upstream hiccup the
 * adapters had swallowed) was served as the truth for 15 minutes, and Retry in
 * the app could not get past it.
 */
export async function cacheWrap(key, producer, { shouldCache = (v) => !isEmpty(v), ttlFor = () => undefined } = {}) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const running = inflight.get(key);
    if (running) return running;
    const pending = (async () => {
        const value = await producer();
        if (shouldCache(value)) {
            const ttl = ttlFor(value);
            cache.set(key, value, ttl ? { ttl } : undefined);
        }
        return value;
    })().finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
}

function isEmpty(value) {
    return value == null || (Array.isArray(value) && value.length === 0);
}

/** An upstream answered, or failed to, with this HTTP status (504 for our own timeout). */
export class UpstreamError extends Error {
    constructor(status, message) {
        super(message);
        this.name = "UpstreamError";
        this.status = status;
    }
}

/**
 * GET/POST one upstream page as text.
 *
 * Retries timeouts, resets and 5xx, but only while REQUEST_BUDGET_MS lasts.
 * Errors carry the status and never the body: the old message embedded the
 * first 200 bytes of mangaread's 404 page, and that HTML went all the way to
 * the app as an "error".
 *
 * A route that makes several calls one after another passes its own
 * `deadline` (see requestDeadline), so the calls share one budget instead of
 * each getting a fresh one - /popular's page rounds plus its comizy top-up
 * could otherwise run ~78s behind nginx's 30s.
 */
export async function fetchUpstream(url, { method = "GET", referer, ajax = false, deadline: outer = Infinity } = {}) {
    const deadline = Math.min(Date.now() + REQUEST_BUDGET_MS, outer);
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining < 1000) break;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
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
                await res.body?.cancel().catch(() => {});
                throw new UpstreamError(res.status, `Upstream HTTP ${res.status} for ${url}`);
            }
            return await res.text();
        } catch (err) {
            const timedOut = err?.name === "AbortError";
            lastErr = err instanceof UpstreamError
                ? err
                : new UpstreamError(timedOut ? 504 : 502, timedOut
                    ? `Upstream timed out for ${url}`
                    : `Upstream request failed for ${url}: ${String(err?.message || err).slice(0, 120)}`);
            const retryable = timedOut || String(err).includes("ECONNRESET") || lastErr.status >= 500;
            if (!retryable) throw lastErr;
        } finally {
            clearTimeout(timer);
        }
    }
    if (lastErr) throw lastErr;
    // The caller's budget was spent before a single attempt.
    throw Object.assign(new UpstreamError(504, `No request budget left for ${url}`), { unattempted: true });
}

/** One budget for everything a single request fetches upstream. */
export function requestDeadline() {
    return Date.now() + REQUEST_BUDGET_MS;
}

function clampInt(value, { min, max, def }) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
}

// Every range /img must never connect to. Literal IPs reach the check already
// normalised: WHATWG URL rewrites decimal, octal, hex and short IPv4 spellings
// (http://2130706433/, http://0x7f.1/, http://127.1/) to dotted quads, and
// IPv6 to its compressed form - inside brackets, which hostOf() strips.
const BLOCKED_V4 = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
];
// No ::ffff:0:0/96 rule here: BlockList checks IPv4 addresses against IPv6
// rules in mapped form, so that rule matches every IPv4 address there is.
// Mapped addresses are unwrapped by hand in isBlockedAddress instead.
const BLOCKED_V6 = [
    ["::", 96], // unspecified, loopback, IPv4-compatible
    ["64:ff9b::", 96], ["64:ff9b:1::", 48], // NAT64
    ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
    ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
];
const BLOCKED_NETS = new net.BlockList();
for (const [addr, prefix] of BLOCKED_V4) BLOCKED_NETS.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of BLOCKED_V6) BLOCKED_NETS.addSubnet(addr, prefix, "ipv6");

/** URL.hostname keeps IPv6 brackets ("[::1]") and a trailing root dot. */
function hostOf(hostname) {
    return String(hostname || "").toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

/** Whether a literal IP is private, local or otherwise not the public internet. */
export function isBlockedAddress(address) {
    const a = hostOf(address);
    const family = net.isIP(a);
    if (family === 0) return true;
    if (family === 6) {
        // IPv4-mapped (::ffff:7f00:1, ::ffff:127.0.0.1) is the IPv4 address in
        // disguise, and connects to it on a dual-stack socket.
        const mapped = a.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
        if (mapped) {
            const v4 = mapped[1] || [mapped[2], mapped[3]]
                .flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; })
                .join(".");
            return isBlockedAddress(v4);
        }
    }
    return BLOCKED_NETS.check(a, family === 6 ? "ipv6" : "ipv4");
}

function isPrivateOrLocalHost(hostname) {
    const h = hostOf(hostname);
    if (!h) return true;
    if (net.isIP(h)) return isBlockedAddress(h);
    return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal");
}

/**
 * Whether /img may fetch from this host: the name AND everything it resolves
 * to must be public. Checking the name alone let any public DNS name that
 * points inward through - 127.0.0.1.nip.io, or a record aimed at the droplet's
 * metadata service. This is the early, friendly 403; guardedLookup re-checks
 * the addresses actually connected to, which a rebinding DNS answer can change
 * between the two lookups.
 */
export async function isPublicHost(hostname, resolve = (h) => lookup(h, { all: true, verbatim: true })) {
    if (isPrivateOrLocalHost(hostname)) return false;
    const h = hostOf(hostname);
    // A literal IP is already fully checked above.
    if (net.isIP(h)) return true;
    try {
        const addrs = await resolve(h);
        return addrs.length > 0 && addrs.every((a) => !isBlockedAddress(a.address));
    } catch {
        return false;
    }
}

/**
 * net.connect's `lookup`, refusing to hand back any non-public address. Runs
 * on every connection /img opens, redirect hops included, so the address
 * checked is the address used. Handles both the single-address form and the
 * `all: true` form Node 20's autoSelectFamily asks for.
 */
export function guardedLookup(hostname, options, callback) {
    if (typeof options === "function") {
        callback = options;
        options = {};
    } else if (typeof options === "number") {
        options = { family: options };
    }
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err);
        const list = Array.isArray(addresses) ? addresses : [];
        if (!list.length || list.some((a) => isBlockedAddress(a.address))) {
            const refused = new Error(`refusing to connect to ${hostname}: not a public address`);
            refused.code = "EHOSTUNREACH";
            return callback(refused);
        }
        if (options?.all) return callback(null, list);
        return callback(null, list[0].address, list[0].family);
    });
}

const imageAgent = new Agent({ connect: { lookup: guardedLookup } });

/**
 * Pull a JSON array out of an SSR payload by bracket-matching from its key.
 *
 * comizy embeds its state as a raw JSON blob in the HTML. A non-greedy regex
 * stops at the first "]", which lands mid-array as soon as any entry contains a
 * nested array, so match brackets properly and skip over string literals.
 */
export function extractJsonArray(html, key) {
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
export function titleKey(title) {
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
export function relevance(title, query) {
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

/**
 * The one spelling of a slug: decoded.
 *
 * mangaread percent-encodes non-ASCII slugs in its hrefs ("s%e2%80%91rank",
 * a non-breaking hyphen), and the old code kept that raw form as the id, then
 * encodeURIComponent'd it again when building URLs - %25e2%2580%2591 - which
 * 404s. Clients also disagree on the form they send back: the web build's
 * router decodes route params, native keeps them encoded. Decoding at every
 * entry point makes both spellings the same series, and URLs are then encoded
 * exactly once, where they are built.
 */
export function canonicalSlug(slug) {
    const s = String(slug || "");
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

export function mangareadSlugFromHref(href) {
    const m = String(href || "").match(/\/manga\/([^/?#]+)/);
    if (!m) return null;
    const slug = canonicalSlug(m[1]);
    // /manga/feed/ is the site's RSS route and matches a naive /manga/ collector.
    if (slug === "feed") return null;
    return slug;
}

const mangareadSeriesUrl = (slug) => `${MANGAREAD_BASE}/manga/${encodeURIComponent(slug)}/`;

/**
 * mangaread's chapter dates, which come in two shapes on the same page.
 *
 * Recent rows render a relative phrase ("3 days ago"); older rows render
 * DD.MM.YYYY ("16.07.2026", "19.01.2023"). Both appear in one response, so
 * both have to be handled.
 *
 * DD.MM.YYYY is DAY FIRST. Reading it month-first silently produces a wrong
 * date for every chapter whose day is 12 or lower — 05.11.2025 is 5 November,
 * not 11 May — and nothing downstream would flag it.
 *
 * Relative phrases are converted by subtracting from now. Exact for hours,
 * days and weeks; months and years are approximate by nature, so they land on
 * a real instant rather than pretending to a precision the source never had.
 */
const RELATIVE_UNIT_MS = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
};

export function parseChapterDate(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;

    const dmy = text.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
    if (dmy) {
        const [, day, month, year] = dmy;
        const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }

    const rel = text.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i);
    if (rel) {
        const unit = RELATIVE_UNIT_MS[rel[2].toLowerCase()];
        if (unit) return new Date(Date.now() - Number(rel[1]) * unit).toISOString();
    }

    // "just now", "a day ago" and anything unrecognised: better no date than a
    // wrong one, and the client renders nothing for an empty value.
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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
 * Titles are chosen by source precedence, not by length, and text inside an
 * image anchor is never treated as a title.
 *
 * Each card links the series twice. The caption anchor holds the real title.
 * The thumbnail anchor holds an SEO alt ("Read Manhwa Baek XX") plus, on the
 * catalogue grid, a rating badge - so its text content is "SS", not the series
 * name. Preferring the longest string picks the boilerplate; trusting anchor
 * text uniformly picks the badge, and because both anchors would then rank
 * equally the caption could never displace it. Every catalogue title came back
 * as "SS" that way.
 */
export function mangareadParseList(html) {
    const $ = loadHtml(html);
    const bySlug = new Map();

    $('a[href*="/manga/"]').each((_, a) => {
        const $a = $(a);
        const slug = mangareadSlugFromHref($a.attr("href"));
        if (!slug) return;
        // Chapter links live under /manga/<slug>/<chapter>/ - only want series.
        const href = $a.attr("href") || "";
        if (/\/manga\/[^/]+\/[^/]+/.test(href.replace(/\/+$/, "") + "/")) {
            const tail = canonicalSlug(href.replace(/\/+$/, "").split("/").slice(-1)[0]);
            if (tail !== slug) return;
        }

        const entry = bySlug.get(slug) || {
            id: `mr:${slug}`,
            title: "",
            titleRank: 0,
            cover: null,
            url: mangareadSeriesUrl(slug),
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
        // never displace the caption anchor's real title. An anchor wrapping an
        // image contributes only its attributes - its text is card chrome.
        const candidates = img.length
            ? [
                  [2, $a.attr("title")],
                  [1, img.attr("alt")],
              ]
            : [[3, $a.text()]];
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

export function mangareadParseDetail(html, slug) {
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
        url: mangareadSeriesUrl(slug),
    };
}

export function mangareadParseChapters(html) {
    const $ = loadHtml(html);
    const issues = [];
    const seen = new Set();
    $("li.wp-manga-chapter").each((_, li) => {
        const $li = $(li);
        const $a = $li.find("a").first();
        const href = ($a.attr("href") || "").trim();
        if (!href) return;
        const chapterSlug = canonicalSlug(href.replace(/\/+$/, "").split("/").pop());
        if (!chapterSlug) return;
        // The same chapter is sometimes listed twice under one URL (Tales of
        // Demons and Gods carries chapter-524-5 as "524-5" and again as
        // "524.5"). Both rows open the same page, and a duplicate id is a
        // duplicate React key and an offline-map collision in the app. The
        // list is newest-first here, so the first row is the latest posting.
        if (seen.has(chapterSlug)) return;
        seen.add(chapterSlug);
        const label = $a.text().replace(/\s+/g, " ").trim();
        const numMatch = chapterSlug.match(/chapter-(\d+(?:[.-]\d+)?)/i) || label.match(/(\d+(?:\.\d+)?)/);
        issues.push({
            id: chapterSlug,
            title: label || chapterSlug,
            number: numMatch ? numMatch[1].replace("-", ".") : null,
            publishAt: parseChapterDate($li.find(".chapter-release-date").text()),
        });
    });
    // Upstream lists newest-first; the client expects reading order.
    return issues.reverse();
}

export function mangareadParsePages(html) {
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
    /** One page (1-based) of the catalogue ordered by views, ~20 series. */
    async popular(page = 1, { deadline } = {}) {
        const url = page > 1
            ? `${MANGAREAD_BASE}/manga/page/${page}/?m_orderby=views`
            : `${MANGAREAD_BASE}/manga/?m_orderby=views`;
        return mangareadParseList(await fetchUpstream(url, { referer: MANGAREAD_BASE, deadline }));
    },
    async details(slug) {
        return mangareadParseDetail(
            await fetchUpstream(mangareadSeriesUrl(slug), { referer: MANGAREAD_BASE }),
            slug,
        );
    },
    async chapters(slug) {
        const html = await fetchUpstream(`${mangareadSeriesUrl(slug)}ajax/chapters/`, {
            method: "POST",
            ajax: true,
            // Encoded, like the URL. The raw slug here was a non-Latin-1
            // header value, which undici refuses outright ("Cannot convert
            // argument to a ByteString"), so these series never had chapters.
            referer: mangareadSeriesUrl(slug),
        });
        return mangareadParseChapters(html);
    },
    async pages(slug, chapterSlug) {
        const url = `${mangareadSeriesUrl(slug)}${encodeURIComponent(chapterSlug)}/`;
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

const COMIZY_SYNTH_MAX = 10_000;

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
export function comizySynthesiseChapters(real) {
    const seen = new Map();
    for (const c of real) {
        const n = comizyChapterNumber(c.id);
        if (n != null && !seen.has(n)) seen.set(n, c);
    }
    const nums = [...seen.keys()].sort((a, b) => a - b);
    // The fill below allocates one row per integer up to the highest slug, so
    // a date-shaped slug ("chapter-20240101") would build 20M rows and take
    // the process down on every request for that series. No real series is
    // anywhere near this; past it, serve only what comizy listed - flipped,
    // because comizy lists newest-first and the client takes this list as
    // reading order (its positional fallback numbers it 1, 2, 3...).
    if (!nums.length || nums[nums.length - 1] > COMIZY_SYNTH_MAX) return [...real].reverse();

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

export function comizyParseSeries(html, slug) {
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
    async popular({ deadline } = {}) {
        const html = await fetchUpstream(`${COMIZY_BASE}/`, { referer: COMIZY_BASE, deadline });
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
            // The slug is decoded (parseId), so encode it like every fetch URL.
            url: `${COMIZY_BASE}/${encodeURIComponent(slug)}`,
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
        // Both guesses share one budget: a slow 404 on the first must not
        // leave the second a full budget of its own past nginx's timeout.
        const deadline = requestDeadline();
        for (const cand of candidates) {
            try {
                const html = await fetchUpstream(
                    `${COMIZY_BASE}/${encodeURIComponent(slug)}/${encodeURIComponent(cand)}`,
                    { referer: `${COMIZY_BASE}/${encodeURIComponent(slug)}`, deadline },
                );
                const images = extractJsonArray(html, "images") || [];
                if (images.length) return images;
            } catch (err) {
                // Only a 404 means "wrong guess, try the next shape". Anything
                // else is comizy failing, and swallowing it used to turn an
                // outage into a 200 with zero pages - which the app cached.
                if (err?.status !== 404) throw err;
            }
        }
        // Every shape 404'd, or answered without images: no such chapter.
        throw new UpstreamError(404, `comizy has no pages for ${slug}/${chapterSlug}`);
    },
};

const ADAPTERS = { mr: mangaread, cz: comizy };

/** Split a prefixed id. Unprefixed ids are rejected rather than guessed at. */
export function parseId(id) {
    const m = String(id || "").match(/^(mr|cz):(.+)$/);
    if (!m) return null;
    const slug = canonicalSlug(m[2]);
    // `key` is the canonical id, so caches agree whichever spelling arrived.
    return { adapter: ADAPTERS[m[1]], slug, key: `${m[1]}:${slug}` };
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

/**
 * A request made straight to this port from the box itself, not through nginx
 * (which always sets X-Real-IP / X-Forwarded-For on its way in).
 */
function isDirectLocalRequest(req) {
    const ip = String(req.socket?.remoteAddress || "");
    const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    return loopback && !req.get("x-real-ip") && !req.get("x-forwarded-for");
}

// Operator probe - not used by the app. An arbitrary-path fetcher aimed at the
// upstreams from the droplet's only IP (uncached, up to three attempts a call)
// has no business being public, so it answers only over SSH:
//     curl 'http://127.0.0.1:3102/debug/probe?adapter=mr&path=/'
app.get("/debug/probe", async (req, res) => {
    if (!isDirectLocalRequest(req)) return res.status(404).json({ error: "not found" });
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

/**
 * Map an adapter failure to a response. 404 stays 404 (the series or chapter
 * really is not there); our own timeout is 504; everything else is 502. Never
 * cached downstream, and never echoes upstream bodies.
 */
function sendUpstreamError(res, err, label) {
    const status = err?.status === 404 ? 404 : err?.status === 504 ? 504 : 502;
    if (status !== 404) console.error(`${label} failed: ${String(err?.message || err).slice(0, 300)}`);
    res.set("Cache-Control", "no-store");
    res.status(status).json({
        error: status === 404 ? "not found" : status === 504 ? "upstream timed out" : "upstream unavailable",
        upstreamStatus: typeof err?.status === "number" ? err.status : null,
    });
}

/** Run `fn` over `items`, at most `limit` at a time, settling like Promise.allSettled. */
async function settleLimited(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            try {
                out[i] = { status: "fulfilled", value: await fn(items[i]) };
            } catch (reason) {
                out[i] = { status: "rejected", reason };
            }
        }
    }));
    return out;
}

/**
 * One source of the popular shelf - a mangaread catalogue page, or comizy's
 * home page - cached on its own and never throwing.
 *
 * Cached per source rather than per (limit, offset) window: a key per window
 * was 60 limits x 201 offsets, every one a fresh 4-5 request fan-out and an
 * LRU eviction of something useful, for any client that cared to walk them.
 * Per source, the key space is POPULAR_MAX_PAGES + 1 and every window is a
 * slice. A refusal (5xx, 403, 404) is remembered for PARTIAL_CACHE_TTL_MS, so
 * a dead page is retried once a minute rather than on every request. A timeout
 * is not: it may only mean the request that fetched it had little budget left,
 * and remembering it would hide that page from every request for a minute.
 */
function popularSource(key, load) {
    return cacheWrap(key, async () => {
        try {
            return { ok: true, items: await load() };
        } catch (err) {
            return { ok: false, items: [], status: typeof err?.status === "number" ? err.status : 502 };
        }
    }, {
        shouldCache: (v) => v.ok || v.status !== 504,
        ttlFor: (v) => (v.ok && v.items.length ? undefined : PARTIAL_CACHE_TTL_MS),
    });
}

app.get("/popular", async (req, res) => {
    const limit = clampInt(req.query.limit, { min: 1, max: 60, def: 24 });
    const offset = clampInt(req.query.offset, { min: 0, max: 200, def: 0 });
    // Up to three rounds of page fetches and then comizy run one after another;
    // they share one budget so the whole route ends before nginx's 30s.
    const deadline = requestDeadline();
    try {
        // Only page 1 of mangaread's view-ordered catalogue was ever read, so
        // every client got the same 19 titles whatever limit it asked for.
        // Read as many pages as the window needs, two at a time, bounded by
        // POPULAR_MAX_PAGES. A page adds 12 NEW series, not ~20: its grid is
        // 12, and the other 7 it parses to are a sidebar widget repeated on
        // every page, which dedupes away. Sizing by 18 a page left
        // limit=44..60 short - the app's limit=60 came back with 54.
        const want = offset + limit;
        const pageCount = Math.min(POPULAR_MAX_PAGES, Math.max(1, Math.ceil(want / 12)));
        const settled = await settleLimited(
            Array.from({ length: pageCount }, (_, i) => i + 1),
            2,
            (page) => popularSource(`popular:v3:mr:${page}`, () => mangaread.popular(page, { deadline })),
        );
        const sources = settled.map((s) => (s.status === "fulfilled" ? s.value : { ok: false, items: [] }));
        const merged = [];
        const seen = new Set();
        const add = (item) => {
            const key = titleKey(item.title);
            if (!key || seen.has(key)) return;
            seen.add(key);
            merged.push(item);
        };
        for (const source of sources) source.items.forEach(add);
        if (merged.length < want) {
            // Pad rather than replace, so a mangaread hiccup still shows a shelf.
            const extra = await popularSource("popular:v3:cz", () => comizy.popular({ deadline }));
            sources.push(extra);
            extra.items.forEach(add);
        }
        if (!merged.length && sources.some((s) => !s.ok)) {
            // Nothing from anyone: an outage, not an empty catalogue.
            return sendUpstreamError(res, new UpstreamError(502, "every popular source failed"), "popular");
        }
        res.json({ items: merged.slice(offset, offset + limit) });
    } catch (err) {
        sendUpstreamError(res, err, "popular");
    }
});

app.get("/search", async (req, res) => {
    const q = String(req.query.q || "").trim();
    const limit = clampInt(req.query.limit, { min: 1, max: 60, def: 20 });
    const offset = clampInt(req.query.offset, { min: 0, max: 500, def: 0 });
    if (!q) return res.json({ items: [] });
    let partial = false;
    try {
        // Cached per query and sliced per request, for the same reason as
        // /popular: a key per (limit, offset) let one client mint ~30k keys
        // for a single term, each a fresh pair of upstream searches. The
        // merged list is a few dozen titles, so slicing it costs nothing.
        const all = await cacheWrap(`search:v2:${q.toLowerCase()}`, async () => {
            // Merge, don't fail over: mangaread wins collisions because its
            // chapter lists are complete, and comizy supplies the titles
            // mangaread simply doesn't carry. One upstream erroring must not
            // suppress the other's results - but such a half answer is only
            // cached for a minute, or the missing half stays missing for 15.
            const [mr, cz] = await Promise.allSettled([mangaread.search(q), comizy.search(q)]);
            partial = mr.status === "rejected" || cz.status === "rejected";
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
            return merged;
        }, { ttlFor: () => (partial ? PARTIAL_CACHE_TTL_MS : undefined) });
        res.json({ items: all.slice(offset, offset + limit) });
    } catch (err) {
        sendUpstreamError(res, err, "search");
    }
});

app.get("/details", async (req, res) => {
    const id = String(req.query.id || "").trim();
    const parsed = parseId(id);
    if (!id) return res.status(400).json({ error: "missing id" });
    if (!parsed) return res.status(400).json({ error: "id must be prefixed mr: or cz:" });
    try {
        const comic = await cacheWrap(`details:${parsed.key}`, () =>
            parsed.adapter.details(parsed.slug),
        );
        if (!comic) return res.status(404).json({ error: "not found" });
        res.json({ comic });
    } catch (err) {
        sendUpstreamError(res, err, `details ${parsed.key}`);
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
        const all = await cacheWrap(`chapters:${parsed.key}`, () => parsed.adapter.chapters(parsed.slug));
        res.json({ issues: all.slice(offset, offset + limit) });
    } catch (err) {
        sendUpstreamError(res, err, `chapters ${parsed.key}`);
    }
});

app.get("/pages", async (req, res) => {
    const id = String(req.query.id || "").trim();
    const chapterId = canonicalSlug(String(req.query.chapterId || "").trim());
    const parsed = parseId(id);
    if (!id || !chapterId) return res.status(400).json({ error: "missing id or chapterId" });
    if (!parsed) return res.status(400).json({ error: "id must be prefixed mr: or cz:" });
    try {
        const pages = await cacheWrap(`pages:v2:${parsed.key}:${chapterId}`, () =>
            parsed.adapter.pages(parsed.slug, chapterId),
        );
        // A chapter page that parsed to zero images is markup drift or an
        // interstitial, not an empty chapter: report it (uncached) instead of a
        // 200 the app would show as a blank reader.
        if (!pages.length) {
            return sendUpstreamError(res, new UpstreamError(502, `0 pages parsed for ${parsed.key} ${chapterId}`), "pages");
        }
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
        sendUpstreamError(res, err, `pages ${parsed.key} ${chapterId}`);
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
    if (!(await isPublicHost(target.hostname))) {
        return res.status(403).type("text/plain").send("forbidden host");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_PROXY_TIMEOUT_MS);
    try {
        // Redirects are followed by hand so every hop gets the same host check:
        // with redirect:follow, a public URL that 302s to an internal address
        // was fetched without one.
        let upstream;
        for (let hop = 0; ; hop += 1) {
            // Referer is chosen by image host, not by whichever adapter produced
            // the page list. comizy's CDN hard-403s without it; mangaread doesn't
            // care. Sending the wrong one is the difference between a page and a
            // blank.
            const referer = /(^|\.)cmzcdn\.org$/i.test(target.hostname)
                ? `${COMIZY_BASE}/`
                : `${MANGAREAD_BASE}/`;
            upstream = await undiciFetch(target.toString(), {
                method: "GET",
                signal: controller.signal,
                headers: {
                    "User-Agent": pickUserAgent(),
                    Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    Referer: referer,
                },
                redirect: "manual",
                // Re-checks the address actually connected to (DNS rebinding).
                dispatcher: imageAgent,
            });
            if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
            const location = upstream.headers.get("location");
            await upstream.body?.cancel().catch(() => {});
            let next = null;
            try {
                next = location ? new URL(location, target) : null;
            } catch {
                next = null;
            }
            res.set("Cache-Control", "no-store");
            if (!next || hop >= 3) return res.status(502).type("text/plain").send("image unavailable");
            if ((next.protocol !== "http:" && next.protocol !== "https:") || !(await isPublicHost(next.hostname))) {
                return res.status(403).type("text/plain").send("forbidden host");
            }
            target = next;
        }
        const ct = (upstream.headers.get("content-type") || "").toLowerCase();
        if (!upstream.ok || !ct.startsWith("image/")) {
            await upstream.body?.cancel().catch(() => {});
            res.set("Cache-Control", "no-store");
            // Only a 404/410 (or a non-image body) means the image is gone.
            // A 403/429/5xx is the CDN refusing or struggling right now, and a
            // 404 for that told every cache in front of us it was permanent.
            const missing = upstream.ok || upstream.status === 404 || upstream.status === 410;
            return res.status(missing ? 404 : 502).type("text/plain").send(missing ? "not an image" : "image unavailable");
        }
        const declared = Number(upstream.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) {
            await upstream.body?.cancel().catch(() => {});
            res.set("Cache-Control", "no-store");
            return res.status(502).type("text/plain").send("image too large");
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of upstream.body ?? []) {
            size += chunk.length;
            if (size > IMAGE_MAX_BYTES) {
                controller.abort();
                res.set("Cache-Control", "no-store");
                return res.status(502).type("text/plain").send("image too large");
            }
            chunks.push(chunk);
        }
        const buf = Buffer.concat(chunks, size);
        res.set("Content-Type", ct);
        res.set("Content-Length", String(buf.length));
        res.set("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable");
        res.set("Access-Control-Allow-Origin", "*");
        res.status(200).end(buf);
    } catch (err) {
        res.set("Cache-Control", "no-store");
        res.status(502).type("text/plain").send(String(err?.message || err).slice(0, 200));
    } finally {
        clearTimeout(timer);
    }
});

app.use((_req, res) => res.status(404).json({ error: "not found" }));

export { app };

// manhwa.spec.mjs imports this module for its exports. An env opt-out rather
// than an "am I the entry point" check, because PM2's fork mode does not run
// the script as argv[1].
if (process.env.MANHWA_SCRAPER_NO_LISTEN !== "1") {
    app.listen(PORT, () => {
        console.log(
            `Sakura manhwa scraper listening on :${PORT} ` +
                `(mangaread=${MANGAREAD_BASE}, comizy=${COMIZY_BASE})`,
        );
    });
}
