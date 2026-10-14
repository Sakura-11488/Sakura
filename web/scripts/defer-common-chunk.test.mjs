import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import {
  COMMON_SENTINEL,
  assertChunksExist,
  documentChunks,
  loadBundleGlobal,
  loaderScript,
  moduleIds,
  rewriteDocument,
  routeImportsThroughCommon,
} from './defer-common-chunk.mjs';

const JS = '/app/_expo/static/js/web';
const RUNTIME = `${JS}/__expo-metro-runtime-${'1'.repeat(32)}.js`;
const COMMON = `${JS}/__common-${'2'.repeat(32)}.js`;
const ENTRY = `${JS}/index-${'3'.repeat(32)}.js`;
const READER = `${JS}/[id]-${'4'.repeat(32)}.js`;
const DOWNLOADS = `${JS}/downloads-${'5'.repeat(32)}.js`;
const CHUNKS = [RUNTIME, COMMON, ENTRY, READER, DOWNLOADS];

const exported = () =>
  '<!DOCTYPE html><html><head><link rel="stylesheet" href="/app/_expo/static/css/a-0.css"></head><body><div id="root"></div>' +
  `<script src="${RUNTIME}" defer></script><script src="${COMMON}" defer></script><script src="${ENTRY}" defer></script>\n</body></html>`;

test('__common becomes a non-fetching link plus the loader, ahead of the entry bundle', () => {
  const { html, common, lazy } = rewriteDocument(exported(), { chunks: CHUNKS, globalKey: '__loadBundleAsync' });
  assert.equal(common, COMMON);
  assert.ok(!html.includes(`<script src="${COMMON}"`), 'the eager script tag is gone');
  assert.ok(html.includes(`<link rel="sakura-common" data-sakura-common href="${COMMON}">`));
  assert.ok(html.indexOf('data-sakura-common') < html.indexOf(ENTRY), 'the loader runs before the entry bundle');
  assert.ok(html.includes(`<script src="${ENTRY}" defer></script>`), 'the entry is untouched');
  assert.deepEqual(lazy, [DOWNLOADS, READER].sort());
});

test('every chunk the document does not load is listed for the service worker, after the entry', () => {
  const { html } = rewriteDocument(exported(), { chunks: CHUNKS, globalKey: '__loadBundleAsync' });
  for (const url of [READER, DOWNLOADS]) {
    assert.ok(html.includes(`<link rel="sakura-chunk" href="${url}">`), url);
    assert.ok(html.indexOf(url) > html.indexOf(ENTRY), 'listed after the entry, so the build id still comes from it');
  }
  // The worker reads documents with this same pattern (public/sw.js shellEntries).
  assert.deepEqual(new Set(documentChunks(html)), new Set(CHUNKS));
});

test('online-only chunks (the trading SDK) are left out of the offline shell', () => {
  const PHOENIX = `${JS}/phoenix-${'6'.repeat(32)}.js`;
  const { html, lazy } = rewriteDocument(exported(), { chunks: [...CHUNKS, PHOENIX], globalKey: '__loadBundleAsync' });
  assert.ok(!lazy.includes(PHOENIX));
  assert.ok(!html.includes(PHOENIX), 'the worker neither precaches it nor waits for it');
  assert.deepEqual(lazy, [DOWNLOADS, READER].sort());
});

test('rewriting is idempotent', () => {
  const once = rewriteDocument(exported(), { chunks: CHUNKS, globalKey: '__loadBundleAsync' }).html;
  const twice = rewriteDocument(once, { chunks: CHUNKS, globalKey: '__loadBundleAsync' }).html;
  assert.equal(twice, once);
});

test('without a recognisable chunk loader, __common stays eager (slower, never broken)', () => {
  const { html, common } = rewriteDocument(exported(), { chunks: CHUNKS, globalKey: null });
  assert.equal(common, null);
  assert.ok(html.includes(`<script src="${COMMON}" defer></script>`));
  assert.ok(html.includes(`<link rel="sakura-chunk" href="${READER}">`), 'chunks are still listed for the worker');
});

test('the loader global is read from the bundles, prefix included', () => {
  const runtime = "var __BUNDLE_START_TIME__=0,__DEV__=false,__METRO_GLOBAL_PREFIX__='';";
  const entry = 'globalThis[`${globalThis.__METRO_GLOBAL_PREFIX__??\'\'}__loadBundleAsync`]=x;';
  assert.equal(loadBundleGlobal([runtime, entry]), '__loadBundleAsync');
  assert.equal(loadBundleGlobal([runtime.replace("''", "'pfx'"), entry]), 'pfx__loadBundleAsync');
  assert.equal(loadBundleGlobal([runtime]), null, 'no loader in the bundles');
  assert.equal(loadBundleGlobal([entry]), null, 'no prefix definition');
});

test('import() targets that live in __common are routed to it; others are left alone', () => {
  const common = '__d(function(g,r){},1776,[1,2]);\n__d(function(g,r){r(d[0])},1762,{"0":5,"paths":{}});';
  const ids = moduleIds(common);
  assert.deepEqual([...ids].sort(), [1762, 1776]);
  const entry =
    '__d(function(g,r,i,a,m,e,d){x}' + ',1710,{"0":41,"1":1776,"2":165,"paths":{}});\n' +
    '__d(function(g,r,i,a,m,e,d){y}' + `,1711,{"0":1762,"1":1730,"paths":{"1730":"${READER}"}});\n` +
    '__d(function(g,r,i,a,m,e,d){z},1712,[1776]);';
  const { code, added } = routeImportsThroughCommon(entry, ids);
  assert.equal(added, 2);
  assert.ok(code.includes(`,1710,{"0":41,"1":1776,"2":165,"paths":{"1776":"${COMMON_SENTINEL}"}});`));
  assert.ok(code.includes(`,1711,{"0":1762,"1":1730,"paths":{"1730":"${READER}","1762":"${COMMON_SENTINEL}"}});`));
  assert.ok(code.includes(',1712,[1776]);'), 'a module with no import() is not touched');
  assert.deepEqual(routeImportsThroughCommon(code, ids), { code, added: 0 }, 'idempotent');
});

test('a chunk path that is referenced but not exported fails the build', () => {
  const html = rewriteDocument(exported(), { chunks: CHUNKS, globalKey: '__loadBundleAsync' }).html;
  assert.doesNotThrow(() => assertChunksExist({ html, sources: [`x={"paths":{"1":"${READER}","2":"${COMMON_SENTINEL}"}}`], chunks: CHUNKS }));
  assert.throws(
    () => assertChunksExist({ html, sources: [`x={"paths":{"1":"${JS}/gone-${'6'.repeat(32)}.js"}}`], chunks: CHUNKS }),
    /gone-/,
  );
  assert.throws(() => assertChunksExist({ html, sources: [], chunks: CHUNKS.filter((u) => u !== READER) }), /\[id\]/);
});

/** Runs the inline loader in a sandbox and plays Expo's part: assign the global, then load chunks. */
function loaderWorld() {
  const listeners = {};
  const requested = [];
  const preloaded = [];
  const pending = new Map();
  const window = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    requestIdleCallback: (fn) => fn(),
  };
  const document = {
    querySelector: (sel) => (sel === 'link[data-sakura-common]' ? { getAttribute: () => COMMON } : null),
    createElement: () => ({}),
    head: { appendChild: (el) => { if (el.rel === 'preload' && el.as === 'script') preloaded.push(el.href); } },
  };
  const sandbox = { window, document, Promise };
  vm.createContext(sandbox);
  const script = loaderScript('__loadBundleAsync').replace(/^<script[^>]*>|<\/script>$/g, '');
  vm.runInContext(script, sandbox);
  // Expo's loader: one fetch per URL, settled by the test.
  const expoLoad = (url) => {
    requested.push(url);
    return new Promise((resolve, reject) => pending.set(url, { resolve, reject }));
  };
  window.__loadBundleAsync = expoLoad;
  const settle = (url, ok = true) => { const p = pending.get(url); pending.delete(url); ok ? p.resolve() : p.reject(new Error('offline')); };
  return { window, listeners, requested, preloaded, settle, tick: () => new Promise((r) => setImmediate(r)) };
}

test('the loader fetches __common alongside the first chunk, once, and runs the chunk after it', async () => {
  const w = loaderWorld();
  let done = false;
  const first = w.window.__loadBundleAsync(READER).then(() => { done = true; });
  assert.deepEqual(w.requested, [COMMON], '__common is loaded first');
  assert.deepEqual(w.preloaded, [READER], 'the chunk downloads in parallel, through a preload hint');
  await w.tick();
  // The regression this guards: a chunk that ran before __common could be
  // imported synchronously by a second import() (Expo tries that first on
  // web), and Metro caches the resulting "Requiring unknown module" for good.
  assert.deepEqual(w.requested, [COMMON], 'the chunk does not run while __common is pending');
  w.settle(COMMON);
  await w.tick();
  assert.deepEqual(w.requested, [COMMON, READER], 'then the chunk runs');
  assert.equal(done, false, 'and the import waits for it');
  w.settle(READER);
  await first;
  assert.equal(done, true);
  const second = w.window.__loadBundleAsync(DOWNLOADS);
  assert.deepEqual(w.requested, [COMMON, READER, DOWNLOADS], '__common is not fetched again, the chunk runs at once');
  assert.deepEqual(w.preloaded, [READER], 'no hint needed once __common has run');
  w.settle(DOWNLOADS);
  await second;
});

test('a chunk whose __common fetch failed is retried with it, not run without it', async () => {
  const w = loaderWorld();
  const failed = w.window.__loadBundleAsync(READER);
  w.settle(COMMON, false);
  await assert.rejects(failed, /offline/);
  assert.deepEqual(w.requested, [COMMON], 'the chunk never ran');
  const retry = w.window.__loadBundleAsync(READER);
  assert.deepEqual(w.requested, [COMMON, COMMON]);
  assert.deepEqual(w.preloaded, [READER], 'hinted once');
  w.settle(COMMON);
  await w.tick();
  w.settle(READER);
  await retry;
});

test('the placeholder resolves to the document\'s __common, and a failed fetch is retried', async () => {
  const w = loaderWorld();
  const failed = w.window.__loadBundleAsync(COMMON_SENTINEL);
  assert.deepEqual(w.requested, [COMMON], 'the placeholder is never fetched itself');
  w.settle(COMMON, false);
  await assert.rejects(failed, /offline/);
  const retry = w.window.__loadBundleAsync(COMMON_SENTINEL);
  assert.deepEqual(w.requested, [COMMON, COMMON], 'retried after a failure');
  w.settle(COMMON);
  await retry;
});

test('once the page has loaded, __common is fetched when the browser is idle', () => {
  const w = loaderWorld();
  assert.deepEqual(w.requested, []);
  w.listeners.load();
  assert.deepEqual(w.requested, [COMMON]);
});
