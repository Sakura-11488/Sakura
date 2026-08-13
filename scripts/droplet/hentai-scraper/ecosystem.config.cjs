const fs = require("fs");
const path = require("path");

// OPTIONAL ESCALATION ONLY — nothing here is needed for the free path.
//
// If hentaifox ever starts scoring the droplet's datacenter ASN in addition to
// the client fingerprint, the fix is to send HTML fetches through a residential
// proxy. That URL contains CREDENTIALS (http://user:pass@host:port), so it must
// never live in this tracked file. Put it in an untracked one-liner next to this
// config and it is picked up on the next reload:
//
//     printf 'http://USER:PASS@geo.example.net:12321' \
//         > /opt/sakura/hentai-scraper/proxy-url.txt
//     pm2 reload ecosystem.config.cjs --update-env
//
// deploy.sh excludes proxy-url*.txt and debug-token.txt from its `rsync
// --delete`, so they survive redeploys. Absent = no proxy = free.
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
            name: "sakura-hentai-scraper",
            script: "server.js",
            cwd: "/opt/sakura/hentai-scraper",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "256M",
            env: {
                NODE_ENV: "production",
                HENTAI_SCRAPER_PORT: "3101",
                HENTAI_UPSTREAM_BASE: "https://hentaifox.com",

                HENTAI_CACHE_MAX: "1000",
                // 60 min, was 15. Every miss is a request at a Cloudflare-scored
                // origin, and galleries are immutable.
                HENTAI_CACHE_TTL_MS: String(60 * 60 * 1000),

                // TIMEOUT BUDGET — load-bearing, do not raise casually.
                // nginx cuts the request at proxy_read_timeout. Worst case here
                // is (1 retry + 1 attempt) x 8s + ~0.8s backoff = ~16.8s, which
                // fits under BOTH the 30s that is live today and the 60s in
                // nginx-snippet.conf. If you raise either number, re-check the
                // product against the LIVE nginx value, not the file:
                //   grep -A12 'location /hentai/v1/' \
                //     /etc/nginx/sites-available/psyopanime | grep proxy_read
                HENTAI_REQUEST_TIMEOUT_MS: "8000",
                HENTAI_UPSTREAM_MAX_RETRIES: "1",
                HENTAI_UPSTREAM_BACKOFF_MS: "600",

                // A bot challenge is a verdict, not a blip. Stop fetching for
                // 90s instead of retrying into it — this is also what stops the
                // client's 4-query /popular fallback from turning one failure
                // into five requests at an origin that just scored us.
                HENTAI_BLOCK_COOLDOWN_MS: "90000",

                HENTAI_UPSTREAM_CONCURRENCY: "4",
                HENTAI_UPSTREAM_QUEUE_MAX: "24",

                // Gallery HTML shared by /details + /pages, byte-bounded so a
                // browsing session cannot grow the heap into max_memory_restart.
                HENTAI_HTML_CACHE_BYTES: String(24 * 1024 * 1024),
                HENTAI_HTML_CACHE_TTL_MS: String(5 * 60 * 1000),

                HENTAI_IMAGE_TIMEOUT_MS: "20000",
                HENTAI_READY_TTL_MS: "60000",

                // Secrets — read from untracked files, empty when absent.
                HENTAI_PROXY_URL: readSecret("proxy-url.txt"),
                HENTAI_DEBUG_TOKEN: readSecret("debug-token.txt"),
            },
        },
    ],
};
