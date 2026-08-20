const fs = require("fs");
const path = require("path");

// THE PROXY IS NOW A FALLBACK, NOT THE DEFAULT PATH.
//
// As of 2026-08-13 the Cloudflare block that forced every byte through ZenRows
// has lifted: plain undici from the droplet gets real HTML on every route and
// valid JPEG bytes for covers, under sustained and concurrent load, with
// `cf-mitigated` never once present. server.js/upstream.js therefore try the
// FREE path first and only escalate to ZenRows on a real challenge or a
// transport failure — never on a product failure, and even then under a token
// bucket (see rules 1 and 2 in upstream.js).
//
// Keep these files in place. They are the safety net, and they cost nothing
// while idle: removing them would leave no way back if the block returns.
//
// The templates hold an API key, so they must NEVER be committed. They live in
// untracked files next to this config (single line each, ending in url={{url}}).
// deploy.sh excludes them from its `rsync --delete`, so they survive redeploys.
//
//   proxy-template.txt        HTML page fetches — needs JS rendering:
//       https://api.zenrows.com/v1/?apikey=KEY&js_render=true&antibot=true&url={{url}}
//   image-proxy-template.txt  cover/page images — cheaper, no JS render:
//       https://api.zenrows.com/v1/?apikey=KEY&antibot=true&url={{url}}
//   debug-token.txt           shared secret for GET /debug/probe
//
// Absent = that tier is simply unavailable; the service still runs on the free
// path and reports `proxyConfigured: false` in /healthz.
function readSecret(name) {
    try {
        return fs.readFileSync(path.join(__dirname, name), "utf8").trim();
    } catch {
        return "";
    }
}

module.exports = {
    apps: [
        {
            name: "sakura-comics-scraper",
            script: "server.js",
            cwd: "/opt/sakura/comics-scraper",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "256M",
            env: {
                NODE_ENV: "production",
                COMICS_SCRAPER_PORT: "3100",
                COMICS_UPSTREAM_BASE: "https://xoxocomic.com",

                // Entry ceiling AND a byte bound. A 36-item list entry is ~13.7 KB
                // and a /pages entry ~17.7 KB, so 1000 entries alone is 14-18 MB
                // of JSON and considerably more as a live object graph — on a 1 GB
                // box with no swap where pm2 restarts us at 256M.
                COMICS_CACHE_MAX: "1000",
                COMICS_CACHE_BYTES: String(12 * 1024 * 1024),
                // Comics change rarely; cache an hour to cut repeat upstream hits.
                COMICS_CACHE_TTL_MS: String(60 * 60 * 1000),
                // ...but a "this is broken" verdict must expire in minutes, or a
                // chapter probed during an outage keeps failing for an hour after
                // the source heals.
                COMICS_NEGATIVE_TTL_MS: String(5 * 60 * 1000),

                // --- the budget, which is the thing that must not invert -------
                // Live nginx proxy_read_timeout is 30s and STAYS 30s: that block
                // is inside the one shared server{} on a 1-worker nginx serving
                // psyopanime, hentai, manhwa, mangadex and media-ingest too, so
                // widening it lowers the arrival rate that starves every other
                // service. The service budget therefore fits UNDER 30s instead:
                //     direct  8s
                //     proxy   2 attempts x 9s + ~0.6s backoff = ~18.6s
                //     hard ceiling enforced by COMICS_TOTAL_BUDGET_MS
                COMICS_TOTAL_BUDGET_MS: "25000",
                COMICS_DIRECT_TIMEOUT_MS: "8000",
                COMICS_REQUEST_TIMEOUT_MS: "9000",
                COMICS_IMAGE_TIMEOUT_MS: "9000",
                COMICS_PROXY_MAX_RETRIES: "1",
                COMICS_PROXY_BACKOFF_MS: "600",

                // --- free path (the default) ---------------------------------
                // Bounded concurrency + a bounded queue, sized from MEMORY not
                // from the nginx timeout: each queued HTML fetch retains its body
                // (~631 KB for the popular page, ~1.26 MB as a V8 string), so 24
                // deep is already ~15-30 MB of worst-case retention.
                COMICS_DIRECT_CONCURRENCY: "6",
                COMICS_DIRECT_QUEUE_MAX: "24",
                // Response ceilings. /img fetches caller-supplied URLs; the
                // largest legitimate body ever seen is 873 KB.
                COMICS_MAX_HTML_BYTES: String(3 * 1024 * 1024),
                COMICS_MAX_IMAGE_BYTES: String(8 * 1024 * 1024),

                // A challenge is a verdict, not a blip. Stay on the proxy for 10
                // minutes rather than re-probing a scored origin on every
                // request; exactly one request re-probes when this expires. HTML
                // and images have INDEPENDENT cooldowns.
                COMICS_BLOCK_COOLDOWN_MS: String(10 * 60 * 1000),

                // --- paid fallback -------------------------------------------
                // Bounded on BOTH axes now. The shipped version had an unbounded
                // waiter array on exactly the tier that is under pressure during
                // a block.
                COMICS_PROXY_CONCURRENCY: "2",
                COMICS_PROXY_QUEUE_MAX: "16",
                // Rule 2: even an ELIGIBLE escalation is rate-limited. A block is
                // one event; discovering it does not require one paid call per
                // inbound request. 8 per 10 minutes caps the worst case at ~40
                // credits / 10 min (~$0.04) no matter what traffic does.
                COMICS_ESCALATION_BUDGET: "8",
                COMICS_ESCALATION_WINDOW_MS: String(10 * 60 * 1000),
                // ZenRows 402 (AUTH004 "usage limit" / AUTH005 "validity
                // period") means the safety net is GONE until someone pays.
                // There is no balance endpoint to ask — every /v1/usage,
                // /v1/account, /v1/subscription candidate 404s — so the 402
                // itself is the only signal, and rediscovering it once per
                // request is pure waste. Park the tier for 6h and say so in
                // /healthz.
                COMICS_QUOTA_COOLDOWN_MS: String(6 * 60 * 60 * 1000),

                // Comic HTML shared by /details + /chapters (one fetch, not two),
                // byte-bounded so a browsing session cannot grow the heap into
                // max_memory_restart.
                COMICS_HTML_CACHE_BYTES: String(16 * 1024 * 1024),
                COMICS_HTML_CACHE_TTL_MS: String(5 * 60 * 1000),

                // A URL that answered with non-image bytes and no challenge is
                // remembered, so a reader session does not re-download ~106 KB of
                // homepage HTML per page per view — and can never send those URLs
                // to the paid tier.
                COMICS_DEAD_IMAGE_TTL_MS: String(30 * 60 * 1000),

                // /img is a caller-supplied-URL fetcher reachable from the public
                // internet and from the Vercel media-proxy allowlist (which
                // forwards ANY http(s) URL). Allowlist the hosts this scraper can
                // legitimately emit.
                COMICS_IMG_HOSTS: "xoxocomic.com,bp.blogspot.com,blogspot.com,blogger.googleusercontent.com",

                COMICS_READY_TTL_MS: "60000",
                COMICS_READY_FAIL_TTL_MS: "10000",
                // PINNED. Using whatever comic leads the popular page today makes
                // the deploy gate depend on a third party's merchandising.
                COMICS_READY_SLUG: "invincible",
                // During a block the proxy IS the read path; readiness must be
                // allowed to use it or the one scenario this design exists for
                // reports NOT READY and blocks the deploy of the fix. At most one
                // walk per COMICS_READY_TTL_MS, HTML legs only.
                COMICS_READY_ALLOW_PROXY: "1",

                // Sample two pages of a chapter before answering /pages, so a
                // reader that cannot render returns an honest error instead of
                // ~29 broken <img> tags. Free (disk cache, then direct; never
                // metered). Set to "0" for an instant rollback to the old
                // unverified behaviour — no redeploy needed, just
                // `pm2 reload ecosystem.config.cjs --update-env`.
                COMICS_PAGES_VERIFY: "1",

                // /readyz ALWAYS checks that a sampled page returns real image
                // bytes off the NETWORK and always reports the result. This flag
                // only controls whether that failure BLOCKS readiness. It is "0"
                // today because page images are broken upstream for everyone
                // (verified from the droplet, from a residential IP, and through
                // ZenRows) — gating on it would mean no deploy could pass until a
                // third party fixes their site. Flip to "1" the moment they
                // come back.
                COMICS_READY_REQUIRE_IMAGE: "0",

                // Secrets — read from untracked files, empty when absent.
                COMICS_FETCH_PROXY_TEMPLATE: readSecret("proxy-template.txt"),
                COMICS_IMAGE_PROXY_TEMPLATE: readSecret("image-proxy-template.txt"),
                COMICS_DEBUG_TOKEN: readSecret("debug-token.txt"),
            },
        },
    ],
};
