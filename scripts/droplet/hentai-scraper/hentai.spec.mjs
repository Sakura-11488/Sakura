/**
 * Regression tests for the 18+ scraper, above all its content policy: nothing
 * that sexualises minors may be listed, opened or proxied. Fixtures are
 * synthetic markup with placeholder titles; nothing here touches the network.
 *
 *     node --test hentai.spec.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Synthetic HentaiFox-shaped markup: the card wrapper carries data-tags.
const card = (id, title, tags) =>
    `<div class="thumb"${tags === null ? "" : ` data-tags="${tags}"`}><div class="inner_thumb">` +
    `<a href="/gallery/${id}/"><img class="lazy" data-src="https://i3.hentaifox.com/005/${id}/thumb.jpg" alt=""></a></div>` +
    `<div class="caption"><h2 class="g_title"><a href="/gallery/${id}/">${title}</a></h2></div></div>`;
const listPage = (cards) => `<html><head><title>HentaiFox</title></head><body>${cards.join("")}</body></html>`;
const galleryPage = (title, tagSlugs, dir) =>
    `<html><head><title>${title} - HentaiFox</title></head><body><div class="info"><h1>${title}</h1><ul class="tags">` +
    tagSlugs.map((s) => `<li><a class='tag_btn ' href='/tag/${s}/'>${s} <span class='t_badge'>1</span></a></li>`).join("") +
    `</ul></div><script>var g_th = $.parseJSON('{"1":"j,800,1200","2":"j,800,1200"}');</script>` +
    `<img data-src="https://i3.hentaifox.com/005/${dir}/1t.jpg"></body></html>`;

const HOME = listPage([
    card("101", "Placeholder Clean One", "3 10 12"),
    card("102", "Placeholder Tagged", "3 8 12"), // 8 = lolicon
    card("103", "Placeholder No Tag Data", null), // cannot be checked
    card("104", "Placeholder Clean Two", "24 26"),
    card("105", "Loli Placeholder", "24 26"), // title alone
    card("106", "Placeholder Shota Tag", "11"), // 11 = shotacon
    card("107", "Placeholder Untagged Clean", null), // checked via its gallery page
    card("108", "Placeholder Untagged Flagged", null), // gallery tags are flagged
]);
const GALLERIES = {
    201: galleryPage("Placeholder Gallery", ["big-breasts", "vanilla"], "9201"),
    202: galleryPage("Placeholder Gallery", ["vanilla", "shotacon"], "9202"),
    203: galleryPage("Placeholder Gallery", ["loli-no-utage"], "9203"),
    204: galleryPage("Placeholder Gallery", ["gothic-lolita", "vanilla"], "9204"),
    205: galleryPage("ロリ Placeholder", ["vanilla"], "9205"),
    107: galleryPage("Placeholder Untagged Clean", ["vanilla"], "107"),
    108: galleryPage("Placeholder Untagged Flagged", ["toddlercon"], "108"),
    // Answers slower than the list route's whole budget (see SLOW below).
    109: galleryPage("Placeholder Untagged Slow", ["vanilla"], "109"),
};
// A search whose one untagged card cannot be checked inside the route budget.
const SLOW = listPage([card("101", "Placeholder Clean One", "3 10 12"), card("109", "Placeholder Untagged Slow", null)]);
const SLOW_GALLERY_MS = 6_000;
const sinkHits = [];

const upstreamServer = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
        // Stand-ins for the image CDN (/img tests). Zero bytes, never image data.
        if (req.url === "/cdn/big.bin") {
            res.writeHead(200, { "content-type": "application/octet-stream" });
            let n = 0;
            const iv = setInterval(() => {
                res.write(Buffer.alloc(16 * 1024));
                if (++n >= 16) { clearInterval(iv); res.end(); }
            }, 2);
            return;
        }
        if (req.url === "/cdn/out") return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
        if (req.url === "/cdn/loop") return res.writeHead(302, { location: "/cdn/loop" }).end();
        // Refuses the direct client (it sends a Referer); answers the fallback
        // client with a redirect that must not be followed.
        if (req.url === "/cdn/scored") {
            if (req.headers.referer) return res.writeHead(403).end("challenge");
            return res.writeHead(302, { location: "/cdn/sink" }).end();
        }
        if (req.url === "/cdn/sink") { sinkHits.push(req.url); return res.writeHead(200).end("x"); }
        if (req.url === "/cdn/hop") return res.writeHead(302, { location: "/elsewhere/1.jpg" }).end();
        if (req.url === "/cdn/gone.jpg") return res.writeHead(404).end();
        if (req.url === "/elsewhere/1.jpg") { sinkHits.push(req.url); return res.writeHead(200).end("x"); }

        res.writeHead(200, { "content-type": "text/html" });
        const g = req.url.match(/^\/gallery\/(\d+)\//);
        if (g && g[1] === "109") return setTimeout(() => res.end(GALLERIES[109]), SLOW_GALLERY_MS);
        if (g && GALLERIES[g[1]]) return res.end(GALLERIES[g[1]]);
        if (req.url.startsWith("/search/?q=slow")) return res.end(SLOW.replace("<title>HentaiFox</title>", "<title>Searching: slow - HentaiFox</title>"));
        if (req.url.startsWith("/search/")) return res.end(HOME.replace("<title>HentaiFox</title>", "<title>Searching: x - HentaiFox</title>"));
        res.end(HOME);
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
});

process.env.HENTAI_NO_LISTEN = "1";
process.env.HENTAI_UPSTREAM_BASE = `http://127.0.0.1:${upstreamServer.address().port}`;
// The /img tests point at the local stand-in CDN; production allows i*.hentaifox.com only.
process.env.HENTAI_IMG_HOSTS = "127.0.0.1";
process.env.HENTAI_IMAGE_MAX_BYTES = String(64 * 1024);
process.env.HENTAI_LIST_ROUTE_BUDGET_MS = "2500";
const unhandled = [];
process.on("unhandledRejection", (err) => unhandled.push(err));
const m = await import("./server.js");
const appServer = await new Promise((resolve) => {
    const s = http.createServer(m.app);
    s.listen(0, "127.0.0.1", () => resolve(s));
});
const api = async (path) => {
    const res = await fetch(`http://127.0.0.1:${appServer.address().port}${path}`);
    return { status: res.status, body: await res.json().catch(() => null) };
};
after(() => {
    upstreamServer.closeAllConnections();
    upstreamServer.close();
    appServer.closeAllConnections();
    appServer.close();
});
const UP = `http://127.0.0.1:${upstreamServer.address().port}`;
// Every image URL a client holds was handed out signed (signImageUrl); `raw`
// sends it as given.
const img = async (u, { raw = false } = {}) => {
    const target = raw ? u : m.signImageUrl(u);
    assert.ok(target, `not signable: ${u}`);
    const res = await fetch(`http://127.0.0.1:${appServer.address().port}/img?u=${encodeURIComponent(target)}`);
    return { status: res.status, cache: res.headers.get("cache-control"), text: await res.text() };
};

test("tag slugs: minor-related tags are blocked as whole words, look-alikes are not", () => {
    for (const s of ["lolicon", "shotacon", "toddlercon", "oppai-loli", "low-shotacon", "loli-no-utage",
        "kodomo-only", "randoseru", "kindergarten-uniform", "age-regression"]) {
        assert.equal(m.isBlockedTagSlug(s), true, s);
    }
    for (const s of ["gothic-lolita", "big-breasts", "vanilla", "milf", "schoolgirl-uniform"]) {
        assert.equal(m.isBlockedTagSlug(s), false, s);
    }
});

test("titles: explicit minor terms are blocked in English and Japanese", () => {
    assert.equal(m.isBlockedTitle("Loli Placeholder"), true);
    assert.equal(m.isBlockedTitle("Placeholder shotacon"), true);
    assert.equal(m.isBlockedTitle("ロリ Placeholder"), true);
    assert.equal(m.isBlockedTitle("Lolita Fashion Placeholder"), false);
    assert.equal(m.isBlockedTitle("Placeholder Clean One"), false);
});

test("list cards: blocked tag IDs, blocked titles and cards without tag data are all dropped", () => {
    const items = m.allowedListItems(m.parseListPage(HOME));
    assert.deepEqual(items.map((i) => i.id), ["101", "104"]);
    assert.ok(items.every((i) => !("tagIds" in i)), "internal tag ids never reach clients");
});

test("gallery pages: blocked by any blocked tag slug or a blocked title", () => {
    assert.equal(m.isBlockedGallery(GALLERIES[201]), false);
    assert.equal(m.isBlockedGallery(GALLERIES[202]), true);
    assert.equal(m.isBlockedGallery(GALLERIES[203]), true);
    assert.equal(m.isBlockedGallery(GALLERIES[204]), false);
    assert.equal(m.isBlockedGallery(GALLERIES[205]), true);
});

test("popular and search serve only policy-passing galleries", async () => {
    const popular = await api("/popular?limit=24");
    assert.equal(popular.status, 200);
    // 103 has no tag data and no checkable gallery page: dropped (fail closed).
    // 107/108 have no tag data either and are judged by their gallery pages.
    assert.deepEqual(popular.body.items.map((i) => i.id), ["101", "104", "107"]);
    const search = await api("/search?q=placeholder&limit=10");
    assert.deepEqual(search.body.items.map((i) => i.id), ["101", "104", "107"]);
    const sliced = await api("/search?q=placeholder&limit=1&offset=1");
    assert.deepEqual(sliced.body.items.map((i) => i.id), ["104"]);
});

test("details and pages refuse blocked galleries with a plain 404", async () => {
    assert.equal((await api("/details?id=201")).status, 200);
    assert.equal((await api("/pages?id=201&chapterId=gallery")).status, 200);
    for (const id of ["202", "203", "205"]) {
        const d = await api(`/details?id=${id}`);
        assert.equal(d.status, 404, `details ${id}`);
        assert.equal(d.body.code, "UNAVAILABLE");
        assert.equal((await api(`/pages?id=${id}&chapterId=gallery`)).status, 404, `pages ${id}`);
    }
});

test("/img only fetches from HentaiFox's own image hosts", async () => {
    for (const h of ["i.hentaifox.com", "i2.hentaifox.com", "i3.hentaifox.com", "I3.HENTAIFOX.COM."]) {
        assert.equal(m.isAllowedImageHost(h), true, h);
    }
    // Not the Cloudflare-scored HTML origin, and nothing that merely ends in it.
    for (const h of ["hentaifox.com", "www.hentaifox.com", "127.0.0.1.nip.io", "hentaifox.com.evil.example",
        "evilhentaifox.com", "x.i3.hentaifox.com", "169.254.169.254", "[::1]"]) {
        assert.equal(m.isAllowedImageHost(h), false, h);
    }
    const r = await fetch(`http://127.0.0.1:${appServer.address().port}/img?u=${encodeURIComponent("http://127.0.0.1.nip.io/x.jpg")}`);
    assert.equal(r.status, 403);
});

test("/img: oversized bodies, off-list redirects and redirect loops fail once, cleanly", async () => {
    const big = await img(`${UP}/cdn/big.bin`);
    assert.equal(big.status, 502);
    assert.equal(big.text, "image too large");
    assert.equal(big.cache, "no-store");
    assert.equal((await img(`${UP}/cdn/out`)).status, 403);
    assert.equal((await img(`${UP}/cdn/loop`)).status, 502);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(unhandled.map((e) => e?.code || String(e)), [], "a second response threw out of the handler");
});

test("/img fallback does not follow redirects", async () => {
    const r = await img(`${UP}/cdn/scored`);
    assert.equal(r.status, 502);
    assert.deepEqual(sinkHits, [], "the impersonating fallback followed a redirect");
});

test("/img refuses images of galleries the policy refused", async () => {
    // Seen blocked by its list card (tag 8) on /popular, and by its gallery page on /details.
    await api("/popular?limit=24");
    await api("/details?id=202");
    for (const u of ["https://i3.hentaifox.com/005/102/1.jpg", "https://i.hentaifox.com/005/102/thumb.jpg",
        "https://i2.hentaifox.com/005/9202/2.jpg"]) {
        const r = await img(u);
        assert.equal(r.status, 404, u);
        assert.equal(r.text, "not available", u);
        assert.equal(r.cache, "no-store", u);
    }
    assert.equal(m.isBlockedImageUrl("https://i3.hentaifox.com/005/9201/1.jpg"), false, "allowed gallery untouched");
});

test("a list never waits past its route budget for policy checks", async () => {
    const t0 = Date.now();
    const r = await api("/search?q=slow&limit=10");
    const ms = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((i) => i.id), ["101"], "the unchecked card is dropped, not waited for");
    assert.ok(ms < 4_000, `took ${ms}ms`);
});

// ---------------------------------------------------------------------------
// Bypass hunt, 2026-10-14: every case below was a way past the policy.

test("titles: look-alikes, spacing, mojibake and other languages are caught", () => {
    for (const t of [
        "\uff4c\uff4f\uff4c\uff49 Placeholder", // fullwidth
        "l\u043eli Placeholder", // Cyrillic o
        "L0li Placeholder", "lo\u200bli Placeholder", "l o l i Placeholder", "S.h.o.t.a Placeholder",
        "Placeholder Lolicon", "Placeholder Mesugaki", "Jidou Inkou", "Placeholder Shougakusei",
        "Placeholder Elementary Schooler", "Placeholder 5th Grader", "Underage Placeholder",
        "\uff9b\uff98 Placeholder", "ロ リ Placeholder", "女子小学生 Placeholder", "メスガキ Placeholder",
        "萝莉 Placeholder", "蘿莉 Placeholder", "로리 Placeholder", "쇼타 Placeholder", "Placeholder JS",
        "\u00e3\u0192\u00ad\u00e3\u0192\u00aa Placeholder", // ロリ stored double-encoded
        "Pedoou Placeholder",
    ]) {
        assert.equal(m.isBlockedTitle(t), true, t);
    }
    for (const t of [
        "Lolita Fashion Placeholder", "Gothic Lolita Placeholder", "Shotaro Placeholder", "I Shot a Placeholder",
        "Schoolgirl Uniform Placeholder", "High School Placeholder", "Petite Placeholder", "Hello Lisa Placeholder",
        "ペロリ Placeholder", "カロリー Placeholder", "Jidou Hanbaiki Placeholder", "Eiyuuou \u00e2\u2122\u20ac Placeholder",
        "Placeholder LOL!", "Placeholder 1011", "Placeholder Speedo",
    ]) {
        assert.equal(m.isBlockedTitle(t), false, t);
    }
});

test("tag slugs: mesugaki and comic-lo are blocked", () => {
    for (const s of ["mesugaki", "comic-lo", "loli-seiyouken"]) assert.equal(m.isBlockedTagSlug(s), true, s);
    assert.equal(m.isBlockedParodySlug("mitsudomoe"), true);
    assert.equal(m.isBlockedParodySlug("original"), false);
});

test("list cards: untagged, empty tag data and child-cast parodies are dropped; outer data never stands in", () => {
    const c = (attrs, id) => `<div class="thumb" ${attrs}><a href="/gallery/${id}/"><img data-src="https://i3.hentaifox.com/005/${id}/thumb.jpg"></a>` +
        `<h2 class="g_title"><a href="/gallery/${id}/">Placeholder ${id}</a></h2></div>`;
    const page = listPage([
        c('data-categories="1" data-languages="1"', "301"), // HentaiFox omits data-tags for an untagged gallery
        c('data-tags=""', "302"),
        c('data-tags="3 10" data-parodies="500"', "303"), // 500 = mitsudomoe
        c('data-tags="3 10" data-parodies="1913"', "304"),
        `<div data-tags="3 10">${c('data-categories="1"', "305")}</div>`, // an outer element's tags are not this card's
        c('data-tags="3 2890"', "306"), // 2890 = mesugaki
    ]);
    const items = m.allowedListItems(m.parseListPage(page));
    assert.deepEqual(items.map((i) => i.id), ["304"]);
    assert.ok(items.every((i) => !("tagIds" in i) && !("parodyIds" in i)), "internal ids never reach clients");
    assert.equal(new URL(items[0].cover).searchParams.get("sk")?.length, 22, "covers are handed out signed");
});

test("gallery pages: untagged, absolute tag links, child-cast parodies; the footer tag link does not count", () => {
    const page = (body) => `<html><head><title>Placeholder - HentaiFox</title></head><body><div class="info"><h1>Placeholder</h1>` +
        `${body}</div><ul><li><a href="https://hentaifox.com/tag/comic/">Comics</a></li></ul></body></html>`;
    const btn = (href, label) => `<a class='tag_btn ' href='${href}'>${label} <span class='t_badge'>1</span></a>`;
    assert.equal(m.isBlockedGallery(page("")), true, "no tags: nothing was checked");
    assert.equal(m.isBlockedGallery(page(btn("https://hentaifox.com/tag/lolicon/", "lolicon"))), true, "absolute href");
    assert.equal(m.isBlockedGallery(page(btn("/tag/x1/", "oppai loli"))), true, "label");
    assert.equal(m.isBlockedGallery(page(btn("/tag/mesugaki/", "mesugaki"))), true);
    assert.equal(m.isBlockedGallery(page(btn("/tag/vanilla/", "vanilla") + btn("/parody/mitsudomoe/", "Mitsudomoe"))), true);
    assert.equal(m.isBlockedGallery(page(btn("/tag/vanilla/", "vanilla") + btn("/parody/original/", "Original"))), false);
});

test("/img serves only image directories this service signed", async () => {
    assert.equal((await img(`${UP}/cdn/gone.jpg`, { raw: true })).status, 403, "unsigned");
    const signed = new URL(m.signImageUrl(`${UP}/cdn/gone.jpg`));
    const moved = new URL(signed);
    moved.pathname = "/elsewhere/1.jpg";
    assert.equal((await img(moved.toString(), { raw: true })).status, 403, "signature of another directory");
    const forged = new URL(signed);
    forged.searchParams.set("sk", "A".repeat(22));
    assert.equal((await img(forged.toString(), { raw: true })).status, 403, "forged signature");
    for (const u of [`${UP}//cdn/gone.jpg`, `${UP}/cdn/a%2Fb.jpg`, "https://hentaifox.com/005/1/1.jpg"]) {
        assert.equal(m.signImageUrl(u), null, u);
    }
    assert.equal((await img(`${UP}/cdn/hop`)).status, 403, "a redirect may not leave the signed directory");
    assert.ok(!sinkHits.includes("/elsewhere/1.jpg"));
    const ok = await img(`${UP}/cdn/gone.jpg`);
    assert.equal(ok.status, 404, "a signed URL reaches the CDN");
    assert.equal(ok.text, "not an image");
});

test("/pages hands out signed page URLs", async () => {
    const r = await api("/pages?id=201&chapterId=gallery");
    assert.equal(r.status, 200);
    for (const u of r.body.pages) {
        const bare = new URL(u);
        assert.equal(bare.searchParams.get("sk")?.length, 22, u);
        bare.search = "";
        assert.equal(m.signImageUrl(bare.toString()), u);
    }
});

test("gallery ids must be numeric", async () => {
    for (const id of ["..", "1/../2", "abc", "12a"]) {
        for (const route of ["details", "pages", "chapters"]) {
            assert.equal((await api(`/${route}?id=${encodeURIComponent(id)}`)).status, 400, `${route} ${id}`);
        }
    }
});
