import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const lib = new URL('../lib/', import.meta.url);
const base = 'https://project.supabase.co';
const signed = (n) => `${base}/functions/v1/anime-stream?token=cGF5bG9hZA.c2lnbmF0dXJl${n}`;
const plain = (value) => JSON.parse(JSON.stringify(value));

function load(name, mocks = {}, globals = {}) {
  const output = ts.transpileModule(readFileSync(new URL(name, lib), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, URL, AbortController, console, setTimeout, clearTimeout,
    process: { env: { EXPO_PUBLIC_SUPABASE_URL: base } },
    require: (id) => {
      if (id in mocks) return mocks[id];
      if (id === './anime-network') return load('anime-network.ts', mocks, globals);
      throw new Error(`Unexpected dependency ${id}`);
    },
    ...globals,
  });
  return module.exports;
}

function client({ fail = 0, navigator } = {}) {
  const calls = [];
  const api = load('anime-stream-client.web.ts', { '@/lib/supabase': { supabase: { functions: { invoke: async (_name, options) => {
    calls.push(plain(options.body));
    if (calls.length <= fail) return { data: null, error: { context: { status: 502 } } };
    return { data: { url: signed(calls.length), isM3U8: true, category: options.body.category }, error: null };
  } } } } }, navigator ? { navigator } : {});
  return { api, calls };
}

const request = { malId: '52991', episode: 2, category: 'sub' };

test('a prewarmed lookup is handed to the next play once, then playback resolves fresh again', async () => {
  const { api, calls } = client();
  api.prewarmBrowserAnimeStream(request);
  api.prewarmBrowserAnimeStream(request);
  assert.equal(calls.length, 1, 'duplicate warm-ups share one lookup');
  const first = await api.fetchBrowserAnimeStream(request);
  assert.equal(first.url, signed(1));
  assert.equal(calls.length, 1, 'the play used the warmed answer');
  const second = await api.fetchBrowserAnimeStream(request);
  assert.equal(second.url, signed(2), 'a warm answer is single use');
});

test('force, a different episode or audio, and a failed warm-up all resolve fresh', async () => {
  const forced = client();
  forced.api.prewarmBrowserAnimeStream(request);
  assert.equal((await forced.api.fetchBrowserAnimeStream({ ...request, force: true })).url, signed(2));
  assert.equal(forced.calls[1].force, true);

  const other = client();
  other.api.prewarmBrowserAnimeStream(request);
  await other.api.fetchBrowserAnimeStream({ ...request, category: 'dub' });
  assert.deepEqual(other.calls.map((call) => call.category), ['sub', 'dub']);

  const failing = client({ fail: 1 });
  failing.api.prewarmBrowserAnimeStream(request);
  const source = await failing.api.fetchBrowserAnimeStream(request);
  assert.equal(source.url, signed(2), 'a failed warm-up is retried rather than reported as no stream');
});

test('warm-ups are skipped when the browser asks to save data or is offline', async () => {
  const saving = client({ navigator: { onLine: true, connection: { saveData: true } } });
  saving.api.prewarmBrowserAnimeStream(request);
  assert.equal(saving.calls.length, 0);
  const offline = client({ navigator: { onLine: false } });
  offline.api.prewarmBrowserAnimeStream(request);
  assert.equal(offline.calls.length, 0);
});

test('native has a no-op warm-up and the anime facade only warms browser-resolvable episodes', () => {
  const native = load('anime-stream-client.ts');
  assert.equal(native.prewarmBrowserAnimeStream(request), undefined);
  const warmed = [];
  const anime = load('anime.ts', {
    './anime-stream-client': { usesBrowserAnimeStream: true, fetchBrowserAnimeStream: async () => null, prewarmBrowserAnimeStream: (value) => warmed.push(plain(value)) },
    './anime-discovery': { primeAnimeDiscovery: () => {} },
    '@/lib/cache': { getCachedValue: async () => null, setCachedValue: async () => {} },
    '@/lib/consumet-client': { consuGet: async () => ({}), consumetCandidates: () => [], getActiveConsumetUrl: () => '', setActiveConsumetUrl: () => {} },
    '@/lib/anime-upstream': { HIANIME_BASE: 'https://hianime.dk', fetchUpstreamText: async () => '', fetchUpstreamJson: async () => ({}) },
  }, { fetch: async () => { throw new Error('no network'); } });
  anime.prewarmEpisodeStream('mal-52991-3', 'dub');
  anime.prewarmEpisodeStream('hi-18542-4', 'sub', '52991');
  anime.prewarmEpisodeStream('hi-18542-4', 'sub');
  anime.prewarmEpisodeStream('degegen-files-ep1', 'sub', 'degegen-files');
  assert.deepEqual(warmed, [{ malId: '52991', episode: 3, category: 'dub' }, { malId: '52991', episode: 4, category: 'sub' }]);
});
