import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');

function load(path, deps = {}, globals = {}) {
  const module = { exports: {} };
  const output = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, {
    module, exports: module.exports, URL, URLSearchParams, Promise, JSON, Date,
    process: { env: {} }, require: (name) => deps[name] || {}, ...globals,
  });
  return module.exports;
}

const CACHE_FILE = 'sakura_api_cache.json';
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * Loads lib/comics.ts or lib/hentai.ts against an in-memory cache and a fake
 * scraper. `seed` pre-fills the persisted cache ({ key: value }, fresh for a
 * day), as a device holds it from the previous release.
 */
function loadSource(source, scraper, { seed = null } = {}) {
  const store = new Map();
  if (seed) {
    const exp = Date.now() + 24 * 60 * 60 * 1000;
    store.set(CACHE_FILE, JSON.stringify(Object.fromEntries(Object.entries(seed).map(([k, value]) => [k, { exp, value }]))));
  }
  const kv = {
    readStore: async (k) => store.get(k) ?? null,
    writeStore: async (k, v) => { store.set(k, v); },
    removeStore: async (k) => { store.delete(k); },
  };
  const cache = load('../lib/cache.ts', { '@/lib/kv-store': kv });
  const fetchName = source === 'comics' ? 'comicsProxyFetch' : 'hentaiProxyFetch';
  const mod = load(`../lib/${source}.ts`, {
    'react-native': { Platform: { OS: 'ios' } },
    '@/lib/cache': cache,
    [`@/lib/${source}-proxy-fetch`]: { [fetchName]: (path) => scraper(path) },
    '@/lib/content-proxy-client': { getWebMediaProxyUrl: (u) => `/api/media/?u=${encodeURIComponent(u)}` },
    '@/lib/content-hosts': { COMICS_PROXY_DEFAULT: 'http://droplet.test/comics/v1', HENTAI_PROXY_DEFAULT: 'http://droplet.test/hentai/v1' },
  });
  return { mod, store };
}

/** A scraper whose answers a test can switch between empty, full and failing. */
function switchableScraper() {
  const state = { mode: 'empty', calls: [] };
  state.fetch = async (path) => {
    state.calls.push(path);
    if (state.mode === 'down') throw new Error(`HTTP 502 for ${path}`);
    const empty = state.mode === 'empty';
    const url = new URL(path, 'http://scraper.test');
    if (url.pathname === '/pages') return { pages: empty ? [] : ['https://img.test/p1.jpg', 'https://img.test/p2.jpg'] };
    if (url.pathname === '/chapters') return { issues: empty ? [] : [{ id: 'issue-1', number: 1 }] };
    if (url.pathname === '/details') return empty ? {} : { comic: { id: url.searchParams.get('id'), title: 'Title' } };
    throw new Error(`unexpected ${path}`);
  };
  return state;
}

for (const source of ['comics', 'hentai']) {
  const pagesOf = (mod) => (source === 'comics' ? mod.fetchComicPages : mod.fetchHentaiPages);

  test(`${source}: an empty page list is returned but not cached; a good one is`, async () => {
    const scraper = switchableScraper();
    const { mod, store } = loadSource(source, scraper.fetch);
    const pages = pagesOf(mod);
    assert.deepEqual(plain(await pages('t1', 'c1')), []);
    assert.ok(!/:pages:/.test(store.get(CACHE_FILE) || ''), 'an empty answer must not be persisted');
    scraper.mode = 'full';
    assert.equal((await pages('t1', 'c1')).length, 2);
    assert.equal(scraper.calls.length, 2, 'the empty answer was not served from the cache');
    await pages('t1', 'c1');
    assert.equal(scraper.calls.length, 2, 'a good answer is cached');
  });

  test(`${source}: a failed page request still rejects, as before`, async () => {
    const scraper = switchableScraper();
    scraper.mode = 'down';
    const { mod } = loadSource(source, scraper.fetch);
    await assert.rejects(pagesOf(mod)('t1', 'c1'), /502/);
  });
}

test('comics: an empty detail or issue list keeps its null / [] answer without caching it, and failures still reject', async () => {
  const scraper = switchableScraper();
  const { mod, store } = loadSource('comics', scraper.fetch);
  assert.equal(await mod.fetchComicDetail('c:x'), null);
  assert.deepEqual(plain(await mod.fetchComicChapters('c:x')), []);
  assert.ok(!/comics:(detail|chapters)/.test(store.get(CACHE_FILE) || ''));

  scraper.mode = 'full';
  assert.equal((await mod.fetchComicDetail('c:x')).title, 'Title');
  assert.equal((await mod.fetchComicChapters('c:x')).length, 1);

  // The detail screen words a comics outage differently from "not found", so
  // a failed request must still reject rather than resolve null / [].
  const down = switchableScraper();
  down.mode = 'down';
  const fresh = loadSource('comics', down.fetch).mod;
  await assert.rejects(fresh.fetchComicDetail('c:y'), /502/);
  await assert.rejects(fresh.fetchComicChapters('c:y'), /502/);
});

test('null / [] the previous release cached under the old keys is not served', async () => {
  const comicsScraper = switchableScraper();
  comicsScraper.mode = 'full';
  const comics = loadSource('comics', comicsScraper.fetch, {
    seed: { 'comics:detail:c:x': null, 'comics:chapters:c:x': [], 'comics:pages:v1:c:x:issue-1': [] },
  }).mod;
  assert.equal((await comics.fetchComicDetail('c:x')).title, 'Title');
  assert.equal((await comics.fetchComicChapters('c:x')).length, 1);
  assert.equal((await comics.fetchComicPages('c:x', 'issue-1')).length, 2);
  assert.equal(comicsScraper.calls.length, 3);

  const hentaiScraper = switchableScraper();
  hentaiScraper.mode = 'full';
  const hentai = loadSource('hentai', hentaiScraper.fetch, {
    seed: { 'hentai:detail:g1': null, 'hentai:chapters:g1': [], 'hentai:pages:v1:g1:gallery': [] },
  }).mod;
  assert.equal((await hentai.fetchHentaiDetail('g1')).title, 'Title');
  assert.equal((await hentai.fetchHentaiChapters('g1')).length, 1);
  assert.equal((await hentai.fetchHentaiPages('g1', 'gallery')).length, 2);
  assert.equal(hentaiScraper.calls.length, 3);
});
