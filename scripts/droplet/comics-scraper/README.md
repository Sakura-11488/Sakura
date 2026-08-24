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
| GET    | `/healthz`                             | `{ ok, upstream, defaultSource, cacheSize }`        |
| GET    | `/popular?limit=24&source=`            | Hot comics list                                     |
| GET    | `/search?q=spider-man&limit=&offset=&source=` | Keyword search                               |
| GET    | `/details?id=<id>`                     | Comic cover, description, authors, genres, status   |
| GET    | `/chapters?id=<id>&limit=&offset=`     | Issue list (newest first, matches upstream order)   |
| GET    | `/pages?id=<id>&chapterId=<issue>`     | Image URLs for a single issue                       |

Every `<id>` comes from a previous response — do not hand-construct them.

## Two sources

| Source | `source=` | Id shape      | State                                            |
| ------ | --------- | ------------- | ------------------------------------------------ |
| Comic Book Plus | `cbp` (default) | `cbp-1325` | Working. Public-domain catalogue     |
| XOXO Comics     | `xoxo`          | `invincible` | Browses, but its reader is dead    |

Ids are namespaced, so `/details`, `/chapters` and `/pages` route by id alone
and ignore `source=` — an id a client stored before the switch keeps resolving
to the source that issued it. `source=` only decides where a sourceless
`/popular` or `/search` goes, and `COMICS_DEFAULT_SOURCE` sets that default.

**Why the default moved (2026-08-24).** xoxocomic answers every page image
(`/comic/<slug>/<issue>/<id>/N.jpg`) with HTTP 200 and its own homepage — 106 KB,
magic `3c21444f`. Confirmed from the droplet, from an unrelated IP and through
ZenRows; a cache-buster forces `cf-cache-status: MISS` and still returns HTML,
so it is the origin's decision. Covers still work. It is an upstream content
regression, not a block, and **no proxy fixes it**. Browse still works there,
which is exactly the trap: defaulting to XOXO hands users a catalogue that
cannot be opened. Flip `COMICS_DEFAULT_SOURCE=xoxo` the day their images return
— the XOXO path is untouched and still tested.

Every free XOXO-family mirror was re-checked on 2026-08-24: `comicextra.me` and
`comicpunch.net` now serve keyword-ad parking pages (behind a JS redirect that
solves fine — there is just nothing behind it), `azcomix.me` is a "coming soon"
stub, `xoxocomics.com`/`readcomiconline.li` do not resolve, `readcomicsonline.ru`
is Cloudflare-challenged, `readallcomics.com` 521s. GetComics is alive but only
publishes pixeldrain archive links, which is a download-and-unpack pipeline, not
a scraper.

### Comic Book Plus notes

`comicbookplus.js` carries the full site model. Four things that look obvious
and are wrong, each of which cost a measurement:

- **`limit` is an OFFSET, not a page size.** `?cid=1325` is rows 0-99,
  `&limit=100` is 100-199, `&limit=200` is the last 95 of 295. Past the end is a
  404, so a 7-issue series 404s on `&limit=200`.
- **Page images live on either host** — `comicbookplus.com/viewer/...` for some
  issues, `box01.comicbookplus.com/viewer/...` for most. Rebuilding the URL
  against the main domain 404s six issues out of six. Read the base, never
  reconstruct it.
- **`meta[itemprop=thumbnailUrl]` omits the two-character fan-out directory**, so
  the microdata URL 404s site-wide. Insert `/<hash[0..2]>/` — and only box01
  serves thumbs.
- **Images 403 without a `Referer`.** Plain hotlink protection: one header, no
  cookie, no session.

Search is served from an index built by fetching two section pages
(`?cid=1507`, `?cid=6`) once every 12 hours — about 1,630 titles. The site's own
search is a Google CSE and needs a key, so this avoids both the key and any
crawling.

**robots.txt.** Comic Book Plus blocks a long list of AI and SEO crawlers by
name and gives everyone else `Crawl-delay: 5`. This service is in the `*` group
and none of the paths it uses (`/?cid=`, `/?dlid=`, `/viewer/`) is disallowed.
HTML fetches are serialised behind `COMICS_CBP_MIN_GAP_MS`. The disallow list
also names listing paths (`/master-listing.php`, `/catalog/*`, `/staging/*`,
`/housekeeping/*`) that appear nowhere in the site's own markup and read as
scraper traps — **nothing may ever fetch those.**

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

## Adding another source

`comicbookplus.js` is the worked example. A source is one module exporting pure
parsers plus a `create…()` returning `{ id, imageReferer, imageHosts, popular,
search, details, chapters, pages }`, wired into `server.js` in four places:
the `sourceForId`/`sourceForRequest` pair, `refererForImage`, `IMG_HOST_ALLOW`
and the five route branches.

Two rules that are not optional:

- **Namespace the ids.** Anything else makes a stored id ambiguous the moment a
  source is added or removed.
- **Do not bypass the `/pages` sampler.** It byte-checks two pages before
  answering, which is what turns a non-viewable issue into an honest error
  instead of a wall of broken images. Comic Book Plus needs it as much as XOXO
  did: some issues are catalogued but not online.

Keep the response envelope identical (`items[]`, `comic`, `issues`, `pages`) —
the client only wants ids and image URLs, and is otherwise source-agnostic, so a
new source ships without an app release.

## Tests

Both suites are plain `node`, no framework, and neither touches the network or
spends a proxy credit:

```bash
node cbp.spec.mjs      # Comic Book Plus parsers (46 assertions)
node ladder.spec.mjs   # direct-first fetch ladder (46 assertions)
```
