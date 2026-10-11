import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

// The browser episode store (lib/anime-offline.web.ts) against a fake relay and
// an in-memory Cache Storage. Real playlist helpers and cache-key module; the
// resolver, hls.js capability check and Originals lookup are fixtures.
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const lib = new URL('../lib/', import.meta.url);
const compile = name => ts.transpileModule(readFileSync(new URL(name, lib), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const sources = {
  store: compile('anime-offline.web.ts'),
  playlist: compile('hls-local-playlist.ts'),
  keys: compile('offline-cache-keys.ts'),
};
const ORIGIN = 'https://sakura.test';
const RELAY = 'https://project.supabase.co/functions/v1/anime-stream?token=';
const plain = value => JSON.parse(JSON.stringify(value));

class FakeCache {
  constructor() { this.store = new Map(); this.puts = []; }
  key(input) { return new URL(typeof input === 'string' ? input : input.url, ORIGIN).href; }
  async match(input) { const hit = this.store.get(this.key(input)); return hit ? hit.clone() : undefined; }
  async put(input, response) {
    const body = await response.arrayBuffer();
    this.puts.push(this.key(input));
    this.store.set(this.key(input), new Response(body, { status: response.status, headers: response.headers }));
  }
  async delete(input) { return this.store.delete(this.key(input)); }
  async keys() { return [...this.store.keys()].map(url => ({ url })); }
  paths(prefix = '') { return [...this.store.keys()].map(url => new URL(url).pathname).filter(path => path.startsWith(prefix)).sort(); }
  async text(path) { return (await this.match(path))?.text(); }
}

function tsBytes(packets = 8) {
  const bytes = new Uint8Array(packets * 188);
  for (let i = 0; i < packets; i++) bytes[i * 188] = 0x47;
  return bytes;
}

function relay(options = {}) {
  const state = { generation: 0, resolves: 0, requests: [], calls: [], durations: [6, 6, 6, 6, 4.5], ...options };
  const url = (generation, name) => `${RELAY}g${generation}.${name}`;
  state.media = generation => {
    let text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n';
    if (state.encrypted) text += `#EXT-X-KEY:METHOD=AES-128,URI="${url(generation, 'key')}",IV=0x01\n`;
    state.durations.forEach((duration, i) => { text += `#EXTINF:${duration},\n${url(generation, `seg${i}`)}\n`; });
    return `${text}#EXT-X-ENDLIST\n`;
  };
  const master = generation => '#EXTM3U\n'
    + `#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n${url(generation, 'v1080')}\n`
    + `#EXT-X-STREAM-INF:BANDWIDTH=2000000,AVERAGE-BANDWIDTH=1600000,RESOLUTION=1280x720\n${url(generation, 'v720')}\n`;
  state.resolve = async request => {
    state.resolves++;
    state.requests.push(plain(request));
    if (state.onResolve) {
      const result = await state.onResolve(request, state);
      if (result !== undefined) return result;
    }
    const generation = ++state.generation;
    return {
      url: url(generation, 'master'), isM3U8: true, category: request.category,
      intro: { start: 30, end: 110 }, outro: { start: 1300, end: 1390 },
      subtitles: [
        { url: url(generation, 'vtt-ja'), lang: 'ja', label: 'Japanese' },
        { url: url(generation, 'vtt-en'), lang: 'en', label: 'English' },
      ],
    };
  };
  state.fetch = async (input, init = {}) => {
    const target = String(input);
    state.calls.push(target);
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (target.startsWith('https://img.test/')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
    const match = /token=g(\d+)\.(.+)$/.exec(target);
    if (!match) return new Response('missing', { status: 404 });
    const generation = Number(match[1]);
    const name = match[2];
    if (state.hook) {
      const response = await state.hook({ generation, name, state, init });
      if (response) return response;
    }
    if (name === 'master') return new Response(master(generation), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    if (name === 'v720' || name === 'v1080') {
      state.variantsFetched = [...(state.variantsFetched ?? []), name];
      return new Response(state.media(generation), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    if (name === 'key') return new Response(new Uint8Array(16).fill(7), { headers: { 'Content-Type': 'application/octet-stream' } });
    if (name.startsWith('vtt-')) return new Response(`WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${name}\n`, { headers: { 'Content-Type': 'text/vtt; charset=utf-8' } });
    if (/^seg\d+$/.test(name)) return new Response(tsBytes(), { headers: { 'Content-Type': 'video/mp2t' } });
    return new Response('{"error":"unknown"}', { status: 404 });
  };
  return state;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** One page load of the store. Pass the same cache to simulate a reload. */
function loadStore({ cache = new FakeCache(), relayState = relay(), hlsSupported = true, navigatorOverrides = {}, originals = {} } = {}) {
  const realSetTimeout = setTimeout;
  // Backoff, Retry-After and the manifest throttle run in milliseconds here;
  // the 60s/15s request deadlines stay real (and never fire in these tests).
  const fastSetTimeout = (callback, ms = 0, ...args) => {
    const timer = realSetTimeout(callback, ms >= 15_000 ? ms : Math.min(ms, 3), ...args);
    if (ms >= 15_000) timer.unref?.();
    return timer;
  };
  const navigator = {
    onLine: true,
    serviceWorker: { controller: {} },
    storage: { estimate: async () => ({ quota: 50e9, usage: 1e6 }), persisted: async () => true, persist: async () => true },
    ...navigatorOverrides,
  };
  const modules = {};
  const context = {
    atob, URL, Response, Blob, DOMException, TextDecoder, TextEncoder, AbortController, Uint8Array, console,
    setTimeout: fastSetTimeout, clearTimeout,
    fetch: (...args) => relayState.fetch(...args),
    caches: { open: async () => cache },
    navigator,
  };
  const load = (key, source) => {
    if (modules[key]) return modules[key];
    const module = { exports: {} };
    modules[key] = module.exports;
    vm.runInNewContext(source, { ...context, module, exports: module.exports, require: requireMock });
    modules[key] = module.exports;
    return module.exports;
  };
  function requireMock(id) {
    if (id === 'hls.js') return { __esModule: true, default: { isSupported: () => hlsSupported } };
    if (id === '@/lib/anime-stream-client') return { fetchBrowserAnimeStream: request => relayState.resolve(request) };
    if (id === '@/lib/hls-local-playlist') return load('playlist', sources.playlist);
    if (id === '@/lib/offline-cache-keys') return load('keys', sources.keys);
    if (id === '@/lib/sakura-originals') {
      return {
        isSakuraOriginal: animeId => String(animeId).startsWith('original-'),
        resolveSakuraOriginalStreamUrl: async () => originals.url ?? null,
      };
    }
    throw new Error(`Unexpected dependency ${id}`);
  }
  const api = load('store', sources.store);
  return { api, cache, relay: relayState, navigator };
}

const episode = (changes = {}) => ({
  animeId: '21', episodeId: 'mal-21-1', episodeNumber: 1, episodeTitle: 'Romance Dawn',
  title: 'One Piece', cover: 'https://img.test/cover.jpg', episodeThumbnail: 'https://img.test/ep1.jpg', ...changes,
});
const DIR = '/app/__offline/anime/21/mal-21-1/';
const segmentFetches = state => state.calls.filter(url => /\.seg\d+$/.test(url));

test('a regular episode downloads through the relay into same-origin files with the playlist written last', async () => {
  const { api, cache, relay: state } = loadStore();
  const notifications = [];
  api.subscribeOfflineEpisodes(() => notifications.push(1));
  await api.downloadAnimeEpisode(episode());
  const row = await api.getOfflineEpisode('21', 'mal-21-1');
  assert.equal(row.status, 'ready');
  assert.equal(row.format, 'hls');
  assert.equal(row.quality, '720p', 'about 720p is preferred over 1080p');
  assert.deepEqual(state.variantsFetched, ['v720']);
  assert.equal(row.totalSegments, 5);
  assert.equal(row.completedSegments, 5);
  assert.equal(row.progress, 1);
  assert.equal(row.bytesDownloaded, 5 * 188 * 8);
  assert.equal(row.category, 'sub');
  assert.deepEqual(plain(state.requests), [{ malId: '21', episode: 1, category: 'sub' }]);
  assert.deepEqual(plain(row.intro), { start: 30, end: 110 });
  assert.deepEqual(plain(row.subtitles), [
    { lang: 'en', label: 'English', uri: `${DIR}sub0.vtt` },
    { lang: 'ja', label: 'Japanese', uri: `${DIR}sub1.vtt` },
  ], 'English captions first');
  assert.equal(row.offlineCover, '/app/__offline/cover/anime/21');
  assert.equal(row.offlineThumbnail, `${DIR}thumb`);
  assert.deepEqual(cache.paths(DIR), [
    ...['index.m3u8'], ...[0, 1, 2, 3, 4].map(i => `seg0000${i}.ts`), 'sub0.vtt', 'sub1.vtt', 'thumb',
  ].map(name => DIR + name).sort());
  assert.equal(cache.puts.filter(url => url.includes(DIR)).at(-1), `${ORIGIN}${DIR}index.m3u8`, 'index.m3u8 is the completeness marker');
  const playlist = await cache.text(`${DIR}index.m3u8`);
  assert.match(playlist, /^#EXTM3U\n/);
  assert.match(playlist, new RegExp(`#EXTINF:4.5,\\n${DIR}seg00004.ts\\n#EXT-X-ENDLIST`));
  assert.doesNotMatch(playlist, /supabase|token=/, 'no signed relay URL survives in the offline playlist');
  const segment = await cache.match(`${DIR}seg00000.ts`);
  assert.equal(segment.headers.get('content-type'), 'video/mp2t');
  assert.equal(segment.headers.get('content-length'), String(188 * 8));
  assert.equal(await api.getOfflinePlaybackUri('21', 'mal-21-1'), `${DIR}index.m3u8`);
  assert.ok(notifications.length >= 5, 'progress is notified per segment');
  assert.equal(await api.getOfflineStorageBytes(), 5 * 188 * 8);
});

test('playback needs a service-worker-controlled tab and a complete copy', async () => {
  const { api, cache, navigator } = loadStore();
  await api.downloadAnimeEpisode(episode());
  navigator.serviceWorker = { controller: null };
  assert.equal(await api.getOfflinePlaybackUri('21', 'mal-21-1'), null, 'an uncontrolled tab would get index.html');
  navigator.serviceWorker = { controller: {} };
  await cache.delete(`${DIR}seg00004.ts`);
  assert.equal(await api.getOfflinePlaybackUri('21', 'mal-21-1'), null, 'evicted bytes fall back to streaming');
});

test('encrypted streams keep their key, and hi- ids resolve with the series MAL id', async () => {
  const { api, cache, relay: state } = loadStore({ relayState: relay({ encrypted: true }) });
  await api.downloadAnimeEpisode(episode({ episodeId: 'hi-1020-3', episodeNumber: 3 }));
  assert.deepEqual(plain(state.requests), [{ malId: '21', episode: 3, category: 'sub' }]);
  const dir = '/app/__offline/anime/21/hi-1020-3/';
  const key = await cache.match(`${dir}key0.key`);
  assert.equal((await key.arrayBuffer()).byteLength, 16);
  assert.match(await cache.text(`${dir}index.m3u8`), new RegExp(`#EXT-X-KEY:METHOD=AES-128,URI="${dir}key0.key",IV=0x01`));
});

test('the asked-for language is tried first, then the other one', async () => {
  const state = relay({ onResolve: request => request.category === 'dub'
    ? { url: '', isM3U8: false, category: 'dub', unavailableCategory: 'dub', availableCategories: ['sub'] } : undefined });
  const { api } = loadStore({ relayState: state });
  await api.downloadAnimeEpisode(episode({ category: 'dub' }));
  assert.deepEqual(state.requests.map(request => request.category), ['dub', 'sub']);
  assert.equal((await api.getOfflineEpisode('21', 'mal-21-1')).category, 'sub');

  // A resolve that merely failed is not "unavailable": no silent language switch.
  const failing = relay({ onResolve: () => null });
  const second = loadStore({ relayState: failing });
  await assert.rejects(second.api.downloadAnimeEpisode(episode()), /Couldn't reach this episode's stream/);
  assert.deepEqual(failing.requests.map(request => request.category), ['sub']);
  assert.equal(await second.api.getOfflineEpisode('21', 'mal-21-1'), null);
});

test('pause stops mid-episode, survives a reload, and resume fetches only what is missing', async () => {
  const cache = new FakeCache();
  const first = relay();
  let paused = false;
  const page1 = loadStore({ cache, relayState: first });
  first.hook = async ({ name }) => {
    if (name === 'seg3' && !paused) {
      paused = true;
      page1.api.pauseAnimeEpisodeDownload('21', 'mal-21-1');
    }
  };
  let notified = 0;
  page1.api.subscribeOfflineEpisodes(() => notified++);
  await page1.api.downloadAnimeEpisode(episode());
  const pausedRow = await page1.api.getOfflineEpisode('21', 'mal-21-1');
  assert.equal(pausedRow.status, 'paused');
  assert.ok(pausedRow.completedSegments < 5 && pausedRow.completedSegments >= 1, `kept ${pausedRow.completedSegments}`);
  assert.equal(await cache.match(`${DIR}index.m3u8`), undefined, 'no playlist for a partial copy');
  assert.ok(notified > 0);
  const kept = cache.paths(DIR).filter(path => /seg\d+\.ts$/.test(path)).length;
  assert.equal(kept, pausedRow.completedSegments);

  const second = relay({ generation: 50 });
  const page2 = loadStore({ cache, relayState: second });
  const reloaded = await page2.api.getOfflineEpisode('21', 'mal-21-1');
  assert.equal(reloaded.status, 'paused');
  page2.api.resumeAnimeEpisodeDownload('21', 'mal-21-1');
  await page2.api.downloadAnimeEpisode(episode());
  const done = await page2.api.getOfflineEpisode('21', 'mal-21-1');
  assert.equal(done.status, 'ready');
  assert.equal(segmentFetches(second).length, 5 - kept, 'segments already in the cache are skipped');
  assert.equal(done.bytesDownloaded, 5 * 188 * 8, 'sizes of kept segments are counted');
});

test('a row left downloading by a closed tab loads as paused, and pausing it notifies', async () => {
  const cache = new FakeCache();
  const row = { ...episode(), category: 'sub', status: 'downloading', progress: 0.4, bytesDownloaded: 10, totalSegments: 5, completedSegments: 2, format: 'hls', updatedAt: 1 };
  await cache.put('/app/__offline/anime-manifest.json', new Response(JSON.stringify({ episodes: { '21::mal-21-1': row } })));
  const { api } = loadStore({ cache });
  assert.equal((await api.getOfflineEpisode('21', 'mal-21-1')).status, 'paused');
  const manifest = JSON.parse(await cache.text('/app/__offline/anime-manifest.json'));
  assert.equal(manifest.episodes['21::mal-21-1'].status, 'paused', 'the fix is persisted');
  let notified = 0;
  api.subscribeOfflineEpisodes(() => notified++);
  api.pauseAnimeEpisodeDownload('21', 'mal-21-1');
  assert.equal(notified, 1);
  assert.equal(api.isAnimeEpisodePaused('21', 'mal-21-1'), true);
});

test('expired signed URLs are re-resolved and the download continues by index', async () => {
  const state = relay();
  state.hook = async ({ generation, name }) => {
    if (generation === 1 && /^seg[2-4]$/.test(name)) return json(401, { error: 'Stream expired. Retry this episode.' });
  };
  const { api } = loadStore({ relayState: state });
  await api.downloadAnimeEpisode(episode());
  const row = await api.getOfflineEpisode('21', 'mal-21-1');
  assert.equal(row.status, 'ready');
  assert.equal(state.resolves, 2, 'one fresh resolve, shared by every worker that hit the expiry');
  const fetched = segmentFetches(state);
  assert.deepEqual(fetched.filter(url => url.includes('token=g2.')).map(url => url.split('.').pop()).sort(), ['seg2', 'seg3', 'seg4']);
});

test('a different encode after re-resolving restarts the episode cleanly', async () => {
  const state = relay();
  state.hook = async ({ generation, name }) => {
    if (generation === 1 && name === 'seg3') return json(401, { error: 'Stream expired. Retry this episode.' });
  };
  state.onResolve = (_request, current) => {
    if (current.resolves === 2) current.durations = [5, 5, 5, 5, 5, 5];
    return undefined;
  };
  const { api, cache } = loadStore({ relayState: state });
  await api.downloadAnimeEpisode(episode());
  const row = await api.getOfflineEpisode('21', 'mal-21-1');
  assert.equal(row.status, 'ready');
  assert.equal(row.totalSegments, 6);
  assert.equal(cache.paths(DIR).filter(path => /seg\d+\.ts$/.test(path)).length, 6);
  assert.match(await cache.text(`${DIR}index.m3u8`), /#EXTINF:5,\n.*seg00005\.ts/);
});

test('429 honours Retry-After and transient 502s are retried', async () => {
  const state = relay();
  const seen = new Map();
  state.hook = async ({ name }) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (name === 'seg1' && count === 1) return json(429, { error: 'Too many stream requests. Try again shortly.' }, { 'Retry-After': '1' });
    if (name === 'seg2' && count < 3) return json(502, { error: 'The upstream stream is unavailable.' });
    if (name === 'seg3' && count === 1) {
      const truncated = tsBytes().subarray(0, 188 * 7 + 20);
      return new Response(truncated, { headers: { 'Content-Type': 'video/mp2t' } });
    }
  };
  const { api, cache } = loadStore({ relayState: state });
  await api.downloadAnimeEpisode(episode());
  assert.equal((await api.getOfflineEpisode('21', 'mal-21-1')).status, 'ready');
  assert.equal(seen.get('seg1'), 2);
  assert.equal(seen.get('seg2'), 3);
  assert.equal(seen.get('seg3'), 2, 'a body cut mid-packet is fetched again');
  assert.equal((await (await cache.match(`${DIR}seg00003.ts`)).arrayBuffer()).byteLength, 188 * 8);
});

test('a relay refusing the CDN host fails fast with a clear message and leaves nothing behind', async () => {
  const state = relay();
  state.hook = async ({ name }) => name === 'v720' ? json(502, { error: 'Media host or path is not allowed.' }) : undefined;
  const { api, cache } = loadStore({ relayState: state });
  await assert.rejects(api.downloadAnimeEpisode(episode()), /source is temporarily unavailable for download/);
  assert.equal(await api.getOfflineEpisode('21', 'mal-21-1'), null);
  assert.deepEqual(cache.paths(DIR), []);
  assert.equal(state.calls.filter(url => url.endsWith('.v720')).length, 1, 'a refusal is not retried');
});

test('a failure part-way keeps the stored segments and the row for a retry', async () => {
  const state = relay();
  state.hook = async ({ name }) => name === 'seg4' ? json(502, { error: 'Media host or path is not allowed.' }) : undefined;
  const { api, cache } = loadStore({ relayState: state });
  await assert.rejects(api.downloadAnimeEpisode(episode()), /temporarily unavailable/);
  const row = await api.getOfflineEpisode('21', 'mal-21-1');
  assert.equal(row.status, 'error');
  assert.match(row.error, /temporarily unavailable/);
  assert.equal(row.completedSegments, 4);
  state.hook = undefined;
  await api.downloadAnimeEpisode(episode());
  assert.equal((await api.getOfflineEpisode('21', 'mal-21-1')).status, 'ready');
  assert.equal(segmentFetches(state).filter(url => url.endsWith('.seg0')).length, 1, 'retry resumed instead of restarting');
  assert.ok(await cache.match(`${DIR}index.m3u8`));
});

test('space is checked against the estimated size before anything is written', async () => {
  const { api, cache } = loadStore({
    relayState: relay({ durations: Array(240).fill(6) }),
    navigatorOverrides: { storage: { estimate: async () => ({ quota: 400e6, usage: 100e6 }), persisted: async () => true, persist: async () => true } },
  });
  // 1.6 Mbps average × 1440s ≈ 288 MB, against 100 MB free after headroom.
  await assert.rejects(api.downloadAnimeEpisode(episode()), /Not enough space: this episode needs about 27\d MB and only 86 MB is free/);
  assert.deepEqual(cache.paths(DIR), []);
});

test('browsers without hls.js support get a clear refusal for HLS episodes', async () => {
  const { api } = loadStore({ hlsSupported: false });
  await assert.rejects(api.downloadAnimeEpisode(episode()), /can't play downloaded episodes/);
  assert.equal(await api.getOfflineEpisode('21', 'mal-21-1'), null);
});

test('Sakura Originals keep the single progressive file path', async () => {
  const state = relay();
  const file = new Uint8Array(1000).fill(3);
  state.fetch = async (input, init = {}) => {
    state.calls.push(String(input));
    if (init.headers?.Range === 'bytes=0-0') return new Response(file.subarray(0, 1), { status: 206, headers: { 'Content-Range': 'bytes 0-0/1000', 'Content-Type': 'video/mp4' } });
    return new Response(file, { headers: { 'Content-Type': 'video/mp4' } });
  };
  const { api, cache } = loadStore({ relayState: state, originals: { url: 'https://sakura.test/api/media-proxy/?path=ep1.mp4' } });
  await api.downloadAnimeEpisode(episode({ animeId: 'original-psyop', episodeId: 'psyop-1' }));
  const row = await api.getOfflineEpisode('original-psyop', 'psyop-1');
  assert.equal(row.status, 'ready');
  assert.equal(row.format, 'mp4');
  assert.equal(state.resolves, 0, 'Originals never touch the relay');
  assert.equal(await api.getOfflinePlaybackUri('original-psyop', 'psyop-1'), '/app/__offline/anime/original-psyop/psyop-1');
  assert.equal((await (await cache.match('/app/__offline/anime/original-psyop/psyop-1')).arrayBuffer()).byteLength, 1000);
});

test('delete removes every file of the episode, the shared cover with the last one, and stops a running job', async () => {
  const { api, cache, relay: state } = loadStore();
  await api.downloadAnimeEpisode(episode());
  await api.downloadAnimeEpisode(episode({ episodeId: 'mal-21-2', episodeNumber: 2 }));
  assert.ok(await cache.match('/app/__offline/cover/anime/21'));
  await api.deleteOfflineEpisode('21', 'mal-21-1');
  assert.deepEqual(cache.paths(DIR), []);
  assert.ok(await cache.match('/app/__offline/cover/anime/21'), 'episode 2 still uses the cover');
  await api.deleteOfflineEpisode('21', 'mal-21-2');
  assert.equal(await cache.match('/app/__offline/cover/anime/21'), undefined);
  assert.deepEqual(cache.paths('/app/__offline/anime/21/'), []);

  // Delete while downloading: the job stops and does not write the row back.
  let deleted = false;
  state.hook = async ({ name }) => {
    if (name === 'seg2' && !deleted) {
      deleted = true;
      await api.deleteOfflineEpisode('21', 'mal-21-3');
    }
  };
  await api.downloadAnimeEpisode(episode({ episodeId: 'mal-21-3', episodeNumber: 3 }));
  assert.equal(await api.getOfflineEpisode('21', 'mal-21-3'), null);
  assert.deepEqual(cache.paths('/app/__offline/anime/21/mal-21-3/'), []);
  await api.clearAllOfflineEpisodes();
  assert.equal((await api.listOfflineEpisodes()).length, 0);
});

test('a second tap joins the running download instead of starting another', async () => {
  const { api, relay: state } = loadStore();
  const a = api.downloadAnimeEpisode(episode());
  const b = api.downloadAnimeEpisode(episode());
  await Promise.all([a, b]);
  assert.equal(state.resolves, 1);
  assert.equal(segmentFetches(state).length, 5);
});

test('missing middle segments and keys invalidate ready copies, and download repairs them', async () => {
  const { api, cache, relay: state } = loadStore({ relayState: relay({ encrypted: true }) });
  await api.downloadAnimeEpisode(episode());
  await cache.delete(`${DIR}seg00002.ts`);
  await cache.delete(`${DIR}key0.key`);
  assert.equal(await api.getOfflinePlaybackUri('21', 'mal-21-1'), null);
  const before = segmentFetches(state).length;
  await api.downloadAnimeEpisode(episode());
  assert.equal(segmentFetches(state).length, before + 1);
  assert.equal(await api.getOfflinePlaybackUri('21', 'mal-21-1'), `${DIR}index.m3u8`);
});

test('a byte-range file shared by the map and media segments downloads once', async () => {
  const state = relay();
  state.media = generation => `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="${RELAY}g${generation}.seg0",BYTERANGE="188@0"\n#EXTINF:6,\n#EXT-X-BYTERANGE:188@188\n${RELAY}g${generation}.seg0\n#EXT-X-ENDLIST\n`;
  const { api, cache } = loadStore({ relayState: state });
  await api.downloadAnimeEpisode(episode());
  assert.equal(segmentFetches(state).length, 1);
  assert.match(await cache.text(`${DIR}index.m3u8`), /BYTERANGE:188@188/);
  assert.equal(await api.getOfflinePlaybackUri('21', 'mal-21-1'), `${DIR}index.m3u8`);
});

test('live playlist snapshots are not marked as complete downloaded episodes', async () => {
  const state = relay();
  const media = state.media;
  state.media = generation => media(generation).replace('#EXT-X-ENDLIST', '');
  const { api, cache } = loadStore({ relayState: state });
  await assert.rejects(api.downloadAnimeEpisode(episode()), /streamed live/);
  assert.deepEqual(cache.paths(DIR), []);
});

test('deleting during HLS resolution leaves no row or media', async () => {
  const state = relay();
  const { api, cache } = loadStore({ relayState: state });
  state.onResolve = async () => { await api.deleteOfflineEpisode('21', 'mal-21-1'); };
  await api.downloadAnimeEpisode(episode());
  assert.equal(await api.getOfflineEpisode('21', 'mal-21-1'), null);
  assert.deepEqual(cache.paths(DIR), []);
});

test('an Original rejects servers that ignore Range rather than concatenating whole files', async () => {
  const state = relay();
  state.fetch = async (_url, init = {}) => init.headers?.Range === 'bytes=0-0'
    ? new Response(new Uint8Array(1), { status: 206, headers: { 'Content-Range': 'bytes 0-0/20000000', 'Content-Type': 'video/mp4' } })
    : new Response(new Uint8Array(1), { status: 200, headers: { 'Content-Type': 'video/mp4' } });
  const { api, cache } = loadStore({ relayState: state, originals: { url: 'https://sakura.test/ep.mp4' } });
  await assert.rejects(api.downloadAnimeEpisode(episode({ animeId: 'original-fixture', episodeId: 'ep1' })), /invalid byte range/);
  assert.equal(await cache.match('/app/__offline/anime/original-fixture/ep1'), undefined);
  assert.equal((await api.getOfflineEpisode('original-fixture', 'ep1')).status, 'error');
});

test('an Original validates both byte offsets and exact full file size', async () => {
  for (const mode of ['offset', 'oversized']) {
    const state = relay();
    const size = mode === 'offset' ? 20000000 : 1000;
    state.fetch = async (_url, init = {}) => {
      if (init.headers?.Range === 'bytes=0-0') return new Response(new Uint8Array(1), { status: 206, headers: { 'Content-Range': `bytes 0-0/${size}`, 'Content-Type': 'video/mp4' } });
      if (mode === 'offset') return new Response(new Uint8Array(10), { status: 206, headers: { 'Content-Range': `bytes 1-10/${size}`, 'Content-Type': 'video/mp4' } });
      return new Response(new Uint8Array(size + 10), { headers: { 'Content-Type': 'video/mp4' } });
    };
    const { api, cache } = loadStore({ relayState: state, originals: { url: 'https://sakura.test/ep.mp4' } });
    await assert.rejects(api.downloadAnimeEpisode(episode({ animeId: 'original-fixture', episodeId: 'ep1' })), mode === 'offset' ? /invalid byte range/ : /connection dropped/);
    assert.equal(await cache.match('/app/__offline/anime/original-fixture/ep1'), undefined);
  }
});

test('deleting an Original during preparation or final cache write never resurrects it', async () => {
  for (const stage of ['probe', 'cache']) {
    const state = relay();
    const { api, cache } = loadStore({ relayState: state, originals: { url: 'https://sakura.test/ep.mp4' } });
    state.fetch = async (_url, init = {}) => {
      if (init.headers?.Range === 'bytes=0-0') {
        if (stage === 'probe') await api.deleteOfflineEpisode('original-fixture', 'ep1');
        return new Response(new Uint8Array(1), { status: 206, headers: { 'Content-Range': 'bytes 0-0/1000', 'Content-Type': 'video/mp4' } });
      }
      return new Response(new Uint8Array(1000), { headers: { 'Content-Type': 'video/mp4' } });
    };
    const put = cache.put.bind(cache);
    cache.put = async (input, response) => {
      if (stage === 'cache' && input === '/app/__offline/anime/original-fixture/ep1') await api.deleteOfflineEpisode('original-fixture', 'ep1');
      return put(input, response);
    };
    await api.downloadAnimeEpisode(episode({ animeId: 'original-fixture', episodeId: 'ep1' }));
    assert.equal(await api.getOfflineEpisode('original-fixture', 'ep1'), null, stage);
    assert.deepEqual(cache.paths('/app/__offline/anime/original-fixture/'), [], stage);
  }
});

test('failure to persist the completed manifest does not report a ready download', async () => {
  const cache = new FakeCache();
  const put = cache.put.bind(cache);
  cache.put = async (input, response) => {
    if (String(input).endsWith('anime-manifest.json') && (await response.clone().text()).includes('"status":"ready"')) {
      throw new DOMException('No more space', 'QuotaExceededError');
    }
    return put(input, response);
  };
  const { api } = loadStore({ cache });
  await assert.rejects(api.downloadAnimeEpisode(episode()), /ran out of space/);
  assert.equal((await api.getOfflineEpisode('21', 'mal-21-1')).status, 'error');
  assert.equal((await loadStore({ cache }).api.getOfflineEpisode('21', 'mal-21-1')).status, 'error');
});
