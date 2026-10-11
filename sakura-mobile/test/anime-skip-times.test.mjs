import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../lib/anime-skip-times.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
const row = (changes = {}) => ({ skipType: 'op', episodeLength: 1440, interval: { startTime: 35, endTime: 125 }, ...changes });
const payload = (...results) => ({ found: true, results });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function load(globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, URL, AbortController, TextDecoder, setTimeout, clearTimeout, ...globals });
  return module.exports;
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

test('uses the official MAL/episode/types/measured-duration query and prefers validated provider markers', async () => {
  const api = load(); let called;
  const markers = await api.fetchAnimeSkipTimes('21', 7, 1440.1234, { fetch: async (url, options) => {
    called = { url: new URL(url), options };
    return json(payload(row({ episodeLength: 1440.1234 }), row({ skipType: 'ed', episodeLength: 1440.1234, interval: { startTime: 1300, endTime: 1390 } })));
  } });
  assert.equal(called.url.origin, 'https://api.aniskip.com');
  assert.equal(called.url.pathname, '/v2/skip-times/21/7');
  assert.deepEqual(called.url.searchParams.getAll('types'), ['op', 'ed']);
  assert.equal(called.url.searchParams.get('episodeLength'), '1440.123');
  assert.equal(called.options.credentials, 'omit');
  assert.deepEqual(plain(api.mergeAnimeSkipMarkers({ intro: { start: 10, end: 100 } }, markers, 1440.1234)), {
    intro: { start: 10, end: 100 }, outro: { start: 1300, end: 1390 },
  });
});

test('rejects unknown cuts, malformed intervals, unsupported types, and out-of-bounds offset results', () => {
  const api = load();
  for (const bad of [
    row({ episodeLength: 1400 }), row({ episodeLength: 0 }), row({ episodeLength: '1440' }),
    row({ interval: { startTime: -5, endTime: 90 } }), row({ interval: { startTime: 90, endTime: 20 } }),
    row({ interval: { startTime: 100, endTime: 1450 } }), row({ interval: { startTime: NaN, endTime: 90 } }),
    row({ skipType: 'mixed-op' }), row({ skipType: 'recap' }),
    row({ episodeLength: 1441, interval: { startTime: 0, endTime: 90 } }),
  ]) assert.deepEqual(plain(api.parseAnimeSkipTimes(payload(bad), 1440)), {});
  assert.deepEqual(plain(api.parseAnimeSkipTimes(payload(row({ episodeLength: 1439 })), 1440)), { intro: { start: 36, end: 126 } });
  assert.deepEqual(plain(api.mergeAnimeSkipMarkers({ intro: { start: -2, end: 90 } }, { intro: { start: 3, end: 93 } }, 1440)), { intro: { start: 3, end: 93 } });
  assert.deepEqual(plain(api.parseAnimeSkipTimes({ found: false, results: [row()] }, 1440)), {});
});

test('invalid identity, episode, missing duration, and pre-aborted requests make no network call', async () => {
  const api = load(); let count = 0;
  const options = { fetch: async () => { count++; return json(payload(row())); } };
  for (const [id, episode, duration] of [['wrong', 1, 1440], ['21', 0, 1440], ['21', 1.5, 1440], ['21', 1, 0], ['21', 1, Infinity]]) {
    assert.deepEqual(plain(await api.fetchAnimeSkipTimes(id, episode, duration, options)), {});
  }
  const controller = new AbortController(); controller.abort();
  await api.fetchAnimeSkipTimes('21', 1, 1440, { ...options, signal: controller.signal });
  assert.equal(count, 0);
});

test('cache is keyed by episode and actual duration, returns copies, and force refreshes timings', async () => {
  const api = load(); let count = 0;
  const options = { fetch: async () => { count++; return json(payload(row())); } };
  const first = await api.fetchAnimeSkipTimes('21', 1, 1440, options);
  first.intro.end = 999;
  assert.equal((await api.fetchAnimeSkipTimes('21', 1, 1440, options)).intro.end, 125);
  assert.equal(count, 1);
  await api.fetchAnimeSkipTimes('21', 2, 1440, options);
  await api.fetchAnimeSkipTimes('21', 1, 1439, options);
  await api.fetchAnimeSkipTimes('21', 1, 1440, { ...options, force: true });
  assert.equal(count, 4);
});

test('aborting a hung transport resolves promptly and cannot cache a late response', async () => {
  const api = load(), gate = deferred(), controller = new AbortController(); let upstreamSignal;
  const pending = api.fetchAnimeSkipTimes('21', 1, 1440, { signal: controller.signal, fetch: async (_url, options) => {
    upstreamSignal = options.signal; return gate.promise;
  } });
  controller.abort();
  assert.deepEqual(plain(await pending), {});
  assert.equal(upstreamSignal.aborted, true);
  gate.resolve(json(payload(row())));
  await new Promise(resolve => setImmediate(resolve));
  let requests = 0;
  await api.fetchAnimeSkipTimes('21', 1, 1440, { fetch: async () => { requests++; return json({ found: false }); } });
  assert.equal(requests, 1);
});

test('the five-second deadline also bounds transports that ignore abort', async () => {
  let expire, delay, upstreamSignal;
  const api = load({ setTimeout: (fn, ms) => { expire = fn; delay = ms; return 1; }, clearTimeout: () => {} });
  const pending = api.fetchAnimeSkipTimes('21', 1, 1440, { fetch: async (_url, options) => { upstreamSignal = options.signal; return new Promise(() => {}); } });
  assert.equal(delay, 5000);
  expire();
  assert.deepEqual(plain(await pending), {});
  assert.equal(upstreamSignal.aborted, true);
});

test('cancellation closes a stalled response body as well as the request', async () => {
  const api = load(), controller = new AbortController(); let closed = false;
  const body = new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode('{"found":')); },
    cancel() { closed = true; },
  });
  const pending = api.fetchAnimeSkipTimes('21', 1, 1440, { signal: controller.signal, fetch: async () => new Response(body) });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(plain(await pending), {});
  assert.equal(closed, true);
});

test('a superseded lookup cannot overwrite a newer forced result', async () => {
  const api = load(), gate = deferred();
  const old = api.fetchAnimeSkipTimes('21', 1, 1440, { fetch: async () => gate.promise });
  const newer = await api.fetchAnimeSkipTimes('21', 1, 1440, { force: true, fetch: async () => json(payload(row({ interval: { startTime: 20, endTime: 110 } }))) });
  assert.equal(newer.intro.start, 20);
  gate.resolve(json(payload(row())));
  assert.deepEqual(plain(await old), {});
  const cached = await api.fetchAnimeSkipTimes('21', 1, 1440, { fetch: () => { throw new Error('cache miss'); } });
  assert.equal(cached.intro.start, 20);
});

test('HTTP errors and oversized/malformed payloads are optional failures and do not poison cache', async () => {
  const api = load();
  for (const response of [new Response('unavailable', { status: 500 }), new Response('{bad json'), new Response('x'.repeat(70_000))]) {
    assert.deepEqual(plain(await api.fetchAnimeSkipTimes('21', 1, 1440, { fetch: async () => response })), {});
  }
  assert.equal((await api.fetchAnimeSkipTimes('21', 1, 1440, { fetch: async () => json(payload(row())) })).intro.end, 125);
});
