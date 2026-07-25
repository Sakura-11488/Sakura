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
                HENTAI_CACHE_TTL_MS: String(15 * 60 * 1000),
                HENTAI_REQUEST_TIMEOUT_MS: "20000",
            },
        },
    ],
};
