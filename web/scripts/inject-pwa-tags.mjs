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
    <script>
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
          navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(function () {});
        });
      }
    </script>
  `;

let html = fs.readFileSync(indexPath, 'utf8');

if (html.includes('rel="manifest"')) {
  console.log('[inject-pwa-tags] Already present — nothing to do.');
  process.exit(0);
}

if (!html.includes('</head>')) {
  console.error('[inject-pwa-tags] No </head> found in index.html — aborting.');
  process.exit(1);
}

html = html.replace('</head>', `${TAGS}</head>`);
fs.writeFileSync(indexPath, html);
console.log('[inject-pwa-tags] Injected PWA + iOS head tags into dist/index.html');
