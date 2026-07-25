module.exports = {
    apps: [
        {
            name: "sakura-manhwa-scraper",
            script: "server.js",
            cwd: "/opt/sakura/manhwa-scraper",
            instances: 1,
            autorestart: true,
            watch: false,
            // Deliberately lower than the 256M its two siblings use. The droplet
            // has 961MB total with ~340MB free while comics and hentai are both
            // running, so a third service at 256M would oversubscribe the box.
            max_memory_restart: "160M",
            env: {
                NODE_ENV: "production",
                MANHWA_SCRAPER_PORT: "3102",
                // Must be the www host - the apex 301s and drops the
                // /ajax/chapters/ suffix, silently returning the series page.
                MANHWA_MANGAREAD_BASE: "https://www.mangaread.org",
                MANHWA_COMIZY_BASE: "https://comizy.io",
                // Chapter-list responses run 60-110KB, so cache far fewer
                // entries than the sibling scrapers do.
                MANHWA_CACHE_MAX: "400",
                MANHWA_CACHE_TTL_MS: String(15 * 60 * 1000),
                MANHWA_REQUEST_TIMEOUT_MS: "25000",
            },
        },
    ],
};
