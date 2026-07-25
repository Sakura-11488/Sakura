# Sakura Comics Scraper

This is the Node.js + Express + Cheerio service that powers the **Comics** tab
in the Sakura app. It runs on the DigitalOcean droplet (`165.232.83.159`)
behind nginx at `/comics/v1/*` and scrapes XOXO Comics on demand, caching
everything in an in-memory LRU for 15 minutes so repeat requests are instant.

The Capacitor app talks to this service via `NEXT_PUBLIC_COMICS_PROXY`
(defaults to `http://165.232.83.159/comics/v1`).

## Endpoints

All responses are JSON and CORS-open.

| Method | Path                                   | Notes                                               |
| ------ | -------------------------------------- | --------------------------------------------------- |
| GET    | `/healthz`                             | `{ ok, upstream, cacheSize }`                       |
| GET    | `/popular?limit=24`                    | Hot comics list                                     |
| GET    | `/search?q=spider-man&limit=&offset=`  | Keyword search (XOXO `?keyword=` under the hood)    |
| GET    | `/details?id=<slug>`                   | Comic cover, description, authors, genres, status   |
| GET    | `/chapters?id=<slug>&limit=&offset=`   | Issue list (newest first, matches upstream order)   |
| GET    | `/pages?id=<slug>&chapterId=<issue>`   | Image URLs for a single issue (uses `/all` endpoint)|

`<slug>` and `<issue>` come from the URLs the service emits in its previous
responses — do not hand-construct them.

## One-time deploy

SSH into the droplet, copy this directory into any path (eg `/root/sakura-comics-scraper`),
and run:

```bash
cd sakura-comics-scraper
bash deploy.sh
```

The script will:

1. Install Node 20 + PM2 if needed.
2. Copy the app to `/opt/sakura/comics-scraper` and run `npm install`.
3. Start (or reload) the PM2 process `sakura-comics-scraper` on port 3100.
4. Patch the existing `psyopanime` nginx site with a `/comics/v1/` proxy block
   (only if the marker is missing) and reload nginx.
5. Hit `/healthz` to confirm the service is up.

After that, from anywhere on the internet:

```bash
curl http://165.232.83.159/comics/v1/healthz
```

should return `{"ok":true,...}`.

## Updating

Re-run `bash deploy.sh` from the same directory. `rsync` will overwrite
`/opt/sakura/comics-scraper`, `npm install` will sync dependencies, and
`pm2 reload` will zero-downtime-restart the process. The nginx patch step is
idempotent (it checks for the `# >>> sakura comics scraper >>>` marker).

## Operations

- **Logs**: `pm2 logs sakura-comics-scraper`
- **Restart**: `pm2 restart sakura-comics-scraper`
- **Tail cache size**: `curl http://127.0.0.1:3100/healthz | jq .cacheSize`
- **Change upstream**: edit `ecosystem.config.cjs` (`COMICS_UPSTREAM_BASE`) then
  `pm2 reload sakura-comics-scraper`.

## Cloudflare bypass (required as of 2026-07)

`xoxocomic.com` now sits behind a Cloudflare **managed challenge**
(`cf-mitigated: challenge`, HTTP 403 "Just a moment...") that blocks this
droplet's DigitalOcean datacenter IP. Symptoms: `/popular` and `/search` return
`{"items":[]}` (or a `502` with an "Upstream HTTP 403" body) even though
`/healthz` is fine — the Cheerio parsers only ever see the challenge page.

Rotated user-agents and TLS impersonation (`curl_cffi` impersonating Chrome)
do **not** get past it, and a headless-browser solver won't fit in the droplet's
RAM. The fix is to route upstream **page** fetches through a scraping/CF-bypass
API that solves the challenge on residential IPs.

Set it up on the droplet (never commit the key):

```bash
cd /opt/sakura/comics-scraper
# one line, must end with url={{url}} — {{url}} is filled in per request
cat > proxy-template.txt <<'TXT'
https://api.zenrows.com/v1/?apikey=YOURKEY&js_render=true&antibot=true&url={{url}}
TXT
pm2 reload ecosystem.config.cjs
curl -s http://127.0.0.1:3100/healthz    # -> "fetchProxy": true
```

`ecosystem.config.cjs` reads `proxy-template.txt` into
`COMICS_FETCH_PROXY_TEMPLATE`, and `deploy.sh` excludes the file from its
`rsync --delete`, so it survives redeploys. Templates for other providers:

```
ScraperAPI:  https://api.scraperapi.com/?api_key=KEY&render=true&url={{url}}
ScrapingBee: https://app.scrapingbee.com/api/v1/?api_key=KEY&render_js=true&url={{url}}
```

Only HTML fetches are proxied. Image bytes (`/img`, and the HEAD checks in
`/pages`) still go direct — the image CDNs aren't challenged, and rendered API
calls are metered.

## Adding a fallback source

Every free XOXO mirror checked in 2026-07 is dead (`xoxocomics.com` is a parked
ad page, `comicextra.me` redirects to a scam domain) or also Cloudflare-blocked
(`readcomiconline.li`, `readcomicsonline.ru`). If a genuinely scrapable source
turns up, swapping upstreams is a matter of adding a second parser module and
picking it via a query parameter or env var. The scraper normalises everything
into the app-facing envelope (`items[]`, `comic`, `issues`, `pages`), so keep
the response shape identical — the client just wants IDs and image URLs.
