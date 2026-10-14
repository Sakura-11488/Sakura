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
    module, exports: module.exports, URL, URLSearchParams, Response, Promise, JSON, Date, Error, Object,
    process: { env: {} }, require: (name) => deps[name] || {}, ...globals,
  });
  return module.exports;
}

// Values built inside the vm carry its own prototypes; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const TYPES = 'Manga,Manwha,Manhua,OEL';

const jsonResponse = (body, status = 200, type = 'application/json; charset=utf-8') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });

/** Plausible upstream bodies per operation, so the real loaders accept them. */
function upstreamBody(url) {
  const q = new URL(url, 'https://sakura.test').searchParams;
  switch (`${q.get('s')}:${q.get('op')}`) {
    case 'atsu:trending': case 'atsu:popular': return { items: [{ id: 'a1', title: 'A' }] };
    case 'atsu:detail': return { mangaPage: { id: q.get('id'), title: 'T', poster: { image: 'posters/x.jpg' } } };
    case 'atsu:chapters': return { chapters: [{ id: 'c1', scanlationMangaId: 'g', title: 'Chapter 1', number: 1, pageCount: 3, createdAt: 1 }] };
    case 'atsu:read': return { readChapter: { pages: [{ image: '/static/pages/g/c1/0.webp' }] } };
    case 'atsu:search': return { hits: [{ document: { id: 'a1', title: 'A' } }] };
    case 'atsu:browse': return { hits: [{ document: { id: 'a1', title: 'A' } }], found: 1 };
    case 'atsu:recentlyUpdated': case 'atsu:hotUpdates': return { items: [{ id: 'a1', title: 'A', updatedAt: 1 }] };
    case 'manhwa:popular': case 'manhwa:search': return { items: [{ id: 'mr:a', title: 'A' }] };
    case 'manhwa:details': return { comic: { id: q.get('id'), title: 'A' } };
    case 'manhwa:chapters': return { issues: [{ id: 'chapter-1', number: '1' }] };
    case 'manhwa:pages': return { pages: ['https://img.test/1.jpg'] };
    default: throw new Error(`unexpected catalogue URL ${url}`);
  }
}

/**
 * The web fetchers wired to a fake same-origin route (`route`) and a fake
 * edge function (`proxy`), with hand-driven timers and clock.
 */
function setup({ route = async (url) => jsonResponse(upstreamBody(url)), proxy = async () => ({ via: 'proxy' }), browser = true } = {}) {
  const clock = { now: 1_000_000 };
  class FakeDate extends Date { static now() { return clock.now; } }
  const timers = new Map();
  let nextTimer = 1;
  const routeCalls = [];
  const proxyCalls = [];
  const client = load('../lib/catalog-client.ts', {}, {
    window: browser ? {} : undefined,
    AbortController,
    Date: FakeDate,
    fetch: (url, init) => { routeCalls.push({ url, init }); return route(url, init); },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  const contentProxy = {
    invokeContentProxy: async (req) => { proxyCalls.push(plain(req)); return proxy(req); },
    getWebMangaPageProxyUrl: (url) => url,
    getWebMediaProxyUrl: (url) => url,
  };
  const deps = { '@/lib/content-proxy-client': contentProxy, '@/lib/catalog-client': client };
  const atsu = load('../lib/atsu-fetch.web.ts', deps);
  const manhwaFetch = load('../lib/manhwa-proxy-fetch.web.ts', deps);
  const passthroughCache = { getOrSetCached: (_key, _ttl, loader) => loader() };
  const manga = load('../lib/manga.ts', {
    'react-native': { Platform: { OS: 'web' } },
    '@/lib/cache': passthroughCache,
    '@/lib/atsu-fetch': atsu,
    '@/lib/content-proxy-client': contentProxy,
  }, { fetch: () => { throw new Error('MangaDex is never reached on web'); } });
  const manhwa = load('../lib/manhwa.ts', {
    'react-native': { Platform: { OS: 'web' } },
    '@/lib/cache': passthroughCache,
    '@/lib/manhwa-proxy-fetch': manhwaFetch,
    '@/lib/content-proxy-client': contentProxy,
    '@/lib/content-hosts': { MANHWA_PROXY_DEFAULT: 'http://165.232.83.159/manhwa/v1' },
  });
  return {
    client, atsu, manhwaFetch, manga, manhwa, clock, timers, routeCalls, proxyCalls,
    fireTimers() { for (const [id, { fn }] of [...timers]) { timers.delete(id); fn(); } },
  };
}

// The same strings the hosting repo's scripts/catalog.test.cjs pins as the
// route's canonical forms; the two sides must agree byte for byte.
const SEARCH = new URLSearchParams({
  q: 'solo leveling',
  query_by: 'title,englishTitle,otherNames,authors',
  query_by_weights: '4,3,2,1',
  num_typos: '4,3,2,1',
  include_fields: 'id,title,englishTitle,poster,posterSmall,posterMedium,type,isAdult,status,year,mbRating,popularity',
  filter_by: 'hidden:!=true && isAdult:=false && type:=[Manga,Manwha,Manhua,OEL]',
  infix: 'off,off,fallback,off',
  page: '1',
  per_page: '24',
});
const BROWSE = new URLSearchParams({
  q: '*',
  filter_by: 'hidden:!=true && isAdult:=false && medium:=Comic && type:=[Manga,Manwha,Manhua,OEL] && genreIds:!=[10,41,46]'
    + ' && genreWeightKeys:=[`29:core`,`29:defining`] && status:=Ongoing',
  sort_by: 'views:desc',
  include_fields: 'id,title,englishTitle,poster,posterSmall,posterMedium,type,mbRating',
  page: '1',
  per_page: '30',
});
const UPDATES = `offset=40&limit=40&types=${encodeURIComponent(TYPES)}&mediums=Comic`;
const CANONICAL = [
  ['atsu', `/collections/manga/documents/search?${BROWSE}`,
    '/api/catalog/?s=atsu&op=browse&genre=29&status=Ongoing&sort=popular&page=1&limit=30'],
  ['atsu', `/api/home2/recentlyUpdated?${UPDATES}`, '/api/catalog/?s=atsu&op=recentlyUpdated&offset=40&limit=40'],
  ['atsu', `/api/home2/hotUpdates?${UPDATES}`, '/api/catalog/?s=atsu&op=hotUpdates&offset=40&limit=40'],
  ['atsu', `https://atsu.moe/api/infinite/trending?page=0&types=${encodeURIComponent(TYPES)}`, '/api/catalog/?s=atsu&op=trending&page=0'],
  ['atsu', `https://atsu.moe/api/infinite/popular?page=50&types=${encodeURIComponent(TYPES)}`, '/api/catalog/?s=atsu&op=popular&page=50'],
  ['atsu', '/api/manga/page?id=sVC2A', '/api/catalog/?s=atsu&op=detail&id=sVC2A'],
  ['atsu', '/api/manga/allChapters?mangaId=sVC2A', '/api/catalog/?s=atsu&op=chapters&id=sVC2A'],
  ['atsu', '/api/read/chapter?mangaId=sVC2A&chapterId=YrFZ5', '/api/catalog/?s=atsu&op=read&mangaId=sVC2A&chapterId=YrFZ5'],
  ['atsu', `/collections/manga/documents/search?${SEARCH}`, '/api/catalog/?s=atsu&op=search&q=solo+leveling&limit=24'],
  ['manhwa', '/popular?limit=60', '/api/catalog/?s=manhwa&op=popular&limit=60'],
  ['manhwa', '/search?q=martial&limit=48&offset=0', '/api/catalog/?s=manhwa&op=search&q=martial&limit=48&offset=0'],
  ['manhwa', '/details?id=mr%3Amartial-peak', '/api/catalog/?s=manhwa&op=details&id=mr%3Amartial-peak'],
  ['manhwa', '/chapters?id=cz%3Asolo-leveling&limit=2000&offset=2000',
    '/api/catalog/?s=manhwa&op=chapters&id=cz%3Asolo-leveling&limit=2000&offset=2000'],
  ['manhwa', '/pages?id=mr%3Amartial-peak&chapterId=chapter-524.5',
    '/api/catalog/?s=manhwa&op=pages&id=mr%3Amartial-peak&chapterId=chapter-524.5'],
];

test('each catalogue request maps to the one URL the route accepts, and its answer is returned as is', async () => {
  for (const [source, path, expected] of CANONICAL) {
    const env = setup();
    const data = source === 'atsu'
      ? await (await env.atsu.atsuFetch(path)).json()
      : await env.manhwaFetch.manhwaProxyFetch(path);
    assert.deepEqual(env.routeCalls.map((c) => c.url), [expected], path);
    assert.deepEqual(plain(data), upstreamBody(expected), path);
    assert.deepEqual(env.proxyCalls, [], `${path}: the edge function is not called`);
    // No custom headers: the edge cache keys on Accept, and a preload of the
    // same URL sends the default one.
    assert.equal(env.routeCalls[0].init.headers, undefined);
    assert.equal(env.routeCalls[0].init.method, undefined);
  }
});

test('the real loaders reach the route for every list, detail, chapter and page read', async () => {
  const env = setup();
  assert.equal((await env.manga.fetchTrendingManga(5)).length, 1);
  assert.equal((await env.manga.fetchPopularManga(5)).length, 1);
  assert.equal((await env.manga.fetchMangaPagedList('popular', 3)).length, 1);
  assert.equal((await env.manga.fetchMangaDetail('sVC2A')).title, 'T');
  assert.equal((await env.manga.fetchMangaChapters('sVC2A')).length, 1);
  assert.equal((await env.manga.fetchMangaChapterPages('sVC2A', 'YrFZ5')).length, 1);
  assert.equal((await env.manga.searchManga('solo leveling', 24)).length, 1);
  assert.equal((await env.manhwa.searchManhwa('martial', 24)).length, 1);
  assert.equal((await env.manhwa.fetchManhwaDetail('mr:martial-peak')).title, 'A');
  assert.equal((await env.manhwa.fetchManhwaChapters('mr:martial-peak')).length, 1);
  assert.equal((await env.manhwa.fetchManhwaPages('mr:martial-peak', 'chapter-1')).length, 1);
  assert.ok((await env.manhwa.fetchTrendingManhwa(1)).length >= 1);
  assert.equal((await env.manga.browseManga({ genreId: '29', status: 'Ongoing', sort: 'popular' }, 0, 30)).items.length, 1);
  assert.equal((await env.manga.browseManga({ sort: 'added' }, 499, 60)).items.length, 1);
  assert.equal((await env.manga.fetchRecentlyUpdatedManga(1, 40)).length, 1);
  assert.equal((await env.manga.fetchHotUpdatedManga(20)).length, 1);
  const urls = env.routeCalls.map((c) => c.url);
  for (const expected of [
    '/api/catalog/?s=atsu&op=trending&page=0',
    '/api/catalog/?s=atsu&op=popular&page=0',
    '/api/catalog/?s=atsu&op=popular&page=3',
    '/api/catalog/?s=atsu&op=detail&id=sVC2A',
    '/api/catalog/?s=atsu&op=chapters&id=sVC2A',
    '/api/catalog/?s=atsu&op=read&mangaId=sVC2A&chapterId=YrFZ5',
    '/api/catalog/?s=atsu&op=search&q=solo+leveling&limit=24',
    '/api/catalog/?s=manhwa&op=search&q=martial&limit=24&offset=0',
    '/api/catalog/?s=manhwa&op=details&id=mr%3Amartial-peak',
    '/api/catalog/?s=manhwa&op=chapters&id=mr%3Amartial-peak&limit=2000&offset=0',
    '/api/catalog/?s=manhwa&op=pages&id=mr%3Amartial-peak&chapterId=chapter-1',
    '/api/catalog/?s=manhwa&op=popular&limit=60',
    '/api/catalog/?s=atsu&op=browse&genre=29&status=Ongoing&sort=popular&page=1&limit=30',
    '/api/catalog/?s=atsu&op=browse&genre=&status=&sort=added&page=500&limit=60',
    '/api/catalog/?s=atsu&op=recentlyUpdated&offset=40&limit=40',
    '/api/catalog/?s=atsu&op=hotUpdates&offset=0&limit=20',
  ]) {
    assert.ok(urls.includes(expected), `${expected} in ${urls.join(' ')}`);
  }
  assert.deepEqual(env.proxyCalls, [], 'nothing needed the edge function');
});

test('requests the route does not cover go to the edge function unchanged', async () => {
  const atsuCases = [
    ['/api/explore/filteredView', { method: 'POST', body: JSON.stringify({ page: 0 }) }],
    [`/api/infinite/trending?page=0&types=Manga`],
    [`/api/infinite/trending?page=51&types=${encodeURIComponent(TYPES)}`],
    [`/api/infinite/trending?page=00&types=${encodeURIComponent(TYPES)}`],
    [`/api/infinite/trending?page=0&types=${encodeURIComponent(TYPES)}&extra=1`],
    ['/api/manga/page?id=a/b'],
    ['/api/manga/page?id=sVC2A&x=1'],
    ['/api/read/chapter?mangaId=sVC2A'],
    [`/collections/manga/documents/search?${new URLSearchParams({ ...Object.fromEntries(SEARCH), filter_by: 'isAdult:=true' })}`],
    [`/collections/manga/documents/search?${new URLSearchParams({ ...Object.fromEntries(SEARCH), per_page: '250' })}`],
    [`/collections/manga/documents/search?${new URLSearchParams({ ...Object.fromEntries(SEARCH), q: ' padded ' })}`],
    ['/api/manga/page', { query: { id: 'sVC2A' }, method: 'POST' }],
    // Browse: any filter but the exact one browseManga builds stays on the edge function.
    [`/collections/manga/documents/search?${new URLSearchParams({ ...Object.fromEntries(BROWSE), filter_by: 'isAdult:=true' })}`],
    [`/collections/manga/documents/search?${new URLSearchParams({
      ...Object.fromEntries(BROWSE), filter_by: BROWSE.get('filter_by').replace('isAdult:=false && ', '') })}`],
    [`/collections/manga/documents/search?${new URLSearchParams({ ...Object.fromEntries(BROWSE), sort_by: 'views:asc' })}`],
    [`/collections/manga/documents/search?${new URLSearchParams({ ...Object.fromEntries(BROWSE), include_fields: 'id' })}`],
    [`/collections/manga/documents/search?${new URLSearchParams({ ...Object.fromEntries(BROWSE), per_page: '61' })}`],
    [`/api/home2/recentlyUpdated?offset=0&limit=40&types=${encodeURIComponent(TYPES)}`],
    [`/api/home2/recentlyUpdated?offset=0&limit=40&types=${encodeURIComponent(TYPES)}&mediums=Novel`],
  ];
  for (const [path, init] of atsuCases) {
    const env = setup();
    const res = await env.atsu.atsuFetch(path, init);
    assert.deepEqual(await res.json(), { via: 'proxy' }, path);
    assert.equal(env.routeCalls.length, 0, path);
    assert.equal(env.proxyCalls.length, 1, path);
    assert.equal(env.proxyCalls[0].source, 'atsu');
  }
  for (const path of ['/popular?limit=61', '/popular?limit=24&offset=24', '/search?q=a&limit=24', '/details?id=martial-peak',
    '/chapters?id=mr%3Aa&limit=5000&offset=0', '/pages?id=mr%3Aa', '/img?u=https%3A%2F%2Fx.test%2F1.jpg', '/healthz']) {
    const env = setup();
    assert.deepEqual(plain(await env.manhwaFetch.manhwaProxyFetch(path)), { via: 'proxy' }, path);
    assert.equal(env.routeCalls.length, 0, path);
    assert.equal(env.proxyCalls[0].source, 'manhwa');
  }
  // Exactly what the edge function received before this change.
  const env = setup();
  await env.manhwaFetch.manhwaProxyFetch('/search?q=a&limit=24');
  assert.deepEqual(env.proxyCalls[0], { source: 'manhwa', path: '/search', method: 'GET', query: { q: 'a', limit: '24' } });
});

test('a failure for one title falls back for that call only', async () => {
  let fail = true;
  const env = setup({
    route: async (url) => (fail
      ? jsonResponse({ error: 'The catalogue source is unavailable.', code: 'CATALOG_UPSTREAM_ERROR', upstreamStatus: 503 }, 502)
      : jsonResponse(upstreamBody(url))),
    proxy: async () => ({ mangaPage: { id: 'sVC2A', title: 'From proxy' } }),
  });
  const res = await env.atsu.atsuFetch('/api/manga/page?id=sVC2A');
  assert.equal((await res.json()).mangaPage.title, 'From proxy');
  assert.equal(env.routeCalls.length, 1);
  assert.deepEqual(env.proxyCalls, [{ source: 'atsu', path: '/api/manga/page', method: 'GET', query: { id: 'sVC2A' } }]);
  fail = false;
  await env.atsu.atsuFetch('/api/manga/page?id=sVC2A');
  assert.equal(env.routeCalls.length, 2, 'the route is still used for the next call');
  assert.equal(env.proxyCalls.length, 1);
});

test('an operation whose upstream keeps refusing the route is paused, not paid for on every read', async () => {
  // atsu blocking Vercel's addresses answers every read with the route's own
  // 502: without a pause each read would cost a function call before the
  // edge function, which is slower than before the route existed.
  const failing = new Set(['detail']);
  const env = setup({
    route: async (url) => (failing.has(new URL(url, 'https://sakura.test').searchParams.get('op'))
      ? jsonResponse({ error: 'The catalogue source is unavailable.', code: 'CATALOG_UPSTREAM_ERROR', upstreamStatus: 403 }, 502)
      : jsonResponse(upstreamBody(url))),
    proxy: async () => ({ mangaPage: { id: 'x', title: 'From proxy' } }),
  });
  assert.equal(env.client.CATALOG_OP_FAILURES_BEFORE_PAUSE, 2);
  await env.atsu.atsuFetch('/api/manga/page?id=a');
  await env.atsu.atsuFetch('/api/manga/page?id=b');
  assert.equal(env.routeCalls.length, 2, 'two different titles failed in a row');
  await env.atsu.atsuFetch('/api/manga/page?id=c');
  assert.equal(env.routeCalls.length, 2, 'the third goes straight to the edge function');
  assert.equal(env.proxyCalls.length, 3);
  await env.atsu.atsuFetch('/api/manga/allChapters?mangaId=a');
  assert.equal(env.routeCalls.length, 3, 'other operations keep the route');
  assert.equal(env.proxyCalls.length, 3);
  env.clock.now += env.client.CATALOG_RETRY_AFTER_MS;
  failing.clear();
  await env.atsu.atsuFetch('/api/manga/page?id=c');
  assert.equal(env.routeCalls.length, 4, 'tried again after the pause');
  assert.equal(env.proxyCalls.length, 3);

  // A success or a not-found in between proves the upstream answers the
  // route, so isolated failures never add up to a pause.
  const mixed = [502, 200, 502, 404, 502, 200];
  const env2 = setup({
    route: async (url) => {
      const status = mixed.shift();
      if (status === 200) return jsonResponse(upstreamBody(url));
      return jsonResponse({ error: 'x', code: status === 404 ? 'CATALOG_NOT_FOUND' : 'CATALOG_TIMEOUT' }, status);
    },
    proxy: async () => ({ issues: [] }),
  });
  for (let i = 0; i < 6; i += 1) await env2.manhwaFetch.manhwaProxyFetch(`/details?id=mr%3At${i}`);
  assert.equal(env2.routeCalls.length, 6);
});

test('when the route itself is missing or broken it is skipped for a while', async () => {
  const outages = [
    ['not deployed (Vercel 404 page)', async () => new Response('<!doctype html>404', { status: 404, headers: { 'content-type': 'text/html' } })],
    ['dev server SPA fallback', async () => new Response('<!doctype html><div id=root>', { headers: { 'content-type': 'text/html' } })],
    ['platform error page', async () => new Response('An error occurred with your deployment', { status: 504, headers: { 'content-type': 'text/plain' } })],
    ['JSON error that is not ours', async () => jsonResponse({ message: 'nope' }, 500)],
    ['network failure', async () => { throw new TypeError('Failed to fetch'); }],
    ['a body that is not the JSON it claims', async () => jsonResponse('{"items":[')],
  ];
  for (const [label, route] of outages) {
    const env = setup({ route });
    const path = '/popular?limit=60';
    assert.deepEqual(plain(await env.manhwaFetch.manhwaProxyFetch(path)), { via: 'proxy' }, label);
    await env.manhwaFetch.manhwaProxyFetch(path);
    assert.equal(env.routeCalls.length, 1, `${label}: one probe, then the edge function directly`);
    assert.equal(env.proxyCalls.length, 2, label);
    env.clock.now += env.client.CATALOG_RETRY_AFTER_MS;
    await env.manhwaFetch.manhwaProxyFetch(path);
    assert.equal(env.routeCalls.length, 2, `${label}: tried again after the pause`);
  }
});

test('a hung route is abandoned after its timeout and the edge function answers', async () => {
  let signal;
  const env = setup({
    route: (url, init) => new Promise((_, reject) => {
      signal = init.signal;
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  const pending = env.atsu.atsuFetch('/api/manga/allChapters?mangaId=sVC2A');
  await tick();
  assert.deepEqual([...env.timers.values()].map((t) => t.ms), [env.client.CATALOG_TIMEOUT_MS]);
  assert.ok(env.client.CATALOG_TIMEOUT_MS < 25_000, 'leaves the edge function its own deadline');
  env.fireTimers();
  assert.deepEqual(await (await pending).json(), { via: 'proxy' });
  assert.equal(signal.aborted, true);
  assert.equal(env.timers.size, 0);
});

test('the edge function still defines the error a failed read throws', async () => {
  const env = setup({
    route: async () => jsonResponse({ error: 'This title is not in the catalogue.', code: 'CATALOG_NOT_FOUND' }, 404),
    proxy: async () => { throw new Error('Upstream HTTP 404'); },
  });
  await assert.rejects(env.manhwaFetch.manhwaProxyFetch('/details?id=mr%3Agone'), /Upstream HTTP 404/);
  await assert.rejects(env.atsu.atsuFetch('/api/manga/page?id=gone'), /Upstream HTTP 404/);
});

test('outside a browser the route is not tried', async () => {
  const env = setup({ browser: false });
  await env.atsu.atsuFetch('/api/manga/page?id=sVC2A');
  assert.equal(env.routeCalls.length, 0);
  assert.equal(env.proxyCalls.length, 1);
});
