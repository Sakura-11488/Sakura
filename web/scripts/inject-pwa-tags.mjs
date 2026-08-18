/**
 * Injects the PWA / iOS "add to home screen" head tags into the exported
 * dist/index.html.
 *
 * Why a post-export step: the web build uses `output: 'single'` (SPA), and Expo
 * generates index.html from its own built-in template — `app/+html.tsx` is only
 * consulted for static rendering, so it can't carry these tags. Runs as part of
 * `npm run build` and is idempotent.
 *
 * Paths are absolute under /app because experiments.baseUrl is '/app'.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(root, 'dist', 'index.html');

if (!fs.existsSync(indexPath)) {
  console.error('[inject-pwa-tags] Missing', indexPath, '— run the export first.');
  process.exit(1);
}

/**
 * The four Nunito weights the app actually uses, resolved to their
 * content-hashed export paths so they can be preloaded.
 *
 * constants/theme.ts routes essentially all text through these four families,
 * and app/_layout.tsx does not gate rendering on them — the tree paints in the
 * browser default first. Worse, expo-font injects each @font-face by appending
 * to a single live <style>, which re-parses the whole sheet: every face that
 * had already resolved briefly reverts to fallback metrics. Measured on the
 * live build, a text run went 292.80px -> 266.33px and back on one injection.
 * With four faces landing at four different times, every text node in the app
 * re-measures several times during load.
 *
 * Preloading starts all four in parallel at document parse instead of after the
 * 8.5MB bundle has evaluated, which collapses those waves into roughly one.
 */
const USED_WEIGHTS = ['400Regular', '600SemiBold', '700Bold', '800ExtraBold'];

function preloadLinks() {
  const base = path.join(root, 'dist', 'assets', '_sakura-mobile', 'node_modules', '@expo-google-fonts', 'nunito');
  if (!fs.existsSync(base)) {
    console.warn('[inject-pwa-tags] Nunito assets not found — skipping font preload.');
    return '';
  }
  const links = [];
  for (const weight of USED_WEIGHTS) {
    const dir = path.join(base, weight);
    if (!fs.existsSync(dir)) {
      console.warn('[inject-pwa-tags] missing weight', weight, '— skipping.');
      continue;
    }
    // Content-hashed filename, so it must be discovered rather than hardcoded.
    const ttf = fs.readdirSync(dir).find((f) => f.endsWith('.ttf'));
    if (!ttf) continue;
    links.push(
      '    <link rel="preload" as="font" type="font/ttf" crossorigin="anonymous" ' +
        'href="/app/assets/_sakura-mobile/node_modules/@expo-google-fonts/nunito/' +
        weight + '/' + ttf + '" />',
    );
  }
  console.log('[inject-pwa-tags] preloading ' + links.length + ' font file(s)');
  return links.join(String.fromCharCode(10));
}

const TAGS = `
    <link rel="manifest" href="/app/manifest.json" />
    <meta name="theme-color" content="#0F0F13" />
    <meta name="application-name" content="Sakura" />
    <meta name="description" content="Watch anime and read manga, comics and novels — with offline downloads and rewards." />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black" />
    <meta name="apple-mobile-web-app-title" content="Sakura" />
    <link rel="apple-touch-icon" href="/app/icons/apple-touch-icon-180.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/app/icons/apple-touch-icon-180.png" />
    <link rel="icon" type="image/png" sizes="192x192" href="/app/icons/icon-192.png" />
${preloadLinks()}
    <style>
      /*
       * Mobile browsers zoom the page in when a text field with a computed
       * font-size under 16px is focused, and do not zoom back out on blur.
       * Page scale is a layout change, and react-native-web's Dimensions
       * reports Math.round(visualViewport.width * scale) — a width that no
       * longer matches the layout width — which 25 components then convert
       * straight into explicit pixel widths and heights. So one tap on a
       * search box can leave the whole app laid out to the wrong width.
       *
       * The app's default body size is 14 (constants/theme.ts FontSize.md), so
       * this fires on real screens. The guard lives here rather than in
       * app/+html.tsx because that file is dead under web.output: 'single'.
       *
       * Deliberately NOT paired with user-scalable=no: taking pinch-zoom away
       * from people who need it is not an acceptable way to fix our own bug.
       */
      input, textarea, select { font-size: 16px; }
    </style>
    <script>
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
          navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(function () {});
        });
      }
    </script>
  `;

let html = fs.readFileSync(indexPath, 'utf8');

// ── Build stamp for the in-app "new version" prompt ────────────────────────
// Expo fingerprints the JS bundle filename on every export, so that hash IS the
// build id. Stamp it into the page and publish it at /app/version.json; the web
// app polls that file and offers a hard refresh when it no longer matches the
// build the tab is running.
const bundle = (html.match(/index-([a-f0-9]{16,})\.js/) || [])[1] || String(Date.now());
fs.writeFileSync(
  path.join(root, 'dist', 'version.json'),
  JSON.stringify({ build: bundle, builtAt: new Date().toISOString() }) + '\n',
);
const BUILD_STAMP = `\n    <script>window.__SAKURA_BUILD__=${JSON.stringify(bundle)};</script>`;

if (html.includes('rel="manifest"')) {
  console.log('[inject-pwa-tags] Already present — nothing to do.');
  process.exit(0);
}

if (!html.includes('</head>')) {
  console.error('[inject-pwa-tags] No </head> found in index.html — aborting.');
  process.exit(1);
}

html = html.replace('</head>', `${TAGS}${BUILD_STAMP}\n  </head>`);
fs.writeFileSync(indexPath, html);
console.log('[inject-pwa-tags] Injected PWA + iOS head tags into dist/index.html');
