/**
 * Regression tests for the direct-first ladder.
 *
 * Every test here exists because a specific defect was found and fixed. The
 * paid tier is a LOCAL MOCK — this suite never touches ZenRows and never spends
 * a credit. Run with:
 *
 *     node test-ladder.mjs
 */
import http from "node:http";
import { createUpstream, looksLikeChallenge, escalationClass, UpstreamError } from "./upstream.js";

let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => {
    if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
    else { fail += 1; console.log(`  FAIL  ${name} ${detail}`); }
};

// --- mock origin + mock paid proxy -----------------------------------------
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
// Shaped like the real thing: the CF JSD beacon is injected near the END of
// every HEALTHY xoxocomic page (measured at offset 182,517 of 183,205 bytes), so
// the fixture pads the body to push it well past the 4 KB head slice. A fixture
// with the beacon in the head would make this suite pass for the wrong reason.
const HEALTHY_LIST = `<html><head><title>Popular</title></head><body>
<article class="item"><h3><a href="/comic/spawn" title="Spawn">Spawn</a></h3><img src="/images/series/1.jpg"></article>
<!--${"pad ".repeat(2000)}-->
</body><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></html>`;
const CHALLENGE = `<html><head><title>Just a moment...</title></head><body>
<div id="cf-wrapper"><script>window._cf_chl_opt={cvId:'3'};</script></div></body></html>`;
const SOFT_404 = `<html><head><title>Read Comics Online | Free Comics at Xoxocomic</title></head><body>home</body></html>`;

const server = { origin: null, proxy: null };
const counters = { origin: 0, proxy: 0, credits: 0 };
let originMode = "healthy";   // healthy | challenge | soft404 | deadimage | 500
let proxyMode = "healthy";    // healthy | 402 | 429 | challenge

function listen(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.listen(0, "127.0.0.1", () => resolve(s));
    });
}

async function boot() {
    server.origin = await listen((req, res) => {
        counters.origin += 1;
        if (originMode === "challenge") {
            res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
            return res.end(CHALLENGE);
        }
        if (originMode === "500") { res.writeHead(500, { "content-type": "text/html" }); return res.end("boom"); }
        if (req.url.includes(".jpg")) {
            if (originMode === "deadimage" || originMode === "soft404") {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end(SOFT_404);
            }
            res.writeHead(200, { "content-type": "image/jpeg" });
            return res.end(JPEG);
        }
        if (originMode === "soft404") { res.writeHead(200, { "content-type": "text/html" }); return res.end(SOFT_404); }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(HEALTHY_LIST);
    });
    server.proxy = await listen((req, res) => {
        counters.proxy += 1;
        counters.credits += 5;
        if (proxyMode === "402") { res.writeHead(402, { "content-type": "application/json" }); return res.end('{"code":"AUTH004"}'); }
        if (proxyMode === "429") { res.writeHead(429, { "content-type": "application/json" }); return res.end('{"code":"AUTH006"}'); }
        if (proxyMode === "challenge") { res.writeHead(200, { "content-type": "text/html", "x-request-credits": "5" }); return res.end(CHALLENGE); }
        const target = decodeURIComponent((req.url.match(/url=([^&]+)/) || [, ""])[1]);
        if (target.includes(".jpg")) { res.writeHead(200, { "x-request-credits": "5" }); return res.end(JPEG); }
        res.writeHead(200, { "content-type": "text/html", "x-request-credits": "5" });
        res.end(HEALTHY_LIST);
    });
}

const O = () => `http://127.0.0.1:${server.origin.address().port}`;
const P = () => `http://127.0.0.1:${server.proxy.address().port}/?apikey=MOCK&url={{url}}`;

function makeUpstream(extra = {}) {
    counters.origin = 0; counters.proxy = 0; counters.credits = 0;
    return createUpstream({
        upstreamBase: O(),
        fetchProxyTemplate: P(),
        imageProxyTemplate: P(),
        directTimeoutMs: 3000,
        proxyTimeoutMs: 3000,
        proxyMaxRetries: 0,
        blockCooldownMs: 120,
        totalBudgetMs: 8000,
        ...extra,
    });
}

const listValidator = (html) => {
    const n = (html.match(/\/comic\//g) || []).length;
    return n > 0 ? { ok: true, value: n } : { ok: false, reason: "0 comics parsed" };
};
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const code = async (fn) => { try { await fn(); return "NO_ERROR"; } catch (e) { return e?.code || String(e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await boot();

console.log("\n--- looksLikeChallenge (rules 3 + 4) ---");
{
    // Measured live 2026-08-13: the CF JSD beacon sits at offset 182,517 of a
    // 183,205-byte chapter page. If the head-slice were dropped, EVERY page
    // would be flagged and the whole Comics tab would 502.
    const realPage = "x".repeat(182_000) + `<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`;
    const idx = realPage.indexOf("challenge-platform");
    ok(idx > 4000, "CF beacon is past the 4 KB head (test still proves something)", `offset=${idx}`);
    ok(!looksLikeChallenge({ status: 200, headers: null, html: realPage }),
        "healthy page with a tail CF beacon is NOT a challenge");
    ok(looksLikeChallenge({ status: 403, headers: null, html: CHALLENGE }),
        "real challenge page IS flagged");
    ok(looksLikeChallenge({ status: 200, headers: new Headers({ "cf-mitigated": "challenge" }), html: "" }),
        "cf-mitigated header alone is conclusive");
    // Rule 4: search echoes the query; prose must not fire on a 200.
    ok(!looksLikeChallenge({ status: 200, headers: null, html: "<title>just a moment</title>" }),
        "user searching 'just a moment' does NOT self-inflict a block");
}

console.log("\n--- escalationClass (rule 1, the money rule) ---");
{
    ok(escalationClass({ challenge: true, status: 200, code: null }) === "escalate", "challenge -> escalate");
    ok(escalationClass({ challenge: false, status: 200, code: "INVALID" }) === "final",
        "200 + no product + no CF markers -> FINAL (free)");
    ok(escalationClass({ challenge: false, status: 404, code: "HTTP" }) === "final", "404 -> FINAL (free)");
    ok(escalationClass({ challenge: false, status: 403, code: "HTTP" }) === "escalate", "403 -> escalate");
    ok(escalationClass({ challenge: false, status: 503, code: "HTTP" }) === "escalate", "5xx -> escalate");
    ok(escalationClass({ challenge: false, status: null, code: "TIMEOUT" }) === "escalate", "timeout -> escalate");
}

console.log("\n--- happy path ---");
{
    originMode = "healthy";
    const up = makeUpstream();
    const r = await up.fetchHtml(`${O()}/popular-comic`, { validate: listValidator });
    ok(r.via === "direct" && r.value === 1, "healthy -> direct, validator product returned");
    ok(counters.proxy === 0, "paid tier never called", `proxyHits=${counters.proxy}`);
    ok(up.stats().proxyCreditsSpent === 0, "0 credits spent");
}

console.log("\n--- BLOCKER 1: a product failure must NOT buy a paid call ---");
{
    originMode = "soft404";
    const up = makeUpstream();
    // xoxocomic answers /comic/<bogus-slug> with HTTP 200 + its homepage. Five
    // hits on a public unauthenticated endpoint used to be five js_render calls.
    for (let i = 0; i < 5; i += 1) {
        const c = await code(() => up.fetchHtml(`${O()}/comic/bogus`, { validate: listValidator }));
        if (c !== "INVALID") ok(false, "soft-404 classified INVALID", `got ${c}`);
    }
    ok(counters.proxy === 0, "5x product failure -> 0 metered requests", `proxyHits=${counters.proxy}`);
    ok(up.stats().proxyCreditsSpent === 0, "0 credits spent on markup drift");
    ok(up.stats().escalations === 0, "escalations stayed 0");
}

console.log("\n--- BLOCKER 2: an unchallenged origin response clears the cooldown ---");
{
    const up = makeUpstream();
    originMode = "challenge";
    await code(() => up.fetchHtml(`${O()}/popular-comic`, { validate: listValidator }));
    ok(up.stats().mode === "proxy", "challenge -> sticky proxy mode");
    await sleep(150); // cooldown expires
    // The probe lands on a soft-404: reaches the origin, gets no product. Under
    // the old code this left blockedUntil pinned in the past FOREVER, so every
    // concurrent request went to the meter while /healthz said mode "direct".
    originMode = "soft404";
    counters.proxy = 0;
    await code(() => up.fetchHtml(`${O()}/popular-comic`, { validate: listValidator }));
    ok(up.stats().mode === "direct", "probe that reached the origin CLEARS the block",
        `mode=${up.stats().mode}`);
    counters.proxy = 0;
    await Promise.all(Array.from({ length: 8 }, () => code(() => up.fetchHtml(`${O()}/x`, { validate: listValidator }))));
    ok(counters.proxy === 0, "8 concurrent requests after recovery -> 0 metered",
        `proxyHits=${counters.proxy}`);
}

console.log("\n--- BLOCKER 3: an HTML block must not route dead images to the meter ---");
{
    const up = makeUpstream();
    originMode = "challenge";
    await code(() => up.fetchHtml(`${O()}/popular-comic`, { validate: listValidator }));
    ok(up.stats().htmlBlocked, "html channel blocked");
    ok(!up.stats().imageBlocked, "image channel is INDEPENDENT and not blocked");
    originMode = "deadimage";
    counters.proxy = 0; counters.credits = 0;
    // One chapter = ~29 page images. Under a coupled cooldown every one of them
    // went to the paid tier at 5 credits, for images ZenRows cannot deliver.
    for (let i = 1; i <= 20; i += 1) {
        await code(() => up.fetchImage(`${O()}/comic/x/issue-1/1/${i}.jpg`, { isImage: isJpeg }));
    }
    ok(counters.proxy === 0, "20 dead page images during an HTML block -> 0 metered",
        `proxyHits=${counters.proxy} credits=${counters.credits}`);
}

console.log("\n--- dead-image memo: a repeat view costs zero network ---");
{
    originMode = "deadimage";
    const up = makeUpstream();
    const url = `${O()}/comic/x/issue-1/1/1.jpg`;
    await code(() => up.fetchImage(url, { isImage: isJpeg }));
    const afterFirst = counters.origin;
    for (let i = 0; i < 10; i += 1) await code(() => up.fetchImage(url, { isImage: isJpeg }));
    ok(counters.origin === afterFirst, "10 repeat views -> 0 extra origin requests",
        `origin=${counters.origin} afterFirst=${afterFirst}`);
    ok(up.stats().deadImageShortCircuits === 10, "short-circuits counted");
}

console.log("\n--- single-flight probe ---");
{
    const up = makeUpstream({ blockCooldownMs: 100 });
    originMode = "challenge";
    await code(() => up.fetchHtml(`${O()}/p`, { validate: listValidator }));
    await sleep(130);
    originMode = "healthy";
    counters.origin = 0;
    const results = await Promise.all(
        Array.from({ length: 8 }, () => up.fetchHtml(`${O()}/p`, { validate: listValidator }).then((r) => r.via).catch((e) => e.code)),
    );
    ok(counters.origin === 1, "exactly 1 of 8 concurrent requests re-probes direct",
        `originHits=${counters.origin}`);
    ok(results.filter((v) => v === "direct").length === 1, "one direct success", JSON.stringify(results));
}

console.log("\n--- probe failure re-arms the cooldown (never a no-op) ---");
{
    const up = makeUpstream({ blockCooldownMs: 100 });
    originMode = "challenge";
    await code(() => up.fetchHtml(`${O()}/p`, { validate: listValidator }));
    await sleep(130);
    counters.origin = 0;
    await code(() => up.fetchHtml(`${O()}/p`, { validate: listValidator })); // probe, still challenged
    ok(up.stats().htmlBlocked, "still blocked after a failed probe");
    counters.origin = 0;
    await Promise.all(Array.from({ length: 5 }, () => code(() => up.fetchHtml(`${O()}/p`, { validate: listValidator }))));
    ok(counters.origin === 0, "cooldown re-armed: no further direct probes", `originHits=${counters.origin}`);
}

console.log("\n--- BLOCKER 2b: escalation accounting cannot under-report ---");
{
    const up = makeUpstream({ blockCooldownMs: 5000 });
    originMode = "challenge"; proxyMode = "healthy";
    await code(() => up.fetchHtml(`${O()}/p`, { validate: listValidator }));
    const before = up.stats().escalations;
    for (let i = 0; i < 3; i += 1) await up.fetchHtml(`${O()}/p`, { validate: listValidator }).catch(() => {});
    const s = up.stats();
    ok(s.escalations >= before + 3, "every entry into the paid tier is counted, including skipped-direct",
        `escalations=${s.escalations} proxyHits=${counters.proxy}`);
    ok(s.proxyCreditsSpent === counters.credits, "credits self-metered from X-Request-Credits",
        `${s.proxyCreditsSpent} vs ${counters.credits}`);
    ok(s.mode === "proxy", "mode reports proxy while on the meter");
}

console.log("\n--- escalation token bucket (rule 2) ---");
{
    const up = makeUpstream({ escalationBudget: 3, escalationWindowMs: 60_000, blockCooldownMs: 0 });
    originMode = "500"; proxyMode = "healthy"; // 5xx is escalation-eligible
    counters.proxy = 0;
    for (let i = 0; i < 10; i += 1) await code(() => up.fetchHtml(`${O()}/p`, { validate: listValidator }));
    ok(counters.proxy === 3, "eligible escalations capped at the budget", `proxyHits=${counters.proxy}`);
    ok(up.stats().escalationsDenied === 7, "denials counted", `denied=${up.stats().escalationsDenied}`);
}

console.log("\n--- quota (rule 8) ---");
{
    const up = makeUpstream({ blockCooldownMs: 5000 });
    originMode = "challenge"; proxyMode = "402";
    const c1 = await code(() => up.fetchHtml(`${O()}/p`, { validate: listValidator }));
    ok(c1 === "QUOTA", "402 -> QUOTA", `got ${c1}`);
    ok(up.stats().proxyQuotaExhausted, "paid tier parked");
    counters.proxy = 0;
    const c2 = await code(() => up.fetchHtml(`${O()}/p`, { validate: listValidator }));
    ok(c2 === "QUOTA" && counters.proxy === 0, "we STOP calling a dry tier", `code=${c2} hits=${counters.proxy}`);
    ok(up.stats().mode === "blocked", "mode is honest: blocked, not 'proxy'");
}
{
    const up = makeUpstream({ blockCooldownMs: 5000 });
    originMode = "challenge"; proxyMode = "429";
    const c = await code(() => up.fetchHtml(`${O()}/p`, { validate: listValidator }));
    ok(c === "BUSY", "429 -> BUSY (transient)", `got ${c}`);
    ok(!up.stats().proxyQuotaExhausted, "429 does NOT park the tier");
}

console.log("\n--- health counters cannot be driven by client garbage ---");
{
    originMode = "soft404"; proxyMode = "healthy";
    const up = makeUpstream();
    for (let i = 0; i < 6; i += 1) await code(() => up.fetchHtml(`${O()}/comic/bogus${i}`, { validate: listValidator }));
    ok(up.stats().consecutiveFailures === 0,
        "6 bogus slugs leave consecutiveFailures at 0 (public /healthz stays green)",
        `consecutiveFailures=${up.stats().consecutiveFailures}`);
    ok(up.stats().invalidResults >= 6, "but they ARE counted as invalidResults");
}

console.log("\n--- probe:true keeps /readyz out of /healthz ---");
{
    originMode = "challenge"; proxyMode = "healthy";
    const up = makeUpstream({ blockCooldownMs: 5000 });
    for (let i = 0; i < 4; i += 1) {
        await code(() => up.fetchHtml(`${O()}/p`, { validate: listValidator, allowProxy: false, probe: true }));
    }
    ok(up.stats().consecutiveFailures === 0,
        "4 failed readiness legs during a block do not 503 /healthz",
        `consecutiveFailures=${up.stats().consecutiveFailures}`);
}

console.log("\n--- rule 10: response size ceiling ---");
{
    const big = await listen((req, res) => {
        res.writeHead(200, { "content-type": "text/html", "content-length": String(50 * 1024 * 1024) });
        res.end("x".repeat(1024));
    });
    const up = createUpstream({
        upstreamBase: `http://127.0.0.1:${big.address().port}`,
        maxHtmlBytes: 1024 * 1024, directTimeoutMs: 3000, totalBudgetMs: 5000,
    });
    const c = await code(() => up.fetchHtml(`http://127.0.0.1:${big.address().port}/huge`, { validate: listValidator }));
    ok(c === "INVALID", "oversized body rejected on content-length, before buffering", `got ${c}`);
    big.close();
}

console.log("\n--- image happy path + no-credential leak in stats ---");
{
    originMode = "healthy";
    const up = makeUpstream();
    const r = await up.fetchImage(`${O()}/images/series/1.jpg`, { isImage: isJpeg });
    ok(r.via === "direct" && isJpeg(r.buf), "cover fetched direct, magic bytes verified");
    const blob = JSON.stringify(up.stats()).toLowerCase();
    ok(!blob.includes("apikey") && !blob.includes("mock") && !blob.includes("127.0.0.1"),
        "stats() leaks no template, key or proxy URL");
}

server.origin.close(); server.proxy.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
