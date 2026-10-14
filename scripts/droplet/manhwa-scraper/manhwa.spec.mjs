/**
 * Regression tests for the manhwa scraper. Each one pins a failure seen in
 * production on 2026-10-13. Upstreams are local fakes; nothing here touches the
 * network.
 *
 *     node --test manhwa.spec.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const seen = { mangaread: [], comizy: [] };
let comizyMode = "ok"; // ok | 500
let mangareadMode = "ok"; // ok | hang

const listCard = (slug, title) =>
    `<div class="page-item"><a href="https://www.mangaread.org/manga/${slug}/" title="${title}"><img alt="Read Manhwa ${title}" src="https://www.mangaread.org/wp-content/uploads/${slug}-175x238.jpg"></a>` +
    `<h3><a href="https://www.mangaread.org/manga/${slug}/">${title}</a></h3></div>`;

const ENCODED = "leveling-up-as-an-s%e2%80%91rank-dark-mage";
const DECODED = "leveling-up-as-an-s‑rank-dark-mage";

function listen(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.listen(0, "127.0.0.1", () => resolve(s));
    });
}

const mangareadServer = await listen((req, res) => {
    seen.mangaread.push({ method: req.method, url: req.url, referer: req.headers.referer });
    // Percent-escapes are case-insensitive; compare decoded paths.
    const path = decodeURIComponent(req.url);
    if (mangareadMode === "hang") return; // never answers
    const page = (req.url.match(/^\/manga\/page\/(\d+)\//) || [, "1"])[1];
    if (req.url.includes("m_orderby=views")) {
        // The live layout: a 12-card grid, then a 7-card "popular" sidebar
        // widget that every page repeats - so a page adds 12 series, not 19.
        const cards = Array.from({ length: 12 }, (_, i) => listCard(`series-p${page}-${i}`, `Series P${page} N${i}`)).join("");
        const widget = Array.from({ length: 7 }, (_, i) => listCard(`widget-${i}`, `Widget Series ${i}`)).join("");
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<html>${cards}<div class="widget">${widget}</div></html>`);
    }
    if (req.url.startsWith("/?s=")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<html>${listCard(ENCODED, "Leveling Up as an S-Rank Dark Mage")}${listCard("solo-leveling", "Solo Leveling")}</html>`);
    }
    if (path === "/manga/slow-series/" && req.method === "GET") {
        return setTimeout(() => {
            res.writeHead(200, { "content-type": "text/html" });
            res.end('<html><div class="post-title"><h1>Slow Series</h1></div></html>');
        }, 100);
    }
    if (path === `/manga/${DECODED}/` && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end('<html><div class="post-title"><h1>Leveling Up as an S-Rank Dark Mage</h1></div></html>');
    }
    if (path === `/manga/${DECODED}/ajax/chapters/` && req.method === "POST") {
        res.writeHead(200, { "content-type": "text/html" });
        const row = (slug, label) =>
            `<li class="wp-manga-chapter"><a href="https://www.mangaread.org/manga/${ENCODED}/${slug}/">${label}</a><span class="chapter-release-date">16.07.2026</span></li>`;
        // Newest-first, with chapter-2-5 listed twice, as mangaread does.
        return res.end(row("chapter-3", "Chapter 3") + row("chapter-2-5", "Chapter 2-5") + row("chapter-2-5", "Chapter 2.5") + row("chapter-1", "Chapter 1"));
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html><head><!-- Yandex.RTB --></head><body>Page not found</body></html>");
});

const comizyServer = await listen((req, res) => {
    seen.comizy.push({ url: req.url, referer: req.headers.referer });
    if (comizyMode === "500") {
        res.writeHead(500, { "content-type": "text/html" });
        return res.end("boom");
    }
    if (req.url.startsWith("/search")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end('<script>{"ssrItems":[{"slug":"red-shirt","name":"Red Shirt","cover":"https://rx.comizy.io/c.webp"}]}</script>');
    }
    if (req.url === "/red-shirt/chapter-5-1") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end('<script>{"images":["https://x1.cmzcdn.org/e/a.webp","https://x1.cmzcdn.org/e/b.webp"]}</script>');
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end("not found");
});

process.env.MANHWA_SCRAPER_NO_LISTEN = "1";
process.env.MANHWA_MANGAREAD_BASE = `http://127.0.0.1:${mangareadServer.address().port}`;
process.env.MANHWA_COMIZY_BASE = `http://127.0.0.1:${comizyServer.address().port}`;
process.env.MANHWA_REQUEST_TIMEOUT_MS = "300";
process.env.MANHWA_REQUEST_BUDGET_MS = "1500";
process.env.MANHWA_PARTIAL_CACHE_TTL_MS = "200";

const m = await import("./server.js");
const appServer = await listen(m.app);
const api = async (path) => {
    const res = await fetch(`http://127.0.0.1:${appServer.address().port}${path}`);
    return { status: res.status, body: await res.json().catch(() => null) };
};

after(() => {
    for (const s of [mangareadServer, comizyServer, appServer]) s.close();
});

test("slugs are canonicalised: both spellings are one series, URLs encoded once", async () => {
    assert.equal(m.canonicalSlug(ENCODED), DECODED);
    assert.equal(m.canonicalSlug("100%-real"), "100%-real", "malformed escapes are kept, not thrown");
    assert.equal(m.mangareadSlugFromHref(`https://www.mangaread.org/manga/${ENCODED}/`), DECODED);
    assert.equal(m.mangareadSlugFromHref("https://www.mangaread.org/manga/feed/"), null);
    assert.equal(m.parseId(`mr:${ENCODED}`).key, m.parseId(`mr:${DECODED}`).key);
});

test("search ids are decoded, and details/chapters for them reach mangaread encoded exactly once", async () => {
    const search = await api("/search?q=leveling&limit=10");
    assert.equal(search.status, 200);
    const item = search.body.items.find((i) => i.title.startsWith("Leveling"));
    assert.equal(item.id, `mr:${DECODED}`);

    seen.mangaread.length = 0;
    for (const id of [`mr:${ENCODED}`, `mr:${DECODED}`]) {
        const details = await api(`/details?id=${encodeURIComponent(id)}`);
        assert.equal(details.status, 200, `details for ${id}`);
        assert.equal(details.body.comic.title, "Leveling Up as an S-Rank Dark Mage");
    }
    // Both spellings share one cache entry, so mangaread was asked once.
    assert.equal(seen.mangaread.filter((r) => r.method === "GET").length, 1);
    assert.ok(!seen.mangaread.some((r) => r.url.includes("%25")), "never double-encoded");

    const chapters = await api(`/chapters?id=${encodeURIComponent(`mr:${DECODED}`)}`);
    assert.equal(chapters.status, 200, "non-Latin-1 slug no longer breaks the Referer header");
    const post = seen.mangaread.find((r) => r.method === "POST");
    assert.match(post.referer, /%E2%80%91/);
    assert.deepEqual(chapters.body.issues.map((c) => c.id), ["chapter-1", "chapter-2-5", "chapter-3"],
        "duplicate chapter rows collapse to one, in reading order");
});

test("an upstream 404 is a clean 404, without the upstream's HTML", async () => {
    const r = await api("/details?id=mr:no-such-series");
    assert.equal(r.status, 404);
    assert.ok(!JSON.stringify(r.body).includes("Yandex"));
});

test("comizy: a 404 guess falls through to the -1 shape; all-404 is 404", async () => {
    const ok = await api("/pages?id=cz:red-shirt&chapterId=chapter-5");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.pages.length, 2);
    const missing = await api("/pages?id=cz:red-shirt&chapterId=chapter-99");
    assert.equal(missing.status, 404);
});

test("comizy failing is a 502 and is not cached as an empty chapter", async () => {
    comizyMode = "500";
    const failed = await api("/pages?id=cz:red-shirt&chapterId=chapter-7");
    assert.equal(failed.status, 502, "was a 200 with zero pages");
    comizyMode = "ok";
    const again = await api("/pages?id=cz:red-shirt&chapterId=chapter-7");
    assert.equal(again.status, 404, "re-asked upstream instead of replaying the failure");
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("popular with every source down is a 502 inside ONE budget, not one per sequential fetch", async () => {
    mangareadMode = "hang";
    comizyMode = "500";
    seen.mangaread.length = 0;
    const started = Date.now();
    const r = await api("/popular?limit=60");
    const took = Date.now() - started;
    mangareadMode = "ok";
    comizyMode = "ok";
    assert.equal(r.status, 502, "an outage, not an empty 200 shelf");
    assert.ok(took < 1500 + 300, `took ${took}ms; must stay under the request budget`);
    // Pages 1-2 spent the budget, so the second round never reached mangaread.
    assert.ok(!seen.mangaread.some((x) => /\/page\/[34]\//.test(x.url)), "second page round ran past the budget");
    await sleep(250); // let the remembered failures (PARTIAL_CACHE_TTL_MS) lapse
});

test("popular reads as many view-ordered pages as the limit needs", async () => {
    seen.mangaread.length = 0;
    const r = await api("/popular?limit=40");
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 40, "was capped at page 1's ~19 titles");
    assert.equal(new Set(r.body.items.map((i) => i.id)).size, 40);
    assert.ok(seen.mangaread.some((x) => x.url === "/manga/?m_orderby=views"));
    assert.ok(seen.mangaread.some((x) => x.url === "/manga/page/2/?m_orderby=views"));
    // Page 1's 12 grid series, then its 7 widget series, then page 2's grid.
    const window = await api("/popular?limit=10&offset=19");
    assert.equal(window.body.items[0].title, "Series P2 N0", "offset pages through the catalogue");
    // What the app asks for. Sized at ~18 new series a page this came back 54.
    const app = await api("/popular?limit=60");
    assert.equal(app.body.items.length, 60, "the app's limit=60 is filled");
    assert.equal(new Set(app.body.items.map((i) => i.id)).size, 60);
});

test("popular windows are slices of cached pages: no per-(limit, offset) fan-out", async () => {
    await api("/popular?limit=40");
    seen.mangaread.length = 0;
    seen.comizy.length = 0;
    for (const [limit, offset] of [[7, 13], [5, 33], [40, 0], [1, 0], [24, 3]]) {
        const r = await api(`/popular?limit=${limit}&offset=${offset}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.items.length, limit);
    }
    assert.equal(seen.mangaread.length + seen.comizy.length, 0, "every window was served from the cached pages");
});

test("search pages are slices of one cached answer per query", async () => {
    const whole = await api("/search?q=leveling&limit=10");
    seen.mangaread.length = 0;
    seen.comizy.length = 0;
    const second = await api("/search?q=leveling&limit=1&offset=1");
    assert.deepEqual(second.body.items, whole.body.items.slice(1, 2));
    assert.equal(seen.mangaread.length + seen.comizy.length, 0);
});

test("concurrent requests for one uncached key share a single upstream fetch", async () => {
    seen.mangaread.length = 0;
    const all = await Promise.all([1, 2, 3].map(() => api("/details?id=mr:slow-series")));
    assert.deepEqual(all.map((r) => r.status), [200, 200, 200]);
    assert.equal(seen.mangaread.filter((r) => r.url === "/manga/slow-series/").length, 1);
});

test("fetchUpstream honours a caller's deadline", async () => {
    seen.mangaread.length = 0;
    await assert.rejects(
        m.fetchUpstream(`${process.env.MANHWA_MANGAREAD_BASE}/manga/slow-series/`, { deadline: Date.now() + 100 }),
        (err) => err.status === 504 && err.unattempted === true,
    );
    assert.equal(seen.mangaread.length, 0);
});

test("/debug/probe answers only direct local requests, never through nginx", async () => {
    seen.mangaread.length = 0;
    const port = appServer.address().port;
    const path = `/debug/probe?adapter=mr&path=${encodeURIComponent(`/manga/${ENCODED}/`)}`;
    const proxied = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "X-Real-IP": "203.0.113.9", "X-Forwarded-For": "203.0.113.9" } });
    assert.equal(proxied.status, 404);
    assert.equal(seen.mangaread.length, 0, "a proxied probe must not reach the upstream");
    const direct = await api(path);
    assert.equal(direct.status, 200);
});

test("comizy synthesis refuses to build millions of rows from a date-shaped slug", () => {
    // comizy lists newest-first; whatever comes back must be reading order.
    const real = [{ id: "chapter-20240101" }, { id: "chapter-3" }];
    assert.deepEqual(m.comizySynthesiseChapters(real).map((c) => c.id), ["chapter-3", "chapter-20240101"]);
    assert.equal(m.comizySynthesiseChapters([{ id: "chapter-3" }]).length, 3);
    // No numbered slugs at all: also served as listed, oldest first.
    assert.deepEqual(m.comizySynthesiseChapters([{ id: "finale" }, { id: "prologue" }]).map((c) => c.id), ["prologue", "finale"]);
});

test("a search one upstream failed is cached only briefly", async () => {
    comizyMode = "500";
    const half = await api("/search?q=red&limit=10");
    assert.equal(half.status, 200);
    assert.ok(!half.body.items.some((i) => i.id.startsWith("cz:")));
    comizyMode = "ok";
    await new Promise((r) => setTimeout(r, 300));
    const whole = await api("/search?q=red&limit=10");
    assert.ok(whole.body.items.some((i) => i.id === "cz:red-shirt"), "comizy's half came back after the short TTL");
});

test("a hung upstream ends inside the request budget as a 504", async () => {
    mangareadMode = "hang";
    const started = Date.now();
    const r = await api("/details?id=mr:hung-series");
    mangareadMode = "ok";
    assert.equal(r.status, 504);
    assert.ok(Date.now() - started < 2500, `took ${Date.now() - started}ms; must stay under nginx's timeout`);
});

test("/img host check resolves names: a public name pointing inward is refused", async () => {
    const resolver = (addrs) => async () => addrs.map((address) => ({ address }));
    assert.equal(await m.isPublicHost("127.0.0.1.nip.io", resolver(["127.0.0.1"])), false);
    assert.equal(await m.isPublicHost("meta.example", resolver(["169.254.169.254"])), false);
    assert.equal(await m.isPublicHost("mapped.example", resolver(["::ffff:10.0.0.5"])), false);
    assert.equal(await m.isPublicHost("cdn.example", resolver(["93.184.216.34"])), true);
    assert.equal(await m.isPublicHost("localhost"), false);
    assert.equal(await m.isPublicHost("nxdomain.example", async () => { throw new Error("ENOTFOUND"); }), false);
});

test("/img refuses every spelling of an inward address, IPv6 literals included", async () => {
    const port = appServer.address().port;
    // URL.hostname keeps IPv6 brackets ("[::1]"), which the old check never
    // stripped, so every IPv6 literal - loopback, mapped metadata - passed.
    for (const u of [
        `http://[::1]:${port}/healthz`,
        `http://[::ffff:127.0.0.1]:${port}/healthz`,
        "http://[::ffff:169.254.169.254]/latest/meta-data/",
        "http://[::]/",
        "http://[fd00::1]/",
        "http://[fe80::1]/",
        "http://[64:ff9b::7f00:1]/",
        `http://2130706433:${port}/healthz`,
        `http://0x7f.1:${port}/healthz`,
        "http://100.64.0.1/",
        "http://0/",
        `http://localhost.:${port}/healthz`,
    ]) {
        const r = await fetch(`http://127.0.0.1:${port}/img?u=${encodeURIComponent(u)}`);
        assert.equal(r.status, 403, u);
    }
    assert.equal(m.isBlockedAddress("2606:4700:4700::1111"), false);
    assert.equal(m.isBlockedAddress("93.184.216.34"), false);
    assert.equal(await m.isPublicHost("fcdn.example", async () => [{ address: "93.184.216.34" }]), true,
        "a NAME starting fc/fd is not a ULA address");
});

test("/img connections re-check the address actually dialled (DNS rebinding)", async () => {
    const { Agent, fetch: undiciFetch } = await import("undici");
    const agent = new Agent({ connect: { lookup: m.guardedLookup } });
    const port = appServer.address().port;
    await assert.rejects(undiciFetch(`http://localhost:${port}/healthz`, { dispatcher: agent }));
    await agent.close();
});
