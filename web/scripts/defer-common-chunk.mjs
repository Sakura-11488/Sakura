/**
 * Post-export step for the split web bundle: decides how dist/index.html
 * refers to the JS chunks Expo emitted beside the main one.
 *
 * 1. Defers Expo's __common chunk.
 *    The web build loads most screens as lazy chunks (router-context.js).
 *    Expo moves every module that two or more of those chunks share into
 *    __common-<hash>.js and loads it from index.html, eagerly, next to the
 *    main bundle. The main bundle never needs it (by construction everything
 *    it uses is inside it), yet it is ~0.7-1MB that the first screen had to
 *    download and parse first, which undid much of the split. Here the
 *    <script> becomes a non-fetching <link data-sakura-common>, plus a small
 *    inline loader that fetches __common alongside the first lazy chunk
 *    (whichever screen or import() comes first) and otherwise once the page
 *    is idle. The two download in parallel, but a chunk only runs once
 *    __common has: see loaderScript for why the order matters.
 *
 *    One more edit makes that hold for every import(). Expo writes no chunk
 *    URL for an import() whose target module itself sits in __common (a
 *    route that another route also imports, say), because it assumes
 *    __common is already loaded; with it deferred, such an import found
 *    nothing to load and threw "Requiring unknown module". Those dependency
 *    maps get an entry pointing at COMMON_SENTINEL, which the loader resolves
 *    to the __common file the document names. A placeholder rather than the
 *    hashed URL, so a chunk cached from another build can never pull in that
 *    build's __common: it always gets the one matching the running bundle.
 *
 * 2. Lists every other emitted chunk in the document, as non-fetching
 *    <link rel="sakura-chunk"> tags.
 *    The service worker treats the scripts and links a document names as that
 *    build's shell: it precaches them, adopts a new document only once all of
 *    them are cached, and never prunes them while that document is the
 *    offline shell (public/sw.js shellEntries). The reader, the player and
 *    Downloads now live in lazy chunks; if the document did not name them,
 *    an offline shell could boot and then fail to open the very screens that
 *    offline mode exists for.
 *    Except ONLINE_ONLY chunks: code that is useless without the network.
 *    The Phoenix perps SDK (~2.2MB, the trade screen and the PnL pill) can
 *    only talk to an exchange, so precaching it would cost every visitor
 *    2MB of mobile data for nothing offline. Left unnamed, it loads on first
 *    use and the worker's hashed-asset route caches it then.
 *
 * Fails the build rather than ship a document that cannot load a chunk:
 * every chunk path any bundle mentions must exist in the export.
 *
 * Runs after `expo export` and normalize-export-assets.mjs, before
 * inject-pwa-tags.mjs and write-precache-manifest.mjs (both read the result).
 * Idempotent.
 *
 *   node scripts/defer-common-chunk.mjs [distDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CHUNK_DIR = '_expo/static/js/web';
const CHUNK_URL_PREFIX = `/app/${CHUNK_DIR}/`;
const BEGIN = '<!-- sakura:chunks -->';
const END = '<!-- /sakura:chunks -->';
const COMMON_TAG = /<script src="(\/app\/_expo\/static\/js\/web\/__common-[0-9a-f]+\.js)" defer><\/script>/;
const COMMON_LINK = /<link rel="sakura-common" data-sakura-common href="(\/app\/_expo\/static\/js\/web\/__common-[0-9a-f]+\.js)">/;
/**
 * Chunks kept out of the offline shell (see 2. above), by the module name Expo
 * gives the chunk file. A rename only means the chunk is precached again.
 */
export const ONLINE_ONLY = /\/phoenix-[0-9a-f]+\.js$/;
/** A chunk URL as Expo writes it into bundles (async-import path maps) and HTML. */
const CHUNK_REF = /\/app\/_expo\/static\/js\/web\/[^"'`\s\\]+?\.js(?=["'`])/g;
/** Stands for "this document's __common" in dependency maps; see the header. Never a real file. */
export const COMMON_SENTINEL = '/app/_expo/static/js/web/__common.js';
/** The end of a Metro module definition: `},<id>,<dependency map>)`. */
const MODULE_END = /\},(\d+),(?:\[[0-9,]*\]|\{(?:"\d+":\d+,)*"paths":\{[^{}]*\}\})\)/g;
/** A dependency map that has async imports: `},<id>,{"0":12,...,"paths":{...}})`. */
const ASYNC_DEPENDENCY_MAP = /\},(\d+),\{((?:"\d+":\d+,)*)"paths":\{([^{}]*)\}\}\)/g;

/**
 * Inline loader. Runs at parse time, before any bundle: Expo assigns
 * globalThis[<prefix>__loadBundleAsync] while the main bundle evaluates, and
 * Metro reads that global each time an import() needs a chunk. The setter
 * below wraps whatever Expo assigns, so every chunk load — routes, and any
 * other import() — also has __common in flight or done.
 *
 * A chunk's <script> is only added once __common has run; until then the
 * chunk is fetched with a preload hint, so the two still download in
 * parallel. Running the chunk first is not safe, even though a chunk only
 * defines modules: on web, Expo's import() first tries the module
 * synchronously and only loads a chunk if that throws. A second import() of a
 * module whose chunk has run (the idle route prefetch in router-context.js,
 * then a tap on that screen) would run its factory with its __common
 * dependencies missing, and Metro caches a module's failure: the screen kept
 * "Requiring unknown module" for the rest of the session even after __common
 * arrived.
 */
export function loaderScript(globalKey) {
  return `<script data-sakura-common-loader>
(function () {
  var link = document.querySelector('link[data-sakura-common]');
  if (!link) return;
  var url = link.getAttribute('href');
  var load = null, wrapped = null, common = null, commonRan = false, hinted = {};
  function loadCommon() {
    if (!common) {
      common = load(url).then(function () { commonRan = true; }, function (e) { common = null; throw e; });
    }
    return common;
  }
  function preload(path) {
    if (hinted[path]) return;
    hinted[path] = true;
    try {
      var hint = document.createElement('link');
      hint.rel = 'preload';
      hint.as = 'script';
      hint.href = path;
      document.head.appendChild(hint);
    } catch (e) {
      // Only a lost head start: the <script> fetches the chunk anyway.
    }
  }
  Object.defineProperty(window, ${JSON.stringify(globalKey)}, {
    configurable: true,
    get: function () { return wrapped; },
    set: function (fn) {
      load = fn;
      wrapped = typeof fn !== 'function' ? fn : function (path) {
        if (path === ${JSON.stringify(COMMON_SENTINEL)}) return loadCommon();
        if (commonRan) return fn(path);
        preload(path);
        return loadCommon().then(function () { return fn(path); });
      };
    }
  });
  window.addEventListener('load', function () {
    var idle = window.requestIdleCallback || function (cb) { return setTimeout(cb, 1500); };
    idle(function () { if (load) loadCommon().catch(function () {}); }, { timeout: 5000 });
  });
})();
</script>`;
}

/** URLs of the scripts and links a document names under the chunk directory. */
export function documentChunks(html) {
  return [...new Set([...html.matchAll(/(?:src|href)="(\/app\/_expo\/static\/js\/web\/[^"]+\.js)"/g)].map((m) => m[1]))];
}

/** Every chunk URL a bundle's source mentions (dynamic-import path maps). */
export function referencedChunks(code) {
  return [...new Set(code.match(CHUNK_REF) || [])];
}

/**
 * The global Metro's async import reads, e.g. '__loadBundleAsync', or null
 * when the bundles do not look the way the loader expects (then __common is
 * left eager, which is slower but always correct).
 */
export function loadBundleGlobal(sources) {
  const all = sources.join('\n');
  if (!/__loadBundleAsync/.test(all)) return null;
  const prefix = /__METRO_GLOBAL_PREFIX__=(['"])([^'"]*)\1/.exec(all);
  if (!prefix) return null;
  return `${prefix[2]}__loadBundleAsync`;
}

/**
 * Pure transform of index.html. `chunks` is every chunk URL in the export,
 * `globalKey` the loader global (null: keep __common eager).
 * Returns { html, common, lazy }.
 */
export function rewriteDocument(html, { chunks, globalKey }) {
  // Undo a previous run, so running twice gives the same document.
  let out = html.replace(new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}`, 'g'), '');
  const deferred = COMMON_LINK.exec(out);
  if (deferred) {
    out = out.replace(deferred[0], `<script src="${deferred[1]}" defer></script>`);
    out = out.replace(/<script data-sakura-common-loader>[\s\S]*?<\/script>/g, '');
  }

  let common = null;
  const tag = COMMON_TAG.exec(out);
  if (tag && globalKey) {
    common = tag[1];
    out = out.replace(tag[0], `<link rel="sakura-common" data-sakura-common href="${common}">${loaderScript(globalKey)}`);
  }

  const named = new Set(documentChunks(out));
  const lazy = chunks.filter((url) => !named.has(url) && !ONLINE_ONLY.test(url)).sort();
  if (lazy.length) {
    const links = lazy.map((url) => `<link rel="sakura-chunk" href="${url}">`).join('\n');
    if (!out.includes('</body>')) throw new Error('index.html has no </body>');
    out = out.replace('</body>', `${BEGIN}\n${links}\n${END}\n</body>`);
  }
  return { html: out, common, lazy };
}

/** IDs of the modules a chunk defines. */
export function moduleIds(code) {
  return new Set([...code.matchAll(MODULE_END)].map((m) => Number(m[1])));
}

/**
 * Give every async-import dependency map an entry for each dependency that
 * lives in __common and has none, pointing at COMMON_SENTINEL. Entries for
 * plain (synchronous) dependencies are harmless: Metro only reads `paths`
 * for import() calls. Returns { code, added }.
 */
export function routeImportsThroughCommon(code, commonIds) {
  let added = 0;
  const out = code.replace(ASYNC_DEPENDENCY_MAP, (whole, id, deps, paths) => {
    const known = paths ? JSON.parse(`{${paths}}`) : {};
    const extra = [];
    for (const m of deps.matchAll(/"\d+":(\d+)/g)) {
      const dep = Number(m[1]);
      if (commonIds.has(dep) && !(String(dep) in known) && !extra.includes(dep)) extra.push(dep);
    }
    if (!extra.length) return whole;
    added += extra.length;
    const more = extra.map((dep) => `"${dep}":${JSON.stringify(COMMON_SENTINEL)}`).join(',');
    return `},${id},{${deps}"paths":{${paths}${paths ? ',' : ''}${more}}})`;
  });
  return { code: out, added };
}

/** Throws unless every chunk any bundle or the document mentions is in the export. */
export function assertChunksExist({ html, sources, chunks }) {
  const present = new Set([...chunks, COMMON_SENTINEL]);
  const missing = new Set();
  for (const url of documentChunks(html)) if (!present.has(url)) missing.add(url);
  for (const code of sources) for (const url of referencedChunks(code)) if (!present.has(url)) missing.add(url);
  if (missing.size) throw new Error(`chunks referenced but not exported: ${[...missing].join(', ')}`);
}

function main() {
  const distDir = path.resolve(process.argv[2] || path.join(webRoot, 'dist'));
  const indexPath = path.join(distDir, 'index.html');
  const chunkDir = path.join(distDir, CHUNK_DIR);
  if (!fs.existsSync(indexPath) || !fs.existsSync(chunkDir)) {
    console.error('[defer-common-chunk] Missing', indexPath, 'or', chunkDir, '— run the export first.');
    process.exit(1);
  }
  const files = fs.readdirSync(chunkDir).filter((name) => name.endsWith('.js')).sort();
  const chunks = files.map((name) => CHUNK_URL_PREFIX + name);
  const sources = files.map((name) => fs.readFileSync(path.join(chunkDir, name), 'utf8'));
  const html = fs.readFileSync(indexPath, 'utf8');
  try {
    assertChunksExist({ html, sources, chunks });
    const globalKey = loadBundleGlobal(sources);
    if (!globalKey) {
      console.warn('[defer-common-chunk] Could not find Metro\'s chunk loader in the bundles; leaving __common eager.');
    }
    const result = rewriteDocument(html, { chunks, globalKey });
    let added = 0;
    if (result.common) {
      const commonIndex = chunks.indexOf(result.common);
      if (commonIndex < 0) throw new Error(`index.html names ${result.common}, which is not in the export`);
      const commonIds = moduleIds(sources[commonIndex]);
      files.forEach((name, i) => {
        if (i === commonIndex) return;
        const patched = routeImportsThroughCommon(sources[i], commonIds);
        if (!patched.added) return;
        added += patched.added;
        fs.writeFileSync(path.join(chunkDir, name), patched.code);
      });
    }
    fs.writeFileSync(indexPath, result.html);
    console.log(
      `[defer-common-chunk] ${result.common ? `deferred ${path.basename(result.common)} ` +
        `(${added} import targets routed through it)` : 'no __common chunk deferred'}; ` +
        `listed ${result.lazy.length} lazy chunks for the service worker`,
    );
  } catch (error) {
    console.error('[defer-common-chunk]', error.message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
