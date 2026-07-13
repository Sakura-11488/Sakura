const fs = require("fs");
const path = require("path");

// The Cloudflare-bypass proxy templates hold an API key, so they must NEVER be
// committed. They live in untracked files next to this config (single line
// each, ending in url={{url}}). deploy.sh excludes proxy-template*.txt from its
// `rsync --delete`, so they survive redeploys.
//
//   proxy-template.txt        HTML page fetches — needs JS rendering:
//       https://api.zenrows.com/v1/?apikey=KEY&js_render=true&antibot=true&url={{url}}
//   image-proxy-template.txt  cover/page images — cheaper, no JS render:
//       https://api.zenrows.com/v1/?apikey=KEY&antibot=true&url={{url}}
//
// image-proxy-template.txt is optional; if absent, images fall back to the HTML
// template. If proxy-template.txt is absent too, the scraper runs with no proxy
// and gets Cloudflare-blocked on datacenter IPs (see server.js).
function readTemplate(name) {
    try {
        return fs.readFileSync(path.join(__dirname, name), "utf8").trim();
    } catch {
        return "";
    }
}
const fetchProxyTemplate = readTemplate("proxy-template.txt");
const imageProxyTemplate = readTemplate("image-proxy-template.txt");

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
                COMICS_CACHE_MAX: "1000",
                COMICS_CACHE_TTL_MS: String(15 * 60 * 1000),
                // Rendered CF-bypass requests take longer than a raw fetch, so
                // allow more time for the first (uncached) hit on each path.
                COMICS_REQUEST_TIMEOUT_MS: "45000",
                COMICS_IMAGE_TIMEOUT_MS: "30000",
                COMICS_FETCH_PROXY_TEMPLATE: fetchProxyTemplate,
                COMICS_IMAGE_PROXY_TEMPLATE: imageProxyTemplate,
            },
        },
    ],
};
