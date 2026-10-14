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

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import express from "express";
import { load as loadHtml } from "cheerio";
import { LRUCache } from "lru-cache";
import { fetch as undiciFetch } from "undici";
import { createUpstream, UpstreamError, readBodyCapped } from "./upstream.js";

const PORT = Number(process.env.HENTAI_SCRAPER_PORT || 3101);
const UPSTREAM_BASE = process.env.HENTAI_UPSTREAM_BASE || "https://hentaifox.com";
const CACHE_MAX = Number(process.env.HENTAI_CACHE_MAX || 1000);
const CACHE_TTL_MS = Number(process.env.HENTAI_CACHE_TTL_MS || 60 * 60 * 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.HENTAI_REQUEST_TIMEOUT_MS || 8_000);
const HTML_CACHE_BYTES = Number(process.env.HENTAI_HTML_CACHE_BYTES || 24 * 1024 * 1024);
const HTML_CACHE_TTL_MS = Number(process.env.HENTAI_HTML_CACHE_TTL_MS || 5 * 60 * 1000);
const READY_TTL_MS = Number(process.env.HENTAI_READY_TTL_MS || 60_000);
// A failed readiness result is held far more briefly: deploy.sh polls /readyz
// 12 times, 2s apart, and rolls back if none passes. With a failure cached for
// the full 60s, one transient upstream error was the only answer that loop
// could ever see.
const READY_FAIL_TTL_MS = Math.min(READY_TTL_MS, Number(process.env.HENTAI_READY_FAIL_TTL_MS || 10_000));
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

// ---------------------------------------------------------------------------
// Content policy: nothing that sexualises minors, on any surface, for any
// client. HentaiFox carries such galleries and this service used to pass them
// through untouched. Enforced server-side, in four layers, failing closed:
//
//   1. List cards (popular, search) by HentaiFox tag ID and parody ID. Cards
//      carry `data-tags="<ids>"` and `data-parodies="<ids>"`. A card with no
//      tag IDs cannot be checked and is dropped - HentaiFox omits the
//      attribute for a gallery nobody has tagged yet (new uploads).
//   2. A gallery's own tags and parodies, by slug, before /details or /pages
//      answer. A gallery page with no tags at all is refused: it is either not
//      curated yet or the tag markup drifted, and either way nothing was
//      checked.
//   3. Titles, on every surface, after folding look-alike characters, spaced-
//      out letters and double-encoded UTF-8.
//   4. /img proxies only image directories this service handed out for an
//      allowed gallery (signed, see signImageUrl), not any URL on the CDN.
//
// IDs resolved 2026-10-14 from HentaiFox's own tag pages: every gallery on
// /tag/<slug>/ shares exactly that tag's ID, so the intersection of the cards'
// data-tags is the ID. HENTAI_BLOCKED_TAG_IDS adds more without a code change.
// The whole /tags/ index (65 pages, 3245 tags) was read by name on 2026-10-14;
// these are the tags in it that indicate a minor.
//
// deploy.sh greps for this marker and refuses to auto-roll-back to a release
// without it: a rollback must never restore the unfiltered service.
export const CONTENT_POLICY_VERSION = 2;

const envList = (name, re) => String(process.env[name] || "").split(/[\s,]+/).filter((v) => re.test(v));

const BLOCKED_TAG_IDS = new Set([
    "8", // lolicon
    "11", // shotacon
    "715", // toddlercon
    "1472", // loli
    "1463", // shota
    "45", // oppai loli
    "111", // low lolicon
    "268", // low shotacon
    "337", // age regression
    "739", // kindergarten uniform
    "3321", // kodomo doushi
    "3322", // kodomo only
    "298", // randoseru
    // Added 2026-10-14. mesugaki ("female brat", meaning a child): 17 of the
    // first 20 galleries on its tag page were also tagged lolicon, and the
    // other 3 were being listed AND opened. comic-lo is "Comic LO", the
    // lolicon anthology magazine.
    "2890", // mesugaki
    "1521", // comic-lo
    "1543", // loli-seiyouken
    ...envList("HENTAI_BLOCKED_TAG_IDS", /^\d+$/),
]);
const BLOCKED_TAG_SLUGS = new Set([
    "lolicon", "shotacon", "toddlercon", "loli", "shota", "oppai-loli", "low-lolicon",
    "low-shotacon", "age-regression", "kindergarten-uniform", "kodomo-doushi", "kodomo-only",
    "randoseru", "mesugaki", "comic-lo",
    ...envList("HENTAI_BLOCKED_TAG_SLUGS", /^[a-z0-9-]+$/),
]);
// Whole hyphen-separated words, so "loli-no-utage" is caught and
// "gothic-lolita" (a fashion style) is not.
const BLOCKED_SLUG_WORDS = /(^|-)(loli|lolis|lolicon|shota|shotas|shotacon|toddler|toddlercon|kodomo|mesugaki)(-|$)/;

// Parodies of series whose main cast are young children. Tags alone leak here:
// on 2026-10-14 each of these parody pages had galleries of the child
// characters carrying no lolicon/shotacon tag at all (a Mitsudomoe gallery
// titled "Jidou Inkou", Prisma Illya galleries of Miyu and of Chloe, a Ro-Kyu-Bu
// "sex education" body swap), while 14-20 of the first 20 galleries on every
// page WERE tagged lolicon/shotacon. IDs are the intersection of the cards'
// data-parodies on /parody/<slug>/. HENTAI_BLOCKED_PARODY_IDS adds more.
const BLOCKED_PARODY_IDS = new Set([
    "17", // kodomo-no-jikan
    "500", // mitsudomoe
    "283", // ojamajo-doremi
    "695", // ro-kyu-bu
    "214", // ichigo-mashimaro
    "1583", // watashi-ni-tenshi-ga-maiorita
    "1477", // ryuuou-no-oshigoto
    "111", // cardcaptor-sakura
    "700", // fate-kaleid-liner-prisma-illya
    ...envList("HENTAI_BLOCKED_PARODY_IDS", /^\d+$/),
]);
const BLOCKED_PARODY_SLUGS = new Set([
    "kodomo-no-jikan", "mitsudomoe", "ojamajo-doremi", "ro-kyu-bu", "ichigo-mashimaro",
    "watashi-ni-tenshi-ga-maiorita", "ryuuou-no-oshigoto", "cardcaptor-sakura",
    "fate-kaleid-liner-prisma-illya",
    ...envList("HENTAI_BLOCKED_PARODY_SLUGS", /^[a-z0-9-]+$/),
]);

// --- Titles ----------------------------------------------------------------
// Latin terms are matched on a folded copy of the title: NFKC, invisible
// characters and accents removed, Cyrillic/Greek look-alikes mapped to Latin,
// lower-cased. So fullwidth "ｌｏｌｉ", "lоli" with a Cyrillic о, "l0li" and
// "lo<zero-width space>li" all read as loli. A second copy also closes up
// letters spaced out one by one ("l o l i", "s.h.o.t.a"). Whole words only:
// "lolita" (the fashion) is not loli and "Shotaro" (a name) is not shota.
const LATIN_TITLE_TERMS = [
    // Digits stand in for letters only after a real "l": "l0li", "lol1" - but
    // not the number 1011, and never "!" ("LOL!" is a common title ending).
    String.raw`l[o0][l1][i1](?:s|z|con|kon|cons|kons|baba)?`, // loli, lolicon
    String.raw`sh[o0]t[a4@](?:s|z|con|kon|cons|kons)?`, // shota, shotacon
    String.raw`r[o0]ri(?:con|kon)?`, // romanised ロリ
    String.raw`t[o0]ddlers?(?:con)?`,
    String.raw`mesugaki`,
    String.raw`kindergart(?:en|ner)(?:ers?|s)?|pre-?school(?:ers?)?`,
    String.raw`(?:elementary|grade|primary|middle)[\s-]*school(?:ers?)?`,
    String.raw`elementary[\s-]*(?:student|pupil|girl|boy|kid)s?|junior[\s-]*high`,
    String.raw`(?:[1-6](?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth)[\s-]*graders?`,
    String.raw`under-?aged?|pre-?teens?|pre-?pubescent|pa?edo(?:s|ou|phil(?:e|es|ia|iac|iacs))?`, // "Pedoou to JS..."
    // Romanised Japanese: 幼女, 小学生/小学校, 中学生, 幼稚園, 保育園, ランドセル.
    String.raw`youjo|shou?gakusei|shou?gakk?ou?|chuu?gakusei|youchien(?:ji)?|hoikuen|randoseru`,
    String.raw`jidou(?![\s-]*hanbaiki)`, // 児童 (children), not 自動販売機 (vending machine)
];
const LATIN_TITLE = new RegExp(LATIN_TITLE_TERMS.map((t) => `(?<![a-z0-9])(?:${t})(?![a-z0-9])`).join("|"));
// JS / JC: Japanese shorthand for an elementary / middle-school girl. Case-sensitive.
const JS_JC_TITLE = /(?<![A-Za-z0-9])J[SC](?![A-Za-z0-9])/;
// Other scripts, matched with spaces and punctuation removed. ロリ is skipped
// after a kana that makes it onomatopoeia or a loanword (ペロリ, トロリ,
// ポロリ, カロリー, フロリダ), 小学 before 館 (the publisher Shogakukan).
const SCRIPT_TITLE = new RegExp([
    // Japanese
    "(?<![カグフクコトポゴホペチドヌボ])ロリ", "ショタ", "メスガキ", "ランドセル", "幼女", "幼児", "女児", "男児",
    "園児", "児童", "小学(?!館)", "中学生", "低学年", "高学年", "幼稚園", "保育園", "ペド(?!ロ)",
    // Chinese, simplified and traditional
    "萝莉", "蘿莉", "幼童", "女童", "男童", "儿童", "兒童", "小學", "幼儿", "幼兒", "幼稚园", "初中生", "国中生", "國中生", "中學生",
    // Korean
    "(?<![칼글플])로리", "쇼타", "초등", "초딩", "유치원", "중학생", "어린이", "아동",
    // Russian
    "лоли(?!т)", "шота",
].join("|"));

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
const LOOKALIKES = {
    а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x",
    і: "i", ј: "j", ѕ: "s", һ: "h", ӏ: "l", ԁ: "d",
    α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x",
    ı: "i", ł: "l", ø: "o", ɩ: "i",
};
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "g");
// Runs of single characters separated by spacing: "l o l i", "s.h.o.t.a".
const SPACED_OUT = /(?<![a-z0-9])(?:[a-z0-9][\s._\-*~·•+'"`]{1,3}){2,}[a-z0-9](?![a-z0-9])/g;

// HentaiFox stores some titles double-encoded ("â™€" for "♀"). Re-read the
// Windows-1252 view of the bytes as UTF-8 so script terms cannot hide there.
const CP1252 = {
    "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89,
    "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
    "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};
function undoMojibake(s) {
    if (!/[Â-ô]/.test(s)) return null;
    const bytes = [];
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c < 0x100) bytes.push(c);
        else if (CP1252[ch] !== undefined) bytes.push(CP1252[ch]);
        else return null;
    }
    const out = Buffer.from(bytes).toString("utf8");
    return out !== s && !out.includes("�") ? out : null;
}

function foldLatin(s) {
    return s.normalize("NFKC").replace(INVISIBLE, "").normalize("NFD").replace(/\p{M}/gu, "")
        .toLowerCase().replace(LOOKALIKE_RE, (ch) => LOOKALIKES[ch]);
}

export function isBlockedTitle(title) {
    const raw = String(title || "");
    return [raw, undoMojibake(raw)].filter(Boolean).some((form) => {
        const latin = foldLatin(form);
        const closedUp = latin.replace(SPACED_OUT, (run) => run.replace(/[^a-z0-9]/g, ""));
        const nfkc = form.normalize("NFKC").replace(INVISIBLE, "");
        return LATIN_TITLE.test(latin) || LATIN_TITLE.test(closedUp) || JS_JC_TITLE.test(nfkc) ||
            SCRIPT_TITLE.test(nfkc.replace(/[\s\p{P}\p{S}]/gu, ""));
    });
}

export function isBlockedTagSlug(slug) {
    const s = String(slug || "").toLowerCase();
    return BLOCKED_TAG_SLUGS.has(s) || BLOCKED_SLUG_WORDS.test(s);
}

export function isBlockedParodySlug(slug) {
    return BLOCKED_PARODY_SLUGS.has(String(slug || "").toLowerCase());
}

/**
 * Policy for a list card. No tag data means it cannot be checked: dropped. An
 * empty tag list counts as none - an untagged gallery has not been curated, so
 * nothing says it is safe.
 */
export function isAllowedListItem(item) {
    if (!item || !Array.isArray(item.tagIds) || item.tagIds.length === 0) return false;
    if (item.tagIds.some((id) => BLOCKED_TAG_IDS.has(id))) return false;
    if ((item.parodyIds || []).some((id) => BLOCKED_PARODY_IDS.has(id))) return false;
    return !isBlockedTitle(item.title);
}

/** What a client sees of a card: no internal policy fields, a signed cover. */
const publicItem = ({ tagIds, parodyIds, ...rest }) => ({ ...rest, cover: signImageUrl(rest.cover) });

/** Filter parsed cards and strip the internal policy fields. */
export function allowedListItems(items) {
    return items.filter(isAllowedListItem).map(publicItem);
}

const POLICY_CHECK_BUDGET_MS = Number(process.env.HENTAI_POLICY_CHECK_BUDGET_MS || 15_000);
// Whole-route budget for /popular and /search, counted from the request: the
// list fetch (up to ~16.8s with its retry) PLUS the policy checks must finish
// inside nginx's 30s proxy_read_timeout and the web client's 25s deadline.
// A 15s policy budget counted only from after the list fetch could not.
const LIST_ROUTE_BUDGET_MS = Number(process.env.HENTAI_LIST_ROUTE_BUDGET_MS || 20_000);
// Gallery-page checks one list request may run at once. They share the upstream
// limiter (4 in flight, 24 queued) with every other route: firing all of a
// home page's ~12 untagged cards at once filled half the queue per request, so
// two cold requests could shed searches and /details with BUSY.
const POLICY_CHECK_CONCURRENCY = Math.max(1, Number(process.env.HENTAI_POLICY_CHECK_CONCURRENCY || 3));
// A list that went out with some cards dropped only because their check did
// not finish is cached briefly, so they reappear once checked.
const INCOMPLETE_LIST_TTL_MS = Number(process.env.HENTAI_INCOMPLETE_LIST_TTL_MS || 2 * 60 * 1000);

// CDN directories (`<shard>/<loadId>`) of galleries this process has seen the
// policy refuse. Every image of a gallery - list thumb, cover, pages - lives in
// one such directory, so /img refuses them too: a client still holding URLs
// from before the policy (its caches, a stale-on-error copy) cannot keep
// pulling them through us. In-memory and best effort; ~30 bytes an entry.
const blockedImageDirs = new LRUCache({ max: 50_000 });

function imageDirKey(url) {
    let path;
    try {
        path = decodeURIComponent(new URL(String(url), "https://i.hentaifox.com").pathname);
    } catch {
        return null;
    }
    const m = path.replace(/\/{2,}/g, "/").match(/^\/([\w-]+)\/(\d+)\//);
    return m ? `${m[1]}/${m[2]}` : null;
}

function noteBlockedImages(...urls) {
    for (const u of urls) {
        const key = u ? imageDirKey(u) : null;
        if (key) blockedImageDirs.set(key, true);
    }
}

export function isBlockedImageUrl(url) {
    const key = imageDirKey(url);
    return Boolean(key && blockedImageDirs.has(key));
}

/** isBlockedGallery, recording a refused gallery's image directory for /img. */
function refuseIfBlocked(html) {
    if (!isBlockedGallery(html)) return false;
    noteBlockedImages(parsePageBaseDir(html));
    return true;
}

/**
 * Policy for a list, async. Cards with tag data are checked on the spot. Cards
 * without it (the home page's sidebar rails are built from different markup;
 * a gallery with no tags at all has no attribute) are checked against their
 * gallery page's own tags - the same fetch /details would make, cached - at
 * most POLICY_CHECK_CONCURRENCY at a time, until `deadline`. A card whose check
 * fails or does not finish is dropped: the policy fails closed.
 * Returns the allowed items (tag IDs stripped) and whether any check was cut
 * short.
 */
async function policyFilter(items, { deadline = Infinity } = {}) {
    const until = Math.min(deadline, Date.now() + POLICY_CHECK_BUDGET_MS);
    let incomplete = false;
    const verdicts = items.map((item) => {
        if (Array.isArray(item.tagIds) || isBlockedTitle(item.title)) {
            const allowed = isAllowedListItem(item);
            if (!allowed) noteBlockedImages(item.cover);
            return allowed;
        }
        const known = cache.get(`policy:${item.id}`);
        return known !== undefined ? known.allowed : null; // null: needs its gallery page
    });

    const checkOne = async (item) => {
        let timer;
        try {
            const verdict = await Promise.race([
                cacheWrap(`policy:${item.id}`, async () => ({ allowed: !refuseIfBlocked(await fetchGalleryHtml(item.id)) }),
                    { shouldCache: (v) => typeof v?.allowed === "boolean" }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("policy check timed out")), Math.max(0, until - Date.now())); }),
            ]);
            if (!verdict.allowed) noteBlockedImages(item.cover);
            return verdict.allowed;
        } catch {
            incomplete = true;
            return false;
        } finally {
            clearTimeout(timer);
        }
    };

    const pending = verdicts.flatMap((v, i) => (v === null ? [i] : []));
    let next = 0;
    const worker = async () => {
        while (next < pending.length) {
            const i = pending[next++];
            // Out of time: drop the rest without starting fetches nobody waits for.
            if (Date.now() >= until) {
                verdicts[i] = false;
                incomplete = true;
                continue;
            }
            verdicts[i] = await checkOne(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(POLICY_CHECK_CONCURRENCY, pending.length) }, worker));

    const allowed = items.filter((_, i) => verdicts[i] === true).map(publicItem);
    return { items: allowed, incomplete };
}

// `/tag/<slug>/`, `/parody/<slug>/`, relative or absolute: an href that
// changes to `https://hentaifox.com/tag/...` must not stop the check.
const TAXONOMY_HREF = /^(?:(?:https?:)?\/\/[^/]+)?\/(tag|parody)\/([^/?#]+)\/?(?:[?#].*)?$/i;

/**
 * Policy for a gallery page: its title, its tags and its parodies. A page with
 * no tags at all is blocked - an uncurated gallery, or tag markup that drifted
 * so that nothing below would be checked (readiness then fails loudly).
 * Only the gallery's own `a.tag_btn` links count: every page's footer links
 * to /tag/comic/, which must not pass for "this gallery has tags".
 */
export function isBlockedGallery(html) {
    const $ = loadHtml(html);
    if (isBlockedTitle($("h1").first().text()) || isBlockedTitle($("title").first().text())) return true;
    let tags = 0;
    let blocked = false;
    $("a.tag_btn").each((_, a) => {
        if (blocked) return;
        const m = ($(a).attr("href") || "").trim().match(TAXONOMY_HREF);
        if (!m) return;
        let slug;
        try { slug = decodeURIComponent(m[2]).toLowerCase(); } catch { slug = m[2].toLowerCase(); }
        if (m[1].toLowerCase() === "tag") {
            tags += 1;
            // The visible label too ("oppai loli"), in case slug and name diverge.
            const label = $(a).clone().children("span").remove().end().text().trim().toLowerCase().replace(/\s+/g, "-");
            if (isBlockedTagSlug(slug) || isBlockedTagSlug(label)) blocked = true;
        } else if (isBlockedParodySlug(slug)) {
            blocked = true;
        }
    });
    return blocked || tags === 0;
}

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

// In-flight producers by key. Concurrent misses on one key share a single
// producer run: a cold home screen (/popular plus four /search rows, from every
// device that opens it) otherwise multiplied each list's gallery-page policy
// checks by the number of callers, into a limiter that sheds load at 24 queued.
const inflight = new Map();

/**
 * @param {(value:any) => boolean} shouldCache guard so an EMPTY result is never
 *        cached. Caching `[]` is how a one-off parse failure becomes an hour of
 *        blank screens that look like success.
 */
async function cacheWrap(key, producer, opts = {}) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const running = inflight.get(key);
    if (running) return running;
    const run = produceAndCache(key, producer, opts);
    inflight.set(key, run);
    try {
        return await run;
    } finally {
        if (inflight.get(key) === run) inflight.delete(key);
    }
}

async function produceAndCache(key, producer, { shouldCache = () => true, ttlFor = () => undefined } = {}) {
    try {
        const value = await producer();
        if (shouldCache(value)) {
            const ttl = ttlFor(value);
            cache.set(key, value, ttl ? { ttl } : undefined);
        }
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
const galleryFetches = new Map();

async function fetchGalleryHtml(id) {
    const key = `html:gallery:${id}`;
    const hit = htmlCache.get(key);
    if (hit !== undefined) return hit;
    // /details, /pages and a list's policy check can ask for one gallery at
    // once; they share one upstream fetch.
    const running = galleryFetches.get(key);
    if (running) return running;
    const run = upstream.fetchHtml(galleryUrl(encodeURIComponent(id)), { validate: validateGalleryPage })
        .then((html) => {
            htmlCache.set(key, html);
            return html;
        });
    galleryFetches.set(key, run);
    try {
        return await run;
    } finally {
        galleryFetches.delete(key);
    }
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

        const entry = byId.get(id) || { id, title: "", cover: null, url: galleryUrl(id), tagIds: null, parodyIds: [] };

        // The card wrapper carries the gallery's taxonomy IDs (content policy):
        // data-tags, data-parodies, data-categories, data-languages... HentaiFox
        // omits an attribute that would be empty, so a card element with no
        // data-tags is an UNTAGGED gallery (tagIds [] - dropped), while a link
        // outside any card (the home page's sidebar rails) has no data at all
        // (tagIds null - judged by its gallery page). The nearest card only: an
        // outer element's data-tags must never stand in for this card's.
        if (!entry.tagIds) {
            const $card = $a.closest("[data-tags], [data-parodies], [data-categories], [data-languages], [data-artists]");
            if ($card.length) {
                const ids = (name) => String($card.attr(name) || "").trim().split(/\s+/).filter(Boolean);
                entry.tagIds = ids("data-tags");
                entry.parodyIds = ids("data-parodies");
            }
        }

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
        // tagIds / parodyIds are internal (publicItem strips them before any response).
        out.push({ id: e.id, title: e.title, cover: e.cover || null, url: e.url, tagIds: e.tagIds, parodyIds: e.parodyIds });
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
const IMAGE_MAX_BYTES = Number(process.env.HENTAI_IMAGE_MAX_BYTES || 16 * 1024 * 1024);
// /img only ever needs HentaiFox's own image hosts (i, i2, i3...hentaifox.com):
// every cover and page URL this service emits is on them. An allowlist, not a
// private-range blocklist - the blocklist checked the name only, so any public
// DNS name pointing inward (127.0.0.1.nip.io) got through.
//
// The image shards only - NOT hentaifox.com itself or www. That is the
// Cloudflare-scored HTML origin: /img?u=https://hentaifox.com/... let anyone
// make the droplet hit it with Node's TLS fingerprint (the exact tell that gets
// us challenged) and then again through the impersonating client, outside the
// block cooldown. HENTAI_IMG_HOSTS adds exact host names.
const IMAGE_HOST_PATTERN = /^i\d{0,2}\.hentaifox\.com$/;
const EXTRA_IMAGE_HOSTS = new Set(String(process.env.HENTAI_IMG_HOSTS || "")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));

export function isAllowedImageHost(hostname) {
    const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
    return IMAGE_HOST_PATTERN.test(h) || EXTRA_IMAGE_HOSTS.has(h);
}

// /img serves only image directories this service handed out for a gallery
// the content policy allowed. A host allowlist alone made /img an open proxy
// for the whole CDN: any image of any refused gallery, by URL, straight past
// every check above. Each cover/page URL we emit carries `sk`, an HMAC of its
// CDN directory (`/005/4222837/` - one per gallery, shared by its thumb, cover
// and pages; the i/i2/i3 shard is not signed, they are aliases).
//
// The key must survive restarts or every link a client holds goes dead with
// each pm2 reload: HENTAI_IMG_KEY, else img-key.txt next to this file, created
// on first start (deploy.sh keeps it out of its rsync --delete).
const IMG_KEY = loadImageKey();

function loadImageKey() {
    const fromEnv = String(process.env.HENTAI_IMG_KEY || "").trim();
    if (fromEnv.length >= 32) return fromEnv;
    if (process.env.HENTAI_NO_LISTEN === "1") return randomBytes(32).toString("hex");
    const file = new URL("./img-key.txt", import.meta.url);
    try {
        const k = readFileSync(file, "utf8").trim();
        if (k.length >= 32) return k;
    } catch { /* first start */ }
    const k = randomBytes(32).toString("hex");
    try {
        writeFileSync(file, `${k}\n`, { mode: 0o600 });
    } catch (err) {
        console.warn(`[img] could not save img-key.txt (${err?.code || err}): image links break at the next restart`);
    }
    return k;
}

// Plain path segments only: no empty segments, no percent-escapes, no dot
// segments - so the directory we verify is the directory the CDN serves.
const IMG_PATH = /^(?:\/[A-Za-z0-9_-]+)+\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const imageDirOf = (pathname) => pathname.slice(0, pathname.lastIndexOf("/") + 1);
const imageSig = (dir) => createHmac("sha256", IMG_KEY).update(dir).digest("base64url").slice(0, 22);

/** A CDN URL as clients get it: signed for its directory. null if not a CDN image URL. */
export function signImageUrl(url) {
    if (!url) return null;
    let u;
    try {
        u = new URL(String(url));
    } catch {
        return null;
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !isAllowedImageHost(u.hostname) || !IMG_PATH.test(u.pathname)) {
        return null;
    }
    u.search = "";
    u.hash = "";
    u.searchParams.set("sk", imageSig(imageDirOf(u.pathname)));
    return u.toString();
}

function hasValidImageSig(u) {
    if (!IMG_PATH.test(u.pathname)) return false;
    const got = Buffer.from(u.searchParams.get("sk") || "");
    const want = Buffer.from(imageSig(imageDirOf(u.pathname)));
    return got.length === want.length && timingSafeEqual(got, want);
}

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

/**
 * A gallery the content policy refuses. A plain 404, cached nowhere downstream,
 * with no detail. The app (lib/hentai.ts) turns a /details failure into null and
 * shows its generic "Could not load this title" screen; a /pages failure
 * rejects into the reader's error state. Note its loaders are staleIfError: a
 * copy the device cached before the policy can still be shown for that session
 * (blockedImageDirs keeps /img from serving its images once we have seen it).
 */
function refuseGallery(res) {
    res.set("Cache-Control", "no-store");
    return res.status(404).json({ error: "not available", code: "UNAVAILABLE" });
}

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
    const checks = { listItems: 0, allowedItems: 0, galleryId: null, title: null, pageUrls: 0, samplePage: null };
    const parsed = parseListPage(await fetchListHtml(`${UPSTREAM_BASE}/`));
    const list = allowedListItems(parsed);
    checks.listItems = parsed.length;
    checks.allowedItems = list.length;
    if (parsed.length === 0) return { ok: false, reason: "home page parsed 0 galleries", checks };
    // Cards without data-tags are dropped (the content policy fails closed), so
    // markup drift there would empty every shelf. Catch it here, at deploy time.
    if (list.length === 0) {
        return { ok: false, reason: "no gallery passed the content policy (card data-tags missing?)", checks };
    }

    const galleryId = String(process.env.HENTAI_READY_GALLERY_ID || "").trim() || list[0].id;
    checks.galleryId = galleryId;
    const html = await fetchGalleryHtml(galleryId);
    // A gallery whose tags do not parse is refused (fail closed), so tag markup
    // drift shows up here as every gallery being blocked.
    if (refuseIfBlocked(html)) {
        return { ok: false, reason: "readiness gallery is blocked by the content policy (or its tags did not parse)", checks };
    }
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
    if (readyCache.payload && now - readyCache.at < (readyCache.payload.ok ? READY_TTL_MS : READY_FAIL_TTL_MS)) {
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
    const deadline = Date.now() + LIST_ROUTE_BUDGET_MS;
    try {
        // One cached, policy-filtered home grid, sliced per request - not a
        // cache entry per limit.
        const { items: all } = await cacheWrap(
            "popular:v2",
            async () => {
                // HentaiFox has no dedicated popular endpoint; the home page is
                // the freshest gallery grid, which we surface as "trending".
                const html = await fetchListHtml(`${UPSTREAM_BASE}/`);
                return policyFilter(parseListPage(html), { deadline });
            },
            {
                shouldCache: (v) => Array.isArray(v?.items) && v.items.length > 0,
                ttlFor: (v) => (v.incomplete ? INCOMPLETE_LIST_TTL_MS : undefined),
            },
        );
        const items = all.slice(0, limit);
        // An empty trending rail must never be a 200 — that is the exact
        // success-shaped-failure this service is being fixed for. With the
        // content policy failing closed, it is also how missing card tag data
        // would show up.
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
    const deadline = Date.now() + LIST_ROUTE_BUDGET_MS;
    try {
        // Cached per query, filtered by the content policy, sliced per request.
        // A key per (limit, offset) let one client mint ~30k keys per term.
        const { items: all } = await cacheWrap(
            `search:v2:${q.toLowerCase()}`,
            async () => {
                const url = `${UPSTREAM_BASE}/search/?q=${encodeURIComponent(q)}`;
                const html = await fetchSearchHtml(url);
                return policyFilter(parseListPage(html), { deadline });
            },
            // A search can legitimately have no results, so 0 items is a valid
            // 200 — but it is never cached, so a parse regression self-heals in
            // seconds instead of being pinned for the full TTL.
            {
                shouldCache: (v) => Array.isArray(v?.items) && v.items.length > 0,
                ttlFor: (v) => (v.incomplete ? INCOMPLETE_LIST_TTL_MS : undefined),
            },
        );
        res.json({ items: all.slice(offset, offset + limit) });
    } catch (err) {
        clientError(res, err, "search");
    }
});

// Gallery IDs are HentaiFox's numeric ones, the only kind this service emits.
// Anything else is refused before it can reach the upstream URL or a cache key
// (`..` used to resolve /gallery/../ to the home page).
const GALLERY_ID = /^\d{1,10}$/;

app.get("/details", async (req, res) => {
    const id = String(req.query.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });
    if (!GALLERY_ID.test(id)) return res.status(400).json({ error: "invalid id" });
    try {
        const comic = await cacheWrap(
            `details:v2:${id}`,
            async () => {
                const html = await fetchGalleryHtml(id);
                // The refusal is cached like an answer: a gallery's tags do not
                // change, and re-fetching it on every tap is load for nothing.
                return refuseIfBlocked(html) ? { id, blocked: true } : parseDetailPage(html, id);
            },
            { shouldCache: (v) => Boolean(v && v.id && (v.blocked || v.title)) },
        );
        if (comic?.blocked) return refuseGallery(res);
        if (!comic || !comic.id || !comic.title) {
            return res.status(502).json({ error: ERROR_TEXT.INVALID, code: "INVALID" });
        }
        res.json({ comic: { ...comic, cover: signImageUrl(comic.cover) } });
    } catch (err) {
        clientError(res, err, "details");
    }
});

app.get("/chapters", async (req, res) => {
    const id = String(req.query.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });
    if (!GALLERY_ID.test(id)) return res.status(400).json({ error: "invalid id" });
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
    if (!GALLERY_ID.test(id)) return res.status(400).json({ error: "invalid id" });
    try {
        const result = await cacheWrap(
            `pages:v2:${id}`,
            async () => {
                const html = await fetchGalleryHtml(id);
                if (refuseIfBlocked(html)) return { blocked: true, pages: [] };
                const pages = buildPageUrls(html);
                return { pages, totalDiscovered: pages.length };
            },
            { shouldCache: (v) => Boolean(v && (v.blocked || (v.pages && v.pages.length > 0))) },
        );
        if (result.blocked) return refuseGallery(res);
        // Signed for /img; a URL that is not a plain CDN image path cannot be.
        const pages = result.pages.map(signImageUrl).filter(Boolean);
        // An existing gallery always has at least one page, so an empty array is
        // definitionally a parse failure — 502, never a 200 with a blank reader.
        if (!pages.length) {
            return res.status(502).json({ error: ERROR_TEXT.INVALID, code: "INVALID" });
        }
        res.json({
            pages,
            droppedCount: 0,
            totalDiscovered: result.totalDiscovered,
            fallbackToRaw: false,
        });
    } catch (err) {
        clientError(res, err, "pages");
    }
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
    if (!isAllowedImageHost(target.hostname)) {
        return res.status(403).type("text/plain").send("forbidden host");
    }

    // Every failure is no-store, and at most one response is ever sent: a
    // second send from the catch below used to throw ERR_HTTP_HEADERS_SENT out
    // of this async handler - an unhandled rejection, which kills Node 20.
    const fail = (status, text) => {
        if (res.headersSent) return;
        res.set("Cache-Control", "no-store");
        res.status(status).type("text/plain").send(text);
    };
    // Only a directory we signed for an allowed gallery (see signImageUrl).
    if (!hasValidImageSig(target)) return fail(403, "forbidden");
    const signedDir = imageDirOf(target.pathname);
    target.search = "";
    target.hash = "";
    // Signed earlier, refused since (see blockedImageDirs).
    if (isBlockedImageUrl(target)) return fail(404, "not available");

    const headers = {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: UPSTREAM_BASE,
    };

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_PROXY_TIMEOUT_MS);
    try {
        // Direct and free. The image CDN (i*.hentaifox.com) is a plain static
        // Cloudflare cache: verified 200 image/jpeg, cf-cache-status HIT, to a
        // bare curl User-Agent with NO Referer. The hotlink protection this
        // endpoint was originally written for no longer exists — but keeping the
        // Referer costs nothing and covers us if it comes back.
        //
        // Redirects are followed by hand so each hop is held to the allowlist;
        // with redirect:follow an allowed URL could bounce anywhere.
        let direct;
        for (let hop = 0; ; hop += 1) {
            direct = await undiciFetch(target.toString(), {
                method: "GET", signal: controller.signal, headers, redirect: "manual",
            });
            if (!REDIRECT_STATUSES.has(direct.status)) break;
            const location = direct.headers.get("location");
            await direct.body?.cancel().catch(() => {});
            let next = null;
            try { next = location ? new URL(location, target) : null; } catch { next = null; }
            if (!next || hop >= 3) return fail(502, "image unavailable");
            if ((next.protocol !== "http:" && next.protocol !== "https:") || !isAllowedImageHost(next.hostname)) {
                return fail(403, "forbidden host");
            }
            // A hop may change shard or file, never gallery: the signature
            // covered one directory.
            if (imageDirOf(next.pathname) !== signedDir) return fail(403, "forbidden");
            if (isBlockedImageUrl(next)) return fail(404, "not available");
            target = next;
        }
        let buf = null;
        let type = null;
        if (direct.ok) {
            if (Number(direct.headers.get("content-length")) > IMAGE_MAX_BYTES) {
                await direct.body?.cancel().catch(() => {});
                return fail(502, "image too large");
            }
            // Cancels the stream at the cap instead of aborting mid-iteration.
            buf = await readBodyCapped(direct.body, IMAGE_MAX_BYTES);
            if (!buf) return fail(502, "image too large");
            type = sniffImageType(buf);
        } else {
            await direct.body?.cancel().catch(() => {});
        }

        // Only a 404/410 is the image really being gone. Anything else that is
        // not image bytes (a 403/5xx, a challenge page) may be the CDN scoring
        // us the way the HTML host does: retry once through the impersonating
        // client - still free, no metered service. It gets what is left of the
        // one image budget (not a second 20s: that ran past nginx's 30s), does
        // not follow redirects (the hops above were the allowlisted ones), and
        // reads under the same size cap.
        if (!type && direct.status !== 404 && direct.status !== 410) {
            const remaining = IMAGE_PROXY_TIMEOUT_MS - (Date.now() - started);
            const alt = remaining >= 1000
                ? await upstream.fetchBinary(target.toString(), { timeoutMs: remaining, maxBytes: IMAGE_MAX_BYTES })
                    .catch(() => null)
                : null;
            type = alt ? sniffImageType(alt.buf) : null;
            buf = alt ? alt.buf : null;
            if (!type) return fail(502, "image unavailable");
        }
        if (!type) return fail(404, "not an image");

        res.set("Content-Type", type);
        res.set("Content-Length", String(buf.length));
        res.set("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable");
        res.set("Access-Control-Allow-Origin", "*");
        res.status(200).end(buf);
    } catch (err) {
        // An outage, not a missing image: never tell caches it is permanent.
        console.error(`[img] ${String(err?.message || err).slice(0, 200)}`);
        fail(502, "image unavailable");
    } finally {
        clearTimeout(timer);
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
    app,
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
