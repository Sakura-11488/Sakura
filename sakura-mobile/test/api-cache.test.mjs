import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../lib/cache.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * A fresh lib/cache.ts per test, with a hand-driven clock and timers, an
 * in-memory kv-store (`disk`, shared between instances to model a reload) and
 * a window/document pair whose events the test fires.
 */
function cacheModule({ disk = new Map(), now = 1_000_000, failWrites = 0 } = {}) {
  const clock = { now };
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const timers = new Map();
  let nextTimer = 1;
  const writes = [];
  const kv = {
    async readStore(name) { return disk.get(name) ?? null; },
    async writeStore(name, value) {
      writes.push({ name, value, at: clock.now });
      if (failWrites > 0) { failWrites -= 1; return false; }
      disk.set(name, value);
      return true;
    },
    async removeStore(name) { disk.delete(name); },
  };
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, JSON, Promise, Map, Set, Error, Blob, Object, Math,
    Date: FakeDate,
    require: (name) => (name === '@/lib/kv-store' ? kv : {}),
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    window, document,
  });
  return {
    cache: module.exports, clock, disk, writes, timers, window, document,
    /** Fire every pending timer (the persist debounce). */
    flushTimers() { for (const [id, { fn }] of [...timers]) { timers.delete(id); fn(); } },
    stored() { return JSON.parse(disk.get('sakura_api_cache.json') || '{}'); },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('a fresh hit never runs the loader', async () => {
  const { cache } = cacheModule();
  let calls = 0;
  const loader = async () => { calls += 1; return ['a']; };
  assert.deepEqual(await cache.getOrSetCached('k', 5 * MIN, loader), ['a']);
  assert.deepEqual(await cache.getOrSetCached('k', 5 * MIN, loader), ['a']);
  assert.equal(calls, 1);
});

test('concurrent callers for one key share a single load', async () => {
  const { cache } = cacheModule();
  const gate = deferred();
  let calls = 0;
  const loader = () => { calls += 1; return gate.promise; };
  const first = cache.getOrSetCached('manga:detail:v2:x', 30 * MIN, loader);
  const second = cache.getOrSetCached('manga:detail:v2:x', 30 * MIN, loader, { staleIfError: true });
  await settle();
  assert.equal(calls, 1, 'the prefetch and the screen do not both hit the network');
  gate.resolve({ id: 'x' });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, { id: 'x' });
  assert.equal(a, b);
  // Once settled, the next miss loads again rather than reusing a finished promise.
  const third = await cache.getOrSetCached('other', MIN, async () => 'o');
  assert.equal(third, 'o');
});

test('a shared load that fails rejects every waiter and caches nothing', async () => {
  const { cache, writes, flushTimers } = cacheModule();
  const gate = deferred();
  let calls = 0;
  const loader = () => { calls += 1; return gate.promise; };
  const first = cache.getOrSetCached('k', MIN, loader).catch((e) => e);
  const second = cache.getOrSetCached('k', MIN, loader).catch((e) => e);
  await settle();
  gate.reject(new Error('atsu HTTP 503'));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.message, 'atsu HTTP 503');
  assert.equal(b, a);
  flushTimers();
  await settle();
  assert.equal(writes.length, 0, 'a failure is never written');
  assert.equal(await cache.getOrSetCached('k', MIN, async () => { calls += 1; return 'ok'; }), 'ok');
  assert.equal(calls, 2, 'the next call tries again');
});

test('a stale entry is served at once and refreshed in the background', async () => {
  const { cache, clock } = cacheModule();
  await cache.getOrSetCached('manga:list:trending', 5 * MIN, async () => ['old']);
  clock.now += 10 * MIN; // past the 5 min TTL, well inside the grace period
  const refreshed = [];
  const unsubscribe = cache.onCacheRefresh((key) => refreshed.push(key));
  const gate = deferred();
  let calls = 0;
  const loader = () => { calls += 1; return gate.promise; };

  assert.deepEqual(await cache.getOrSetCached('manga:list:trending', 5 * MIN, loader), ['old'],
    'the screen gets the stale copy without waiting on the network');
  assert.deepEqual(await cache.getOrSetCached('manga:list:trending', 5 * MIN, loader), ['old']);
  assert.equal(calls, 1, 'one background refresh, however many readers');
  assert.deepEqual(refreshed, []);

  gate.resolve(['new']);
  await settle();
  assert.deepEqual(refreshed, ['manga:list:trending']);
  assert.deepEqual(await cache.getOrSetCached('manga:list:trending', 5 * MIN, async () => { throw new Error('no'); }), ['new']);
  assert.equal(calls, 1, 'the refreshed value is fresh again');
  unsubscribe();
});

test('a failed background refresh keeps the stale copy and caches nothing', async () => {
  const { cache, clock, flushTimers, stored } = cacheModule();
  await cache.getOrSetCached('k', 5 * MIN, async () => 'good');
  flushTimers();
  await settle();
  clock.now += 6 * MIN;
  let calls = 0;
  const failing = async () => { calls += 1; throw new Error('droplet down'); };
  assert.equal(await cache.getOrSetCached('k', 5 * MIN, failing), 'good');
  await settle();
  assert.equal(await cache.getOrSetCached('k', 5 * MIN, failing), 'good', 'still served, still stale');
  await settle();
  assert.equal(calls, 2, 'each stale read retries once the previous refresh has finished');
  flushTimers();
  await settle();
  assert.equal(stored().k.value, 'good');
});

test('past the grace period the loader is awaited again, and staleIfError still answers', async () => {
  const { cache, clock } = cacheModule();
  assert.equal(cache.STALE_GRACE_MS, 24 * HOUR);
  await cache.getOrSetCached('k', 5 * MIN, async () => 'v1');
  clock.now += 5 * MIN + cache.STALE_GRACE_MS;
  const gate = deferred();
  const pending = cache.getOrSetCached('k', 5 * MIN, () => gate.promise);
  let done = false;
  pending.then(() => { done = true; });
  await settle();
  assert.equal(done, false, 'too old to show: the caller waits for fresh data');
  gate.resolve('v2');
  assert.equal(await pending, 'v2');

  clock.now += 5 * MIN + cache.STALE_GRACE_MS;
  assert.equal(await cache.getOrSetCached('k', 5 * MIN, async () => { throw new Error('down'); }, { staleIfError: true }), 'v2');
  await assert.rejects(cache.getOrSetCached('k', 5 * MIN, async () => { throw new Error('down'); }), /down/);
});

test('a chapter list past its TTL waits for the network, and the kept copy answers only a failure', async () => {
  // A stale list would hide the chapter a new-chapter push opened, on the
  // title page and in the reader's next / previous, until the screen reopened.
  const disk = new Map();
  const first = cacheModule({ disk });
  const keys = ['manga:chapters:v3:a', 'manhwa:chapters:v2:mr:a', 'comics:chapters:v2:a', 'hentai:chapters:v2:a', 'novel:chapters:v2:a'];
  for (const key of keys) await first.cache.getOrSetCached(key, 15 * MIN, async () => ['ch1'], { staleIfError: true });
  await first.cache.getOrSetCached('manga:detail:v2:a', 30 * MIN, async () => 'detail');
  first.flushTimers();
  await settle();

  // The next evening, after a reload: inside the grace period.
  const later = cacheModule({ disk, now: first.clock.now + 20 * HOUR });
  for (const key of keys) {
    const gate = deferred();
    const pending = later.cache.getOrSetCached(key, 15 * MIN, () => gate.promise, { staleIfError: true });
    let done = false;
    pending.then(() => { done = true; });
    await settle();
    assert.equal(done, false, `${key}: not answered from yesterday's list`);
    gate.resolve(['ch1', 'ch2']);
    assert.deepEqual(await pending, ['ch1', 'ch2'], key);
  }
  // Offline: the list kept across the reload is still better than nothing.
  const offline = cacheModule({ disk, now: first.clock.now + 20 * HOUR });
  assert.deepEqual(await offline.cache.getOrSetCached(keys[0], 15 * MIN, async () => { throw new Error('offline'); },
    { staleIfError: true }), ['ch1']);
  // Everything else keeps stale-while-revalidate: a refresh that never ends
  // does not hold the title page.
  assert.equal(await offline.cache.getOrSetCached('manga:detail:v2:a', 30 * MIN, () => new Promise(() => {})), 'detail');
});

test('getCachedValue stays fresh-only (pass receipts and price alerts rely on it)', async () => {
  const { cache, clock } = cacheModule();
  await cache.setCachedValue('pass:receipt', 123, MIN);
  assert.equal(await cache.getCachedValue('pass:receipt'), 123);
  clock.now += 2 * MIN;
  assert.equal(await cache.getCachedValue('pass:receipt'), null);
  assert.equal(await cache.getCachedValue('missing'), null);
});

test('loader writes are coalesced into at most one write a second', async () => {
  const { cache, writes, timers, flushTimers, stored } = cacheModule();
  for (let i = 0; i < 5; i += 1) await cache.getOrSetCached(`k${i}`, MIN, async () => i);
  assert.equal(writes.length, 0, 'no write per miss');
  assert.deepEqual([...timers.values()].map((t) => t.ms), [cache.PERSIST_DEBOUNCE_MS]);
  assert.equal(cache.PERSIST_DEBOUNCE_MS, 1000);
  flushTimers();
  await settle();
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(stored()).sort(), ['k0', 'k1', 'k2', 'k3', 'k4']);
  flushTimers();
  assert.equal(writes.length, 1, 'nothing pending, nothing written');
});

test('pending writes are flushed when the page is hidden or unloads', async () => {
  const run = async (fire) => {
    const env = cacheModule();
    await env.cache.getOrSetCached('k', MIN, async () => 'v');
    assert.equal(env.writes.length, 0);
    fire(env);
    assert.equal(env.writes.length, 1, 'written synchronously inside the event');
    assert.equal(env.timers.size, 0, 'the debounce is cancelled');
    assert.equal(env.stored().k.value, 'v');
    fire(env);
    assert.equal(env.writes.length, 1, 'only when something is pending');
  };
  await run(({ window }) => window.dispatchEvent(new Event('pagehide')));
  await run(({ document }) => {
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // Becoming visible is not a reason to write.
  const env = cacheModule();
  await env.cache.getOrSetCached('k', MIN, async () => 'v');
  env.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(env.writes.length, 0);
});

test('setCachedValue is on disk when it resolves (user state goes through it)', async () => {
  const { cache, writes, stored } = cacheModule();
  await cache.setCachedValue('sakura_price_alerts_v1', [{ id: 'a' }], 365 * 24 * HOUR);
  assert.equal(writes.length, 1);
  assert.deepEqual(stored().sakura_price_alerts_v1.value, [{ id: 'a' }]);
});

test('a reload keeps stale entries for the grace period and drops older ones', async () => {
  const disk = new Map();
  const first = cacheModule({ disk });
  await first.cache.getOrSetCached('ancient', 5 * MIN, async () => 'a');
  first.clock.now += 2 * HOUR;
  await first.cache.getOrSetCached('recent', 5 * MIN, async () => 'r');
  first.flushTimers();
  await settle();

  // 25 h after `ancient` was loaded, 23 h after `recent`.
  const later = cacheModule({ disk, now: first.clock.now + 23 * HOUR });
  let calls = 0;
  const loader = async () => { calls += 1; return 'fresh'; };
  assert.equal(await later.cache.getOrSetCached('recent', 5 * MIN, loader), 'r', 'a day-old visit paints from disk');
  assert.equal(await later.cache.getOrSetCached('ancient', 5 * MIN, loader), 'fresh', 'older than the grace period: gone');
  await settle();
  assert.equal(calls, 2, 'the stale one is refreshed behind the screen');
});

test('a previous build\'s blob (fresh entries only, same shape) still loads', async () => {
  const disk = new Map([['sakura_api_cache.json', JSON.stringify({ 'manga:list:x': { exp: 2_000_000, value: [1] } })]]);
  const { cache } = cacheModule({ disk, now: 1_000_000 });
  assert.deepEqual(await cache.getOrSetCached('manga:list:x', MIN, async () => [2]), [1]);
});

test('the stored blob is bounded; the soonest-expiring entries go first', async () => {
  const { cache, flushTimers, stored, writes } = cacheModule();
  assert.equal(cache.MAX_PERSIST_CHARS, 1_500_000);
  const chunk = 'x'.repeat(100_000);
  await cache.setCachedValue('sakura_price_alerts_v1', [{ id: 'keep' }], 365 * 24 * HOUR);
  for (let i = 0; i < 20; i += 1) await cache.getOrSetCached(`list:${i}`, (i + 1) * MIN, async () => chunk);
  // One entry bigger than a quarter of the budget stays in memory only.
  const huge = 'y'.repeat(400_000);
  await cache.getOrSetCached('huge', 60 * MIN, async () => huge);
  flushTimers();
  await settle();
  const blob = writes.at(-1).value;
  assert.ok(blob.length <= cache.MAX_PERSIST_CHARS, `${blob.length} chars`);
  const keys = Object.keys(stored());
  assert.ok(keys.includes('sakura_price_alerts_v1'), 'long-lived user state survives');
  assert.ok(!keys.includes('list:0') && !keys.includes('list:5'), 'the soonest to expire were evicted');
  assert.ok(keys.includes('list:19'));
  assert.ok(!keys.includes('huge'));
  assert.equal(await cache.getOrSetCached('huge', 60 * MIN, async () => 'refetched'), huge, 'but it is still served from memory');
  let refetched = 0;
  assert.equal(await cache.getOrSetCached('list:0', MIN, async () => { refetched += 1; return 'again'; }), 'again',
    'evicted entries leave memory too, so memory is bounded as well');
  assert.equal(refetched, 1);
});

test('when storage refuses the write, a smaller blob is tried once', async () => {
  const { cache, writes, stored } = cacheModule({ failWrites: 1 });
  await cache.setCachedValue('a', 'x'.repeat(10), MIN);
  assert.equal(writes.length, 2);
  assert.deepEqual(stored().a.value, 'xxxxxxxxxx');
});

test('clearApiCache empties memory and disk, and a load in flight cannot write back', async () => {
  const { cache, disk, flushTimers } = cacheModule();
  await cache.setCachedValue('a', 1, MIN);
  const gate = deferred();
  const pending = cache.getOrSetCached('b', MIN, () => gate.promise);
  await settle();
  await cache.clearApiCache();
  assert.equal(disk.size, 0);
  gate.resolve(2);
  assert.equal(await pending, 2, 'the caller still gets its answer');
  flushTimers();
  await settle();
  assert.equal(disk.size, 0, 'but it is not cached into the cleared store');
  assert.equal(await cache.getCachedValue('a'), null);
  assert.equal(await cache.getApiCacheSizeBytes(), 0);
});

test('the size shown in settings includes writes still pending', async () => {
  const { cache } = cacheModule();
  await cache.getOrSetCached('k', MIN, async () => 'v');
  assert.ok(await cache.getApiCacheSizeBytes() > 0);
});
