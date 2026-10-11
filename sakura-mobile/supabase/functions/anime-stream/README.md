# Anime streaming for the web player

`anime-stream` resolves an episode on the server and relays its HLS playlists,
segments, and captions to Sakura's built-in player. The browser never loads the
provider's player page, ad scripts, or raw CDN URLs.

The function is independent of the older Consumet server. Native playback and
Sakura Originals keep their existing sources.

## Request flow

The web client calls `POST /functions/v1/anime-stream` with JSON:

```json
{ "malId": "21", "episode": 1, "category": "sub", "force": false }
```

The resolver reads the provider's public episode/source endpoints. Where the
provider wraps its source URL, it parses the two public encoding constants as
JSON string literals and decodes the response using Web Crypto. It never runs
downloaded JavaScript or loads advertising assets.

The response contains a signed HLS URL, signed subtitle URLs, and available skip
markers. Media `GET` and `HEAD` requests authenticate with two-hour HMAC
capabilities. Rewritten playlist links retain the original expiry; fetching a
child playlist cannot extend a session. URLs are resolved afresh on retry and
are not persisted in the app's content cache.

## Configuration and rollout

Set `ANIME_STREAM_SIGNING_SECRET` to a dedicated, securely generated secret of
at least 32 characters (for example, 32 random bytes encoded as 64 hex
characters). Keep it in a private environment file containing only this secret.
Do not reuse a Supabase JWT or service-role key. The server reads `SUPABASE_URL`
from the platform; no new public web environment variable is needed.

From `sakura-mobile`, deploy only this function:

```sh
supabase secrets set --env-file /secure/path/anime-stream.env --project-ref YOUR_PROJECT_REF
supabase functions deploy anime-stream --project-ref YOUR_PROJECT_REF --use-api
```

`supabase/config.toml` sets `verify_jwt = false` for this function because browser
video/track requests do not carry an Authorization header. Media requests still
require a valid signed capability. The public POST endpoint accepts only
numeric episode identifiers and sub/dub selection, never a caller-supplied URL
or upstream headers. No database migration is required.

After deploying the function, rebuild `web` with `npm run build` and publish its
Expo export using the existing website release process. A missing deployment,
configuration error, timeout, or unsupported provider response leaves the
explicit external-player option available. No external player opens automatically.

## Limits and maintenance

- Only verified provider host families and episode paths are accepted. Redirects
  and playlist children are checked again; arbitrary internet URLs are rejected.
- Provider file extensions and MIME types are unreliable. Clear media is checked
  for supported video/audio signatures and served with a safe media type.
- Segments stream with backpressure instead of being buffered as whole files.
  Genuine range responses are preserved. A provider that ignores Range keeps its
  original `200` response; the relay does not invent byte-range support.
- Resolver requests have an 18-second deadline; individual relay requests have
  a 35-second deadline. The function has bounded text reads, concurrency limits,
  and per-worker request limits. These are not an account-wide bandwidth budget.
  Video traffic consumes Edge Function invocations and bandwidth.
- Provider hosts and source formats can change. Unknown hosts or unsupported
  playlist features fail closed and need a verified adapter update. Rotating the
  signing secret invalidates outstanding playback links; Retry obtains new ones.
- This removes the external player's advertising code. Ads already encoded in
  video frames cannot be removed by a stream relay.

## Verification

From the repository root, with `web` dependencies installed:

```sh
node --test sakura-mobile/test/anime-stream-*.test.mjs sakura-mobile/test/web-video-player.test.mjs
npx deno check sakura-mobile/supabase/functions/anime-stream/index.ts
```

The opt-in browser check uses the real resolver, relay, Supabase client, HLS
engine, and video component through a temporary local server. It uses a fresh
temporary signing secret and does not deploy anything. It briefly plays a live
episode and checks decoded frames, resume, seeking, subtitles, and absence of
external browser requests. Optional tools stay outside application dependencies:

```sh
npm install --prefix /tmp/sakura-anime-player-tests esbuild playwright
SAKURA_ANIME_LIVE=1 SAKURA_BROWSER_TEST_NODE_MODULES=/tmp/sakura-anime-player-tests/node_modules \
  node --test web/test/anime-stream.browser.mjs
```
