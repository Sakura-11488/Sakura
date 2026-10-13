import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// Loads lib/manga.ts the same way test/manga-page-urls.test.mjs does.
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
  return load('../lib/content-proxy-client.ts', { ...platform(OS), './content-hosts': hosts }, OS === 'web' ? { window: {} } : {});
}

function mangaModule(OS, { atsuFetch, cache, fetch } = {}) {
  return load('../lib/manga.ts', {
    ...platform(OS),
    '@/lib/content-proxy-client': proxyClient(OS),
    '@/lib/atsu-fetch': { atsuFetch },
    '@/lib/cache': cache || { getOrSetCached: (_k, _ttl, loader) => loader() },
  }, { fetch: fetch || (() => { throw new Error('unexpected network call'); }) });
}

function persistedCache(initial = {}) {
  let stored = JSON.stringify(initial);
  const kv = {
    readStore: async () => stored,
    writeStore: async (_name, value) => { stored = value; },
    removeStore: async () => { stored = null; },
  };
  return { cache: load('../lib/cache.ts', { '@/lib/kv-store': kv }), keys: () => Object.keys(JSON.parse(stored || '{}')) };
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
/** An allChapters row, shaped like atsu's live response. */
const row = (group, number, { pages = 20, at = 0, title = `Chapter ${number}` } = {}) => ({
  id: `${group}-${number}-${seq++}`, scanlationMangaId: group, title, number,
  createdAt: 1_790_000_000_000 + at * DAY, index: Math.floor(number), pageCount: pages, progress: null,
});
const range = (group, from, to, opts) => Array.from({ length: to - from + 1 }, (_, i) => row(group, from + i, opts));

async function chaptersFor(rows) {
  const manga = mangaModule('web', { atsuFetch: async () => json({ chapters: rows }) });
  return [...await manga.fetchMangaChapters('m')];
}
const numbers = (list) => list.map((c) => c.number);

test('a lagging primary group keeps its feed, and the newest chapters come from the groups that have them', async () => {
  // Live Lookism: the biggest group (642 rows, counting its own part uploads)
  // stopped at 624 while groups with fewer rows reached 628.
  const parts = Array.from({ length: 10 }, (_, i) => row('big', 500 + i + 0.1));
  const primary = [...range('big', 1, 624), ...parts];
  const rows = [
    ...primary,
    ...range('fast', 1, 628, { pages: 60, at: 1 }),
    ...range('twin', 1, 628, { pages: 60, at: 2 }), // same pages as `fast`, uploaded later
    ...range('thin', 600, 628, { pages: 19, at: 3 }),
  ];
  const list = await chaptersFor(rows);

  const expected = [...range('x', 1, 628), ...parts].map((c) => c.number).sort((a, b) => a - b);
  assert.deepEqual(numbers(list), expected);
  // Every chapter the primary has is still the primary's row.
  const primaryIds = new Set(primary.map((c) => c.id));
  assert.equal(list.filter((c) => primaryIds.has(c.id)).length, primary.length);
  // Each gap takes the row with the most pages, then the newest upload.
  for (const c of list.slice(-4)) {
    assert.match(c.id, /^twin-/);
    assert.equal(c.pageCount, 60);
  }
});

test('gaps inside the primary range: whole chapters are filled, other groups\' fractional parts are not', async () => {
  const rows = [
    ...range('big', 1, 20).filter((c) => ![7, 9, 12].includes(c.number)),
    row('big', 12.1), row('big', 12.2), // the primary uploaded 12 as two parts (live Lookism 510)
    row('big', 9.5, { title: 'Chapter 9.5 - Side story' }), // an extra: 9 itself is still missing
    ...range('other', 1, 15),
    row('other', 1.1, { pages: 212 }), row('other', 1.2, { pages: 212 }), // live Lookism 1.1-5.3
    row('other', 13.5, { pages: 1, title: 'Chapter 13.5 - Hiatus Announcement' }),
    // After the primary's newest: filled, except a part of a chapter it has whole
    // (live Northern Blade: the primary has 202, another group's 202.2 is half its own split 202).
    row('late', 20.2), row('late', 21), row('late', 21.5),
  ];
  const list = await chaptersFor(rows);

  assert.deepEqual(numbers(list), [1, 2, 3, 4, 5, 6, 7, 8, 9, 9.5, 10, 11, 12.1, 12.2, 13, 14, 15, 16, 17, 18, 19, 20, 21, 21.5]);
  assert.match(list.find((c) => c.number === 7).id, /^other-/);
  assert.match(list.find((c) => c.number === 9).id, /^other-/);
});

test('a row whose title names another number never fills, and a named row beats an unnamed one', async () => {
  const rows = [
    ...range('big', 1, 20).filter((c) => c.number !== 5),
    // Live Time-Limited Genius Dark Knight: one group's numbers ran 12 ahead,
    // so its copies of chapters 9-13 sat at 21-25 and would read as five new ones.
    ...range('ahead', 21, 25).map((c) => ({ ...c, title: `Episode ${c.number - 12}` })),
    row('next', 21, { pages: 12 }), // the real 21, from a group counting like the primary
    // Live Villainess Turns the Hourglass: the epilogue shares 5 and has more pages.
    row('other', 5, { pages: 42, title: 'Epilogue 5' }), row('other', 5, { pages: 35, title: 'Episode 5' }),
    row('hunt', 22, { title: 'Hunt 22' }), // names no number at all: still fills when nothing better has 22
    row('split', 21.2, { title: 'Chapter 21 Part 2' }), // names only the whole number: agrees
  ];
  const list = await chaptersFor(rows);

  assert.deepEqual(numbers(list), [...range('x', 1, 21).map((c) => c.number), 21.2, 22]);
  assert.equal(list.find((c) => c.number === 5).title, 'Episode 5');
  assert.match(list.find((c) => c.number === 21).id, /^next-/);
  assert.equal(list.at(-1).title, 'Hunt 22');
});

test('rows atsu reports with no pages never fill a gap', async () => {
  const rows = [
    ...range('big', 1, 10),
    row('ghost', 11, { pages: 0, at: 5 }),
    row('ghost', 12, { pages: 0 }),
    row('real', 11, { pages: 14 }),
  ];
  const list = await chaptersFor(rows);
  assert.deepEqual(numbers(list).slice(-2), [10, 11]);
  assert.match(list.at(-1).id, /^real-/);
});

test('a single group keeps the old behaviour: one row per number, most pages then newest', async () => {
  const rows = [
    row('only', 2), row('only', 1), row('only', 1, { pages: 0, at: 9 }), row('only', 3, { pages: 0 }),
    row('only', 2, { pages: 20, at: 1 }),
  ];
  const list = await chaptersFor(rows);
  assert.deepEqual(numbers(list), [1, 2, 3]);
  assert.equal(list[0].pageCount, 20); // the zero-page duplicate lost despite being newer
  assert.equal(list[1].id, rows[4].id); // equal pages: the newer upload
  assert.equal(list[2].pageCount, 0); // a lone zero-page row in the feed itself stays
});

test('a filled-in chapter reads through its own id, whichever page path shape atsu returns', async () => {
  // Live: gap-filled rows came back in both shapes, /<scanlationId>/<chapterId>/<file> and /<chapterId>/<file>.
  const shapes = {
    filledA: '/static/pages/cmgzl8e3c8vehm191t1j11y4p/filledA/a693210d4d7bfc02.avif',
    filledB: '/static/pages/filledB/95ca4ea17d07c4c5.avif',
  };
  const calls = [];
  const manga = mangaModule('web', {
    atsuFetch: async (path) => {
      calls.push(path);
      const chapterId = new URLSearchParams(path.split('?')[1]).get('chapterId');
      return json({ readChapter: { pages: [{ image: shapes[chapterId] }] } });
    },
  });
  for (const [chapterId, path] of Object.entries(shapes)) {
    const pages = await manga.fetchMangaChapterPages('xdhnm', chapterId);
    assert.deepEqual([...pages], [`/api/manga-page/?u=${encodeURIComponent(`https://cdn.atsu.moe${path}`)}`]);
  }
  assert.deepEqual(calls, [
    '/api/read/chapter?mangaId=xdhnm&chapterId=filledA',
    '/api/read/chapter?mangaId=xdhnm&chapterId=filledB',
  ]);
});

test('entries the previous build cached for failures are not read back', async () => {
  // What line A persisted: its loaders returned null / [] on failure, cached as fresh.
  const exp = Date.now() + 60 * 60 * 1000;
  const { cache } = persistedCache({
    'manga:detail:m': { exp, value: null },
    'manga:chapters:v2:m': { exp, value: [] },
    'manga:thumb:m:c1': { exp, value: null },
    'manga:paged:popular:0': { exp, value: [] },
  });
  const manga = mangaModule('web', {
    cache,
    atsuFetch: async (path) => {
      if (path.startsWith('/api/manga/page')) return json({ mangaPage: { id: 'm', title: 'Frieren', poster: { image: 'posters/f.jpg' } } });
      if (path.startsWith('/api/manga/allChapters')) return json({ chapters: [row('g', 1)] });
      if (path.startsWith('/api/read/chapter')) return json({ readChapter: { pages: [{ image: '/static/pages/c1/0.avif' }] } });
      if (path.includes('/api/infinite/popular')) return json({ items: [{ id: 'a', title: 'A' }] });
      throw new Error(`unexpected ${path}`);
    },
  });
  assert.equal((await manga.fetchMangaDetail('m')).title, 'Frieren');
  assert.equal((await manga.fetchMangaChapters('m')).length, 1);
  assert.ok(await manga.fetchMangaChapterThumbnail('m', 'c1'));
  assert.equal((await manga.fetchMangaPagedList('popular', 0)).length, 1);
});

test('paged browse: atsu\'s empty page is the end of the list on web, a failure is an uncached error', async () => {
  let mangadexCalls = 0;
  const fetch = async () => { mangadexCalls++; return json({ data: [] }); };
  let atsu = async () => json({ items: [] }); // live: page 51 onwards
  const { cache, keys } = persistedCache();
  const web = mangaModule('web', { cache, fetch, atsuFetch: (...a) => atsu(...a) });

  assert.deepEqual([...await web.fetchMangaPagedList('popular', 51)], []);
  assert.equal(mangadexCalls, 0);

  atsu = async () => { throw new Error('proxy down'); };
  await assert.rejects(web.fetchMangaPagedList('trending', 3));
  assert.ok(!keys().some((k) => k.includes('trending:3')), 'a failure must not be cached');

  // Native can reach MangaDex, so it still continues the catalogue there.
  const native = mangaModule('ios', { fetch, atsuFetch: async () => json({ items: [] }) });
  await native.fetchMangaPagedList('popular', 51);
  assert.equal(mangadexCalls, 1);
});
