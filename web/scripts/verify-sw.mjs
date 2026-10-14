/**
 * Tests the service-worker behaviour that can destroy user data or brick the
 * app, by loading the REAL worker under mocked globals.
 *
 *   1. nothing may ever delete the offline library (activate, prune, install)
 *   2. /app/__offline/** must be answered from the library — nested HLS files
 *      included, with their stored type and Range support — and a miss must be
 *      an honest 404 rather than a network request that 200s with HTML
 *   3. install precaches the shell, best effort, and replaces the cached
 *      document only together with its bundle
 *   4. navigations fall back to that shell offline, on a 5xx, and on a network
 *      that is too slow
 *   5. activate prunes stale bundles but never the one the cached shell loads
 *
 *   node scripts/verify-sw.mjs          tests public/sw.js (stamped in memory)
 *   node scripts/verify-sw.mjs --dist   tests the built dist/sw.js, and checks
 *                                       its stamped list against the export
 *                                       (--dist=<dir> for an export elsewhere)
 *
 * It used to read a hard-coded 'C:/Users/1/Documents/...' path, so it could not
 * run anywhere but the one machine that wrote it.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { stampServiceWorker } from './write-precache-manifest.mjs';
import { ONLINE_ONLY } from './defer-common-chunk.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distArg = process.argv.find((a) => a === '--dist' || a.startsWith('--dist='));
const useDist = !!distArg;
const distDir = distArg?.includes('=') ? path.resolve(distArg.slice('--dist='.length)) : path.join(webRoot, 'dist');
const SRC = useDist ? path.join(distDir, 'sw.js') : path.join(webRoot, 'public', 'sw.js');
const code = fs.readFileSync(SRC, 'utf8');
console.log(`Testing ${SRC}\n`);

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) fail++;
};

const ORIGIN = 'https://sakuraonseeker.com';
const abs = (u) => new URL(typeof u === 'string' ? u : u.url, ORIGIN).href;
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The worker's own timers run 100x faster, so NAV_TIMEOUT_MS (4s) takes 40ms.
const TIME_SCALE = 0.01;

const MARKER = /\/\* @sakura-precache \*\/ (?:null|\{[^\n]*\})(?=;)/;
const unstamped = code.replace(MARKER, '/* @sakura-precache */ null');

// ── Fetch API stand-ins ─────────────────────────────────────────────────────
// Minimal Blob: the worker slices cached bodies to serve Range requests, so the
// mock supports the same two operations the real one does.
class FakeBlob {
  constructor(text, type) { this.text = text; this.type = type || ''; }
  get size() { return this.text.length; }
  slice(start, end, type) { return new FakeBlob(this.text.slice(start, end), type); }
}

class FakeHeaders {
  constructor(init = {}) {
    this.map = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), String(v)]));
  }
  // Header lookup is case-insensitive in the real thing.
  get(k) { return this.map.get(String(k).toLowerCase()) ?? null; }
}

class FakeResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? '';
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = init.headers instanceof FakeHeaders ? init.headers : new FakeHeaders(init.headers || {});
  }
  async text() {
    if (this.body instanceof FakeBlob) return this.body.text;
    return this.body == null ? '' : String(this.body);
  }
  async blob() { this.bodyUsed = true; return new FakeBlob(await this.text(), this.headers.get('content-type') || ''); }
  clone() {
    return new FakeResponse(this.body, { status: this.status, statusText: this.statusText, headers: this.headers });
  }
}

const res = (body, type, status = 200) => new FakeResponse(body, { status, headers: type ? { 'Content-Type': type } : {} });
const offline = () => { throw new TypeError('Failed to fetch'); };

// ── Fixtures ────────────────────────────────────────────────────────────────
const OLD_BUNDLE = '/app/_expo/static/js/web/index-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.js';
const NEW_BUNDLE = '/app/_expo/static/js/web/index-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.js';
const FONT = '/app/assets/vendor/@expo-google-fonts/nunito/400Regular/Nunito_400Regular.f04f0e9ff969fd52a75deade3a9761cd.ttf';
const ICONS = '/app/assets/vendor/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.b4eb097d35f44ed943676fd56f6bdc51.ttf';
const TAP = '/app/assets/_sakura-mobile/assets/sounds/tap.15b0efd7b20ecc3b05183915349b9fb5.mp3';
const FLAKY = '/app/assets/vendor/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Octicons.871378c6eab492a3e689a9385dc45a12.ttf';
const BROKEN = '/app/assets/_sakura-mobile/assets/images/logo.499f460218847ca80d1dc1dc2e5e42b8.png';
const REWRITTEN = '/app/assets/generated/card-images/2he.23eec8ad96b32100867fd38ee75e87f4.webp';
const MANIFEST = { build: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', urls: [NEW_BUNDLE, FONT, ICONS, TAP, FLAKY, BROKEN, REWRITTEN] };

const doc = (bundle) =>
  `<!DOCTYPE html><html><head><link rel="preload" as="font" href="${FONT}" /></head>` +
  `<body><div id="root"></div><script src="${bundle}" defer></script></body></html>`;
const OLD_DOC = doc(OLD_BUNDLE);
const NEW_DOC = doc(NEW_BUNDLE);

/** The deployment, for the precache: the new document and its assets. */
function deployment(overrides = {}) {
  const routes = {
    [abs('/app/')]: () => res(NEW_DOC, 'text/html; charset=utf-8'),
    [abs(NEW_BUNDLE)]: () => res('/* new bundle */', 'application/javascript'),
    [abs(FONT)]: () => res('FONT', 'font/ttf'),
    [abs(ICONS)]: () => res('ICONS', 'font/ttf'),
    [abs(TAP)]: () => res('0123456789', 'audio/mpeg'),
    [abs(FLAKY)]: offline,
    [abs(BROKEN)]: () => res('nope', 'text/plain', 500),
    // A rewrite answering an asset with the document must never be cached.
    [abs(REWRITTEN)]: () => res(NEW_DOC, 'text/html'),
    ...overrides,
  };
  return (url) => (routes[url] ? routes[url]() : res('not found', 'text/plain', 404));
}

const LIBRARY = {
  '/app/__offline/manhwa/s1/c1/0000': () => res('JPEGBYTES', 'image/jpeg'),
  '/app/__offline/atsu/m1/c1/0001': () => res('AVIFBYTES', 'image/avif'),
  '/app/__offline/title/manhwa/s1.json': () => res('{"title":"S1"}', 'application/json'),
  '/app/__offline/cover/atsu/m1': () => res('COVERBYTES', 'image/webp'),
  '/app/__offline/anime/show/ep1': () => res('0123456789', 'video/mp4'),
  '/app/__offline/anime/show%201/ep%3A2/index.m3u8': () => res('#EXTM3U\nseg-00001.ts\n', 'application/vnd.apple.mpegurl'),
  '/app/__offline/anime/show%201/ep%3A2/seg-00001.ts': () => res('GABCDEFGHIJ', 'video/mp2t'),
};

// ── A worker in a sandbox ───────────────────────────────────────────────────
function createWorld({ stamped = true, manifest = MANIFEST, network = offline, shell = {}, extraCaches = {} } = {}) {
  const store = new Map(); // cacheName -> Map(url -> response)
  const deleted = [];
  const fetches = [];
  const fill = (entries) => new Map(Object.entries(entries).map(([u, make]) => [abs(u), make()]));
  store.set('sakura-shell-v1', new Map());
  store.set('sakura-shell-v2', fill(shell));
  store.set('sakura-offline-v1', fill(LIBRARY));
  // Something we did not create, which must be left alone.
  store.set('some-other-app-cache', new Map());
  for (const [name, entries] of Object.entries(extraCaches)) store.set(name, fill(entries));

  // The real Cache API resolves relative URLs against the origin before using
  // them as keys — put('/app/x') stores 'https://origin/app/x', and match() by
  // either form hits. The mock does the same, or it fails the worker for a
  // difference that does not exist.
  const open = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      async match(req) { return m.get(abs(req))?.clone(); },
      async put(req, response) {
        if (response.status === 206) throw new TypeError('Partial response');
        m.set(abs(req), response);
      },
      async keys() { return [...m.keys()].map((url) => ({ url })); },
      async delete(req) { return m.delete(abs(req)); },
    };
  };
  const caches = {
    async keys() { return [...store.keys()]; },
    async delete(k) { deleted.push(k); return store.delete(k); },
    async open(name) { return open(name); },
    async match(url) {
      for (const m of store.values()) if (m.has(abs(url))) return m.get(abs(url));
      return undefined;
    },
  };

  const handlers = {};
  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      skipWaiting: () => {},
      clients: { claim: async () => {} },
    },
    caches,
    fetch: async (input) => {
      const url = abs(input);
      fetches.push(url);
      return network(url);
    },
    Response: FakeResponse,
    AbortController,
    URL,
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms * TIME_SCALE),
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(stamped ? stampServiceWorker(code, manifest) : unstamped, sandbox, { filename: 'sw.js' });

  const has = (cacheName, url) => !!store.get(cacheName)?.has(abs(url));
  const get = (cacheName, url) => store.get(cacheName)?.get(abs(url));

  async function extendable(type, data) {
    const waits = [];
    handlers[type]({ data, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  }

  async function request(url, { mode = 'no-cors', headers = {} } = {}) {
    let responded = null;
    const waits = [];
    const event = {
      // A real Request always has headers; the worker reads Range off it.
      request: { url: abs(url), method: 'GET', mode, headers: new FakeHeaders(headers) },
      respondWith: (p) => { responded = p; },
      waitUntil: (p) => { waits.push(p); },
    };
    handlers.fetch(event);
    const response = responded ? await responded : null;
    return { res: response, settled: () => Promise.all(waits) };
  }

  const libraryIntact = () =>
    !deleted.includes('sakura-offline-v1') &&
    Object.keys(LIBRARY).every((u) => has('sakura-offline-v1', u));

  return { store, deleted, fetches, has, get, extendable, request, libraryIntact };
}

// ── RULE 1: activate sweeps old shells and nothing else ─────────────────────
{
  const w = createWorld({ shell: { '/app/': () => res(OLD_DOC, 'text/html') } });
  await w.extendable('activate');
  check('the offline library survives activate', w.libraryIntact(), 'deleted: ' + JSON.stringify(w.deleted));
  check('a stale shell cache IS swept', !w.store.has('sakura-shell-v1'));
  check('the current shell cache is kept', w.store.has('sakura-shell-v2'));
  check('an unrecognised cache is left alone', w.store.has('some-other-app-cache'),
    'deleting caches we did not create is how user data disappears');
  check('no sakura-offline-* cache is ever swept', !w.deleted.some((k) => k.startsWith('sakura-offline-')));
}

// ── RULE 2: the offline library is cache-only ───────────────────────────────
{
  const w = createWorld();
  const hit = await w.request('/app/__offline/manhwa/s1/c1/0000');
  check('a downloaded page is served from the library',
    hit.res?.status === 200 && (await hit.res.text()) === 'JPEGBYTES');
  check('serving a downloaded page makes no network request', w.fetches.length === 0,
    'a cache-only route must not fall through');

  const miss = await w.request('/app/__offline/manhwa/nope/nope/9999');
  check('a missing page is an honest 404', miss.res?.status === 404,
    'a network fallback here would 200 with the SPA shell and render as a broken image');
  check('a missing page makes no network request', w.fetches.length === 0);

  for (const [url, type] of [
    ['/app/__offline/atsu/m1/c1/0001', 'image/avif'],
    ['/app/__offline/title/manhwa/s1.json', 'application/json'],
    ['/app/__offline/cover/atsu/m1', 'image/webp'],
    ['/app/__offline/anime/show%201/ep%3A2/index.m3u8', 'application/vnd.apple.mpegurl'],
    ['/app/__offline/anime/show%201/ep%3A2/seg-00001.ts', 'video/mp2t'],
  ]) {
    const r = await w.request(url, { mode: url.endsWith('.m3u8') || url.endsWith('.ts') ? 'cors' : 'no-cors' });
    check(`nested ${url.replace('/app/__offline/', '')} served with its stored type`,
      r.res?.status === 200 && r.res.headers.get('Content-Type') === type, r.res && `${r.res.status} ${r.res.headers.get('Content-Type')}`);
  }

  const seg = await w.request('/app/__offline/anime/show%201/ep%3A2/seg-00001.ts', { headers: { Range: 'bytes=1-4' } });
  check('a ranged HLS segment gets 206 with its stored type',
    seg.res?.status === 206 && seg.res.headers.get('Content-Type') === 'video/mp2t' &&
      seg.res.headers.get('Content-Range') === 'bytes 1-4/11' && (await seg.res.text()) === 'ABCD',
    seg.res && `${seg.res.status} ${seg.res.headers.get('Content-Range')}`);

  const segMiss = await w.request('/app/__offline/anime/show%201/ep%3A2/seg-99999.ts', { mode: 'cors' });
  check('a missing segment is a 404, not the SPA shell', segMiss.res?.status === 404);
  check('nested library routes make no network request', w.fetches.length === 0);

  const nav = await w.request('/app/__offline/cover/atsu/m1', { mode: 'navigate' });
  check('opening a download directly in a tab is still served from the library',
    nav.res?.status === 200 && (await nav.res.text()) === 'COVERBYTES');

  const other = await w.request('https://sakuraonseeker.com/api/media-proxy/?path=%2Fx', { mode: 'cors' });
  check('unrelated requests are not intercepted', other.res === null,
    'the handler must fall through for everything else');
}

{
  const w = createWorld({ shell: { '/app/': () => res(OLD_DOC, 'text/html') } });
  for (const url of ['/app/version.json', '/app/sw.js', '/app/manifest.json', '/app/assets/logo.png', '/app/icons/icon-192.png']) {
    const r = await w.request(url, { mode: 'navigate' });
    check(`static navigation ${url} never falls back to HTML`, r.res === null);
  }
  const unversioned = await w.request('/app/assets/settings.json');
  check('unhashed asset paths are never served cache-first', unversioned.res === null);
}

// ── Range, for downloaded video ─────────────────────────────────────────────
// A <video> seeks by asking for byte ranges. Returning the stored 200 verbatim
// let it play from the start but never seek.
{
  const w = createWorld();
  const VID = '/app/__offline/anime/show/ep1';
  const noRange = await w.request(VID);
  check('no Range header still returns the whole 200', noRange.res?.status === 200,
    'images take this path and must be untouched');

  const partial = await w.request(VID, { headers: { Range: 'bytes=2-5' } });
  check('a Range request gets 206', partial.res?.status === 206, 'got ' + partial.res?.status);
  check('206 carries a correct Content-Range', partial.res?.headers.get('Content-Range') === 'bytes 2-5/10',
    partial.res?.headers.get('Content-Range'));
  check('206 preserves the stored Content-Type', partial.res?.headers.get('Content-Type') === 'video/mp4');

  const suffix = await w.request(VID, { headers: { Range: 'bytes=-3' } });
  check('suffix ranges resolve from the end', suffix.res?.headers.get('Content-Range') === 'bytes 7-9/10',
    suffix.res?.headers.get('Content-Range'));

  const past = await w.request(VID, { headers: { Range: 'bytes=99-200' } });
  check('a range past the end is 416, not a lie', past.res?.status === 416,
    'a 206 with no bytes would look like a corrupt file to the player');

  const openEnded = await w.request(VID, { headers: { Range: 'bytes=8-' } });
  check('an open-ended range runs to the last byte', openEnded.res?.headers.get('Content-Range') === 'bytes 8-9/10',
    openEnded.res?.headers.get('Content-Range'));
  for (const range of ['bytes=0-1,4-5', 'not-a-range']) {
    const ignored = await w.request(VID, { headers: { Range: range } });
    check(`unsupported Range ${range} returns an unused full body`,
      ignored.res?.status === 200 && !ignored.res.bodyUsed && (await ignored.res.text()) === '0123456789');
  }
}

// ── Install: precache, best effort, atomic shell ────────────────────────────
{
  const w = createWorld({
    network: deployment(),
    shell: {
      '/app/': () => res(OLD_DOC, 'text/html'),
      [OLD_BUNDLE]: () => res('/* old bundle */', 'application/javascript'),
      // Already cached by an earlier build: a hashed hit must not be refetched.
      [ICONS]: () => res('ICONS', 'font/ttf'),
    },
  });
  let threw = null;
  try {
    await w.extendable('install');
  } catch (error) {
    threw = error;
  }
  check('install resolves even though some assets failed', threw === null, threw && String(threw));
  check('install precaches the new bundle', w.has('sakura-shell-v2', NEW_BUNDLE));
  check('install precaches fonts and sounds', w.has('sakura-shell-v2', FONT) && w.has('sakura-shell-v2', TAP));
  check('a failed asset is skipped, not cached',
    !w.has('sakura-shell-v2', FLAKY) && !w.has('sakura-shell-v2', BROKEN));
  check('an HTML response is never cached under a hashed asset URL', !w.has('sakura-shell-v2', REWRITTEN));
  check('an already-cached hashed asset is not downloaded again', !w.fetches.includes(abs(ICONS)));
  check('install replaces the shell document once its bundle is cached',
    (await w.get('sakura-shell-v2', '/app/')?.text()) === NEW_DOC);
  check('install never touches the offline library', w.libraryIntact());

  await w.extendable('activate');
  check('activate prunes the previous build\'s bundle', !w.has('sakura-shell-v2', OLD_BUNDLE));
  check('activate keeps the current bundle', w.has('sakura-shell-v2', NEW_BUNDLE));
  check('activate leaves hashed assets alone', w.has('sakura-shell-v2', FONT) && w.has('sakura-shell-v2', ICONS));
  check('activate after a precache never touches the offline library', w.libraryIntact(),
    'deleted: ' + JSON.stringify(w.deleted));
}

{
  // The new bundle cannot be fetched: the old, complete pair must survive both
  // install and the prune, or the offline app boots to a blank page.
  const w = createWorld({
    network: deployment({ [abs(NEW_BUNDLE)]: offline }),
    shell: {
      '/app/': () => res(OLD_DOC, 'text/html'),
      [OLD_BUNDLE]: () => res('/* old bundle */', 'application/javascript'),
    },
  });
  await w.extendable('install');
  check('a shell whose bundle failed is not adopted', (await w.get('sakura-shell-v2', '/app/')?.text()) === OLD_DOC);
  await w.extendable('activate');
  check('the bundle the cached shell loads is never pruned', w.has('sakura-shell-v2', OLD_BUNDLE),
    'it is not on the new list, but the offline document still needs it');
}

{
  // A deploy landed after this worker was fetched: the document loads a bundle
  // the stamped list has never heard of. It is cached anyway.
  const NEWER = '/app/_expo/static/js/web/index-cccccccccccccccccccccccccccccccc.js';
  const w = createWorld({
    network: deployment({
      [abs('/app/')]: () => res(doc(NEWER), 'text/html'),
      [abs(NEWER)]: () => res('/* newer */', 'application/javascript'),
    }),
  });
  await w.extendable('install');
  check('the fetched document\'s own bundle is precached too', w.has('sakura-shell-v2', NEWER));
  check('…and that document becomes the shell', (await w.get('sakura-shell-v2', '/app/')?.text()) === doc(NEWER));
}

{
  const w = createWorld({ network: offline });
  await w.extendable('install');
  check('install with no network still resolves and caches nothing', !w.has('sakura-shell-v2', '/app/'));
}

{
  const w = createWorld({ network: deployment({ [abs(FLAKY)]: () => new Promise(() => {}) }) });
  const started = Date.now();
  await w.extendable('install');
  check('a stalled optional asset cannot leave installation pending forever', Date.now() - started < 1500);
  check('the usable shell survives a stalled optional asset',
    (await w.get('sakura-shell-v2', '/app/')?.text()) === NEW_DOC);
}

{
  const w = createWorld({
    stamped: false,
    network: deployment(),
    shell: { [OLD_BUNDLE]: () => res('/* old bundle */', 'application/javascript') },
  });
  await w.extendable('install');
  check('an unstamped worker (public/sw.js as-is) precaches nothing', w.fetches.length === 0);
  await w.extendable('activate');
  check('an unstamped worker prunes nothing', w.has('sakura-shell-v2', OLD_BUNDLE));
}

{
  const w = createWorld({ network: deployment() });
  await w.extendable('message', { type: 'sakura:warm-shell' });
  check('a warm-shell message runs the precache', w.has('sakura-shell-v2', NEW_BUNDLE) &&
    (await w.get('sakura-shell-v2', '/app/')?.text()) === NEW_DOC);
  const before = w.fetches.length;
  await w.extendable('message', { type: 'something-else' });
  check('other messages are ignored', w.fetches.length === before);
}

// ── Lazy chunks ─────────────────────────────────────────────────────────────
// The bundle is split per screen. The document names its lazy chunks (the
// reader, the player, Downloads...) in non-fetching <link> tags, and a shell is
// only complete, adopted and kept with all of them.
const READER = '/app/_expo/static/js/web/[id]-dddddddddddddddddddddddddddddddd.js';
const COMMON = '/app/_expo/static/js/web/__common-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.js';
const OLD_READER = '/app/_expo/static/js/web/[id]-ffffffffffffffffffffffffffffffff.js';
const splitDoc = (bundle, reader) =>
  `<!DOCTYPE html><html><head><link rel="preload" as="font" href="${FONT}" /></head>` +
  `<body><div id="root"></div><link rel="sakura-common" data-sakura-common href="${COMMON}">` +
  `<script src="${bundle}" defer></script>\n<link rel="sakura-chunk" href="${reader}">\n</body></html>`;
const SPLIT_NEW = splitDoc(NEW_BUNDLE, READER);
const SPLIT_OLD = splitDoc(OLD_BUNDLE, OLD_READER);
const splitDeployment = (overrides = {}) => deployment({
  [abs('/app/')]: () => res(SPLIT_NEW, 'text/html; charset=utf-8'),
  [abs(READER)]: () => res('/* reader */', 'application/javascript'),
  [abs(COMMON)]: () => res('/* common */', 'application/javascript'),
  ...overrides,
});
const SPLIT_MANIFEST = { ...MANIFEST, urls: [NEW_BUNDLE, COMMON, READER, ...MANIFEST.urls.slice(1)] };

{
  const w = createWorld({ manifest: SPLIT_MANIFEST, network: splitDeployment() });
  await w.extendable('install');
  check('install precaches the lazy chunks the document names',
    w.has('sakura-shell-v2', READER) && w.has('sakura-shell-v2', COMMON));
  check('…and then adopts the document', (await w.get('sakura-shell-v2', '/app/')?.text()) === SPLIT_NEW);
}

{
  // The reader chunk cannot be fetched: booting offline would work, opening a
  // downloaded chapter would not. Keep the previous, complete shell instead.
  const w = createWorld({
    manifest: SPLIT_MANIFEST,
    network: splitDeployment({ [abs(READER)]: offline }),
    shell: {
      '/app/': () => res(SPLIT_OLD, 'text/html'),
      [OLD_BUNDLE]: () => res('/* old bundle */', 'application/javascript'),
      [OLD_READER]: () => res('/* old reader */', 'application/javascript'),
      [COMMON]: () => res('/* common */', 'application/javascript'),
    },
  });
  await w.extendable('install');
  check('a shell missing one of its lazy chunks is not adopted', (await w.get('sakura-shell-v2', '/app/')?.text()) === SPLIT_OLD);
  await w.extendable('activate');
  check('activate keeps the lazy chunks the cached shell names', w.has('sakura-shell-v2', OLD_READER),
    'pruning them would leave an offline shell that cannot open the reader');
  check('activate keeps the cached shell\'s entry bundle too', w.has('sakura-shell-v2', OLD_BUNDLE));
}

{
  const w = createWorld({
    manifest: SPLIT_MANIFEST,
    network: splitDeployment(),
    shell: { [OLD_READER]: () => res('/* old reader */', 'application/javascript') },
  });
  await w.extendable('install');
  await w.extendable('activate');
  check('a previous build\'s lazy chunk is pruned once a complete new shell is in',
    !w.has('sakura-shell-v2', OLD_READER) && w.has('sakura-shell-v2', READER));
}

{
  // Install runs during the first page load. What the page itself loads is
  // precached at once (shared downloads); the lazy chunks wait until the page
  // says it has loaded, or LAZY_PRECACHE_DELAY_MS (10s, 100ms here) passes.
  const w = createWorld({ manifest: SPLIT_MANIFEST, network: splitDeployment() });
  const install = w.extendable('install');
  await realSleep(40);
  check('install fetches the boot bundle straight away', w.fetches.includes(abs(NEW_BUNDLE)));
  check('…but holds the lazy chunks and optional assets back while the page loads',
    !w.fetches.includes(abs(READER)) && !w.fetches.includes(abs(COMMON)) && !w.fetches.includes(abs(TAP)));
  await w.extendable('message', { type: 'sakura:warm-shell' });
  check('a page saying it has loaded releases them at once',
    w.fetches.includes(abs(READER)) && w.has('sakura-shell-v2', READER));
  await install;
  check('…and the shell is adopted', (await w.get('sakura-shell-v2', '/app/')?.text()) === SPLIT_NEW);
}

{
  const w = createWorld({ manifest: SPLIT_MANIFEST, network: splitDeployment() });
  const started = Date.now();
  await w.extendable('install');
  const elapsed = Date.now() - started;
  check('without a word from the page, the lazy chunks follow after the delay',
    w.has('sakura-shell-v2', READER) && elapsed >= 90 && elapsed < 1500, `${elapsed}ms`);
}

{
  // A page that already said it loaded before install reached the gate.
  const w = createWorld({ manifest: SPLIT_MANIFEST, network: splitDeployment() });
  const install = w.extendable('install');
  await w.extendable('message', { type: 'sakura:warm-shell' });
  const started = Date.now();
  await install;
  check('an early "loaded" message is not lost', Date.now() - started < 80 && w.has('sakura-shell-v2', READER));
}

// ── Navigations ─────────────────────────────────────────────────────────────
const cachedShell = () => ({
  '/app/': () => res(OLD_DOC, 'text/html'),
  [OLD_BUNDLE]: () => res('/* old bundle */', 'application/javascript'),
});

{
  const w = createWorld({ network: offline, shell: cachedShell() });
  const r = await w.request('/app/manga/some-title', { mode: 'navigate' });
  check('offline navigation to a deep route falls back to the shell',
    r.res?.status === 200 && (await r.res.text()) === OLD_DOC);
}

{
  const w = createWorld({ network: offline });
  const r = await w.request('/app/manga/some-title', { mode: 'navigate' });
  check('offline with no shell is an honest 503', r.res?.status === 503);
}

{
  const w = createWorld({ network: () => res('Bad gateway', 'text/html', 502), shell: cachedShell() });
  const r = await w.request('/app/downloads', { mode: 'navigate' });
  check('a 5xx navigation falls back to the shell', (await r.res?.text()) === OLD_DOC);
}

{
  // The network answers eventually, but far past the timeout.
  const late = () => realSleep(500).then(() => res(NEW_DOC, 'text/html'));
  const w = createWorld({
    network: late,
    shell: { ...cachedShell(), [NEW_BUNDLE]: () => res('/* new bundle */', 'application/javascript') },
  });
  const started = Date.now();
  const r = await w.request('/app/manga/some-title', { mode: 'navigate' });
  const elapsed = Date.now() - started;
  check('a slow navigation is answered from the shell after the timeout',
    (await r.res?.text()) === OLD_DOC && elapsed < 400, `${elapsed}ms`);
  await r.settled();
  check('…and the late response still refreshes the shell',
    (await w.get('sakura-shell-v2', '/app/')?.text()) === NEW_DOC);
}

{
  const late = () => realSleep(200).then(() => res(NEW_DOC, 'text/html'));
  const w = createWorld({ network: late });
  const r = await w.request('/app/', { mode: 'navigate' });
  check('a slow first visit (no shell yet) waits for the network instead of failing',
    r.res?.status === 200 && (await r.res.text()) === NEW_DOC);
}

{
  // Every SPA route is rewritten to the document; the bundle is a real file.
  const w = createWorld({
    network: deployment({ [abs('/app/manga/x')]: () => res(NEW_DOC, 'text/html') }),
    shell: cachedShell(),
  });
  const r = await w.request('/app/manga/x', { mode: 'navigate' });
  check('online navigation is network-first', (await r.res?.text()) === NEW_DOC);
  // The page now loads the new bundle through the worker, which caches it…
  const bundle = await w.request(NEW_BUNDLE);
  check('the hashed bundle is fetched and returned on a miss', (await bundle.res?.text()) === '/* new bundle */');
  await r.settled();
  check('…and only then is the new document adopted as the shell',
    (await w.get('sakura-shell-v2', '/app/')?.text()) === NEW_DOC);
}

{
  const w = createWorld({ network: () => res(NEW_DOC, 'text/html'), shell: cachedShell() });
  const r = await w.request('/app/manga/x', { mode: 'navigate' });
  await r.settled(); // its bundle never arrives
  check('a document whose bundle never arrives is not adopted',
    (await w.get('sakura-shell-v2', '/app/')?.text()) === OLD_DOC);
}

{
  const w = createWorld({ network: () => res('{"build":"x"}', 'application/json'), shell: cachedShell() });
  const r = await w.request('/app/version.json', { mode: 'navigate' });
  await r.settled();
  check('a non-HTML navigation is never adopted as the shell',
    (await w.get('sakura-shell-v2', '/app/')?.text()) === OLD_DOC);
}

// ── Hashed assets ───────────────────────────────────────────────────────────
{
  const w = createWorld({
    network: deployment(),
    shell: { [TAP]: () => res('0123456789', 'audio/mpeg') },
  });
  const hit = await w.request(TAP);
  check('a cached hashed asset is served without the network', (await hit.res?.text()) === '0123456789' && w.fetches.length === 0);
  const ranged = await w.request(TAP, { headers: { Range: 'bytes=0-' } });
  check('a ranged request for a cached sound gets 206', ranged.res?.status === 206 &&
    ranged.res.headers.get('Content-Range') === 'bytes 0-9/10');
  const rewritten = await w.request(REWRITTEN);
  await realSleep(5);
  check('an HTML answer for a hashed URL is passed through but not cached',
    rewritten.res?.status === 200 && !w.has('sakura-shell-v2', REWRITTEN));
  check('hashed-asset routing never touches the offline library', w.libraryIntact());
}

// ── The built artifact ──────────────────────────────────────────────────────
if (useDist) {
  const dist = distDir;
  const m = /\/\* @sakura-precache \*\/ (null|\{[^\n]*\})(?=;)/.exec(code);
  const list = m && m[1] !== 'null' ? JSON.parse(m[1]) : null;
  check('dist/sw.js carries a stamped precache list', !!list,
    list ? `${list.urls.length} URLs` : 'run scripts/write-precache-manifest.mjs');
  if (list) {
    let version = null;
    try { version = JSON.parse(fs.readFileSync(path.join(dist, 'version.json'), 'utf8')).build; } catch {}
    check('the stamped build matches dist/version.json', list.build === version, `${list.build} vs ${version}`);
    const missing = list.urls.filter((u) => !fs.existsSync(path.join(dist, decodeURI(u.replace(/^\/app\//, '')))));
    check('every precached URL exists in the export', missing.length === 0, missing.join(', '));
    const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    const entries = [...html.matchAll(/(?:src|href)="(\/app\/_expo\/static\/[^"]+)"/g)].map((x) => x[1]);
    check('the list includes every bundle index.html loads', entries.length > 0 && entries.every((u) => list.urls.includes(u)));
    const chunkDir = path.join(dist, '_expo/static/js/web');
    const unlisted = fs.readdirSync(chunkDir).filter((f) => f.endsWith('.js'))
      .map((f) => `/app/_expo/static/js/web/${f}`).filter((u) => !entries.includes(u));
    // Online-only chunks (the trading SDK) are left out on purpose and cached on first use.
    const onlineOnly = unlisted.filter((u) => ONLINE_ONLY.test(u));
    const missingChunks = unlisted.filter((u) => !ONLINE_ONLY.test(u));
    check('index.html names every JS chunk in the export but the online-only ones (so the worker keeps them offline)',
      missingChunks.length === 0, missingChunks.join(', '));
    check('online-only chunks stay out of the precache list', onlineOnly.every((u) => !list.urls.includes(u)),
      onlineOnly.join(', '));
    check('index.html registers the worker at parse time, not on load',
      html.includes("navigator.serviceWorker.register('/app/sw.js'") && !/addEventListener\('load'[^)]*\)\s*{\s*navigator\.serviceWorker/.test(html));
  }
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
