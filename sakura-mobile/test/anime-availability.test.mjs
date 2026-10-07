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
  const metadata = { malId: 20, title: 'Naruto', status: 'FINISHED', episodes: 220, image: '/cover.jpg', genres: ['Action'] };
  const anime = loadTs('anime.ts', {
    '@/lib/cache': {
      getCachedValue: async (key) => cache.get(key) ?? null,
      setCachedValue: async (key, value) => cache.set(key, value),
    },
    '@/lib/consumet-client': {
      consuGet: async (path) => {
        requests.push(path);
        if (path === '/api/meta/20') return metadata;
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
  }, {
    fetch: options.fetch ?? (() => new Promise(() => {})),
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
