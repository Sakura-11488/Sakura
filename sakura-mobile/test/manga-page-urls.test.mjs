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
    module, exports: module.exports, URL, URLSearchParams, Response, Promise, JSON, Date,
    process: { env: {} }, require: (name) => deps[name] || {}, ...globals,
  });
  return module.exports;
}

const platform = (OS) => ({ 'react-native': { Platform: { OS } } });
function proxyClient(OS) {
  const hosts = load('../lib/content-hosts.ts');
  // `window` exists in the browser, which is what selects the same-origin media proxy.
  return load('../lib/content-proxy-client.ts', { ...platform(OS), './content-hosts': hosts }, OS === 'web' ? { window: {} } : {});
}

const PAGE = '/static/pages/cmgzkjxs70k8hm191srm4qxf9/YrFZ5/457b5102c6b348e4.avif';
const CDN = `https://cdn.atsu.moe${PAGE}`;

test('every form of an atsu page URL normalises to the CDN, and nothing else does', () => {
  const { atsuPageCdnUrl } = proxyClient('web');
  for (const url of [
    `https://atsu.moe${PAGE}`, `http://atsu.moe${PAGE}`, `https://www.atsu.moe${PAGE}`, CDN, `//atsu.moe${PAGE}`,
    `${CDN}?v=1#x`, `/api/manga-page/?u=${encodeURIComponent(CDN)}`, `/api/manga-page/?u=${encodeURIComponent(`https://atsu.moe${PAGE}`)}`,
  ]) {
    assert.equal(atsuPageCdnUrl(url), CDN, url);
  }
  for (const url of [
    'https://atsu.moe/static/posters/qp33UK6whoY69nrR-medium.avif', // covers keep their own route
    `https://evil.example${PAGE}`, `https://atsu.moe.evil.example${PAGE}`, `https://user:pw@cdn.atsu.moe${PAGE}`,
    `https://cdn.atsu.moe:8443${PAGE}`, 'https://cdn.atsu.moe/static/pages/../posters/x.jpg', PAGE, '', 'not a url',
    `/api/manga-page/?u=${encodeURIComponent('/api/manga-page/?u=x')}`,
    '/app/__offline/atsu/sVC2A/YrFZ5/0000',
  ]) {
    assert.equal(atsuPageCdnUrl(url), null, url);
  }
});

test('web wraps atsu pages in the same-origin page proxy, idempotently; native and other URLs pass through', () => {
  const web = proxyClient('web');
  const wrapped = web.getWebMangaPageProxyUrl(`https://atsu.moe${PAGE}`);
  assert.equal(wrapped, `/api/manga-page/?u=${encodeURIComponent(CDN)}`);
  assert.equal(web.getWebMangaPageProxyUrl(wrapped), wrapped);
  for (const other of ['https://atsu.moe/static/posters/a.avif', '/app/__offline/atsu/a/b/0000', 'https://iiif.archive.org/image/iiif/3/x/full/1200,/0/default.jpg']) {
    assert.equal(web.getWebMangaPageProxyUrl(other), other);
  }
  const native = proxyClient('ios');
  assert.equal(native.getWebMangaPageProxyUrl(CDN), CDN);
  assert.equal(native.getWebMangaPageFallbackUrl(CDN), CDN);
});

test('the downloader fallback is the droplet image route that serves cdn.atsu.moe today', () => {
  const web = proxyClient('web');
  const expected = `/api/media-proxy/?path=${encodeURIComponent(`/manhwa/v1/img?u=${encodeURIComponent(CDN)}`)}`;
  assert.equal(web.getWebMangaPageFallbackUrl(CDN), expected);
  assert.equal(web.getWebMangaPageFallbackUrl(web.getWebMangaPageProxyUrl(CDN)), expected);
  assert.equal(web.getWebMangaPageFallbackUrl('https://atsu.moe/static/posters/a.avif'), 'https://atsu.moe/static/posters/a.avif');
});

function mangaModule(OS, { atsuFetch, cache, fetch } = {}) {
  const client = proxyClient(OS);
  return load('../lib/manga.ts', {
    ...platform(OS),
    '@/lib/content-proxy-client': client,
    '@/lib/atsu-fetch': { atsuFetch },
    '@/lib/cache': cache || { getOrSetCached: (_k, _ttl, loader) => loader() },
  }, { fetch: fetch || (() => { throw new Error('unexpected network call'); }) });
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const readChapter = () => json({ readChapter: { pages: [{ image: PAGE }, { image: PAGE.replace('457b', '90fe') }] } });

test('page paths resolve to the CDN host; posters keep theirs', () => {
  const manga = mangaModule('ios');
  assert.equal(manga.toPageUrl(PAGE), CDN);
  assert.equal(manga.toPageUrl(PAGE.slice(1)), CDN);
  assert.equal(manga.toPageUrl(`https://atsu.moe${PAGE}`), CDN);
  assert.equal(manga.toPageUrl('posters/x-medium.avif'), 'https://atsu.moe/static/posters/x-medium.avif');
});

test('chapter pages are proxied on web and raw CDN URLs on native', async () => {
  const web = await mangaModule('web', { atsuFetch: async () => readChapter() }).fetchMangaChapterPages('sVC2A', 'YrFZ5');
  assert.equal(web.length, 2);
  assert.ok(web.every((u) => u.startsWith('/api/manga-page/?u=https%3A%2F%2Fcdn.atsu.moe%2Fstatic%2Fpages%2F')));
  const native = await mangaModule('ios', { atsuFetch: async () => readChapter() }).fetchMangaChapterPages('sVC2A', 'YrFZ5');
  assert.equal(native[0], CDN);
});

test('web never waits on MangaDex, which no browser on our origin can reach', async () => {
  let mangadexCalls = 0;
  const manga = mangaModule('web', {
    atsuFetch: async () => { throw new Error('proxy down'); },
    fetch: async () => { mangadexCalls++; return json({}); },
  });
  assert.deepEqual([...await manga.fetchMangaChapterPages('m', 'c')], []);
  assert.deepEqual([...await manga.fetchMangaChapters('m')], []);
  assert.equal(await manga.fetchMangaDetail('m'), null);
  assert.equal(mangadexCalls, 0);
});

test('a failed fetch is never cached as an empty title, and the last good value survives a failure', async () => {
  let stored = null;
  let now = 1_000_000;
  const FakeDate = class extends Date { static now() { return now; } };
  const kv = {
    readStore: async () => stored,
    writeStore: async (_name, value) => { stored = value; },
    removeStore: async () => { stored = null; },
  };
  const cache = load('../lib/cache.ts', { '@/lib/kv-store': kv }, { Date: FakeDate });
  let online = false;
  const manga = mangaModule('web', {
    cache,
    atsuFetch: async (path) => {
      if (!online) throw new Error('offline');
      if (path.startsWith('/api/manga/page')) return json({ mangaPage: { id: 'm', title: 'Frieren', synopsis: 's', poster: { image: 'posters/f.jpg' } } });
      return json({ chapters: [{ id: 'c1', number: 1, title: 'Chapter 1' }] });
    },
  });

  // Offline: the old code cached null / [] here as fresh for 30 / 15 minutes.
  assert.equal(await manga.fetchMangaDetail('m'), null);
  assert.deepEqual([...await manga.fetchMangaChapters('m')], []);
  assert.ok(!stored || !/manga:(detail|chapters)/.test(stored), 'failure must not be persisted');

  // Back online: loads immediately, no poisoned entry in the way.
  online = true;
  assert.equal((await manga.fetchMangaDetail('m')).title, 'Frieren');
  assert.equal((await manga.fetchMangaChapters('m')).length, 1);

  // TTL passes and the network fails again: the stale copy is served.
  now += 60 * 60 * 1000;
  online = false;
  assert.equal((await manga.fetchMangaDetail('m')).title, 'Frieren');
  assert.equal((await manga.fetchMangaChapters('m')).length, 1);
});

test('manhwa detail and chapters keep their null / [] contract without caching the failure', async () => {
  let stored = null;
  const kv = { readStore: async () => stored, writeStore: async (_n, v) => { stored = v; }, removeStore: async () => {} };
  const cache = load('../lib/cache.ts', { '@/lib/kv-store': kv });
  let online = false;
  const manhwa = load('../lib/manhwa.ts', {
    ...platform('web'),
    '@/lib/cache': cache,
    '@/lib/content-proxy-client': proxyClient('web'),
    '@/lib/content-hosts': load('../lib/content-hosts.ts'),
    '@/lib/manhwa-proxy-fetch': {
      manhwaProxyFetch: async (path) => {
        if (!online) throw new Error('offline');
        return path.startsWith('/details') ? { manga: { id: 'mr:x', title: 'X' } } : { chapters: [{ id: 'c1', number: 1 }] };
      },
    },
  });
  assert.equal(await manhwa.fetchManhwaDetail('mr:x'), null);
  assert.deepEqual([...await manhwa.fetchManhwaChapters('mr:x')], []);
  assert.ok(!stored || !/manhwa:(detail|chapters)/.test(stored));
  online = true;
  assert.equal((await manhwa.fetchManhwaDetail('mr:x')).title, 'X');
  assert.equal((await manhwa.fetchManhwaChapters('mr:x')).length, 1);
});

test('source route parameters never resolve inherited properties as adapters', () => {
  const sources = load('../lib/scraped-sources.ts');
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', null, undefined]) {
    assert.equal(sources.asScrapedSource(key), null);
    assert.equal(sources.getScrapedAdapter(key), null);
  }
  assert.equal(sources.getScrapedAdapter('manhwa').key, 'manhwa');
});
