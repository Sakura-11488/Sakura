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

const POPULAR = Array.from({ length: 19 }, (_, i) => ({ id: `mr:pop-${i}`, title: `Popular ${i}`, cover: `https://img.test/pop-${i}.jpg` }));

/**
 * A stand-in for the droplet scraper with its real quirks: /popular is a fixed
 * 19 whatever `limit` says, and one search answers at most 36 titles whatever
 * `limit` says, sliced by `offset`. Each word's answer repeats a popular title
 * and a title of the previous word, so dedupe has something to do.
 */
function fakeScraper({ fail = new Set(), empty = new Set(), delay = 2 } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const answerFor = (q) => {
    const own = Array.from({ length: 30 }, (_, i) => ({ id: `cz:${q}-${i}`, title: `${q} ${i}` }));
    return [...own, { id: 'mr:pop-3', title: 'Popular 3' }, { id: 'cz:shared-title', title: 'Shared' }];
  };
  async function manhwaProxyFetch(path) {
    calls.push(path);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, delay));
      const url = new URL(path, 'http://scraper.test');
      const key = url.pathname === '/popular' ? 'popular' : url.searchParams.get('q');
      if (fail.has(key)) throw new Error(`HTTP 502 for ${path}`);
      if (empty.has(key)) return { items: [] };
      if (url.pathname === '/popular') return { items: POPULAR };
      if (url.pathname === '/search') {
        const offset = Number(url.searchParams.get('offset') || 0);
        const limit = Number(url.searchParams.get('limit') || 24);
        return { items: answerFor(key).slice(0, 36).slice(offset, offset + limit) };
      }
      throw new Error(`unexpected ${path}`);
    } finally {
      inFlight -= 1;
    }
  }
  return { manhwaProxyFetch, calls, get maxInFlight() { return maxInFlight; } };
}

/** The persisted cache file, as lib/cache.ts reads and writes it. */
const CACHE_FILE = 'sakura_api_cache.json';

/**
 * `seed` pre-fills the persisted cache ({ key: value }, fresh for a day), as a
 * user's device holds it from the previous release; `DateImpl` lets a test
 * move the clock past a TTL.
 */
function loadManhwa(scraper, OS = 'ios', { seed = null, DateImpl = Date } = {}) {
  const store = new Map();
  if (seed) {
    const exp = DateImpl.now() + 24 * 60 * 60 * 1000;
    store.set(CACHE_FILE, JSON.stringify(Object.fromEntries(Object.entries(seed).map(([k, value]) => [k, { exp, value }]))));
  }
  const kv = {
    readStore: async (k) => store.get(k) ?? null,
    writeStore: async (k, v) => { store.set(k, v); },
    removeStore: async (k) => { store.delete(k); },
  };
  const cache = load('../lib/cache.ts', { '@/lib/kv-store': kv }, { Date: DateImpl });
  const manhwa = load('../lib/manhwa.ts', {
    'react-native': { Platform: { OS } },
    '@/lib/cache': cache,
    '@/lib/manhwa-proxy-fetch': { manhwaProxyFetch: (path) => scraper.manhwaProxyFetch(path) },
    '@/lib/content-proxy-client': { getWebMediaProxyUrl: (u) => `/api/media/?u=${encodeURIComponent(u)}` },
    '@/lib/content-hosts': { MANHWA_PROXY_DEFAULT: 'http://droplet.test/manhwa/v1' },
  });
  return { manhwa, cache, store };
}

// Values built inside the vm carry its own Array/Object prototypes, which
// deepStrictEqual rejects; copy them into this realm before comparing.
const plain = (value) => JSON.parse(JSON.stringify(value));
const ids = (items) => [...items].map((i) => i.id);
const assertUnique = (items) => assert.equal(new Set(ids(items)).size, items.length, 'no duplicate ids');
const searchQ = (path) => new URL(path, 'http://x').searchParams.get('q');

test('trending tops /popular up from the discovery words, popular first, deduped, in one wave', async () => {
  const scraper = fakeScraper();
  const { manhwa } = loadManhwa(scraper);
  const words = manhwa.MANHWA_DISCOVERY_QUERIES;
  const list = await manhwa.fetchTrendingManhwa(40);
  assert.equal(list.length, 40);
  assertUnique(list);
  assert.deepEqual(ids(list.slice(0, 19)), ids(POPULAR));
  assert.deepEqual(ids(list.slice(19, 21)), [`cz:${words[0]}-0`, `cz:${words[0]}-1`]);
  // popular + the first two words cover 40; no further wave is started.
  assert.equal(scraper.calls.length, 3);
  assert.ok(scraper.calls[0].startsWith('/popular'));
  assert.deepEqual(scraper.calls.slice(1).map(searchQ), [words[0], words[1]]);
  assert.ok(scraper.maxInFlight <= 3);
  // Native covers go straight to the droplet's /img.
  assert.equal(list[0].cover, `http://droplet.test/manhwa/v1/img?u=${encodeURIComponent(POPULAR[0].cover)}`);
  assert.equal(list[0].source, 'manhwa');
});

test('trending keeps going past failed words, never runs more than 3 requests at once, and keeps a stable order', async () => {
  const words = ['martial', 'level', 'return', 'regress'];
  const scraper = fakeScraper({ fail: new Set(['level', 'popular']), delay: 5 });
  const { manhwa } = loadManhwa(scraper);
  assert.deepEqual([...manhwa.MANHWA_DISCOVERY_QUERIES.slice(0, 4)], words);
  const list = await manhwa.fetchTrendingManhwa(100);
  assert.equal(list.length, 100);
  assertUnique(list);
  assert.ok(scraper.maxInFlight <= 3, `max in flight ${scraper.maxInFlight}`);
  assert.equal(list[0].id, 'cz:martial-0');
  assert.ok(!list.some((i) => i.id.startsWith('cz:level-')), 'failed word contributes nothing');
  const firstReturn = list.findIndex((i) => i.id === 'cz:return-0');
  assert.ok(firstReturn > list.findIndex((i) => i.id === 'cz:martial-29'), 'words merge in list order');
  assert.deepEqual(scraper.calls.slice(3).map(searchQ), ['return', 'regress', 'tower']);
});

test('trending resolves [] when nothing loads, and caches nothing: the next load recovers', async () => {
  const everything = new Set(['popular']);
  const scraper = fakeScraper({ empty: everything });
  const { manhwa } = loadManhwa(scraper);
  for (const q of manhwa.MANHWA_DISCOVERY_QUERIES) everything.add(q);
  assert.deepEqual(plain(await manhwa.fetchTrendingManhwa(40)), []);
  // A wave in which every request failed is an outage: give up after it
  // instead of walking all 25 requests in 9 serial waves.
  assert.equal(scraper.calls.length, 3);
  assert.ok(scraper.maxInFlight <= 3);
  everything.clear();
  const recovered = await manhwa.fetchTrendingManhwa(40);
  assert.equal(recovered.length, 40);
});

test('trending stops at a wave that failed outright, keeping what earlier waves found', async () => {
  const scraper = fakeScraper({ fail: new Set(['return', 'regress', 'tower']) });
  const { manhwa } = loadManhwa(scraper);
  const list = await manhwa.fetchTrendingManhwa(200);
  // popular + martial + level, then return/regress/tower all fail: stop there.
  assert.equal(scraper.calls.length, 6);
  assert.equal(list.length, 19 + 30 + 30 + 1);
  assertUnique(list);
});

test('the same series under an mr: and a cz: id is listed once, first id wins', async () => {
  const scraper = fakeScraper();
  const inner = scraper.manhwaProxyFetch;
  scraper.manhwaProxyFetch = async (path) => {
    const data = await inner(path);
    if (searchQ(path) === 'martial') {
      // What the live scraper does: /popular has mr:martial-peak, the
      // "martial" search has cz:martial-peak; curly vs straight quotes too.
      data.items = [
        { id: 'cz:pop-0', title: 'POPULAR  0' },
        { id: 'cz:couldnt', title: 'The Regressor Couldn’t' },
        { id: 'mr:couldnt', title: "The Regressor Couldn't" },
        { id: 'cz:ko-1', title: '나 혼자만 레벨업' },
        { id: 'cz:ko-2', title: '전지적 독자 시점' },
        ...data.items,
      ];
    }
    return data;
  };
  const { manhwa } = loadManhwa(scraper);
  const list = await manhwa.fetchTrendingManhwa(60);
  assertUnique(list);
  assert.equal(list[0].id, 'mr:pop-0');
  assert.ok(!list.some((i) => i.id === 'cz:pop-0'), 'cz duplicate of a popular title dropped');
  assert.ok(list.some((i) => i.id === 'cz:couldnt'));
  assert.ok(!list.some((i) => i.id === 'mr:couldnt'), 'punctuation-only difference dropped');
  assert.ok(list.some((i) => i.id === 'cz:ko-1') && list.some((i) => i.id === 'cz:ko-2'), 'non-Latin titles kept apart');
  assert.equal(manhwa.manhwaTitleKey('!!!'), '');
  assert.equal(manhwa.manhwaTitleKey('Leveling Up as an S‑Rank Dark Mage'), manhwa.manhwaTitleKey('leveling up as an s-rank dark mage'));
});

test('an empty search or an empty chapter is returned but not cached', async () => {
  let empty = true;
  const calls = [];
  const scraper = {
    async manhwaProxyFetch(path) {
      calls.push(path);
      if (path.startsWith('/pages')) return { pages: empty ? [] : ['https://img.test/p1.jpg'] };
      return { items: empty ? [] : [{ id: 'cz:a', title: 'A' }] };
    },
  };
  const { manhwa } = loadManhwa(scraper);
  assert.deepEqual(plain(await manhwa.searchManhwa('hunter', 12)), []);
  assert.deepEqual(plain(await manhwa.fetchManhwaPages('cz:a', 'ch-1')), []);
  empty = false;
  assert.equal((await manhwa.searchManhwa('hunter', 12)).length, 1);
  assert.equal((await manhwa.fetchManhwaPages('cz:a', 'ch-1')).length, 1);
  assert.equal(calls.length, 4);
  // A good answer IS cached.
  await manhwa.searchManhwa('hunter', 12);
  await manhwa.fetchManhwaPages('cz:a', 'ch-1');
  assert.equal(calls.length, 4);
});

test('browse pages through the catalogue: popular + first batch, then later batches, then the end', async () => {
  const scraper = fakeScraper();
  const { manhwa } = loadManhwa(scraper);
  const words = manhwa.MANHWA_DISCOVERY_QUERIES;
  const perPage = 2; // ceil(60 / ~30 new titles per word)
  const pageCount = Math.ceil(words.length / perPage);

  const first = await manhwa.browseManhwa(0, 60);
  assert.equal(first.hasMore, true);
  assertUnique(first.items);
  assert.deepEqual(ids(first.items.slice(0, 19)), ids(POPULAR));
  assert.ok(first.items.some((i) => i.id === `cz:${words[1]}-29`));
  assert.ok(!first.items.some((i) => i.id.startsWith(`cz:${words[2]}-`)));

  const seen = new Set(ids(first.items));
  let last = first;
  for (let p = 1; p < pageCount; p++) {
    last = await manhwa.browseManhwa(p, 60);
    assert.equal(last.hasMore, p < pageCount - 1, `page ${p}`);
    assert.ok(last.items.some((i) => i.id === `cz:${words[p * perPage]}-0`), `page ${p} starts at its batch`);
    assert.ok(!last.items.some((i) => i.id.startsWith('mr:pop-') && i.id !== 'mr:pop-3'), 'popular only on page 0');
    for (const id of ids(last.items)) seen.add(id);
  }
  assert.equal(last.hasMore, false);
  assert.equal(seen.size, 19 + words.length * 30 + 1);
  assert.deepEqual(plain(await manhwa.browseManhwa(pageCount, 60)), { items: [], hasMore: false });
  assert.ok(scraper.maxInFlight <= 3);
});

test('browse page 0 reuses what trending already fetched', async () => {
  const scraper = fakeScraper();
  const { manhwa } = loadManhwa(scraper);
  await manhwa.fetchTrendingManhwa(40);
  const before = scraper.calls.length;
  const page = await manhwa.browseManhwa(0, 60);
  assert.equal(scraper.calls.length, before, 'no new requests');
  assert.ok(page.items.length > 40);
});

test('a browse page that cannot load at all rejects; a partly failed one keeps the rest', async () => {
  const words = ['martial', 'level', 'return', 'regress'];
  const dead = loadManhwa(fakeScraper({ fail: new Set(['return', 'regress']) })).manhwa;
  assert.deepEqual([...dead.MANHWA_DISCOVERY_QUERIES.slice(0, 4)], words);
  await assert.rejects(dead.browseManhwa(1, 60), /502/);

  const partial = await loadManhwa(fakeScraper({ fail: new Set(['popular', 'level']) })).manhwa.browseManhwa(0, 60);
  assert.equal(partial.items.length, 32);
  assert.ok(partial.items.every((i) => i.id.startsWith('cz:martial-') || i.id === 'mr:pop-3' || i.id === 'cz:shared-title'));
  assert.equal(partial.hasMore, true);
});

test('browse with a query pages /search by offset; pages do not collide and end on a short page', async () => {
  const scraper = fakeScraper();
  const { manhwa } = loadManhwa(scraper);
  const p0 = await manhwa.browseManhwa(0, 24, ' Tower ');
  const p1 = await manhwa.browseManhwa(1, 24, ' Tower ');
  assert.equal(p0.items.length, 24);
  assert.equal(p0.hasMore, true);
  assert.equal(p1.items.length, 8);
  assert.equal(p1.hasMore, false);
  assert.equal(p0.items[0].id, 'cz:Tower-0');
  assert.equal(p1.items[0].id, 'cz:Tower-24');
  const params = scraper.calls.map((c) => Object.fromEntries(new URL(c, 'http://x').searchParams));
  assert.deepEqual(params, [
    { q: 'Tower', limit: '24', offset: '0' },
    { q: 'Tower', limit: '24', offset: '24' },
  ]);
  // Cached per page: asking again makes no requests and returns the same pages.
  assert.deepEqual(ids((await manhwa.browseManhwa(1, 24, 'Tower')).items), ids(p1.items));
  assert.equal(scraper.calls.length, 2);
  // The scraper caps a query at 36, so a 60-title page is the only page.
  assert.equal((await manhwa.browseManhwa(0, 60, 'tower')).hasMore, false);
});

test('an empty search page ends paging without being cached', async () => {
  const empty = new Set(['hunter']);
  const scraper = fakeScraper({ empty });
  const { manhwa } = loadManhwa(scraper);
  assert.deepEqual(plain(await manhwa.browseManhwa(0, 24, 'hunter')), { items: [], hasMore: false });
  empty.clear();
  const again = await manhwa.browseManhwa(0, 24, 'hunter');
  assert.equal(again.items.length, 24);
  assert.equal(again.hasMore, true);
});

test('a search page that fails rejects instead of looking like the end', async () => {
  const scraper = fakeScraper({ fail: new Set(['hunter']) });
  const { manhwa } = loadManhwa(scraper);
  await assert.rejects(manhwa.browseManhwa(0, 24, 'hunter'), /502/);
});

test('web routes covers through the same-origin media proxy', async () => {
  const { manhwa } = loadManhwa(fakeScraper(), 'web');
  const [first] = await manhwa.fetchTrendingManhwa(1);
  assert.equal(first.cover, `/api/media/?u=${encodeURIComponent(`http://droplet.test/manhwa/v1/img?u=${encodeURIComponent(POPULAR[0].cover)}`)}`);
});

test('the registry gives manhwa a paged browse and leaves the other sources unpaged', () => {
  const browseManhwa = () => {};
  const manhwaTitleKey = () => '';
  const { SCRAPED_SOURCES } = load('../lib/scraped-sources.ts', {
    '@/lib/manhwa': { browseManhwa, manhwaTitleKey },
  });
  assert.equal(SCRAPED_SOURCES.manhwa.browse, browseManhwa);
  assert.equal(SCRAPED_SOURCES.manhwa.titleKey, manhwaTitleKey);
  assert.equal(SCRAPED_SOURCES.comics.browse, undefined);
  assert.equal(SCRAPED_SOURCES.hentai.browse, undefined);
  assert.equal(SCRAPED_SOURCES.comics.titleKey, undefined);
  assert.equal(SCRAPED_SOURCES.hentai.titleKey, undefined);
});

/**
 * A stand-in for the droplet's /chapters with its real quirk: it answers at
 * most 2000 chapters per request whatever `limit` says, sliced by `offset`.
 * `failAt` holds offsets that answer 502; `ignoreOffset` models a scraper that
 * always answers the first page.
 */
function chapterScraper(series, { failAt = new Set(), ignoreOffset = false } = {}) {
  const calls = [];
  return {
    calls,
    async manhwaProxyFetch(path) {
      calls.push(path);
      const url = new URL(path, 'http://scraper.test');
      if (url.pathname === '/details') return { manga: { id: url.searchParams.get('id'), title: 'Detail' } };
      if (url.pathname === '/pages') return { pages: ['https://img.test/p1.jpg'] };
      if (url.pathname !== '/chapters') throw new Error(`unexpected ${path}`);
      const offset = ignoreOffset ? 0 : Number(url.searchParams.get('offset') || 0);
      if (failAt.has(offset)) throw new Error(`HTTP 502 for ${path}`);
      const limit = Math.min(2000, Number(url.searchParams.get('limit') || 2000));
      return { issues: (series[url.searchParams.get('id')] || []).slice(offset, offset + limit) };
    },
  };
}

const chaptersOf = (n, from = 1) =>
  Array.from({ length: n }, (_, i) => ({ id: `chapter-${from + i}`, title: `Chapter ${from + i}`, number: String(from + i) }));
const offsets = (calls) => calls.map((c) => new URL(c, 'http://x').searchParams.get('offset'));

test('chapters page past the scraper\'s 2000 cap: a 3864-chapter series shows every chapter in order', async () => {
  const scraper = chapterScraper({
    'mr:martial-peak': chaptersOf(3864),
    'mr:exact': chaptersOf(4000),
    'mr:short': chaptersOf(328),
  });
  const { manhwa } = loadManhwa(scraper);

  const peak = await manhwa.fetchManhwaChapters('mr:martial-peak');
  assert.equal(peak.length, 3864);
  assert.equal(peak[0].id, 'chapter-1');
  assert.equal(peak[2000].id, 'chapter-2001');
  assert.equal(peak.at(-1).id, 'chapter-3864');
  assert.ok(peak.every((c, i) => i === 0 || c.number > peak[i - 1].number), 'ascending reading order');
  // Stops at the first short page, asking for 2000 at a time.
  assert.deepEqual(offsets(scraper.calls), ['0', '2000']);
  assert.ok(scraper.calls.every((c) => new URL(c, 'http://x').searchParams.get('limit') === '2000'));

  scraper.calls.length = 0;
  assert.equal((await manhwa.fetchManhwaChapters('mr:exact')).length, 4000);
  assert.deepEqual(offsets(scraper.calls), ['0', '2000', '4000'], 'a full last page needs one more request to see the end');

  scraper.calls.length = 0;
  assert.equal((await manhwa.fetchManhwaChapters('mr:short')).length, 328);
  assert.deepEqual(offsets(scraper.calls), ['0'], 'a series under 2000 chapters is still one request');

  // The complete list is what gets cached.
  scraper.calls.length = 0;
  assert.equal((await manhwa.fetchManhwaChapters('mr:martial-peak')).length, 3864);
  assert.equal(scraper.calls.length, 0);
});

test('a duplicate chapter id keeps the later entry in its own place, which restores ascending order', async () => {
  // The live Tales of Demons and Gods answer, positions 966-971.
  const rows = [
    { id: 'chapter-523-1', title: 'Chapter 523.1', number: '523.1' },
    { id: 'chapter-523-6', title: 'Chapter 523.6', number: '523.6' },
    { id: 'chapter-524-5', title: 'Chapter 524-5', number: '524.5', publishAt: '2026-07-31T00:00:00.000Z' },
    { id: 'chapter-524-1', title: 'Chapter 524.1', number: '524.1' },
    { id: 'chapter-524-5', title: 'Chapter 524.5', number: '524.5', publishAt: '2026-08-01T00:00:00.000Z' },
    { id: 'chapter-525-1', title: 'Chapter 525.1', number: '525.1' },
  ];
  const { manhwa } = loadManhwa(chapterScraper({ 'mr:tales-of-demons-and-gods': rows }));
  const list = await manhwa.fetchManhwaChapters('mr:tales-of-demons-and-gods');
  assert.deepEqual(ids(list), ['chapter-523-1', 'chapter-523-6', 'chapter-524-1', 'chapter-524-5', 'chapter-525-1']);
  const kept = list.find((c) => c.id === 'chapter-524-5');
  assert.equal(kept.title, 'Chapter 524.5');
  assert.equal(kept.createdAt, '2026-08-01T00:00:00.000Z');
  assert.deepEqual(plain(list.map((c) => c.number)), [523.1, 523.6, 524.1, 524.5, 525.1]);
});

test('paging dedupes across a page boundary and numbers missing chapter numbers across the whole series', async () => {
  // A chapter inserted upstream between two requests repeats chapter 2000 at
  // the top of the second page; the second page's chapters carry no number.
  const first = chaptersOf(2000);
  const second = [first[1999], ...chaptersOf(10, 2001).map(({ number, ...c }) => c)];
  const scraper = {
    calls: [],
    async manhwaProxyFetch(path) {
      this.calls.push(path);
      const offset = new URL(path, 'http://x').searchParams.get('offset');
      return { issues: offset === '0' ? first : offset === '2000' ? second : [] };
    },
  };
  const { manhwa } = loadManhwa(scraper);
  const list = await manhwa.fetchManhwaChapters('mr:boundary');
  assert.equal(list.length, 2010);
  assertUnique(list);
  assert.equal(list[1999].id, 'chapter-2000');
  assert.equal(list[2000].id, 'chapter-2001');
  // Positional fallback is the chapter's place in the whole list, not on its page.
  assert.equal(list[2000].number, 2001);
  assert.equal(list.at(-1).number, 2010);
  assert.equal(list.at(-1).title, 'Chapter 2010');
});

test('an id-less row in a full page is dropped without ending the walk early', async () => {
  // The scraper answered a full 2000; one row is unusable. Judging "short
  // page" after the filter would stop here and lose chapters 2001-2100.
  const series = chaptersOf(2100);
  series[5] = { ...series[5], id: '' };
  const scraper = chapterScraper({ 'mr:x': series });
  const { manhwa } = loadManhwa(scraper);
  const list = await manhwa.fetchManhwaChapters('mr:x');
  assert.equal(list.length, 2099);
  assert.equal(list.at(-1).id, 'chapter-2100');
  assert.deepEqual(offsets(scraper.calls), ['0', '2000']);
});

test('a scraper that ignores offset costs one extra request, not ten', async () => {
  const scraper = chapterScraper({ 'mr:x': chaptersOf(2500) }, { ignoreOffset: true });
  const { manhwa } = loadManhwa(scraper);
  const list = await manhwa.fetchManhwaChapters('mr:x');
  assert.equal(list.length, 2000);
  assertUnique(list);
  assert.equal(scraper.calls.length, 2);
});

test('a later chapter page failing fails the whole load: nothing partial is shown or cached, the last full list is served', async () => {
  let now = 1_000_000;
  const FakeDate = class extends Date { static now() { return now; } };
  const failAt = new Set([2000]);
  const scraper = chapterScraper({ 'mr:martial-peak': chaptersOf(3864) }, { failAt });
  const { manhwa, store } = loadManhwa(scraper, 'ios', { DateImpl: FakeDate });

  // Page 0 loaded, page 1 failed: the first 2000 are NOT passed off as the series.
  assert.deepEqual(plain(await manhwa.fetchManhwaChapters('mr:martial-peak')), []);
  assert.ok(!/manhwa:chapters/.test(store.get(CACHE_FILE) || ''), 'a partial list must not be persisted');

  failAt.clear();
  assert.equal((await manhwa.fetchManhwaChapters('mr:martial-peak')).length, 3864);

  // TTL passes and the second page fails again: the last complete list is served.
  now += 60 * 60 * 1000;
  failAt.add(2000);
  scraper.calls.length = 0;
  assert.equal((await manhwa.fetchManhwaChapters('mr:martial-peak')).length, 3864);
  assert.deepEqual(offsets(scraper.calls), ['0', '2000'], 'the expired list was refetched, not just served');
});

test('null / [] the previous release cached under the old keys is not served', async () => {
  // What a device holds after opening these while the scraper was failing on
  // the previous release: its loaders swallowed the error and cached it.
  const seed = {
    'manhwa:detail:mr:x': null,
    'manhwa:chapters:mr:x': [],
    'manhwa:pages:v1:mr:x:chapter-1': [],
  };
  const scraper = chapterScraper({ 'mr:x': chaptersOf(3) });
  const { manhwa } = loadManhwa(scraper, 'ios', { seed });
  assert.equal((await manhwa.fetchManhwaDetail('mr:x')).title, 'Detail');
  assert.equal((await manhwa.fetchManhwaChapters('mr:x')).length, 3);
  assert.equal((await manhwa.fetchManhwaPages('mr:x', 'chapter-1')).length, 1);
  assert.equal(scraper.calls.length, 3);
});
