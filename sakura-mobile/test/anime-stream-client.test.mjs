import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const root = new URL('../lib/', import.meta.url);
const base = 'https://project.supabase.co';
const signed = `${base}/functions/v1/anime-stream?token=cGF5bG9hZA.c2lnbmF0dXJl`;
const embed = 'https://megaplay.buzz/stream/mal/20/1/sub';
const request = { malId: '20', episode: 1, category: 'sub' };

function load(name, mocks = {}, globals = {}) {
  const output = ts.transpileModule(readFileSync(new URL(name, root), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, URL, AbortController,
    process: { env: { EXPO_PUBLIC_SUPABASE_URL: base } }, console,
    setTimeout, clearTimeout,
    require: id => {
      if (id in mocks) return mocks[id];
      if (id === './anime-network') return load('anime-network.ts', mocks, globals);
      throw new Error(`Unexpected dependency ${id}`);
    },
    ...globals,
  });
  return module.exports;
}

function client(invoke, globals) {
  return load('anime-stream-client.web.ts', { '@/lib/supabase': { supabase: { functions: { invoke } } } }, globals);
}

function animeHarness({ browser = true, configured = false, invoke, original = null } = {}) {
  const calls = [], upstream = [], legacy = [];
  const platformClient = browser ? client(async (name, options) => {
    calls.push({ name, ...options });
    return invoke ? invoke(name, options) : { data: { url: signed, isM3U8: true, category: options.body.category, embedUrl: embed }, error: null };
  }) : load('anime-stream-client.ts');
  const anime = load('anime.ts', {
    './anime-stream-client': platformClient,
    '@/lib/cache': { getCachedValue: async () => null, setCachedValue: async () => {} },
    '@/lib/consumet-client': {
      consumetCandidates: () => configured ? ['https://provider.example'] : [],
      getActiveConsumetUrl: () => configured ? 'https://provider.example' : '',
      setActiveConsumetUrl: () => {},
      consuGet: async (path) => { legacy.push(path); throw new Error('Legacy extractor unavailable'); },
    },
    '@/lib/anime-upstream': {
      HIANIME_BASE: 'https://hianime.dk',
      fetchUpstreamText: async (url) => { upstream.push(url); return '<div data-id="104103"></div>'; },
      fetchUpstreamJson: async () => ({ enc: 'provider-format' }),
    },
    './sakura-originals': { resolveSakuraOriginalStreamUrl: async () => original },
  });
  return { anime, calls, upstream, legacy };
}

test('browser resolves a MAL episode before requiring legacy configuration and forwards category/force', async () => {
  const h = animeHarness();
  const source = await h.anime.fetchEpisodeSources('mal-20-7', 'dub', undefined, { force: true });
  assert.equal(source.url, signed);
  assert.equal(source.category, 'dub');
  assert.equal(h.calls[0].name, 'anime-stream');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].body)), { malId: '20', episode: 7, category: 'dub', force: true });
  assert.equal(h.calls[0].signal.aborted, false);
  assert.deepEqual(h.upstream, []);
  assert.deepEqual(h.legacy, []);
});

test('browser resolves HiAnime episodes using the supplied MAL id, including unresolved hi-0 ids', async () => {
  const h = animeHarness();
  await h.anime.fetchEpisodeSources('hi-1020-4', 'sub', '20');
  await h.anime.fetchEpisodeSources('hi-0-8', 'dub', '20');
  assert.deepEqual(h.calls.map(call => JSON.parse(JSON.stringify(call.body))), [
    { malId: '20', episode: 4, category: 'sub' },
    { malId: '20', episode: 8, category: 'dub' },
  ]);
});

test('a missing server deployment retains an explicit external-player source', async () => {
  const h = animeHarness({ invoke: async () => ({ data: null, error: { message: 'Function not found' } }) });
  const source = await h.anime.fetchEpisodeSources('mal-20-1', 'sub');
  assert.equal(source.url, '');
  assert.equal(source.isM3U8, false);
  assert.equal(source.embedUrl, embed);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.legacy, []);
});

test('resolver validates its own signed function URL and drops malformed optional metadata', async () => {
  const api = client(async () => ({ data: {
    url: signed, isM3U8: true, category: 'sub', embedUrl: 'javascript:alert(1)',
    intro: { start: -1, end: 10 }, outro: { start: 100, end: 120 },
    availableCategories: ['sub', 'invalid', 'sub', 'dub'],
    requestHeaders: { Authorization: 'must-not-be-propagated' },
    subtitles: [
      { url: signed, lang: 'en', label: 'English' },
      { url: 'https://attacker.example/sub.vtt', lang: 'en', label: 'Bad host' },
      { url: signed, lang: {}, label: 'Bad language' },
    ],
  }, error: null }));
  const source = await api.fetchBrowserAnimeStream(request);
  assert.equal(source.url, signed);
  assert.equal(source.embedUrl, undefined);
  assert.equal(source.intro, undefined);
  assert.equal(source.outro.end, 120);
  assert.equal(source.requestHeaders, undefined);
  assert.equal(source.subtitles.length, 1);
  assert.equal(source.subtitles[0].lang, 'en');
  assert.deepEqual(Array.from(source.availableCategories), ['sub', 'dub']);

  for (const url of [signed.replace('project.', 'other.'), signed.replace('/anime-stream?', '/anime-stream-other?'), `${base}/functions/v1/anime-stream`, 'javascript:alert(1)']) {
    const invalid = client(async () => ({ data: { url, isM3U8: true, category: 'sub' }, error: null }));
    assert.equal(await invalid.fetchBrowserAnimeStream(request), null);
  }
  const wrongType = client(async () => ({ data: { url: signed, isM3U8: 'true', category: 'sub' }, error: null }));
  assert.equal(await wrongType.fetchBrowserAnimeStream(request), null);
});

test('a hung server invoke aborts at the 20-second deadline even if the transport ignores abort', async () => {
  let signal, expire, requestedDelay;
  const api = client((_name, options) => { signal = options.signal; return new Promise(() => {}); }, {
    setTimeout: (fn, ms) => { expire = fn; requestedDelay = ms; return 1; }, clearTimeout: () => {},
  });
  const pending = api.fetchBrowserAnimeStream(request);
  assert.equal(requestedDelay, 20_000);
  expire();
  assert.equal(await pending, null);
  assert.equal(signal.aborted, true);
});

test('signed sources are freshly resolved on every playback attempt', async () => {
  let count = 0;
  const h = animeHarness({ invoke: async () => ({ data: { url: `${signed}${++count}`, isM3U8: true, category: 'sub' }, error: null }) });
  const first = await h.anime.fetchEpisodeSources('mal-20-1');
  const second = await h.anime.fetchEpisodeSources('mal-20-1');
  assert.notEqual(first.url, second.url);
  assert.equal(h.calls.length, 2);
});

test('native does not load Supabase or change its existing source path', async () => {
  const native = load('anime-stream-client.ts');
  assert.equal(native.usesBrowserAnimeStream, false);
  assert.equal(await native.fetchBrowserAnimeStream(request), null);
  const h = animeHarness({ browser: false, configured: true });
  const source = await h.anime.fetchEpisodeSources('mal-20-1', 'sub', '20');
  assert.equal(source.url, '');
  assert.equal(source.embedUrl, embed);
  assert.equal(source.requestHeaders.Referer, 'https://megaplay.buzz/');
  assert.equal(h.calls.length, 0);
  assert.ok(h.upstream.length > 0);
});

test('Sakura Originals bypass server resolution and invalid inputs make no request', async () => {
  const h = animeHarness({ original: 'https://media.example/original.mp4' });
  const source = await h.anime.fetchEpisodeSources('original-episode-1');
  assert.equal(source.url, 'https://media.example/original.mp4');
  assert.equal(h.calls.length, 0);
  let calls = 0;
  const api = client(async () => { calls++; throw new Error('Unexpected request'); });
  assert.equal(await api.fetchBrowserAnimeStream({ ...request, episode: -1 }), null);
  assert.equal(await api.fetchBrowserAnimeStream({ ...request, malId: 'wrong-id' }), null);
  assert.equal(calls, 0);
});
