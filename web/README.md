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
| Native HLS player (Android) | iframe embed player |

## Notes

- Use the same Supabase project and edge functions as mobile.
- For wallet on desktop, embedded wallet works; Phantom/Solflare browser extensions can be added later.
- The legacy Next.js app in `src/` remains separate; this web client tracks `sakura-mobile` directly.
