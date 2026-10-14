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

/**
 * lib/chapter-pages with atsu's read/chapter answered by `atsuAnswer` (a
 * response body, or a function throwing), the shared fetcher recording its
 * calls, and an in-memory kv-store. Timers run on demand.
 */
function harness({ atsuAnswer, files = new Map() } = {}) {
  const calls = [];
  const timers = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Promise, Map, Set, JSON, Math, Number, Object, Array,
    Date: { now: () => 1_000 },
    encodeURIComponent,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    require: (name) => {
      if (name === '@/lib/manga') return {
        fetchMangaChapters: async () => [],
        fetchMangaChapterPages: async (m, c) => { calls.push(`shared:${m}:${c}`); return ['/fallback/0.webp']; },
        toPageUrl: (path) => `https://cdn.atsu.moe${path}`,
      };
      if (name === '@/lib/atsu-fetch') return {
        atsuFetch: async (path) => {
          calls.push(`atsu:${path}`);
          const body = typeof atsuAnswer === 'function' ? atsuAnswer() : atsuAnswer;
          return { ok: true, json: async () => body };
        },
      };
      if (name === '@/lib/content-proxy-client') return { getWebMangaPageProxyUrl: (url) => `/api/manga-page/?u=${encodeURIComponent(url)}` };
      if (name === '@/lib/kv-store') return {
        readStore: async (n) => files.get(n) ?? null,
        writeStore: async (n, v) => { files.set(n, v); return true; },
      };
      if (name === '@/lib/manga-offline') return { getOfflineMapForManga: async () => ({}), getOfflineMangaPageUris: async () => null };
      if (name === '@/lib/scraped-offline') return { getScrapedOfflineMap: async () => ({}), getScrapedOfflinePageUris: async () => null };
      if (name === '@/lib/scraped-sources') return {
        getScrapedAdapter: (key) => key === 'manhwa' ? { key: 'manhwa', adult: false, pages: async () => ['/m/0.jpg', '/m/1.jpg'] }
          : key === 'hentai' ? { key: 'hentai', adult: true, pages: async () => ['/h/0.jpg'] } : null,
      };
      if (name === '@/lib/chapter-order') return { normalizeChaptersForReading: (list) => list };
      if (name === '@/lib/use-online') return { isOnline: () => true };
      throw new Error(`unexpected import ${name}`);
    },
  });
  const flushTimers = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    while (timers.length) timers.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { api: module.exports, calls, files, flushTimers };
}

test("atsu's page sizes come back with the URLs, aligned after empty rows are dropped", async () => {
  const { api, calls } = harness({
    atsuAnswer: { readChapter: { pages: [
      { image: '/static/pages/v8/c1/0.webp', width: 784, height: 1145 },
      { image: '' },
      { image: '/static/pages/v8/c1/2.webp', width: 0, height: 1145 },
      { image: '/static/pages/v8/c1/3.webp', width: 690, height: 13915 },
    ] } },
  });
  const loaded = await api.loadChapterPages({ contentId: 'v8', chapterId: 'c1' });
  assert.equal(loaded.urls.length, 3);
  assert.equal(loaded.urls[0], `/api/manga-page/?u=${encodeURIComponent('https://cdn.atsu.moe/static/pages/v8/c1/0.webp')}`);
  assert.deepEqual({ ...loaded.sizes[0] }, { width: 784, height: 1145 });
  assert.equal(loaded.sizes[1], null, 'a zero width is not a size');
  assert.deepEqual({ ...loaded.sizes[2] }, { width: 690, height: 13915 });
  assert.deepEqual(calls, ['atsu:/api/read/chapter?mangaId=v8&chapterId=c1']);
  // The cached copy keeps the sizes too.
  const again = await api.loadChapterPages({ contentId: 'v8', chapterId: 'c1' });
  assert.equal(again.sizes.length, 3);
  assert.equal(calls.length, 1);
});

test('an atsu miss falls back to the shared fetcher (and its MangaDex route)', async () => {
  const { api, calls } = harness({ atsuAnswer: () => { throw new Error('proxy down'); } });
  const loaded = await api.loadChapterPages({ contentId: 'v8', chapterId: 'c9' });
  assert.deepEqual([...loaded.urls], ['/fallback/0.webp']);
  assert.equal(loaded.sizes, undefined);
  assert.deepEqual(calls.slice(-1), ['shared:v8:c9']);
  const empty = harness({ atsuAnswer: { readChapter: { pages: [] } } });
  await empty.api.loadChapterPages({ contentId: 'v8', chapterId: 'c8' });
  assert.ok(empty.calls.includes('shared:v8:c8'));
});

test('measured sizes are remembered per chapter and merged, and survive a reload', async () => {
  const first = harness();
  first.api.rememberPageSizes('manhwa', 'mr:solo', 'ch-1', [{ width: 690, height: 4000 }, null]);
  await first.flushTimers();
  first.api.rememberPageSizes('manhwa', 'mr:solo', 'ch-1', [undefined, { width: 690, height: 2000 }, { width: 700.4, height: 1400.6 }]);
  await first.flushTimers();
  const stored = JSON.parse(first.files.get('sakura_page_size_cache.json'));
  assert.deepEqual(stored['manhwa:mr:solo:ch-1'].s, [690, 4000, 690, 2000, 700, 1401]);

  const second = harness({ files: first.files });
  const sizes = await second.api.getRememberedPageSizes('manhwa', 'mr:solo', 'ch-1');
  assert.deepEqual([...sizes].map((s) => s && { ...s }), [
    { width: 690, height: 4000 }, { width: 690, height: 2000 }, { width: 700, height: 1401 },
  ]);
  assert.equal(await second.api.getRememberedPageSizes('manhwa', 'mr:solo', 'ch-2'), null);
  assert.equal(await second.api.getRememberedPageSizes(undefined, 'mr:solo', 'ch-1'), null, 'sources do not share sizes');
});

test('nothing is remembered for the 18+ source', async () => {
  const { api, files, flushTimers } = harness();
  api.rememberPageSizes('hentai', '123', 'g', [{ width: 800, height: 1200 }]);
  await flushTimers();
  assert.equal(files.size, 0);
  assert.equal(await api.getRememberedPageSizes('hentai', '123', 'g'), null);
});

test('a corrupt size store is ignored', async () => {
  const { api } = harness({ files: new Map([['sakura_page_size_cache.json', '{broken']]) });
  assert.equal(await api.getRememberedPageSizes('manhwa', 'x', 'y'), null);
});
