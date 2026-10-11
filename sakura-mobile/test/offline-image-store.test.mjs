import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../lib/offline-image-store.web.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Timers fire on the next macrotask, so backoff and deadlines cost nothing.
const fastSetTimeout = (fn, _ms) => setTimeout(fn, 0);

function load(globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, URL, AbortController, Response, Blob, Uint8Array, Promise,
    setTimeout: fastSetTimeout, clearTimeout, ...globals,
  });
  return module.exports;
}

/** A Cache Storage stand-in keyed by the URL string the stores pass. */
function fakeCache() {
  const entries = new Map();
  return {
    entries,
    puts: [],
    async match(key) {
      const hit = entries.get(String(key));
      return hit ? new Response(hit.blob, { headers: hit.headers }) : undefined;
    },
    async put(key, res) {
      this.puts.push(String(key));
      entries.set(String(key), { blob: await res.blob(), headers: Object.fromEntries(res.headers) });
    },
    async delete(key) {
      return entries.delete(typeof key === 'string' ? key : new URL(key.url).pathname);
    },
    async keys() {
      return [...entries.keys()].map((k) => ({ url: `https://sakuraonseeker.com${k}` }));
    },
  };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const image = (bytes = JPEG, type = 'image/jpeg') => new Response(bytes, { headers: { 'content-type': type } });
const html = (status = 200) => new Response('<!doctype html><title>Gone</title>', { status, headers: { 'content-type': 'text/html' } });

/** fetch stub: `routes(url, callNumberForThatUrl)` returns a Response, or 'hang'. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = (url, init = {}) => {
    calls.push(url);
    const n = calls.filter((u) => u === url).length;
    const out = routes(url, n);
    if (out === 'hang') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return Promise.resolve(out);
  };
  return { fetch, calls };
}

function job(engine, overrides) {
  const progress = [];
  return {
    progress,
    run: () => engine.downloadPagesToCache({
      keyFor: (i) => `/app/__offline/atsu/m/c/${String(i).padStart(4, '0')}`,
      candidatesFor: (u) => [u],
      shouldStop: () => null,
      onProgress: (done, bytes) => progress.push([done, bytes]),
      ...overrides,
    }),
  };
}

test('stores every page as an image with its real type and size, in page order keys', async () => {
  const { fetch } = fakeFetch(() => image(JPEG, 'image/avif'));
  const engine = load({ fetch });
  const cache = fakeCache();
  const { run, progress } = job(engine, { cache, urls: ['a', 'b', 'c', 'd'] });
  const result = await run();
  assert.deepEqual({ ...result }, { outcome: 'done', done: 4, bytes: 4 * JPEG.length });
  assert.equal(cache.entries.size, 4);
  const first = cache.entries.get('/app/__offline/atsu/m/c/0000');
  assert.equal(first.headers['content-type'], 'image/avif');
  assert.equal(first.headers['x-sakura-bytes'], String(JPEG.length));
  assert.deepEqual(progress.at(-1), [4, 4 * JPEG.length]);
});

test('resume skips pages already in the library, counting their stored bytes', async () => {
  const { fetch, calls } = fakeFetch(() => image());
  const engine = load({ fetch });
  const cache = fakeCache();
  await cache.put('/app/__offline/atsu/m/c/0000', engine.pageResponse(new Blob([new Uint8Array(500)]), 'image/jpeg'));
  await cache.put('/app/__offline/atsu/m/c/0002', engine.pageResponse(new Blob([new Uint8Array(700)]), 'image/jpeg'));
  cache.puts.length = 0;
  const { run } = job(engine, { cache, urls: ['p0', 'p1', 'p2', 'p3'] });
  const result = await run();
  assert.equal(result.outcome, 'done');
  assert.equal(result.done, 4);
  assert.equal(result.bytes, 500 + 700 + 2 * JPEG.length);
  assert.deepEqual(calls.sort(), ['p1', 'p3']);
  assert.deepEqual(cache.puts.sort(), ['/app/__offline/atsu/m/c/0001', '/app/__offline/atsu/m/c/0003']);
});

test('an HTML entry left by an older build is replaced, not skipped', async () => {
  const { fetch, calls } = fakeFetch(() => image());
  const engine = load({ fetch });
  const cache = fakeCache();
  await cache.put('/app/__offline/atsu/m/c/0000', new Response('<html>', { headers: { 'content-type': 'text/html' } }));
  const { run } = job(engine, { cache, urls: ['p0'] });
  await run();
  assert.deepEqual(calls, ['p0']);
  assert.equal(cache.entries.get('/app/__offline/atsu/m/c/0000').headers['content-type'], 'image/jpeg');
});

test('retries a transient failure and a page that hangs past its deadline', async () => {
  const { fetch, calls } = fakeFetch((url, n) => {
    if (url === 'flaky' && n === 1) return new Response('busy', { status: 503 });
    if (url === 'slow' && n < 3) return 'hang';
    return image();
  });
  const engine = load({ fetch });
  const cache = fakeCache();
  const result = await job(engine, { cache, urls: ['flaky', 'slow'], timeoutMs: 5 }).run();
  assert.equal(result.outcome, 'done');
  assert.equal(calls.filter((u) => u === 'flaky').length, 2);
  assert.equal(calls.filter((u) => u === 'slow').length, 3);
});

test('falls back to the second route, and stops paying for a route shown to be broken', async () => {
  // The primary proxy is "not deployed": a fast 404 for every page.
  const { fetch, calls } = fakeFetch((url) => (url.startsWith('/api/manga-page/') ? new Response('nope', { status: 404 }) : image()));
  const engine = load({ fetch });
  const cache = fakeCache();
  const result = await job(engine, {
    cache,
    urls: ['a', 'b', 'c', 'd', 'e', 'f'],
    concurrency: 1,
    candidatesFor: (u) => [`/api/manga-page/?u=${u}`, `/api/media-proxy/?path=${u}`],
  }).run();
  assert.equal(result.outcome, 'done');
  assert.equal(calls.filter((u) => u.startsWith('/api/manga-page/')).length, 1);
  assert.equal(calls.filter((u) => u.startsWith('/api/media-proxy/')).length, 6);
});

test('a 200 that is not an image fails the page, keeps earlier pages and names the page', async () => {
  // atsu.moe/static/pages answers 410 text/html; an uncontrolled /app/ URL answers index.html with 200.
  const { fetch } = fakeFetch((url) => (url === 'bad' ? html(200) : image()));
  const engine = load({ fetch });
  const cache = fakeCache();
  await assert.rejects(
    job(engine, { cache, urls: ['ok0', 'ok1', 'bad'], concurrency: 1, attempts: 2 }).run(),
    (e) => e.name === 'OfflineDownloadError' && e.code === 'failed' && /Page 3/.test(e.message),
  );
  assert.equal(cache.entries.size, 2);
});

test('pause stops after the pages in flight, with every counted page really stored', async () => {
  const { fetch } = fakeFetch(() => image());
  const engine = load({ fetch });
  const cache = fakeCache();
  let stored = 0;
  const result = await engine.downloadPagesToCache({
    cache,
    urls: Array.from({ length: 12 }, (_, i) => `p${i}`),
    keyFor: (i) => `/k/${i}`,
    candidatesFor: (u) => [u],
    shouldStop: () => (stored >= 4 ? 'paused' : null),
    onProgress: (done) => { stored = done; },
  });
  assert.equal(result.outcome, 'paused');
  assert.equal(result.done, cache.entries.size);
  assert.ok(result.done >= 4 && result.done < 12);
});

test('a canceled job never writes the page that was in flight', async () => {
  let canceled = false;
  const { fetch } = fakeFetch(() => { canceled = true; return image(); });
  const engine = load({ fetch });
  const cache = fakeCache();
  const result = await job(engine, { cache, urls: ['p0'], shouldStop: () => (canceled ? 'canceled' : null) }).run();
  assert.equal(result.outcome, 'canceled');
  assert.equal(cache.entries.size, 0);
});

test('a full disk surfaces as a quota error that stops a batch', async () => {
  const { fetch } = fakeFetch(() => image());
  const engine = load({ fetch });
  const cache = fakeCache();
  cache.put = async () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; };
  await assert.rejects(job(engine, { cache, urls: ['p0'] }).run(), (e) => {
    assert.equal(e.code, 'quota');
    assert.equal(engine.isFatalDownloadError(e), true);
    return true;
  });
});

test('sniffs the image formats the sources serve and nothing else', () => {
  const engine = load();
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  assert.equal(engine.sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xdb])), 'image/jpeg');
  assert.equal(engine.sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(engine.sniffImageType(new Uint8Array(ascii('GIF89a'))), 'image/gif');
  assert.equal(engine.sniffImageType(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8 ')])), 'image/webp');
  assert.equal(engine.sniffImageType(new Uint8Array([0, 0, 0, 28, ...ascii('ftypavif')])), 'image/avif');
  assert.equal(engine.sniffImageType(new Uint8Array([0, 0, 0, 28, ...ascii('ftypmif1'), 0, 0, 0, 0, ...ascii('mif1avif')])), 'image/avif');
  assert.equal(engine.sniffImageType(new Uint8Array([0, 0, 0, 28, ...ascii('ftypisom')])), null);
  assert.equal(engine.sniffImageType(new Uint8Array(ascii('<!doctype html>'))), null);
});

test('accepts an untyped body only when its bytes are an image, and stores the sniffed type', async () => {
  const engine = load();
  const sniffed = await engine.readImageBody(new Response(JPEG, { headers: { 'content-type': 'application/octet-stream' } }));
  assert.equal(sniffed.type, 'image/jpeg');
  assert.equal(await engine.readImageBody(new Response('{"error":"x"}', { headers: { 'content-type': 'application/json' } })), null);
  assert.equal(await engine.readImageBody(new Response('hello', { headers: { 'content-type': 'application/octet-stream' } })), null);
  assert.equal(await engine.readImageBody(new Response(new Uint8Array(0), { headers: { 'content-type': 'image/jpeg' } })), null);
});

test('manifest: one shared load, leftover downloads become paused, writes carry the latest rows', async () => {
  const engine = load();
  const cache = fakeCache();
  await cache.put('/m.json', new Response(JSON.stringify({ chapters: {
    a: { status: 'downloading', updatedAt: 1 },
    b: { status: 'ready', updatedAt: 1 },
  } })));
  let opens = 0;
  const manifest = engine.createOfflineManifest({
    url: '/m.json',
    openCache: async () => { opens++; return cache; },
    onLoad: (rows) => {
      let changed = false;
      for (const [k, r] of Object.entries(rows)) if (r.status === 'downloading') { rows[k] = { ...r, status: 'paused' }; changed = true; }
      return changed;
    },
    persistDelayMs: 1,
  });
  // A second caller must not see an empty manifest while the first load is in flight.
  const [, seen] = await Promise.all([manifest.ensureLoaded(), manifest.ensureLoaded().then(() => Object.keys(manifest.state.chapters))]);
  assert.deepEqual(seen.sort(), ['a', 'b']);
  assert.equal(manifest.state.chapters.a.status, 'paused');
  const onDisk = async () => JSON.parse(await (await cache.match('/m.json')).text()).chapters;
  assert.equal((await onDisk()).a.status, 'paused');

  manifest.state.chapters.c = { status: 'downloading', updatedAt: 2 };
  manifest.persistSoon();
  manifest.persistSoon();
  manifest.state.chapters.c = { status: 'ready', updatedAt: 3 };
  await manifest.persistNow();
  assert.equal((await onDisk()).c.status, 'ready');
  assert.ok(opens >= 2);
});

test('a download asks the service worker to refill the app shell, at most once per interval', () => {
  const posted = [];
  const engine = load({ navigator: { serviceWorker: { controller: { postMessage: (m) => posted.push(m) } } } });
  engine.warmOfflineShell();
  engine.warmOfflineShell();
  assert.deepEqual(posted.map((m) => m.type), ['sakura:warm-shell']);
  // No worker at all (dev server, unsupported browser) is silent.
  assert.doesNotThrow(() => load({ navigator: {} }).warmOfflineShell());
});

test('a page-specific primary failure never disables that route for later pages', async () => {
  const { fetch, calls } = fakeFetch((url) => {
    if (url === 'primary-a' || url === 'fallback-b') return new Response('missing', { status: 404 });
    return image();
  });
  const engine = load({ fetch });
  const result = await job(engine, {
    cache: fakeCache(), urls: ['a', 'b'], concurrency: 1,
    candidatesFor: (u) => [`primary-${u}`, `fallback-${u}`],
  }).run();
  assert.equal(result.outcome, 'done');
  assert.ok(calls.includes('primary-b'));
});

test('manifest failures reject the status write and a later retry can persist', async () => {
  const engine = load();
  const cache = fakeCache();
  const put = cache.put.bind(cache);
  let fail = true;
  cache.put = async (...args) => {
    if (fail) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    return put(...args);
  };
  const manifest = engine.createOfflineManifest({ url: '/m.json', openCache: async () => cache });
  await manifest.ensureLoaded();
  manifest.state.chapters.one = { status: 'ready' };
  await assert.rejects(manifest.persistNow(), (e) => e.code === 'quota');
  fail = false;
  await manifest.persistNow();
  assert.equal((await (await cache.match('/m.json')).json()).chapters.one.status, 'ready');
});

test('an untyped error document already cached by an old build must be downloaded again', async () => {
  const { fetch, calls } = fakeFetch(() => image());
  const engine = load({ fetch });
  const cache = fakeCache();
  await cache.put('/app/__offline/atsu/m/c/0000', new Response(new Blob(['<html>offline</html>'])));
  await job(engine, { cache, urls: ['page'] }).run();
  assert.deepEqual(calls, ['page']);
});

test('a temporarily unavailable cache is retried before any manifest can overwrite its old rows', async () => {
  const engine = load();
  const cache = fakeCache();
  await cache.put('/m.json', new Response(JSON.stringify({ chapters: { saved: { status: 'ready' } } })));
  let available = false;
  const manifest = engine.createOfflineManifest({ url: '/m.json', openCache: async () => available ? cache : null });
  await assert.rejects(manifest.ensureLoaded(), (error) => error.code === 'unavailable');
  available = true;
  await manifest.ensureLoaded();
  assert.equal(manifest.state.chapters.saved.status, 'ready');
});
