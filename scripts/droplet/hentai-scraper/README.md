# Sakura Hentai (18+) Scraper

Node.js + Express + Cheerio service that powers the **18+** tab in the Sakura
app. It runs on the DigitalOcean droplet (`165.232.83.159`) behind nginx at
`/hentai/v1/*` and scrapes **HentaiFox** on demand, caching everything in an
in-memory LRU for 15 minutes so repeat requests are instant.

It is a sibling of `../comics-scraper` — same endpoint contract and JSON
envelopes, so the mobile client reuses the manga detail/reader screens. The
only differences are the upstream (HentaiFox) and the gallery→manga mapping.

The app talks to this service via `EXPO_PUBLIC_HENTAI_PROXY`
(defaults to `http://165.232.83.159/hentai/v1`).

## Gallery → manga mapping

HentaiFox galleries are single works with no chapters, so:

- `/details` returns the `comic{}` envelope (artists+groups as authors, tags as
  genres, `status: "Completed"`, plus `pageCount`).
- `/chapters` returns exactly **one synthetic issue** `{ id: "gallery",
  title: "Read Gallery", number: "1" }` — no upstream fetch.
- `/pages?id=<gid>&chapterId=gallery` ignores `chapterId` and returns every page
  image URL, derived from the embedded `g_th` map (per-page extension code) plus
  the CDN base dir scraped from the gallery's page thumbnails.

## Endpoints

All responses are JSON and CORS-open.

| Method | Path                                  | Notes                                            |
| ------ | ------------------------------------- | ------------------------------------------------ |
| GET    | `/healthz`                            | `{ ok, upstream, cacheSize }`                    |
| GET    | `/popular?limit=24`                   | Latest galleries (HentaiFox has no popular page) |
| GET    | `/search?q=love&limit=&offset=`       | Keyword search (HentaiFox `/search/?q=`)         |
| GET    | `/details?id=<galleryId>`             | Cover, title, authors, tags, pageCount           |
| GET    | `/chapters?id=<galleryId>`            | Always one synthetic `gallery` issue             |
| GET    | `/pages?id=<galleryId>&chapterId=gallery` | Image URLs for the whole gallery             |
| GET    | `/img?u=<encoded image url>`          | Streams image bytes with a Referer header        |

`<galleryId>` is the numeric id from the URLs the service emits — do not
hand-construct it.

## One-time deploy

SSH into the droplet, copy this directory into any path (eg
`/root/sakura-hentai-scraper`), and run:

```bash
cd sakura-hentai-scraper
bash deploy.sh
```

The script installs Node 20 + PM2 if needed, copies the app to
`/opt/sakura/hentai-scraper`, runs `npm install`, starts/reloads the PM2 process
`sakura-hentai-scraper` on port 3101, patches the existing `psyopanime` nginx
site with a `/hentai/v1/` proxy block (idempotent — checks for the
`# >>> sakura hentai scraper >>>` marker), reloads nginx, and hits `/healthz`.

After that:

```bash
curl http://165.232.83.159/hentai/v1/healthz
```

should return `{"ok":true,...}`.

## Updating

Re-run `bash deploy.sh` from the same directory. `rsync` overwrites the app,
`npm install` syncs deps, and `pm2 reload` zero-downtime-restarts the process.

## Operations

- **Logs**: `pm2 logs sakura-hentai-scraper`
- **Restart**: `pm2 restart sakura-hentai-scraper`
- **Change upstream**: edit `ecosystem.config.cjs` (`HENTAI_UPSTREAM_BASE`) then
  `pm2 reload sakura-hentai-scraper`.

## Swapping the upstream

If HentaiFox breaks or blocks the droplet, the parser normalises into the
app-facing envelope (`items[]`, `comic`, `issues`, `pages`), so swapping is a
matter of adding a second parser module keyed on `HENTAI_UPSTREAM_BASE` (or a
`HENTAI_UPSTREAM_KIND` selector) and keeping the response shape identical — the
client just wants gallery IDs and image URLs. Candidate fallbacks: nhentai
(JSON API `/api/gallery/{id}`, but Cloudflare often 403s datacenter IPs) or
other gallery clones.
