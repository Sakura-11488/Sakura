# Sakura Web

Browser build of the Sakura app with **full parity** to the iOS and Android Expo clients.

The `web/` folder is a thin Expo Web shell. All screens, components, and business logic are shared from `sakura-mobile/` via symlinks — no duplicated app code.

## Features (same as mobile)

- Home, anime, manga, novels, search, library
- Wallet, trade, Sakura Pass, Sakura AI
- Creator dashboard, upload, verification, coin launch, feed
- Social: messages, DMs, follows, comments, profile avatars
- Offline downloads (limited on web — uses browser storage)

## Setup

```bash
cd web
cp .env.example .env
# Fill in EXPO_PUBLIC_SUPABASE_* and other keys (same as sakura-mobile)

npm install
npm run dev
```

Open **http://localhost:8081** (production bundle + SPA server — avoids Metro HMR crashes on Windows).

For live Metro reload during development:

```bash
npm run dev:metro
```

If Metro disconnects with an empty-path HMR error, use `npm run dev` instead.

## How it works

| Path | Purpose |
|------|---------|
| `app/`, `components/`, `lib/`, … | Symlinked to `../sakura-mobile/` |
| `shims/` | Web replacements for native-only modules |
| `metro.config.js` | Bundles mobile source + applies web shims |
| `index.js` | Solana/crypto polyfills + expo-router entry |

## Build for production

```bash
npm run build
```

Output goes to `dist/` for static hosting.

## Web vs native differences

| Native | Web |
|--------|-----|
| SecureStore + biometrics | Browser localStorage + confirm prompt |
| Push notifications | Disabled |
| iOS widgets / Live Activity | Disabled |
| Save photo to gallery | Browser download |
| Native HLS player (Android) | Built-in HTML video / HLS player |

Web playback resolves signed HLS streams through the `anime-stream` Edge
Function first, including captions and skip markers. See
[`anime-stream` setup and verification](../sakura-mobile/supabase/functions/anime-stream/README.md).
If server resolution fails or the provider only
returns an embed, viewers can retry, switch sub/dub, or explicitly open the
external player in a separate tab. Provider embeds never load inside the web
watch screen: the current provider rejects a sandbox that blocks ad popups.
External players may still show ads. The external tab has no opener access.

On portrait touch phones, the watch screen automatically turns the video and
controls into a landscape layout. It fits the visible viewport and safe areas,
returns upright when the viewport becomes landscape, and restores the normal
page on exit. Screen orientation locking is best effort; the rotated layout
also works when the browser does not support it. Resizing keeps playback mounted.

The web player has compact Sakura controls for seeking, captions, playback speed,
available HLS quality levels, fullscreen, and the next episode. Volume, mute,
speed, and caption visibility are remembered in this browser. Controls hide
during playback and remain available by touch, mouse, or keyboard (Space/K,
Left/Right, M, F). The series page shows the saved episode and measured time.

Direct web playback saves its exact clock every three seconds and immediately
on pause, seeking, hiding/leaving the page, or finishing. Reloads resume even
early in an episode; Start over resets the bookmark, and actual completion
queues the next episode. Existing native bookmarks keep their original behavior.
Bookmarks/preferences use local browser storage; clearing site data removes them.

Skip Opening/Ending uses valid provider timings first, with an optional public
AniSkip lookup matched to the current episode and measured stream duration.
Missing, invalid, or mismatched timings never block playback or guess a skip.

The server supplies required provider headers and rewrites media URLs for the
browser. Its signing secret stays on the server; the client uses the existing
Supabase URL. Without the function deployed, the external-player fallback stays
available.

## Browser playback regression

The opt-in browser check bundles the actual watch screen with React, while
replacing native adapters, source responses, and video playback with local
fixtures. It checks source fallback, recovery controls, absence of embedded
players, and explicit external tabs with no opener. It does not verify live
provider availability or actual media decoding. With web dependencies installed,
run from the repository root:

```bash
npm install --prefix /tmp/sakura-anime-player-tests esbuild playwright
SAKURA_BROWSER_TEST_NODE_MODULES=/tmp/sakura-anime-player-tests/node_modules \
  node --test web/test/anime-player.browser.mjs
SAKURA_BROWSER_TEST_NODE_MODULES=/tmp/sakura-anime-player-tests/node_modules \
  node --test web/test/anime-player-controls.browser.mjs
```

The check uses installed Google Chrome on macOS. Elsewhere, set
`SAKURA_BROWSER_EXECUTABLE` to a Chromium executable or install Playwright's
Chromium. Optional browser tooling is kept outside application dependencies.

## Notes

- Use the same Supabase project and edge functions as mobile.
- For wallet on desktop, embedded wallet works; Phantom/Solflare browser extensions can be added later.
- The legacy Next.js app in `src/` remains separate; this web client tracks `sakura-mobile` directly.
