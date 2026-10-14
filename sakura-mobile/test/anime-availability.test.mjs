import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const lib = new URL('../lib/', import.meta.url);

function loadTs(name, mocks = {}, globals = {}) {
  const output = ts.transpileModule(readFileSync(new URL(name, lib), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, console, URL, AbortController,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)), clearTimeout,
    require: (id) => {
      if (id in mocks) return mocks[id];
      if (id === './anime-network') return loadTs('anime-network.ts', mocks, globals);
      throw new Error(`Unexpected dependency: ${id}`);
    },
    ...globals,
  });
  return module.exports;
}

function animeHarness(options = {}) {
  const requests = [];
  const cache = new Map();
  const metadata = options.metadata ?? { malId: 20, title: 'Naruto', status: 'FINISHED', episodes: 220, image: '/cover.jpg', genres: ['Action'] };
  const anime = loadTs('anime.ts', {
    '@/lib/cache': {
      getCachedValue: async (key) => cache.get(key) ?? null,
      setCachedValue: async (key, value) => cache.set(key, value),
    },
    '@/lib/consumet-client': {
      consuGet: async (path) => {
        requests.push(path);
        if (path === `/api/meta/${metadata.malId}`) return metadata;
        throw new Error('Provider extraction is unavailable.');
      },
      consumetCandidates: () => ['https://example.test'],
      getActiveConsumetUrl: () => 'https://example.test',
      setActiveConsumetUrl: () => {},
    },
    '@/lib/anime-upstream': {
      HIANIME_BASE: 'https://hianime.dk',
      fetchUpstreamText: async () => options.removed ? '<title>Error 410</title>' : '<div data-id="104103"></div>',
      fetchUpstreamJson: async () => ({ enc: 'provider-owned-format', intro: { start: 0, end: 25 } }),
    },
    './sakura-originals': { isSakuraOriginal: () => false, resolveSakuraOriginalStreamUrl: async () => null },
    './anime-stream-client': { usesBrowserAnimeStream: false, fetchBrowserAnimeStream: async () => null },
    './anime-discovery': { primeAnimeDiscovery: () => {} },
  }, {
    fetch: options.fetch ?? (() => new Promise(() => {})),
    Date: options.Date ?? Date,
  });
  return { anime, requests, cache };
}

test('a hung metadata request falls back to the indexed episode count without waiting for thumbnails or stream matching', async () => {
  const { anime, requests } = animeHarness();
  const info = await anime.fetchAnimeInfo('20');
  assert.equal(info.title, 'Naruto');
  assert.equal(info.episodes.length, 220);
  assert.equal(info.episodes[0].id, 'mal-20-1');
  assert.deepEqual(requests, ['/api/meta/20']);
  const again = await anime.fetchAnimeInfo('20');
  assert.equal(again.episodes.length, 220);
  assert.deepEqual(requests, ['/api/meta/20'], 'MAL-addressed episode lists remain cacheable');
});

test('response bodies have the same timeout as the metadata headers', async () => {
  const { anime } = animeHarness({ fetch: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) });
  const info = await anime.fetchAnimeInfo('20');
  assert.equal(info.episodes.length, 220);
});

function scheduledAnimeHarness({ schedule, seed = true, status = 'Not yet aired', prefix = 'mal-61323' } = {}) {
  const clock = { now: 1_800_000_000_000 };
  class TestDate extends Date { static now() { return clock.now; } }
  let releaseRequests = 0;
  const h = animeHarness({
    Date: TestDate,
    metadata: { malId: 61323, title: 'Blue Box Season 2', status: 'UPCOMING', episodes: 12 },
    fetch: async (url, options) => {
      if (url !== 'https://graphql.anilist.co') throw new Error('Jikan unavailable');
      // These cases exercise records built from the fallback metadata; the
      // AniList title record (tested separately) is unavailable here.
      if (JSON.parse(options.body).query.includes('SakuraTitle')) throw new Error('AniList title unavailable');
      if (!JSON.parse(options.body).query.includes('nextAiringEpisode')) {
        return { ok: true, json: async () => ({ data: { Media: { streamingEpisodes: [] } } }) };
      }
      releaseRequests++;
      const media = schedule
        ? await schedule(clock, releaseRequests)
        : { idMal: 61323, status: 'RELEASING', nextAiringEpisode: { episode: 3, airingAt: Math.floor(clock.now / 1000) + 3600 } };
      return { ok: true, json: async () => ({ data: { Media: media } }) };
    },
  });
  const original = { id: '61323', title: 'Blue Box Season 2', status,
    episodes: Array.from({ length: 12 }, (_, index) => ({
      id: `${prefix}-${index + 1}`, number: index + 1, title: `Episode ${index + 1}`, thumbnail: '/thumb.jpg',
    })),
  };
  if (seed) h.cache.set('anime:info3_61323', original);
  return { ...h, clock, original, get releaseRequests() { return releaseRequests; } };
}

test('a fresh future airing schedule caps a new planned list without trusting stale upcoming metadata', async () => {
  const h = scheduledAnimeHarness({ seed: false });
  const info = await h.anime.fetchAnimeInfo('61323');
  assert.equal(info.status, 'Currently Airing');
  assert.deepEqual(Array.from(info.episodes, episode => episode.id), ['mal-61323-1', 'mal-61323-2']);
  assert.equal(h.cache.get('anime:info3_61323').episodes.length, 12, 'content cache retains the complete list');
  assert.equal(h.releaseRequests, 1);
});

test('cached planned episodes are capped without mutation and the bound refreshes within five minutes', async () => {
  const h = scheduledAnimeHarness({ schedule: (clock, request) => ({
    idMal: 61323, status: 'RELEASING',
    nextAiringEpisode: { episode: request === 1 ? 3 : 4, airingAt: Math.floor(clock.now / 1000) + 3600 },
  }) });
  assert.equal((await h.anime.fetchAnimeInfo('61323')).episodes.length, 2);
  assert.equal((await h.anime.fetchAnimeInfo('61323')).episodes.length, 2);
  assert.equal(h.releaseRequests, 1);
  h.clock.now += 5 * 60_000 + 1;
  assert.equal((await h.anime.fetchAnimeInfo('61323')).episodes.length, 3);
  assert.equal(h.releaseRequests, 2);
  assert.equal(h.original.episodes.length, 12);
  assert.equal(h.original.status, 'Not yet aired');
});

test('the airing boundary expires earlier than the cache limit so a newly aired episode can return', async () => {
  const h = scheduledAnimeHarness({ schedule: (clock, request) => ({
    idMal: 61323, status: 'RELEASING',
    nextAiringEpisode: { episode: request === 1 ? 3 : 4, airingAt: Math.floor(clock.now / 1000) + (request === 1 ? 1 : 3600) },
  }) });
  assert.equal((await h.anime.fetchAnimeInfo('61323')).episodes.length, 2);
  h.clock.now += 1000;
  assert.equal((await h.anime.fetchAnimeInfo('61323')).episodes.length, 3);
  assert.equal(h.releaseRequests, 2);
});

test('an explicit refresh resolves the airing bound again instead of retaining the prior cap', async () => {
  const h = scheduledAnimeHarness({ schedule: (clock, request) => ({
    idMal: 61323, status: 'RELEASING',
    nextAiringEpisode: { episode: request === 1 ? 3 : 4, airingAt: Math.floor(clock.now / 1000) + 3600 },
  }) });
  assert.equal((await h.anime.fetchAnimeInfo('61323')).episodes.length, 2);
  assert.equal((await h.anime.fetchAnimeInfo('61323', { force: true })).episodes.length, 3);
  assert.equal(h.releaseRequests, 2);
});

test('missing, stale, mismatched and malformed schedules never hide existing episodes', async () => {
  const valid = { idMal: 61323, status: 'RELEASING', nextAiringEpisode: { episode: 3, airingAt: 1_800_003_600 } };
  for (const media of [null, { ...valid, idMal: 123 }, { ...valid, status: 'NOT_YET_RELEASED' },
    { ...valid, nextAiringEpisode: null },
    ...[0, -1, 1.5, 50002, '3'].map(episode => ({ ...valid, nextAiringEpisode: { ...valid.nextAiringEpisode, episode } })),
    ...[1_800_000_000, 1_799_999_999, 1_800_003_600.25, Infinity, '1800003600'].map(airingAt => ({ ...valid, nextAiringEpisode: { episode: 3, airingAt } })),
  ]) {
    const h = scheduledAnimeHarness({ schedule: () => media });
    const info = await h.anime.fetchAnimeInfo('61323');
    assert.equal(info.episodes.length, 12, JSON.stringify(media));
    assert.equal(info.status, 'Not yet aired');
  }
});

test('an unavailable or stalled schedule preserves the original episodes', async () => {
  for (const schedule of [() => { throw new Error('AniList unavailable'); }, () => new Promise(() => {})]) {
    const h = scheduledAnimeHarness({ schedule });
    assert.equal((await h.anime.fetchAnimeInfo('61323')).episodes.length, 12);
  }
});

test('finished series and provider episode lists do not use the metadata release cap', async () => {
  for (const options of [{ status: 'Finished Airing' }, { status: 'FINISHED' }, { prefix: 'hi-8719' }]) {
    const h = scheduledAnimeHarness(options);
    assert.equal((await h.anime.fetchAnimeInfo('61323')).episodes.length, 12);
    assert.equal(h.releaseRequests, 0);
  }
});

test('encoded public-player responses produce an immediate embed while the old extraction API is broken', async () => {
  const { anime, requests } = animeHarness();
  const source = await anime.fetchEpisodeSources('mal-20-1', 'sub', '20');
  assert.equal(source.embedUrl, 'https://megaplay.buzz/stream/mal/20/1/sub');
  assert.equal(source.url, '');
  assert.equal(source.isM3U8, false);
  assert.equal(source.requestHeaders.Referer, 'https://megaplay.buzz/');
  assert.deepEqual(requests, [], 'a supported player does not need the stale droplet extractor');
});

test('native upstream reads abort when the response body never finishes', async () => {
  let signal;
  const upstream = loadTs('anime-upstream.ts', {}, {
    fetch: async (_url, options) => {
      signal = options.signal;
      return { ok: true, text: () => new Promise(() => {}) };
    },
  });
  await assert.rejects(upstream.fetchUpstreamText('https://example.test'), /timed out/);
  assert.equal(signal.aborted, true);
});

test('web consumet honors the caller timeout even when the edge proxy never settles', async () => {
  const client = loadTs('consumet-client.web.ts', {
    '@/lib/content-proxy-client': { invokeContentProxy: () => new Promise(() => {}) },
    '@/lib/consumet-config': {
      consumetCandidates: () => ['https://example.test'], getActiveConsumetUrl: () => 'https://example.test',
      setActiveConsumetUrl: () => {},
    },
  });
  await assert.rejects(client.consuGet('/api/meta/20', 5, 0), /timed out/);
});
