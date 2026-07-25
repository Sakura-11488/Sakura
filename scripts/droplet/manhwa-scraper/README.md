# Sakura Manhwa scraper (`/manhwa/v1`)

Node service on the droplet, behind nginx on port **3102**, PM2 name
`sakura-manhwa-scraper`. Same endpoint contract and JSON envelopes as the
comics and hentai scrapers, so the mobile client reuses the manga detail and
reader screens unchanged.

It exists because four titles the app needs are unavailable from the existing
sources — MangaDex carries 0 chapters of Baek XX, and xoxocomic doesn't have
them at all.

## Two upstreams, one service

Neither source covers the catalogue alone:

| | mangaread.org | comizy.io |
|---|---|---|
| Chapter list | Complete, one AJAX call | Only a ~50-chapter SSR window |
| Images | Self-hosted, no Referer needed | `x1..x10.cmzcdn.org`, **Referer required** |
| God of Blackfield | 328 (`god-of-blackfield-manhwa`) | ✅ |
| Baek XX | 182 (`baek-xx`) | ✅ |
| The Executioner | 68 (`executioner`) | 50, truncated |
| The Red Shirt | ❌ absent | 67 (`red-shirt`) |

**They are not a failover pair.** Which upstream serves a series is decided once,
at search time, and baked into the id:

```
mr:<slug>   ->  mangaread.org     e.g.  mr:god-of-blackfield-manhwa
cz:<slug>   ->  comizy.io         e.g.  cz:red-shirt
```

The prefix matters because the client persists these ids — offline manifests,
reading progress, history. A bare slug could resolve to a different site later
if coverage changed, and the stored chapter ids would then match nothing,
producing an empty reader with no error. So `/details`, `/chapters` and `/pages`
dispatch strictly on the prefix and never fall back across upstreams. Only
`/search` touches both, merging rather than failing over.

## Things that will bite you

Every one of these was hit while building the service, and each fails silently
rather than erroring.

- **`MANHWA_MANGAREAD_BASE` must be the `www` host.** The apex 301s to `www`
  *and drops the `/ajax/chapters/` suffix* along the way, so with
  `redirect: follow` a chapter-list request lands on the series page. That page
  still contains chapter links, so it looks like it worked.
- **Trim image `src`.** mangaread emits `src="\t\t\n\t\t\thttps://…"`. Cheerio
  does not trim, and an untrimmed URL yields a zero-page chapter.
- **Never reconstruct page filenames.** God of Blackfield chapter 1 starts at
  `3.jpeg`. Use DOM order only.
- **Never construct series slugs — always resolve through search.** It is
  `god-of-blackfield-manhwa`, not `god-of-blackfield`; `executioner`, not
  `the-executioner`. comizy also hosts duplicate uploads: `/red-shirt` has 67
  chapters and `/the-red-shirt` has 61, and only search points at the better
  one.
- **Never trust comizy's `chaptersCount`.** It is an internal ordinal
  high-water mark. Red Shirt reports 74 while the newest real chapter is 67 and
  `chapter-68` upward are 404. The per-entry `number` disagrees too — slug
  `chapter-67` carries `number: 74`.
- **Synthesise comizy chapters from 1, not from the lowest slug seen.** The SSR
  window slides; chapter 1 is sometimes rendered and sometimes not. Anchoring on
  the lowest observed slug silently started Red Shirt at chapter 24.
- **`/img` picks its Referer by image host, not by adapter.** `cmzcdn.org` hard
  403s without `Referer: https://comizy.io/`; mangaread doesn't care. This is
  the difference between a page and a blank.
- **Title precedence, not title length.** Each search card links the series
  twice — the thumbnail anchor carries only an SEO alt ("Read Manhwa Baek XX")
  while the caption anchor carries the real title ("Baek XX"). Preferring the
  longer string picks the boilerplate.

## Endpoints

Paths below are post-nginx-strip; publicly they are `/manhwa/v1/<route>`.

| Route | Params | Response |
|---|---|---|
| `GET /healthz` | — | `{ ok, upstream: { mangaread, comizy }, cacheSize }` |
| `GET /popular` | `limit` (1–60, def 24) | `{ items: ListItem[] }` |
| `GET /search` | `q`, `limit`, `offset` | `{ items: ListItem[] }` — merged, relevance-ordered |
| `GET /details` | `id` (prefixed) | `{ comic: Detail }` |
| `GET /chapters` | `id`, `limit` (≤2000), `offset` | `{ issues: Issue[] }`, reading order |
| `GET /pages` | `id`, `chapterId` | `{ pages, droppedCount, totalDiscovered, fallbackToRaw }` |
| `GET /img` | `u` (encoded absolute URL) | raw image bytes |
| `GET /debug/probe` | `adapter` (`mr`/`cz`), `path` | operator only |

An unprefixed `id` is a 400, never a guess.

## Deploy

```bash
scp -r scripts/droplet/manhwa-scraper root@165.232.83.159:/root/
ssh root@165.232.83.159 'cd /root/manhwa-scraper && bash deploy.sh'
curl http://165.232.83.159/manhwa/v1/healthz
```

`deploy.sh` splices `nginx-snippet.conf` in before the **last** top-level `}` —
the server block's closing brace. Not the first: each sibling scraper's snippet
contributes its own column-0 `}`, and anchoring on the first one nests the new
location inside a sibling, which nginx rejects with
`location "/manhwa/v1/" is outside location "/hentai/v1/"`.

`max_memory_restart` is 160M rather than the siblings' 256M — the droplet has
961MB total and roughly 340MB free with comics and hentai already running.
`MANHWA_CACHE_MAX` is 400 rather than 1000 because a mangaread chapter-list
response is 60–110KB.

## Smoke test

```bash
B=http://165.232.83.159/manhwa/v1
curl -s "$B/healthz"
curl -s --get "$B/search"   --data-urlencode 'q=red shirt'
curl -s --get "$B/chapters" --data-urlencode 'id=mr:god-of-blackfield-manhwa'   # 328
curl -s --get "$B/chapters" --data-urlencode 'id=cz:red-shirt'                  # 67
curl -s --get "$B/pages"    --data-urlencode 'id=cz:red-shirt' --data-urlencode 'chapterId=chapter-5'
```

`cz:red-shirt` chapter 5 is the highest-value single check: it exercises comizy
routing, a synthesised slug absent from the SSR window, and the Referer path all
at once. Fetch one of its returned image URLs directly (expect 403) and then
through `/img` (expect 200) to confirm the proxy is doing its job.
