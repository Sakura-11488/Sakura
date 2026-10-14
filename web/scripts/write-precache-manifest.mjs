/**
 * Writes this build's precache list into dist/sw.js.
 *
 * Why: the service worker used to precache nothing, so a user who downloaded
 * chapters on their first visit and reopened the app offline got a bare
 * "Offline" page on every route. The worker now caches one build's shell at
 * install, and this script tells it what that shell is.
 *
 * Why inline into sw.js rather than a separate JSON file: a browser only runs
 * a worker's install again when sw.js changes byte for byte. Stamping the list
 * (and the build id) into it makes every deploy a new worker, which is what
 * makes the new bundle get precached and the old one pruned.
 *
 * What goes in (every URL is content-hashed, so precaching cannot pin a stale
 * build — see RULE 2 in public/sw.js):
 *   - the scripts and stylesheets dist/index.html loads, and every lazy chunk
 *     it names (always, no size cap). The bundle is split per screen, and the
 *     reader, the player and Downloads only exist offline if their chunks are
 *     here; scripts/defer-common-chunk.mjs writes them into the document.
 *   - every font index.html preloads (the Nunito weights the app registers)
 *   - the icon fonts of the @expo/vector-icons families the source imports
 *   - other assets the bundle references, under a per-file size cap
 * What stays out, logged: unused Google Font weights and icon families (the
 * bundle references all of them, the app loads a handful), anything over the
 * caps, and anything past the total budget. Those are still cached on first
 * use by the worker's hashed-asset route; they just are not fetched up front.
 *
 * Runs last in `npm run build`, after defer-common-chunk.mjs (which lists the
 * lazy chunks) and inject-pwa-tags.mjs (which writes the font preloads and
 * version.json this reads). Idempotent: re-running replaces the previous list.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Matches the placeholder in public/sw.js, and a list a previous run stamped. */
const MARKER = /\/\* @sakura-precache \*\/ (?:null|\{[^\n]*\})(?=;)/g;

export const LIMITS = {
  /** Icon fonts top out around 1.3MB (MaterialCommunityIcons). */
  fontBytes: 2 * 1024 * 1024,
  /** Images, sounds and everything else. Keeps the hero banners and posters out. */
  assetBytes: 512 * 1024,
  /** All assets together, not counting the bundle and its chunks. */
  totalBytes: 12 * 1024 * 1024,
};

const FONT = /\.(?:ttf|otf|woff2?)$/i;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const ICON_FONT = /\/@expo\/vector-icons\/.*\/Fonts\/([A-Za-z0-9]+?)(?:_[A-Za-z]+)?\.[0-9a-f]{32}\.ttf$/;

/**
 * Hashed scripts and stylesheets the document loads, plus the lazy chunks it
 * names in non-fetching <link> tags. Same rule as shellEntries in public/sw.js.
 */
export function shellEntries(html) {
  return [...new Set([...html.matchAll(/(?:src|href)="(\/app\/_expo\/static\/[^"]+)"/g)].map((m) => m[1]))];
}

/** Fonts the document preloads: exactly the weights app/_layout.tsx registers. */
export function preloadedFonts(html) {
  return [...new Set(
    [...html.matchAll(/<link\b[^>]*\brel="preload"[^>]*>/g)]
      .map((m) => /\bhref="(\/app\/assets\/[^"]+)"/.exec(m[0])?.[1])
      .filter(Boolean),
  )];
}

/** Asset URLs a bundle or stylesheet mentions. Expo's web export inlines them whole. */
export function referencedAssets(text) {
  return new Set(
    [...text.matchAll(/\/app\/assets\/[^"'`\s\\()]+/g)]
      .map((m) => m[0])
      // Only paths that stay inside the export; a dot segment would resolve elsewhere.
      .filter((url) => !/\/\.\.?(?:\/|$)/.test(url)),
  );
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && SOURCE_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The @expo/vector-icons families the source imports, or null when that
 * cannot be told (no sources found, or a namespace/default import of the whole
 * package) — the caller then precaches every icon font, erring toward an app
 * that has its icons offline.
 */
export function usedIconFamilies(sourceRoots) {
  const files = sourceRoots
    .filter((root) => fs.existsSync(root))
    // web/app, web/components, ... are symlinks into sakura-mobile.
    .flatMap((root) => walk(fs.realpathSync(root), []));
  if (!files.length) return null;
  const families = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('@expo/vector-icons')) continue;
    if (/import\s+(?:\*\s+as\s+)?\w+\s+from\s*['"]@expo\/vector-icons['"]/.test(text) ||
      /require\(\s*['"]@expo\/vector-icons['"]\s*\)/.test(text)) {
      return null;
    }
    // Type-only imports load no font, so `import type { … }` and `type X` are skipped.
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@expo\/vector-icons['"]/g)) {
      for (const name of m[1].split(',')) {
        const spec = name.trim();
        if (!spec || /^type\s/.test(spec)) continue;
        families.add(spec.split(/\s+as\s+/)[0].trim());
      }
    }
    for (const m of text.matchAll(/['"]@expo\/vector-icons\/([A-Za-z0-9]+)['"]/g)) families.add(m[1]);
  }
  return families.size ? families : null;
}

const kb = (n) => `${Math.round(n / 1024)}KB`;

/**
 * Decide what to precache for the export in `distDir`.
 * Returns { build, urls, bytes, excluded: [{ url, bytes, why }] }.
 */
export function collectPrecache({
  distDir,
  sourceRoots = ['app', 'components', 'lib', 'constants', 'hooks'].map((d) => path.join(webRoot, d)),
  limits = LIMITS,
} = {}) {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const fileFor = (url) => path.join(distDir, decodeURI(url.replace(/^\/app\//, '')));
  const sizeOf = (url) => {
    try {
      const stat = fs.statSync(fileFor(url));
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  };

  const entries = shellEntries(html);
  if (!entries.length) throw new Error('dist/index.html loads no /app/_expo/static/ bundle');
  for (const url of entries) {
    if (sizeOf(url) === null) throw new Error(`dist/index.html loads ${url}, which is not in the export`);
  }

  let build = null;
  try {
    build = JSON.parse(fs.readFileSync(path.join(distDir, 'version.json'), 'utf8')).build || null;
  } catch {
    // inject-pwa-tags.mjs not run: fall back to the bundle's own hash.
  }
  // The entry <script>, not the first index-<hash>.js: lazy screens such as
  // novel/index emit chunks with that name too.
  build ||= /<script src="[^"]*\/index-([a-f0-9]{16,})\.js"/.exec(html)?.[1] || null;
  if (!build) throw new Error('could not determine the build id');

  const preloaded = new Set(preloadedFonts(html));
  const referenced = new Set(preloaded);
  for (const url of entries) {
    for (const asset of referencedAssets(fs.readFileSync(fileFor(url), 'utf8'))) referenced.add(asset);
  }

  const icons = usedIconFamilies(sourceRoots);
  if (!icons) console.warn('[write-precache-manifest] could not tell which icon families are used — precaching all of them.');

  const excluded = [];
  const candidates = [];
  for (const url of referenced) {
    const bytes = sizeOf(url);
    // Strings in the bundle that merely look like asset paths.
    if (bytes === null) continue;
    const font = FONT.test(url);
    const cap = font ? limits.fontBytes : limits.assetBytes;
    let why = null;
    // A preloaded font is the app's own text face: always in, whatever its size.
    if (!preloaded.has(url)) {
      if (url.includes('/@expo-google-fonts/') && preloaded.size) why = 'font weight not registered';
      else if (icons && ICON_FONT.test(url) && !icons.has(ICON_FONT.exec(url)[1])) why = 'icon family not imported';
      else if (bytes > cap) why = `over the ${kb(cap)} cap`;
    }
    if (why) excluded.push({ url, bytes, why });
    else candidates.push({ url, bytes, rank: preloaded.has(url) ? 0 : font ? 1 : 2 });
  }

  // Preloads first, then fonts, then assets smallest first, so if the budget
  // ever bites it drops the largest optional files rather than the text face.
  candidates.sort((a, b) => a.rank - b.rank || a.bytes - b.bytes || a.url.localeCompare(b.url));
  const urls = [...entries];
  let assetBytes = 0;
  for (const c of candidates) {
    if (assetBytes + c.bytes > limits.totalBytes) {
      excluded.push({ url: c.url, bytes: c.bytes, why: `over the ${kb(limits.totalBytes)} total budget` });
      continue;
    }
    assetBytes += c.bytes;
    urls.push(c.url);
  }
  const entryBytes = entries.reduce((sum, url) => sum + sizeOf(url), 0);
  excluded.sort((a, b) => a.url.localeCompare(b.url));
  return { build, urls, bytes: { entries: entryBytes, assets: assetBytes }, excluded };
}

/** Replace the precache placeholder (or a previous list) in a worker's source. */
export function stampServiceWorker(code, manifest) {
  const hits = code.match(MARKER) || [];
  if (hits.length !== 1) {
    throw new Error(`expected exactly one "/* @sakura-precache */" placeholder in sw.js, found ${hits.length}`);
  }
  const json = JSON.stringify({ build: manifest.build, urls: manifest.urls });
  return code.replace(MARKER, () => `/* @sakura-precache */ ${json}`);
}

function main() {
  const distDir = path.resolve(process.argv[2] || path.join(webRoot, 'dist'));
  const swPath = path.join(distDir, 'sw.js');
  if (!fs.existsSync(swPath) || !fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error('[write-precache-manifest] Missing', swPath, 'or index.html — run the export first.');
    process.exit(1);
  }
  let manifest;
  try {
    manifest = collectPrecache({ distDir });
    fs.writeFileSync(swPath, stampServiceWorker(fs.readFileSync(swPath, 'utf8'), manifest));
  } catch (error) {
    // Failing the build is deliberate: an unstamped sw.js is identical on every
    // deploy, so browsers would never install a new worker and the offline
    // shell would freeze on whatever build each user first saw.
    console.error('[write-precache-manifest]', error.message);
    process.exit(1);
  }
  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)}MB`;
  console.log(
    `[write-precache-manifest] build ${manifest.build}: precaching ${manifest.urls.length} files ` +
      `(${mb(manifest.bytes.entries)} bundle and chunks + ${mb(manifest.bytes.assets)} assets) into sw.js`,
  );
  if (manifest.excluded.length) {
    console.log(`[write-precache-manifest] left ${manifest.excluded.length} referenced assets to runtime caching:`);
    for (const e of manifest.excluded) console.log(`  - ${e.url} (${kb(e.bytes)}): ${e.why}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
