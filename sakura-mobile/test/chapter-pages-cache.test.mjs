import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../lib/chapter-pages.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

/**
 * lib/chapter-pages with its stores and fetchers replaced. `answers` maps a
 * chapter id to the page list the network returns (a function may throw or
 * return a deferred's promise); `downloaded` maps a chapter id to its local
 * page URIs.
 */
function harness({ answers = {}, downloaded = {} } = {}) {
  const network = [];
  const offlineReads = [];
  const clock = { now: 5_000_000 };
  const answer = (chapterId) => {
    const value = answers[chapterId];
    return typeof value === 'function' ? value() : Promise.resolve(value ?? []);
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Promise, Map, Set,
    Date: { now: () => clock.now },
    require: name => {
      if (name === '@/lib/manga') return {
        fetchMangaChapters: async () => [],
        fetchMangaChapterPages: (mangaId, chapterId) => { network.push(`atsu:${mangaId}:${chapterId}`); return answer(chapterId); },
        toPageUrl: (path) => path,
      };
      // The sized atsu request (chapter-page-sizes.test.mjs covers it) is
      // unavailable here, so every atsu list comes from the shared fetcher.
      if (name === '@/lib/atsu-fetch') return { atsuFetch: async () => { throw new Error('offline'); } };
      if (name === '@/lib/content-proxy-client') return { getWebMangaPageProxyUrl: (url) => url };
      if (name === '@/lib/kv-store') return { readStore: async () => null, writeStore: async () => true };
      if (name === '@/lib/manga-offline') return {
        getOfflineMapForManga: async () => ({}),
        getOfflineMangaPageUris: async (mangaId, chapterId) => { offlineReads.push(chapterId); return downloaded[chapterId] ?? null; },
      };
      if (name === '@/lib/scraped-offline') return {
        getScrapedOfflineMap: async () => ({}),
        getScrapedOfflinePageUris: async (_source, _id, chapterId) => { offlineReads.push(chapterId); return downloaded[chapterId] ?? null; },
      };
      if (name === '@/lib/scraped-sources') return {
        getScrapedAdapter: key => key === 'manhwa' ? {
          key: 'manhwa',
          pages: (contentId, chapterId) => { network.push(`manhwa:${contentId}:${chapterId}`); return answer(chapterId); },
        } : null,
      };
      if (name === '@/lib/chapter-order') return { normalizeChaptersForReading: list => list };
      if (name === '@/lib/use-online') return { isOnline: () => true };
      throw new Error(`unexpected import ${name}`);
    },
  });
  return { api: module.exports, network, offlineReads, clock };
}

test('a chapter reopened within the window is answered from memory', async () => {
  const { api, network } = harness({ answers: { c1: ['/p1', '', '/p2'] } });
  const first = await api.loadChapterPages({ contentId: 'm', chapterId: 'c1' });
  const again = await api.loadChapterPages({ contentId: 'm', chapterId: 'c1' });
  assert.deepEqual([...first.urls], ['/p1', '/p2']);
  assert.equal(first.origin, 'network');
  assert.deepEqual([...again.urls], ['/p1', '/p2']);
  assert.deepEqual(network, ['atsu:m:c1']);
});

test('Retry (preferOffline false) skips the memory and stores the new answer', async () => {
  let version = 1;
  const { api, network } = harness({ answers: { c1: () => Promise.resolve([`/v${version++}`]) } });
  await api.loadChapterPages({ contentId: 'm', chapterId: 'c1' });
  const retried = await api.loadChapterPages({ contentId: 'm', chapterId: 'c1', preferOffline: false });
  assert.deepEqual([...retried.urls], ['/v2']);
  const after = await api.loadChapterPages({ contentId: 'm', chapterId: 'c1' });
  assert.deepEqual([...after.urls], ['/v2']);
  assert.equal(network.length, 2);
});

test('lists expire after ten minutes, since some sources hand out expiring URLs', async () => {
  const { api, network, clock } = harness({ answers: { c1: ['/p1'] } });
  await api.loadChapterPages({ contentId: 'm', chapterId: 'c1' });
  clock.now += 10 * 60 * 1000 + 1;
  await api.loadChapterPages({ contentId: 'm', chapterId: 'c1' });
  assert.equal(network.length, 2);
});

test('empty answers and failures are not remembered', async () => {
  let calls = 0;
  const { api, network } = harness({ answers: { empty: [], broken: () => { calls++; return Promise.reject(new Error('down')); } } });
  assert.deepEqual([...(await api.loadChapterPages({ contentId: 'm', chapterId: 'empty' })).urls], []);
  await api.loadChapterPages({ contentId: 'm', chapterId: 'empty' });
  await assert.rejects(api.loadChapterPages({ contentId: 'm', chapterId: 'broken' }), /down/);
  await assert.rejects(api.loadChapterPages({ contentId: 'm', chapterId: 'broken' }), /down/);
  assert.equal(network.filter(call => call.endsWith(':empty')).length, 2);
  assert.equal(calls, 2);
});

test('a prefetch and the reader opening during it share one request', async () => {
  const gate = deferred();
  const { api, network } = harness({ answers: { c1: () => gate.promise } });
  const prefetch = api.prefetchChapterPages({ contentId: 'm', chapterId: 'c1' });
  await new Promise(resolve => setImmediate(resolve));
  const opened = api.loadChapterPages({ contentId: 'm', chapterId: 'c1' });
  gate.resolve(['/p1']);
  assert.deepEqual([...(await prefetch)], ['/p1']);
  assert.deepEqual([...(await opened).urls], ['/p1']);
  assert.deepEqual(network, ['atsu:m:c1']);
});

test('repeated prefetches of one chapter (one per page turn) do the work once', async () => {
  const { api, network, offlineReads } = harness({ answers: { c2: ['/a'] } });
  const results = await Promise.all([1, 2, 3].map(() => api.prefetchChapterPages({ contentId: 'm', chapterId: 'c2' })));
  results.push(await api.prefetchChapterPages({ contentId: 'm', chapterId: 'c2' }));
  assert.ok(results.every(urls => urls?.[0] === '/a'));
  assert.equal(network.length, 1);
  assert.equal(offlineReads.length, 1);
});

test('a downloaded chapter is not prefetched: the reader opens it from disk', async () => {
  const { api, network } = harness({ answers: { c1: ['/remote'] }, downloaded: { c1: ['blob:local'] } });
  assert.equal(await api.prefetchChapterPages({ contentId: 'm', chapterId: 'c1' }), null);
  assert.deepEqual(network, []);
  const loaded = await api.loadChapterPages({ contentId: 'm', chapterId: 'c1' });
  assert.equal(loaded.origin, 'offline');
});

test('a failed prefetch is tried again on the next call', async () => {
  let fail = true;
  const { api, network } = harness({ answers: { c1: () => (fail ? Promise.reject(new Error('x')) : Promise.resolve(['/ok'])) } });
  assert.equal(await api.prefetchChapterPages({ contentId: 'm', chapterId: 'c1' }), null);
  fail = false;
  assert.deepEqual([...(await api.prefetchChapterPages({ contentId: 'm', chapterId: 'c1' }))], ['/ok']);
  assert.equal(network.length, 2);
});

test('scraped sources are cached under their own key', async () => {
  const { api, network } = harness({ answers: { c1: ['/x'] } });
  await api.loadChapterPages({ contentId: 'm', chapterId: 'c1', source: 'manhwa' });
  await api.loadChapterPages({ contentId: 'm', chapterId: 'c1' });
  await api.loadChapterPages({ contentId: 'm', chapterId: 'c1', source: 'manhwa' });
  assert.deepEqual(network, ['manhwa:m:c1', 'atsu:m:c1']);
});

test('missing ids prefetch nothing', async () => {
  const { api, network } = harness();
  assert.equal(await api.prefetchChapterPages({ contentId: '', chapterId: 'c' }), null);
  assert.equal(await api.prefetchChapterPages({ contentId: 'm', chapterId: '' }), null);
  assert.deepEqual(network, []);
});

test('a page-list request that has hung for 15 s is not joined by the next open', async () => {
  let call = 0;
  const hung = deferred();
  const { api, network, clock } = harness({ answers: { c1: () => (++call === 1 ? hung.promise : Promise.resolve(['/p1'])) } });
  const first = api.loadChapterPages({ contentId: 'm', chapterId: 'c1' });
  await new Promise(resolve => setImmediate(resolve));
  clock.now += 15_001;
  const reopened = await api.loadChapterPages({ contentId: 'm', chapterId: 'c1' });
  assert.deepEqual([...reopened.urls], ['/p1']);
  assert.equal(network.length, 2);
  // A prefetch memo still pending past the same age is not reused either.
  const prefetchGate = deferred();
  let prefetchCalls = 0;
  const second = harness({ answers: { c2: () => (++prefetchCalls === 1 ? prefetchGate.promise : Promise.resolve(['/q'])) } });
  void second.api.prefetchChapterPages({ contentId: 'm', chapterId: 'c2' });
  await new Promise(resolve => setImmediate(resolve));
  second.clock.now += 15_001;
  assert.deepEqual([...(await second.api.prefetchChapterPages({ contentId: 'm', chapterId: 'c2' }))], ['/q']);
  hung.resolve([]);
  prefetchGate.resolve([]);
  await first;
});
