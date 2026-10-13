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
    module, exports: module.exports, URL, URLSearchParams, Promise, JSON, Date, Error, DOMException,
    process: { env: {} }, require: (name) => deps[name] || {}, ...globals,
  });
  return module.exports;
}

/** Timers the test fires by hand, so the 25 s deadline costs nothing. */
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    fireAll() { for (const [id, { fn }] of [...pending]) { pending.delete(id); fn(); } },
  };
}

/**
 * `invoke` stands in for supabase.functions.invoke. Like the real one it never
 * rejects: an aborted fetch comes back as { error } (FunctionsFetchError).
 */
function client(invoke) {
  const timers = fakeTimers();
  const calls = [];
  const mod = load('../lib/content-proxy-client.ts', {
    'react-native': { Platform: { OS: 'web' } },
    '@/lib/supabase': { supabase: { functions: { invoke: (name, options) => { calls.push({ name, options }); return invoke(options); } } } },
  }, { AbortController, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  return { mod, timers, calls };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const abortedFetch = (options) => new Promise((resolve) => {
  options.signal.addEventListener('abort', () => resolve({
    data: null,
    error: { message: 'Failed to send a request to the Edge Function', context: new DOMException('aborted', 'AbortError') },
  }));
});

test('a stalled content-proxy call rejects with a clear timeout after 25 s and aborts the request', async () => {
  const { mod, timers, calls } = client(abortedFetch);
  const pending = mod.invokeContentProxy({ source: 'manhwa', path: '/chapters', method: 'GET', query: { id: 'mr:x' } });
  const outcome = pending.then(() => null, (error) => error);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'web-content-proxy');
  assert.deepEqual(calls[0].options.body, { source: 'manhwa', path: '/chapters', method: 'GET', query: { id: 'mr:x' } });
  assert.equal(calls[0].options.signal.aborted, false);
  assert.deepEqual([...timers.pending.values()].map((t) => t.ms), [mod.CONTENT_PROXY_TIMEOUT_MS]);
  assert.equal(mod.CONTENT_PROXY_TIMEOUT_MS, 25_000);

  timers.fireAll();
  const error = await outcome;
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'TimeoutError');
  assert.match(error.message, /took too long to respond/);
  assert.equal(calls[0].options.signal.aborted, true, 'the stalled request is cancelled, not left running');
});

test('the deadline holds even when the client stalls before it fetches (auth session await)', async () => {
  const { mod, timers } = client(() => new Promise(() => {}));
  const outcome = mod.invokeContentProxy({ source: 'atsu', path: '/api/manga/page' }).then(() => null, (error) => error);
  await tick();
  timers.fireAll();
  assert.equal((await outcome)?.name, 'TimeoutError');
});

test('answers and proxy errors behave as before, and a settled call leaves no timer behind', async () => {
  const ok = client(async () => ({ data: { chapters: [1] }, error: null }));
  assert.deepEqual(await ok.mod.invokeContentProxy({ source: 'manhwa', path: '/chapters' }), { chapters: [1] });
  assert.equal(ok.timers.pending.size, 0);

  const failed = client(async () => ({ data: { error: 'Upstream returned 502' }, error: null }));
  await assert.rejects(failed.mod.invokeContentProxy({ source: 'manhwa', path: '/details' }), /Upstream returned 502/);
  assert.equal(failed.timers.pending.size, 0);
});

test('a timed-out loader is never cached, so the next open fetches again and a stale copy is still served', async () => {
  let stored = null;
  const kv = { readStore: async () => stored, writeStore: async (_n, v) => { stored = v; }, removeStore: async () => { stored = null; } };
  let now = 1_000_000;
  const FakeDate = class extends Date { static now() { return now; } };
  const cache = load('../lib/cache.ts', { '@/lib/kv-store': kv }, { Date: FakeDate, Blob });

  let stall = true;
  const { mod, timers } = client(async (options) => (stall ? abortedFetch(options) : { data: { manga: { id: 'mr:x', title: 'X' } }, error: null }));
  const detail = () => cache.getOrSetCached('manhwa:detail:mr:x', 60_000,
    () => mod.invokeContentProxy({ source: 'manhwa', path: '/details', query: { id: 'mr:x' } }), { staleIfError: true });

  const first = detail().then(() => null, (error) => error);
  await tick();
  timers.fireAll();
  assert.equal((await first)?.name, 'TimeoutError');
  assert.ok(!stored || !stored.includes('manhwa:detail'), 'the timeout must not be persisted');

  stall = false;
  assert.equal((await detail()).manga.title, 'X');
  assert.ok(stored.includes('manhwa:detail'));

  // Past the TTL with the source stalled again: the last good answer is served.
  now += 120_000;
  stall = true;
  const stale = detail();
  await tick();
  timers.fireAll();
  assert.equal((await stale).manga.title, 'X');
});
