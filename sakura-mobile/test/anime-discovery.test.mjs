import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const source = require('typescript').transpileModule(readFileSync(new URL('../lib/anime-discovery.ts', import.meta.url), 'utf8'), { compilerOptions: { target: 9, module: 1 } }).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
const json = value => new Response(JSON.stringify(value));
function load(extra = {}) { const module = { exports: {} }; vm.runInNewContext(source, { module, exports: module.exports, URL, AbortController, setTimeout, clearTimeout, ...extra }); return module.exports; }
const media = (id = 20, extra = {}) => ({ idMal: id, type: 'ANIME', title: { english: `Series ${id}` }, coverImage: { large: 'https://example.com/cover.jpg' }, averageScore: 85, seasonYear: 2025, format: 'TV', ...extra });
const discovery = (...items) => ({ data: { Media: { recommendations: { nodes: items.map(item => ({ mediaRecommendation: item })) }, relations: { edges: [] } } } });

test('recommendations and real relation labels validate identities, media types, safe images, and duplicates', () => {
  const api = load();
  const payload = discovery(media(), media(), media(21, { isAdult: true }), media(22, { type: 'MANGA' }), media(23, { title: {} }), media(24, { coverImage: { large: 'javascript:alert(1)' } }));
  payload.data.Media.relations.edges = [{ relationType: 'SEQUEL', node: media(30) }, { relationType: 'PREQUEL', node: media(31) }, { relationType: 'CHARACTER', node: media(32) }];
  const result = api.parseAnimeDiscovery(payload);
  assert.deepEqual(plain(result.recommendations.map(row => row.id)), ['20', '24']);
  assert.equal(result.recommendations[1].image, '');
  assert.deepEqual(plain(result.relations.map(row => row.relation)), ['Prequel', 'Sequel']);
  assert.equal(result.recommendations[0].score, 8.5);
});

test('discovery uses GraphQL variables, excludes cookies, and returns independent cached snapshots', async () => {
  const api = load(); let calls = 0, request;
  const options = { fetch: async (url, init) => { calls++; request = { url, init }; return json(discovery(media())); } };
  const first = await api.fetchAnimeDiscovery('21', options);
  assert.equal(request.url, 'https://graphql.anilist.co');
  assert.equal(JSON.parse(request.init.body).variables.id, 21);
  assert.equal(request.init.credentials, 'omit');
  first.recommendations[0].title = 'mutated';
  assert.equal((await api.fetchAnimeDiscovery('21', options)).recommendations[0].title, 'Series 20');
  assert.equal(calls, 1);
  await api.fetchAnimeDiscovery('21', { ...options, force: true });
  assert.equal(calls, 2);
  assert.deepEqual(plain(await api.fetchAnimeDiscovery('mal-21', options)), { recommendations: [], relations: [] });
  assert.equal(calls, 2);
});

test('temporary AniList failures fall back to actual Jikan recommendations without inventing seasons', async () => {
  const api = load(), urls = [];
  const result = await api.fetchAnimeDiscovery('21', { fetch: async url => {
    urls.push(url);
    if (url.includes('anilist')) return new Response('', { status: 503 });
    return json({ data: [{ entry: { mal_id: 20, title: 'Naruto', images: { jpg: { large_image_url: 'https://example.com/naruto.jpg' } } } }] });
  } });
  assert.equal(urls[1], 'https://api.jikan.moe/v4/anime/21/recommendations');
  assert.equal(result.recommendations[0].title, 'Naruto');
  assert.deepEqual(plain(result.relations), []);
});

test('cancellation is prompt and cannot cache a late response or start fallback', async () => {
  const api = load(), controller = new AbortController(); let resolve, count = 0;
  const pending = api.fetchAnimeDiscovery('21', { signal: controller.signal, fetch: async () => { count++; return new Promise(done => { resolve = done; }); } });
  await Promise.resolve(); controller.abort();
  await assert.rejects(pending, /cancelled/);
  resolve(json(discovery(media(20)))); await Promise.resolve();
  const fresh = await api.fetchAnimeDiscovery('21', { fetch: async () => { count++; return json(discovery(media(99))); } });
  assert.equal(fresh.recommendations[0].id, '99'); assert.equal(count, 2);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(api.fetchAnimeDiscovery('20', { signal: cancelled.signal, fetch: () => { throw new Error('must not call'); } }), /cancelled/);
});

test('schedule validates dates, deduplicates pages, and queries exact local week boundaries', async () => {
  const api = load(), start = new Date(2026, 9, 5).getTime(), end = api.shiftScheduleDays(start, 7), requests = [];
  const options = { fetch: async (_url, init) => {
    const { variables } = JSON.parse(init.body); requests.push(variables);
    return json({ data: { Page: { pageInfo: { hasNextPage: variables.page === 1 }, airingSchedules: [
      { id: 10, episode: 3, airingAt: start / 1000, media: media(20) },
      { id: variables.page + 20, episode: variables.page, airingAt: (start + variables.page * 1000) / 1000, media: media(21) },
      { id: 90, episode: 0, airingAt: start / 1000, media: media() },
      { id: 91, episode: 1, airingAt: end / 1000, media: media() },
      { id: 92, episode: 2, airingAt: start / 1000, media: media(40, { isAdult: true }) },
    ] } } });
  } };
  const result = await api.fetchAnimeScheduleWeek(start, options);
  assert.equal(result.episodes.length, 3); assert.equal(result.partial, false);
  assert.equal(requests.length, 2); assert.equal(requests[0].from, start / 1000 - 1); assert.equal(requests[0].to, end / 1000);
  result.episodes.length = 0;
  assert.equal((await api.fetchAnimeScheduleWeek(start, options)).episodes.length, 3); assert.equal(requests.length, 2);
  await assert.rejects(api.fetchAnimeScheduleWeek(NaN, options), /valid week/);
});

test('schedule bounds pagination and reports incomplete weeks honestly', async () => {
  const api = load(); let count = 0;
  const result = await api.fetchAnimeScheduleWeek(Date.now(), { fetch: async () => { count++; return json({ data: { Page: { pageInfo: { hasNextPage: true }, airingSchedules: [] } } }); } });
  assert.equal(count, 6); assert.equal(result.partial, true);
});

test('calendar arithmetic uses local midnights across daylight-saving changes', () => {
  const previous = process.env.TZ; process.env.TZ = 'America/New_York';
  try {
    const api = load({ Date }), monday = api.startOfScheduleWeek(new Date(2026, 10, 1, 15).getTime());
    assert.equal(new Date(monday).getDay(), 1); assert.equal(new Date(monday).getHours(), 0);
    const next = api.shiftScheduleDays(monday, 7);
    assert.equal(new Date(next).getHours(), 0); assert.equal((next - monday) / 3600000, 169);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('personal seeds come from genuine watch activity and saved titles, not trending or empty bookmarks', () => {
  const api = load();
  const history = [{ animeId: '20', title: 'Watched', updatedAt: 10, progress: .3 }, { animeId: '21', title: 'Just queued', updatedAt: 100, progress: 0 }, { animeId: 'original-local', title: 'Local', updatedAt: 100, progress: 1 }];
  const saved = [{ id: '20', title: 'Dup', type: 'anime', savedAt: 100 }, { id: '30', title: 'Saved', type: 'anime', savedAt: 10 }, { id: '31', title: 'Manga', type: 'manga', savedAt: 100 }];
  assert.deepEqual(plain(api.chooseDiscoverySeeds(history, saved)), [{ id: '20', title: 'Watched', reason: 'watched' }, { id: '30', title: 'Saved', reason: 'saved' }]);
  assert.deepEqual(plain(api.chooseDiscoverySeeds([{ animeId: '40', title: 'Reset', updatedAt: 100, progress: 0, episodeHistory: { one: { watched: false, progress: 0, positionSeconds: 0 } } }], [])), []);
  assert.equal(api.chooseDiscoverySeeds([{ animeId: '40', title: 'Queued next', updatedAt: 100, progress: 0, episodeHistory: { one: { watched: true, progress: 1 } } }], [])[0].reason, 'watched');
});


test('metadata refresh and Continue Watching dismissal do not outrank more recent playback seeds', () => {
  const api = load();
  const history = [
    { animeId: '20', title: 'Old viewing, fresh metadata', updatedAt: 1000, lastPlayedAt: 10, progress: .3 },
    { animeId: '21', title: 'Recently watched', updatedAt: 100, lastPlayedAt: 100, progress: .2 },
    { animeId: '22', title: 'Legacy recent viewing', updatedAt: 50, progress: .4 },
  ];
  assert.deepEqual(plain(api.chooseDiscoverySeeds(history, [])), [
    { id: '21', title: 'Recently watched', reason: 'watched' },
    { id: '22', title: 'Legacy recent viewing', reason: 'watched' },
  ]);
});
