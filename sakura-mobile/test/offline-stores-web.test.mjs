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
    module, exports: module.exports, URL, URLSearchParams, Response, Blob, Uint8Array, AbortController,
    Promise, JSON, Date, process: { env: {} },
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    require: (name) => {
      if (!(name in deps)) throw new Error(`unexpected import ${name}`);
      return deps[name];
    },
    ...globals,
  });
  return module.exports;
}

function fakeCache() {
  const entries = new Map();
  return {
    entries,
    async match(key) {
      const hit = entries.get(String(key));
      return hit ? new Response(hit.blob, { headers: hit.headers }) : undefined;
    },
    async put(key, res) {
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

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
const image = () => new Response(JPEG, { headers: { 'content-type': 'image/avif' } });

/** One browser: a library cache, a network and a navigator shared by every module. */
function browser({ route }) {
  const cache = fakeCache();
  const calls = [];
  const navigator = {
    onLine: true,
    storage: { estimate: async () => ({ quota: 10e9, usage: 0 }), persisted: async () => true },
    serviceWorker: { controller: {} },
  };
  const fetch = async (url) => { calls.push(url); return route(url); };
  const globals = { navigator, fetch, caches: { open: async () => cache } };
  const rn = { Platform: { OS: 'web' } };
  const hosts = load('../lib/content-hosts.ts');
  const client = load('../lib/content-proxy-client.ts', { 'react-native': rn, '@/lib/supabase': {}, './content-hosts': hosts }, { window: {} });
  const keys = load('../lib/offline-cache-keys.ts', {}, globals);
  const engine = load('../lib/offline-image-store.web.ts', {}, globals);
  const titlesDeleted = [];
  const titles = {
    deleteOfflineTitle: async (source, id) => { titlesDeleted.push(`${source}:${id}`); },
    listOfflineTitles: async () => [{ source: 'atsu', contentId: 'm1' }, { source: 'manhwa', contentId: 'x' }],
  };
  return { cache, calls, navigator, globals, client, keys, engine, titles, titlesDeleted };
}

const PAGE = (n) => `/static/pages/scan/ch/${n}.avif`;
const CDN = (n) => `https://cdn.atsu.moe${PAGE(n)}`;

function mangaStore(b, pagesFor) {
  return load('../lib/manga-offline.web.ts', {
    '@/lib/manga': {
      // What fetchMangaChapterPages returns on web: proxied page URLs.
      fetchMangaChapterPages: async (m, c) => (pagesFor(m, c) || []).map((p) => b.client.getWebMangaPageProxyUrl(`https://cdn.atsu.moe${p}`)),
    },
    '@/lib/content-proxy-client': b.client,
    '@/lib/offline-cache-keys': b.keys,
    '@/lib/offline-titles': b.titles,
    '@/lib/offline-image-store.web': b.engine,
    '@/lib/offline-job-coordinator': load('../lib/offline-job-coordinator.ts'),
  }, b.globals);
}

const chapter = (id, n = 1) => ({ mangaId: 'm1', chapterId: id, chapterNumber: n, chapterTitle: `Chapter ${n}`, title: 'Frieren', cover: '' });

test('atsu: a chapter downloads through the page proxy into same-origin URLs the reader can use', async () => {
  const b = browser({ route: () => image() });
  const store = mangaStore(b, () => [PAGE(0), PAGE(1), PAGE(2)]);
  assert.deepEqual({ ...await store.downloadMangaChapter(chapter('c1')) }, {});

  const row = await store.getOfflineMangaChapter('m1', 'c1');
  assert.equal(row.status, 'ready');
  assert.equal(row.pageCount, 3);
  assert.equal(row.bytes, 3 * JPEG.length);
  assert.ok(b.calls.every((u) => u.startsWith('/api/manga-page/?u=')));
  assert.equal(decodeURIComponent(b.calls[0].split('u=')[1]), CDN(0));

  const uris = await store.getOfflineMangaPageUris('m1', 'c1');
  assert.deepEqual([...uris], [0, 1, 2].map((i) => b.keys.offlineMangaPageUrl('m1', 'c1', i)));
  assert.equal(b.cache.entries.get(uris[0]).headers['content-type'], 'image/avif');
  // The manifest is in the library, where a reload will find it.
  const manifest = JSON.parse(await (await b.cache.match(b.keys.MANGA_MANIFEST_URL)).text());
  assert.equal(manifest.chapters['m1::c1'].status, 'ready');
  assert.equal(await store.getOfflineMangaStorageBytes(), 3 * JPEG.length);
});

test('atsu: falls back to the droplet route when the page proxy is missing', async () => {
  const b = browser({ route: (u) => (u.startsWith('/api/manga-page/') ? new Response('Not Found', { status: 404 }) : image()) });
  const store = mangaStore(b, () => [PAGE(0), PAGE(1)]);
  await store.downloadMangaChapter(chapter('c1'));
  assert.equal((await store.getOfflineMangaChapter('m1', 'c1')).status, 'ready');
  assert.ok(b.calls.some((u) => u.startsWith('/api/media-proxy/?path=%2Fmanhwa%2Fv1%2Fimg%3Fu%3Dhttps%253A%252F%252Fcdn.atsu.moe')));
});

test('atsu: no page list is an error row with a readable message, not a "ready" empty chapter', async () => {
  const b = browser({ route: () => image() });
  const store = mangaStore(b, () => []);
  await assert.rejects(store.downloadMangaChapter(chapter('c1')), /Could not load this chapter/);
  const row = await store.getOfflineMangaChapter('m1', 'c1');
  assert.equal(row.status, 'error');
  assert.equal(await store.getOfflineMangaPageUris('m1', 'c1'), null);
});

test('atsu: a tab the service worker does not control reads from the network instead', async () => {
  const b = browser({ route: () => image() });
  const store = mangaStore(b, () => [PAGE(0)]);
  await store.downloadMangaChapter(chapter('c1'));
  b.navigator.serviceWorker.controller = null;
  assert.equal(await store.getOfflineMangaPageUris('m1', 'c1'), null);
});

test('atsu: deleting the last chapter of a title removes its pages and its title snapshot', async () => {
  const b = browser({ route: () => image() });
  const store = mangaStore(b, () => [PAGE(0), PAGE(1)]);
  await store.downloadMangaChapter(chapter('c1', 1));
  await store.downloadMangaChapter(chapter('c2', 2));
  await store.deleteOfflineMangaChapter('m1', 'c1');
  assert.deepEqual(b.titlesDeleted, []);
  assert.equal(b.cache.entries.has(b.keys.offlineMangaPageUrl('m1', 'c1', 0)), false);
  await store.deleteOfflineMangaChapter('m1', 'c2');
  assert.deepEqual(b.titlesDeleted, ['atsu:m1']);
  assert.deepEqual([...await store.listOfflineMangaChapters()], []);
});

test('atsu: clear all sweeps every atsu page and only atsu title snapshots', async () => {
  const b = browser({ route: () => image() });
  const store = mangaStore(b, () => [PAGE(0)]);
  await store.downloadMangaChapter(chapter('c1'));
  await b.cache.put('/app/__offline/manhwa/x/1/0000', image()); // another store's page survives
  await store.clearAllOfflineManga();
  assert.deepEqual([...b.cache.entries.keys()].filter((k) => k.includes('/atsu/')), []);
  assert.ok(b.cache.entries.has('/app/__offline/manhwa/x/1/0000'));
  assert.deepEqual(b.titlesDeleted, ['atsu:m1']);
});

test('atsu: Download all goes chapter by chapter, skips finished ones, and stops (paused) when the network goes', async () => {
  let offlineAfter = Infinity;
  const b = browser({ route: () => image() });
  const store = mangaStore(b, (_m, c) => {
    if (Number(c.slice(1)) >= offlineAfter) b.navigator.onLine = false;
    return b.navigator.onLine ? [PAGE(0)] : [];
  });
  await store.downloadMangaChapter(chapter('c1', 1));
  const chapters = [1, 2, 3, 4].map((n) => ({ id: `c${n}`, number: n, title: `Chapter ${n}` }));
  const started = [];

  offlineAfter = 3;
  await assert.rejects(
    store.downloadAllMangaChapters({ mangaId: 'm1', title: 'Frieren', cover: '', chapters, onChapterStart: (n) => started.push(n) }),
    (e) => e.code === 'offline',
  );
  const paused = store.getMangaBatchState('m1');
  assert.equal(paused.paused, true);
  assert.equal(paused.done, 2);
  assert.equal(paused.ok, 2);

  // Back online, the screen's Resume (resume flag, then Download all again, as
  // on native) walks the list again; finished chapters return at once.
  offlineAfter = Infinity;
  b.navigator.onLine = true;
  store.resumeMangaBatchDownload('m1');
  const pageCalls = b.calls.length;
  const result = await store.downloadAllMangaChapters({ mangaId: 'm1', title: 'Frieren', cover: '', chapters, onChapterStart: (n) => started.push(n) });
  assert.deepEqual({ ...result }, { ok: 4, failed: 0 });
  assert.deepEqual(started, [1, 2, 3, 1, 2, 3, 4]);
  assert.equal(b.calls.length - pageCalls, 2, 'only chapters 3 and 4 touch the network');
  assert.equal(store.getMangaBatchState('m1'), null);

  // A caller that skips the resume flag continues from the paused index.
  offlineAfter = 2;
  await assert.rejects(store.downloadAllMangaChapters({ mangaId: 'm1', title: 'Frieren', cover: '', chapters: [...chapters, { id: 'c5', number: 5, title: 'Chapter 5' }] }));
  assert.equal(store.getMangaBatchState('m1').done, 4);
  offlineAfter = Infinity;
  b.navigator.onLine = true;
  const tail = [];
  await store.downloadAllMangaChapters({ mangaId: 'm1', title: 'Frieren', cover: '', chapters: [...chapters, { id: 'c5', number: 5, title: 'Chapter 5' }], onChapterStart: (n) => tail.push(n) });
  assert.deepEqual(tail, [5]);
});

test('atsu: a row left "downloading" by a closed tab loads as paused, and pausing it notifies', async () => {
  const b = browser({ route: () => image() });
  await b.cache.put('/app/__offline/manga-manifest.json', new Response(JSON.stringify({ chapters: {
    'm1::c1': { ...chapter('c1'), status: 'downloading', progress: 0.5, pageCount: 2, completedPages: 1, updatedAt: 1 },
  } })));
  const store = mangaStore(b, () => [PAGE(0), PAGE(1)]);
  assert.equal((await store.getOfflineMangaChapter('m1', 'c1')).status, 'paused');
  let notified = 0;
  store.subscribeOfflineManga(() => { notified++; });
  store.pauseMangaChapterDownload('m1', 'c1');
  assert.ok(notified >= 1);
});

function scrapedStore(b, pages) {
  const sources = { SCRAPED_SOURCES: { manhwa: { pages: async (id, ch) => pages(id, ch) }, comics: { pages: async (id, ch) => pages(id, ch) } } };
  return load('../lib/scraped-offline.web.ts', {
    '@/lib/scraped-sources': sources,
    '@/lib/content-proxy-client': b.client,
    '@/lib/offline-cache-keys': b.keys,
    '@/lib/offline-titles': b.titles,
    '@/lib/offline-image-store.web': b.engine,
    '@/lib/offline-job-coordinator': load('../lib/offline-job-coordinator.ts'),
  }, b.globals);
}

test('scraped: Download all counts finished chapters as done, keeps going past a failed one, and pauses', async () => {
  let store;
  const b = browser({
    route: (u) => {
      if (u.includes('broken')) return new Response('x', { status: 404 });
      // The user taps pause while chapter 4 is mid-download.
      if (u.includes('c4-')) store.pauseScrapedChapterDownload('manhwa', 'x', 'c4');
      return image();
    },
  });
  store = scrapedStore(b, (_id, ch) => (ch === 'c2' ? ['/api/media-proxy/?path=broken'] : [`/api/media-proxy/?path=${ch}-1`, `/api/media-proxy/?path=${ch}-2`]));
  const common = { source: 'manhwa', contentId: 'x', title: 'X', cover: '' };
  await store.downloadScrapedChapter({ ...common, chapterId: 'c1', chapterNumber: 1, chapterTitle: 'Chapter 1' });

  let batchNotes = 0;
  const unsubscribe = store.subscribeScrapedBatch(() => { batchNotes++; });
  const chapters = [1, 2, 3].map((n) => ({ id: `c${n}`, number: n, title: `Chapter ${n}` }));
  const result = await store.downloadAllScrapedChapters({ ...common, chapters });
  assert.deepEqual({ ...result }, { ok: 2, failed: 1 });
  assert.ok(batchNotes > 0);
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(unsubscribe(), undefined);
  const map = await store.getScrapedOfflineMap('manhwa', 'x');
  assert.equal(map.c2.status, 'error');
  assert.equal(map.c3.status, 'ready');
  assert.equal(store.getScrapedBatchState('manhwa', 'x'), null);

  // Pause mid-batch: the running chapter pauses, the batch reports paused and stays resumable.
  const more = [4, 5].map((n) => ({ id: `c${n}`, number: n, title: `Chapter ${n}` }));
  const paused = await store.downloadAllScrapedChapters({ ...common, chapters: more });
  assert.equal(paused.paused, true);
  assert.equal(store.getScrapedBatchState('manhwa', 'x').paused, true);
  assert.equal((await store.getScrapedOfflineChapter('manhwa', 'x', 'c4')).status, 'paused');
});

test('scraped: an Internet Archive page that hangs gets a smaller rendition before the chapter fails', async () => {
  const big = 'https://iiif.archive.org/image/iiif/3/book%2Fpage_0010.jp2/full/1200,/0/default.jpg';
  const b = browser({ route: (u) => (u.includes('/full/1200,/') ? new Response('x', { status: 504 }) : image()) });
  const store = scrapedStore(b, () => [big]);
  await store.downloadScrapedChapter({ source: 'comics', contentId: 'ia-book', chapterId: 'ia-book', chapterNumber: 1, chapterTitle: 'Issue 1', title: 'Book', cover: '' });
  assert.equal((await store.getScrapedOfflineChapter('comics', 'ia-book', 'ia-book')).status, 'ready');
  assert.ok(b.calls.some((u) => u.includes('/full/800,/')));
});

function titlesStore(b) {
  return load('../lib/offline-titles.web.ts', {
    '@/lib/cover-thumbnail': load('../lib/cover-thumbnail.ts'),
    '@/lib/offline-cache-keys': b.keys,
    '@/lib/offline-image-store.web': b.engine,
    '@/lib/offline-job-coordinator': load('../lib/offline-job-coordinator.ts'),
  }, b.globals);
}

const detail = (cover) => ({ id: 'sVC2A', title: 'Frieren', cover, description: 'An elf', genres: ['Fantasy'] });
const chapters = [{ id: 'c1', number: 1, title: 'Chapter 1', pageCount: 16, createdAt: '' }];

test('titles: a snapshot round-trips with the cover stored from the same URL the hero shows', async () => {
  const b = browser({ route: (u) => (u.startsWith('/api/cover-image/') ? image() : new Response('no', { status: 403 })) });
  const titles = titlesStore(b);
  await titles.saveOfflineTitle({ source: 'atsu', contentId: 'sVC2A', detail: detail('https://atsu.moe/static/posters/p-large.avif'), chapters });
  const snap = await titles.getOfflineTitle('atsu', 'sVC2A');
  assert.equal(snap.detail.title, 'Frieren');
  assert.equal(snap.chapters.length, 1);
  assert.equal(snap.coverUri, b.keys.offlineCoverUrl('atsu', 'sVC2A'));
  assert.ok(b.calls[0].startsWith('/api/cover-image/?url=https%3A%2F%2Fcdn.atsu.moe%2Fstatic%2Fposters%2Fp-large.avif&width=512'));
  assert.equal(b.cache.entries.get(snap.coverUri).headers['content-type'], 'image/avif');

  // A refresh with the same cover does not refetch it.
  await titles.saveOfflineTitle({ source: 'atsu', contentId: 'sVC2A', detail: detail('https://atsu.moe/static/posters/p-large.avif'), chapters: [...chapters, { ...chapters[0], id: 'c2', number: 2 }] });
  assert.equal(b.calls.length, 1);
  assert.equal((await titles.getOfflineTitle('atsu', 'sVC2A')).chapters.length, 2);

  // An uncontrolled tab would get index.html for that URL, so it is not offered.
  b.navigator.serviceWorker.controller = null;
  assert.equal((await titles.getOfflineTitle('atsu', 'sVC2A')).coverUri, undefined);
});

test('titles: a cover that cannot be fetched never fails the save', async () => {
  const b = browser({ route: () => { throw new Error('network down'); } });
  const titles = titlesStore(b);
  await titles.saveOfflineTitle({ source: 'comics', contentId: 'ia-x', detail: detail('https://archive.org/services/img/x'), chapters });
  const snap = await titles.getOfflineTitle('comics', 'ia-x');
  assert.equal(snap.detail.title, 'Frieren');
  assert.equal(snap.coverUri, undefined);
});

test('titles: list, delete, and an index rebuilt from the snapshots when it is missing', async () => {
  const b = browser({ route: () => image() });
  const titles = titlesStore(b);
  await titles.saveOfflineTitle({ source: 'atsu', contentId: 'a', detail: detail(''), chapters });
  await titles.saveOfflineTitle({ source: 'manhwa', contentId: 'mr:x', detail: detail(''), chapters });
  assert.deepEqual((await titles.listOfflineTitles()).map((t) => t.contentId).sort(), ['a', 'mr:x']);

  // A fresh session with no index on disk still finds both.
  b.cache.entries.delete('/app/__offline/title-index.json');
  const fresh = titlesStore(b);
  assert.deepEqual((await fresh.listOfflineTitles()).map((t) => t.contentId).sort(), ['a', 'mr:x']);

  await fresh.deleteOfflineTitle('manhwa', 'mr:x');
  assert.deepEqual((await fresh.listOfflineTitles()).map((t) => t.contentId), ['a']);
  assert.equal(await fresh.getOfflineTitle('manhwa', 'mr:x'), null);
  assert.equal(b.cache.entries.has(b.keys.offlineTitleUrl('manhwa', 'mr:x')), false);
});

for (const source of ['atsu', 'manhwa']) {
  test(`${source}: a missing middle page is detected and repaired without downloading intact pages`, async () => {
    const b = browser({ route: () => image() });
    const makeStore = () => source === 'atsu' ? mangaStore(b, () => [PAGE(0), PAGE(1), PAGE(2)]) : scrapedStore(b, () => ['p0', 'p1', 'p2']);
    const opts = source === 'atsu' ? chapter('c1') : { source, contentId: 'm1', chapterId: 'c1', chapterNumber: 1, chapterTitle: 'One', title: 'X', cover: '' };
    const download = (s) => source === 'atsu' ? s.downloadMangaChapter(opts) : s.downloadScrapedChapter(opts);
    const first = makeStore();
    await download(first);
    const missing = source === 'atsu' ? b.keys.offlineMangaPageUrl('m1', 'c1', 1) : b.keys.offlinePageUrl(source, 'm1', 'c1', 1);
    await b.cache.delete(missing);
    const store = makeStore();
    const rows = source === 'atsu' ? await store.getOfflineMapForManga('m1') : await store.getScrapedOfflineMap(source, 'm1');
    assert.equal(rows.c1.status, 'error');
    assert.equal(rows.c1.completedPages, 2);
    const calls = b.calls.length;
    await download(store);
    assert.equal(b.calls.length - calls, 1);
    assert.ok(b.cache.entries.has(missing));
  });

  test(`${source}: clear during a cache write leaves no pages, rows, or continuing batch`, async () => {
    const b = browser({ route: () => image() });
    const store = source === 'atsu' ? mangaStore(b, () => [PAGE(0)]) : scrapedStore(b, () => ['page']);
    let entered;
    const writing = new Promise((resolve) => { entered = resolve; });
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const put = b.cache.put.bind(b.cache);
    b.cache.put = async (key, response) => {
      if (key.includes(`/${source}/`) && !key.endsWith('.json')) { entered(); await blocked; }
      await put(key, response);
    };
    const opts = { title: 'X', cover: '', chapters: [{ id: 'c1', number: 1, title: 'One' }, { id: 'c2', number: 2, title: 'Two' }] };
    const download = source === 'atsu' ? store.downloadAllMangaChapters({ ...opts, mangaId: 'm1' }) : store.downloadAllScrapedChapters({ ...opts, source, contentId: 'm1' });
    await writing;
    const clear = source === 'atsu' ? store.clearAllOfflineManga() : store.clearAllScrapedOffline();
    release();
    await Promise.all([download, clear]);
    assert.equal([...b.cache.entries.keys()].filter((key) => key.includes(`/${source}/`)).length, 0);
    const rows = source === 'atsu' ? await store.listOfflineMangaChapters() : await store.listScrapedOfflineChapters();
    assert.equal(rows.length, 0);
    assert.equal(b.calls.length, 1, 'the next batch chapter never starts');
  });

  test(`${source}: duplicate download requests share completion and a failed manifest cannot report ready`, async () => {
    const b = browser({ route: () => image() });
    const store = source === 'atsu' ? mangaStore(b, () => [PAGE(0)]) : scrapedStore(b, () => ['page']);
    const opts = source === 'atsu' ? chapter('c1') : { source, contentId: 'm1', chapterId: 'c1', chapterNumber: 1, chapterTitle: 'One', title: 'X', cover: '' };
    const download = () => source === 'atsu' ? store.downloadMangaChapter(opts) : store.downloadScrapedChapter(opts);
    const put = b.cache.put.bind(b.cache);
    b.cache.put = async (key, response) => {
      if (key.endsWith('manifest.json') && (await response.clone().text()).includes('"ready"')) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
      return put(key, response);
    };
    const a = download();
    assert.equal(a, download());
    await assert.rejects(a, (error) => error.code === 'quota');
    const row = source === 'atsu' ? await store.getOfflineMangaChapter('m1', 'c1') : await store.getScrapedOfflineChapter(source, 'm1', 'c1');
    assert.equal(row.status, 'error');
  });
}

test('titles: metadata is durable while the optional cover is still downloading', async () => {
  let entered;
  const fetching = new Promise((resolve) => { entered = resolve; });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const b = browser({ route: async () => { entered(); await blocked; return image(); } });
  const store = titlesStore(b);
  const save = store.saveOfflineTitle({ source: 'atsu', contentId: 'm1', detail: detail('https://atsu.moe/static/posters/p-large.avif'), chapters });
  await fetching;
  const snap = await store.getOfflineTitle('atsu', 'm1');
  assert.equal(snap.detail.title, 'Frieren');
  assert.equal(snap.chapters.length, 1);
  const deleting = store.deleteOfflineTitle('atsu', 'm1');
  release();
  await Promise.all([save, deleting]);
  assert.equal(await store.getOfflineTitle('atsu', 'm1'), null);
  assert.equal(b.cache.entries.has(b.keys.offlineCoverUrl('atsu', 'm1')), false);
});

function nativeStore(source, { downloadPage } = {}) {
  const files = new Map();
  const calls = [];
  const fs = {
    documentDirectory: '/documents/',
    makeDirectoryAsync: async () => {},
    getInfoAsync: async (path) => ({ exists: files.has(path), size: files.has(path) ? files.get(path).length : 0 }),
    readAsStringAsync: async (path) => files.get(path),
    writeAsStringAsync: async (path, body) => { files.set(path, body); },
    readDirectoryAsync: async (path) => [...files.keys()].filter((key) => key.startsWith(path)).map((key) => key.slice(path.length)),
    deleteAsync: async (path) => { for (const key of files.keys()) if (key === path || key.startsWith(path)) files.delete(key); },
    downloadAsync: async (url, path) => {
      calls.push(url);
      if (downloadPage) await downloadPage(url, path);
      files.set(path, 'x'.repeat(200));
      return { status: 200 };
    },
  };
  const titlesDeleted = [];
  const deps = {
    'expo-file-system/legacy': fs,
    '@/lib/offline-job-coordinator': load('../lib/offline-job-coordinator.ts'),
    '@/lib/offline-titles': { deleteOfflineTitle: async (s, id) => { titlesDeleted.push(`${s}:${id}`); }, listOfflineTitles: async () => [{ source, contentId: 'm1' }] },
    '@/lib/manga': { toPageUrl: (url) => url },
    '@/lib/scraped-sources': { SCRAPED_SOURCES: { manhwa: { pages: async () => ['page0', 'page1'] } } },
  };
  const store = load(source === 'atsu' ? '../lib/manga-offline.ts' : '../lib/scraped-offline.ts', deps, {
    fetch: async () => new Response(JSON.stringify({ readChapter: { pages: ['page0', 'page1'] } })),
  });
  return { store, fs, files, calls, titlesDeleted };
}

for (const source of ['atsu', 'manhwa']) {
  test(`${source} native: clear waits for an in-flight filesystem download and stops its batch`, async () => {
    let entered;
    const writing = new Promise((resolve) => { entered = resolve; });
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const b = nativeStore(source, { downloadPage: async () => { entered(); await blocked; } });
    const opts = { title: 'X', cover: '', chapters: [{ id: 'c1', number: 1, title: 'One' }, { id: 'c2', number: 2, title: 'Two' }] };
    const batch = source === 'atsu' ? b.store.downloadAllMangaChapters({ ...opts, mangaId: 'm1' }) : b.store.downloadAllScrapedChapters({ ...opts, source, contentId: 'm1' });
    await writing;
    const clear = source === 'atsu' ? b.store.clearAllOfflineManga() : b.store.clearAllScrapedOffline();
    release();
    await Promise.all([batch, clear]);
    assert.equal([...b.files.keys()].filter((key) => key.includes('page-')).length, 0);
    assert.equal(b.calls.length, 1);
    const rows = source === 'atsu' ? await b.store.listOfflineMangaChapters() : await b.store.listScrapedOfflineChapters();
    assert.equal(rows.length, 0);
    assert.deepEqual(b.titlesDeleted, [`${source}:m1`]);
  });
}

for (const source of ['atsu', 'manhwa']) {
  test(`${source} native: paused batches resume from actual files and delete removes the title snapshot`, async () => {
    let b;
    let pauseOnce = true;
    b = nativeStore(source, { downloadPage: async () => {
      if (!pauseOnce) return;
      pauseOnce = false;
      if (source === 'atsu') b.store.pauseMangaChapterDownload('m1', 'c1');
      else b.store.pauseScrapedChapterDownload(source, 'm1', 'c1');
    } });
    const opts = { title: 'X', cover: '', chapters: [{ id: 'c1', number: 1, title: 'One' }] };
    const batch = () => source === 'atsu' ? b.store.downloadAllMangaChapters({ ...opts, mangaId: 'm1' }) : b.store.downloadAllScrapedChapters({ ...opts, source, contentId: 'm1' });
    assert.equal((await batch()).paused, true);
    assert.equal(b.calls.length, 1);
    assert.equal((await batch()).ok, 1);
    assert.equal(b.calls.length, 2, 'resume fetches only the second page');
    if (source === 'atsu') await b.store.deleteOfflineMangaChapter('m1', 'c1');
    else await b.store.deleteScrapedOfflineChapter(source, 'm1', 'c1');
    assert.equal([...b.files.keys()].filter((key) => key.includes('page-')).length, 0);
    assert.deepEqual(b.titlesDeleted, [`${source}:m1`]);
  });

  test(`${source} native: deleting during a download cannot recreate its row or files`, async () => {
    let entered;
    const writing = new Promise((resolve) => { entered = resolve; });
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const b = nativeStore(source, { downloadPage: async () => { entered(); await blocked; } });
    const opts = { chapterId: 'c1', chapterNumber: 1, chapterTitle: 'One', title: 'X', cover: '' };
    const download = source === 'atsu' ? b.store.downloadMangaChapter({ ...opts, mangaId: 'm1' }) : b.store.downloadScrapedChapter({ ...opts, source, contentId: 'm1' });
    await writing;
    const deleting = source === 'atsu' ? b.store.deleteOfflineMangaChapter('m1', 'c1') : b.store.deleteScrapedOfflineChapter(source, 'm1', 'c1');
    release();
    await Promise.all([download, deleting]);
    assert.equal([...b.files.keys()].filter((key) => key.includes('page-')).length, 0);
    const row = source === 'atsu' ? await b.store.getOfflineMangaChapter('m1', 'c1') : await b.store.getScrapedOfflineChapter(source, 'm1', 'c1');
    assert.equal(row, null);
  });
}
