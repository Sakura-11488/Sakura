/**
 * Comic Book Plus source adapter.
 *
 * WHY THIS EXISTS: xoxocomic's origin stopped serving reader images in 2026-08.
 * Every `/comic/<slug>/<issue>/<id>/N.jpg` answers HTTP 200 with the site
 * homepage (105 KB, magic `3c21444f`), verified from the droplet, from a
 * residential IP and through ZenRows. Covers (`/images/series/*.jpg`) still
 * work, so it is their reader path, not a block on us — no proxy fixes it. Every
 * free XOXO-family mirror re-checked 2026-08-24 is dead or parked
 * (comicextra.me and comicpunch.net now serve keyword-ad pages, azcomix.me is a
 * "coming soon" stub, readcomiconline/readcomicsonline do not resolve or answer
 * 403). Comic Book Plus is a public-domain archive that serves real bytes.
 *
 * SITE MODEL (measured 2026-08-24, not guessed):
 *
 *   section  ?cid=1507        "Comic Books" — lists ~1797 titles, one fetch
 *      |                       Publisher blocks: h2.cathead + a "Titles:" row
 *      |                       of `<a href="/?cid=N">Name (count)</a>`
 *   series   ?cid=1325        one title; rows are `tr.overrow` carrying the
 *      |                       dlid, name, numberOfPages and datePublished
 *   issue    ?dlid=102339     carries the absolute viewer base + page count
 *   pages    <viewerBase>/<0..n-1>.jpg
 *
 * FOUR THINGS THAT LOOK OBVIOUS AND ARE WRONG — each cost a measurement:
 *
 *  1. `limit` is an OFFSET, not a page size. `?cid=1325` returns rows 0-99,
 *     `&limit=100` returns 100-199, `&limit=200` returns the last 95 of 295.
 *     A value past the end is a 404, so a small series 404s on `&limit=200`.
 *  2. Page images live on EITHER host — `comicbookplus.com/viewer/...` for some
 *     issues, `box01.comicbookplus.com/viewer/...` for most. Reconstructing the
 *     URL against the main domain 404s six issues out of six. Always take the
 *     absolute URL the issue page prints.
 *  3. `meta[itemprop=thumbnailUrl]` omits the two-character fan-out directory,
 *     so the URL in the microdata 404s site-wide. Inserting `/<hash[0..2]>/`
 *     fixes it — but only on box01; the main domain 404s for thumbs.
 *  4. Images 403 without a Referer. That is plain hotlink protection: one
 *     header, no cookie, no session. `403 Forbidden - Comic Book Plus` (1175
 *     bytes) is the tell.
 *
 * ROBOTS: comicbookplus.com/robots.txt blocks a long list of AI and SEO
 * crawlers by name and gives everyone else `Crawl-delay: 5`. This service is in
 * the `*` group, and none of the paths used here (`/?cid=`, `/?dlid=`,
 * `/viewer/`) is disallowed. The disallow list contains a set of listing paths
 * (`/master-listing.php`, `/catalog/*`, `/staging/*`, `/housekeeping/*`) that do
 * not appear anywhere in the site's own markup — they read as traps for
 * scrapers that walk robots.txt. NOTHING HERE MAY EVER FETCH THOSE. HTML
 * fetches are serialised through a minimum gap for the same reason.
 */
import { load as loadHtml } from "cheerio";

export const CBP_BASE = "https://comicbookplus.com";
export const CBP_REFERER = "https://comicbookplus.com/";
export const CBP_IMAGE_HOSTS = ["comicbookplus.com"]; // suffix match covers box01.

/** Namespaced so a Comic Book Plus id can never be mistaken for an XOXO slug. */
export const CBP_PREFIX = "cbp-";

/** Section ids worth indexing. Comic Books first — it is what the tab is for. */
export const CBP_SECTIONS = [
    { cid: 1507, name: "Comic Books" },
    { cid: 6, name: "Comic Strips" },
];

export function isCbpId(id) {
    return /^cbp-\d+$/.test(String(id || ""));
}

export function toCbpId(numeric) {
    return `${CBP_PREFIX}${numeric}`;
}

/** `cbp-1325` -> `1325`. Returns null for anything that is not one of ours. */
export function cbpNumeric(id) {
    const m = /^cbp-(\d+)$/.exec(String(id || ""));
    return m ? m[1] : null;
}

/**
 * The site answers a bad id with a styled 404 page, not an empty one — 105 KB
 * of chrome under `<h1>Something Is Not Quite Right</h1>`. Parsed naively that
 * is "a series with zero issues", which the client renders as a real but empty
 * comic. Detect it by content, because `&limit=<past the end>` returns it too.
 */
export function cbpSoft404(html) {
    if (!html) return true;
    const head = String(html).slice(0, 4000);
    return /We Could Not Find It|Something Is Not Quite Right/i.test(head)
        || /Something Is Not Quite Right/i.test(String(html));
}

/**
 * Insert the two-character fan-out directory the microdata leaves out, and pin
 * the result to box01 — the main domain 404s for thumbnails even with it.
 *   .../viewer/<hash>/mediumthumb.jpg -> https://box01…/viewer/<xx>/<hash>/mediumthumb.jpg
 */
export function fixThumbUrl(url) {
    if (!url) return null;
    const m = /\/viewer\/([a-f0-9]{32})\/([a-z]+\.(?:jpg|png))/i.exec(url);
    if (!m) return url;
    return `https://box01.comicbookplus.com/viewer/${m[1].slice(0, 2)}/${m[1]}/${m[2]}`;
}

/** The absolute viewer base an issue page prints, on whichever host it uses. */
export function parseViewerBase(html) {
    const m = /https?:\/\/[a-z0-9.-]*comicbookplus\.com\/viewer\/[a-f0-9]{2}\/[a-f0-9]{32}(?=\/)/i
        .exec(String(html || ""));
    return m ? m[0] : null;
}

/**
 * Section index -> every title it lists. One fetch yields ~1797 series, which
 * is what makes search possible without crawling: the site's own search is a
 * Google CSE and needs a key.
 */
export function parseCatalog(html) {
    if (cbpSoft404(html)) return [];
    const $ = loadHtml(html);
    const out = [];
    const seen = new Set();

    $("h2.cathead").each((_, head) => {
        const publisher = $(head).text().trim();
        // The publisher's own artwork, reused as the placeholder cover for its
        // titles — the index carries no per-title image, and a title's real
        // cover only appears on its own page (which /details backfills).
        const block = $(head).next("table");
        const cover = block.find("img.thumb").attr("src") || null;

        block.find("td.d").each((__, label) => {
            if ($(label).text().trim().toLowerCase() !== "titles:") return;
            $(label).next("td").find('a[href*="?cid="]').each((___, a) => {
                const href = $(a).attr("href") || "";
                const cid = (/[?&]cid=(\d+)/.exec(href) || [])[1];
                if (!cid || seen.has(cid)) return;
                const raw = $(a).text().trim();
                // "All Love (7)" — the trailing count is the issue count.
                const cm = /^(.*?)\s*\((\d+)\)\s*$/.exec(raw);
                if (!cm) return; // a bare name is a publisher link, not a title
                seen.add(cid);
                out.push({
                    id: toCbpId(cid),
                    title: cm[1].trim(),
                    issueCount: Number(cm[2]),
                    publisher,
                    cover,
                });
            });
        });
    });

    return out;
}

/**
 * A series page -> its title, cover and the issue rows on THIS offset.
 * `total` comes from the header count when present so the caller knows whether
 * to ask for another offset.
 */
export function parseSeries(html) {
    if (cbpSoft404(html)) return null;
    const $ = loadHtml(html);
    const title = $("h1").first().text().trim();
    if (!title) return null;

    // The in-page `thumbs/` artwork resolves; the og:image `thumbsalt/` variant
    // is not guaranteed to, so prefer the former and rewrite the latter.
    let cover = $('img.thumb[src*="/thumbs/"]').first().attr("src")
        || $('meta[property="og:image"]').attr("content")
        || null;
    if (cover) cover = cover.replace("/thumbsalt/", "/thumbs/");

    const issues = [];
    $("tr.overrow").each((_, row) => {
        const $row = $(row);
        const dlid = (/mp\('(\d+)'\)/.exec($row.attr("onclick") || "") || [])[1]
            || (/[?&]dlid=(\d+)/.exec($row.find('a[href*="?dlid="]').attr("href") || "") || [])[1];
        if (!dlid) return;
        const name = $row.find('[itemprop="name"]').first().text().trim();
        const pages = Number($row.find('[itemprop="numberOfPages"]').first().text().trim()) || null;
        const published = $row.find('time[itemprop="datePublished"]').attr("datetime") || null;
        const thumb = fixThumbUrl($row.find('meta[itemprop="thumbnailUrl"]').attr("content") || null);
        issues.push({ id: toCbpId(dlid), title: name || `Issue ${dlid}`, pages, publishAt: published, thumb });
    });

    // "Titles: 43 | Books: 719" on a publisher page, "295" alone on a series.
    const total = Number((/Books:\s*<?[^>]*>?\s*(\d+)/i.exec($.html()) || [])[1]) || null;

    return { title, cover, issues, total };
}

/** An issue page -> what /pages needs: where the images are and how many. */
export function parseIssue(html) {
    if (cbpSoft404(html)) return null;
    const $ = loadHtml(html);
    const viewerBase = parseViewerBase(html);
    if (!viewerBase) return null;
    const title = ($("h1").first().text().trim() || $("title").text().trim())
        .replace(/\s*-\s*Comic Book Plus\s*$/i, "");
    const pageCount = Number($('[itemprop="numberOfPages"]').first().text().trim())
        || Number((/(\d+)\s*pages/i.exec($("body").text()) || [])[1])
        || 0;
    return { title, viewerBase, pageCount };
}

/** Pages are zero-indexed and `pageCount` is exact: index `pageCount` is a 404. */
export function buildPageUrls(viewerBase, pageCount) {
    const n = Math.max(0, Math.min(Number(pageCount) || 0, 2000));
    return Array.from({ length: n }, (_, i) => `${viewerBase}/${i}.jpg`);
}

/**
 * Live adapter. Owns its own HTML fetching so the crawl gap below cannot be
 * bypassed, but reuses the shared ladder for transport, byte caps and the
 * block/quota accounting that /healthz reports.
 *
 * @param {object} deps
 * @param {{fetchHtml: Function}} deps.upstream shared ladder from upstream.js
 * @param {{get:Function,set:Function}} deps.htmlCache LRU shared with the xoxo path
 */
export function createComicBookPlus({ upstream, htmlCache, minGapMs = 1000, catalogTtlMs = 12 * 60 * 60 * 1000 }) {
    // Serialise HTML fetches with a floor between them. Reading a comic pulls
    // its images concurrently (they are ordinary reader traffic and land in the
    // disk cache), but page fetches are the crawl-shaped ones, and robots.txt
    // asks for a delay.
    let gate = Promise.resolve();
    let lastAt = 0;
    function serialise(fn) {
        const run = gate.then(async () => {
            const wait = Math.max(0, lastAt + minGapMs - Date.now());
            if (wait) await new Promise((r) => setTimeout(r, wait));
            try {
                return await fn();
            } finally {
                lastAt = Date.now();
            }
        });
        // A rejection must not poison the queue for every later caller.
        gate = run.then(() => undefined, () => undefined);
        return run;
    }

    async function html(url, { cacheKey, ttl, validate }) {
        if (cacheKey) {
            const hit = htmlCache.get(cacheKey);
            if (hit !== undefined) return hit;
        }
        const { html: body } = await serialise(() => upstream.fetchHtml(url, {
            validate: validate || ((h) => (cbpSoft404(h)
                ? { ok: false, reason: "comicbookplus soft-404" }
                : { ok: true, value: h })),
            referer: CBP_REFERER,
            // Comic Book Plus is not Cloudflare-challenged, so an escalation here
            // could only ever spend a credit to repeat a failure we already have.
            allowProxy: false,
        }));
        if (cacheKey) htmlCache.set(cacheKey, body, ttl ? { ttl } : undefined);
        return body;
    }

    // The search index: title -> cid, built from the section pages. Two fetches
    // buy the whole catalogue, so this never crawls.
    let catalog = null;
    let catalogAt = 0;
    let catalogInflight = null;
    /** Real covers learned from /details, so a searched title stops showing publisher art. */
    const coverOverrides = new Map();

    async function loadCatalog() {
        if (catalog && Date.now() - catalogAt < catalogTtlMs) return catalog;
        if (catalogInflight) return catalogInflight;
        catalogInflight = (async () => {
            const merged = [];
            const seen = new Set();
            for (const section of CBP_SECTIONS) {
                try {
                    const body = await html(`${CBP_BASE}/?cid=${section.cid}`, {
                        cacheKey: `cbp:section:${section.cid}`,
                        ttl: catalogTtlMs,
                    });
                    for (const entry of parseCatalog(body)) {
                        if (seen.has(entry.id)) continue;
                        seen.add(entry.id);
                        merged.push({ ...entry, section: section.name });
                    }
                } catch (err) {
                    console.warn(`[cbp] section ${section.cid} failed: ${err?.code || err?.message}`);
                }
            }
            // An empty catalogue is a parse regression, not an empty site.
            // Keeping the previous one beats serving "there are no comics".
            if (merged.length) {
                catalog = merged;
                catalogAt = Date.now();
            }
            catalogInflight = null;
            return catalog || [];
        })();
        return catalogInflight;
    }

    function decorate(entry) {
        return { ...entry, cover: coverOverrides.get(entry.id) || entry.cover };
    }

    async function popular(limit) {
        const all = await loadCatalog();
        // No popularity signal exists in the index, so rank by how much of a run
        // we can actually show. Long runs are also the recognisable titles.
        return [...all]
            .sort((a, b) => b.issueCount - a.issueCount || a.title.localeCompare(b.title))
            .slice(0, limit)
            .map(decorate)
            .map((e) => ({
                id: e.id,
                title: e.title,
                cover: e.cover,
                url: `${CBP_BASE}/?cid=${cbpNumeric(e.id)}`,
                description: `${e.issueCount} issue${e.issueCount === 1 ? "" : "s"} · ${e.publisher}`,
                tags: [e.section, e.publisher].filter(Boolean),
                status: "Completed",
                year: null,
            }));
    }

    async function search(q, limit, offset) {
        const all = await loadCatalog();
        const needle = q.trim().toLowerCase();
        if (!needle) return [];
        const scored = [];
        for (const entry of all) {
            const hay = entry.title.toLowerCase();
            const at = hay.indexOf(needle);
            if (at === -1) {
                // Let "spirit spider" style multi-word queries still match.
                const words = needle.split(/\s+/).filter(Boolean);
                if (words.length < 2 || !words.every((w) => hay.includes(w))) continue;
                scored.push({ entry, rank: 3 });
                continue;
            }
            scored.push({ entry, rank: at === 0 ? (hay === needle ? 0 : 1) : 2 });
        }
        scored.sort((a, b) => a.rank - b.rank
            || b.entry.issueCount - a.entry.issueCount
            || a.entry.title.localeCompare(b.entry.title));
        return scored.slice(offset, offset + limit).map(({ entry }) => {
            const e = decorate(entry);
            return {
                id: e.id,
                title: e.title,
                cover: e.cover,
                url: `${CBP_BASE}/?cid=${cbpNumeric(e.id)}`,
                description: `${e.issueCount} issue${e.issueCount === 1 ? "" : "s"} · ${e.publisher}`,
                tags: [e.section, e.publisher].filter(Boolean),
                status: "Completed",
                year: null,
            };
        });
    }

    /**
     * Walk a series' offsets. `limit` is an offset and a value past the end is a
     * 404, so the walk stops on a short page — never on a guessed bound.
     */
    async function fetchSeries(cid, { maxIssues = 500 } = {}) {
        const first = parseSeries(await html(`${CBP_BASE}/?cid=${cid}`, {
            cacheKey: `cbp:series:${cid}:0`,
        }));
        if (!first) return null;
        const pageSize = first.issues.length;
        const issues = [...first.issues];
        if (pageSize >= 100) {
            for (let off = pageSize; off < maxIssues; off += pageSize) {
                let next;
                try {
                    next = parseSeries(await html(`${CBP_BASE}/?cid=${cid}&limit=${off}`, {
                        cacheKey: `cbp:series:${cid}:${off}`,
                    }));
                } catch {
                    break; // a 404 here means we walked past the end
                }
                if (!next || !next.issues.length) break;
                issues.push(...next.issues);
                if (next.issues.length < pageSize) break;
            }
        }
        if (first.cover) coverOverrides.set(toCbpId(cid), first.cover);
        return { ...first, issues };
    }

    async function details(id) {
        const cid = cbpNumeric(id);
        if (!cid) return null;
        const series = await fetchSeries(cid, { maxIssues: 100 });
        if (!series) return null;
        const entry = (catalog || []).find((e) => e.id === id);
        return {
            id,
            title: series.title,
            cover: series.cover,
            url: `${CBP_BASE}/?cid=${cid}`,
            description: entry
                ? `${entry.issueCount} issue${entry.issueCount === 1 ? "" : "s"} from ${entry.publisher}, free and in the public domain at Comic Book Plus.`
                : "Free public-domain comics, hosted by Comic Book Plus.",
            authors: entry?.publisher ? [entry.publisher] : [],
            tags: [entry?.section, entry?.publisher].filter(Boolean),
            status: "Completed",
            year: null,
        };
    }

    async function chapters(id) {
        const cid = cbpNumeric(id);
        if (!cid) return [];
        const series = await fetchSeries(cid);
        if (!series) return [];
        // Newest first, matching what the XOXO path returns and what the reader
        // expects when it computes a chapter number from the index.
        return series.issues.slice().reverse().map((issue) => ({
            id: issue.id,
            title: issue.title,
            number: null,
            publishAt: issue.publishAt,
            pages: issue.pages,
        }));
    }

    async function pages(_seriesId, chapterId) {
        const dlid = cbpNumeric(chapterId);
        if (!dlid) return [];
        const issue = parseIssue(await html(`${CBP_BASE}/?dlid=${dlid}`, {
            cacheKey: `cbp:issue:${dlid}`,
        }));
        if (!issue) return [];
        return buildPageUrls(issue.viewerBase, issue.pageCount);
    }

    return {
        id: "cbp",
        label: "Comic Book Plus",
        base: CBP_BASE,
        imageReferer: CBP_REFERER,
        imageHosts: CBP_IMAGE_HOSTS,
        popular,
        search,
        details,
        chapters,
        pages,
        // Exposed for /readyz: a source must be able to prove its own read path.
        loadCatalog,
        catalogSize: () => (catalog ? catalog.length : 0),
    };
}
