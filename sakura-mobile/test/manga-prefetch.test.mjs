import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../lib/manga-prefetch.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const settle = () => new Promise(resolve => setImmediate(resolve));

/**
 * A fresh copy of the module per test, with the fetchers, the source registry,
 * the clock, idle callbacks and the network information all under the test's
 * control. Each fetcher call is recorded and answered by a deferred, so tests
 * decide when (and whether) a request finishes.
 */
function harness({ connection, onLine = true, timers } = {}) {
  const calls = [];
  const pending = [];
  const fetcher = kind => id => {
    const gate = deferred();
    calls.push(`${kind}:${id}`);
    pending.push({ kind, id, gate });
    return gate.promise;
  };
  const adapters = {
    manhwa: { key: 'manhwa', adult: false, detail: fetcher('manhwa-detail'), chapters: fetcher('manhwa-chapters') },
    hentai: { key: 'hentai', adult: true, detail: fetcher('hentai-detail'), chapters: fetcher('hentai-chapters') },
  };
  const idle = [];
  const clock = { now: 1_000_000 };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Promise, Map, Set, WeakMap,
    Date: { now: () => clock.now },
    // Unref'd: a test that leaves a request hanging must not keep the run
    // alive for the module's 15 s slot timer.
    setTimeout: timers?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms).unref()), clearTimeout: timers?.clearTimeout ?? clearTimeout,
    requestIdleCallback: fn => { idle.push(fn); return idle.length; },
    cancelIdleCallback: () => {},
    navigator: { onLine, connection },
    require: name => {
      if (name === '@/lib/manga') return { fetchMangaDetail: fetcher('detail'), fetchMangaChapters: fetcher('chapters') };
      if (name === '@/lib/scraped-sources') return { getScrapedAdapter: key => adapters[key] ?? null };
      throw new Error(`unexpected import ${name}`);
    },
  });
  const runIdle = async () => {
    while (idle.length) idle.splice(0).forEach(fn => fn());
    await settle();
  };
  return { api: module.exports, calls, pending, clock, runIdle };
}

test('previews keep what a card knew, per source, and never for 18+ or non-manga items', () => {
  const { api } = harness();
  api.rememberMangaPreview({ id: 'a1', title: ' One Piece ', cover: '/c.avif', type: 'manga' });
  api.rememberMangaPreview({ id: 'a1', source: 'manhwa', title: 'Solo', cover: '/m.webp' });
  api.rememberMangaPreview({ id: 'h1', source: 'hentai', title: 'Adult', cover: '/h.jpg' });
  api.rememberMangaPreview({ id: 'n1', type: 'novel', title: 'A novel', cover: '/n.jpg' });
  api.rememberMangaPreview({ id: 'blank', title: '   ' });
  assert.deepEqual({ ...api.getMangaPreview('a1') }, { title: 'One Piece', cover: '/c.avif' });
  assert.deepEqual({ ...api.getMangaPreview('a1', 'manga') }, { title: 'One Piece', cover: '/c.avif' }, "'manga' is atsu");
  assert.deepEqual({ ...api.getMangaPreview('a1', 'manhwa') }, { title: 'Solo', cover: '/m.webp' });
  assert.equal(api.getMangaPreview('h1', 'hentai'), null);
  assert.equal(api.getMangaPreview('n1'), null);
  assert.equal(api.getMangaPreview('blank'), null);
});

test('previews are bounded, dropping the least recently remembered first', () => {
  const { api } = harness();
  for (let i = 0; i < 400; i++) api.rememberMangaPreview({ id: `t${i}`, title: `Title ${i}` });
  api.rememberMangaPreview({ id: 't0', title: 'Title 0 again' });
  api.rememberMangaPreview({ id: 'extra', title: 'Extra' });
  assert.equal(api.getMangaPreview('t1'), null, 'oldest untouched entry goes');
  assert.equal(api.getMangaPreview('t0').title, 'Title 0 again', 're-remembering refreshes an entry');
  assert.equal(api.getMangaPreview('extra').title, 'Extra');
});

test('the page joins a load already in flight; a Retry (fresh) asks again', async () => {
  const { api, calls, pending } = harness();
  const first = api.loadMangaDetail('m1');
  const joined = api.loadMangaDetail('m1');
  assert.equal(first, joined);
  assert.deepEqual(calls, ['detail:m1']);
  const retry = api.loadMangaDetail('m1', null, { fresh: true });
  assert.notEqual(retry, first);
  assert.deepEqual(calls, ['detail:m1', 'detail:m1']);
  pending[0].gate.resolve({ id: 'm1', title: 'Old' });
  pending[1].gate.resolve({ id: 'm1', title: 'New' });
  assert.equal((await first).title, 'Old');
  assert.equal((await retry).title, 'New');
  // Settled loads are forgotten: lib/cache.ts owns the answer from here.
  api.loadMangaDetail('m1');
  assert.equal(calls.length, 3);
});

test('shared loads keep the fetchers\' contract, including rejections, and route scraped sources', async () => {
  const { api, calls, pending } = harness();
  const chapters = api.loadMangaChapters('s1', 'manhwa');
  assert.deepEqual(calls, ['manhwa-chapters:s1']);
  pending[0].gate.reject(new Error('down'));
  await assert.rejects(chapters, /down/);
  api.loadMangaChapters('s1', 'manhwa');
  assert.equal(calls.length, 2, 'a failure is not remembered');
});

test('hover or press prefetches detail and chapters at once, once per title', async () => {
  const { api, calls } = harness();
  api.prefetchMangaTitle({ id: 'm1', title: 'T', cover: '/c' }, 'intent');
  api.prefetchMangaTitle({ id: 'm1', title: 'T', cover: '/c' }, 'intent');
  api.prefetchMangaTitle({ id: 'm1' }, 'intent', { pressed: true });
  assert.deepEqual(calls, ['detail:m1', 'chapters:m1']);
  assert.equal(api.getMangaPreview('m1').title, 'T', 'a prefetch also leaves a preview');
  // The page itself then joins the prefetch rather than repeating it.
  api.loadMangaDetail('m1');
  api.loadMangaChapters('m1');
  assert.equal(calls.length, 2);
});

test('nothing is prefetched for 18+ titles, other media types or while offline', async () => {
  const { api, calls, runIdle } = harness();
  api.prefetchMangaTitle({ id: 'h1', source: 'hentai', title: 'Adult' }, 'intent', { pressed: true });
  api.prefetchMangaTitle({ id: 'h2', source: 'hentai' }, 'visible');
  api.prefetchMangaTitle({ id: 'a1', type: 'anime' }, 'intent');
  await runIdle();
  assert.deepEqual(calls, []);
  const off = harness({ onLine: false });
  off.api.prefetchMangaTitle({ id: 'm1' }, 'intent', { pressed: true });
  await off.runIdle();
  assert.deepEqual(off.calls, []);
});

test('data saver and 2G allow only a press, which navigates anyway', async () => {
  for (const connection of [{ saveData: true }, { effectiveType: 'slow-2g' }, { effectiveType: '2g' }]) {
    const { api, calls, runIdle } = harness({ connection });
    api.prefetchMangaTitle({ id: 'hover' }, 'intent');
    api.prefetchMangaTitle({ id: 'seen' }, 'visible');
    await runIdle();
    assert.deepEqual(calls, [], JSON.stringify(connection));
    api.prefetchMangaTitle({ id: 'press' }, 'intent', { pressed: true });
    assert.deepEqual(calls, ['detail:press', 'chapters:press']);
  }
  const fast = harness({ connection: { effectiveType: '4g' } });
  fast.api.prefetchMangaTitle({ id: 'hover' }, 'intent');
  assert.equal(fast.calls.length, 2);
});

test('visible cards load only the detail, at idle, two at a time', async () => {
  const { api, calls, pending, runIdle } = harness();
  for (const id of ['v1', 'v2', 'v3', 'v4']) api.prefetchMangaTitle({ id, title: id }, 'visible');
  assert.deepEqual(calls, [], 'nothing before idle');
  await runIdle();
  assert.deepEqual(calls, ['detail:v1', 'detail:v2']);
  pending[0].gate.resolve({ id: 'v1' });
  await settle();
  await runIdle();
  assert.deepEqual(calls, ['detail:v1', 'detail:v2', 'detail:v3']);
  pending[1].gate.resolve(null);
  pending[2].gate.reject(new Error('x'));
  await settle();
  await runIdle();
  assert.deepEqual(calls, ['detail:v1', 'detail:v2', 'detail:v3', 'detail:v4']);
});

test('a visible card is not queued twice, and a hover is not blocked by the queue', async () => {
  const { api, calls, runIdle } = harness();
  api.prefetchMangaTitle({ id: 'v1' }, 'visible');
  api.prefetchMangaTitle({ id: 'v1' }, 'visible');
  // Hovered while still waiting for idle: starts now, not after the queue.
  api.prefetchMangaTitle({ id: 'v1' }, 'intent');
  assert.deepEqual(calls, ['detail:v1', 'chapters:v1']);
  await runIdle();
  assert.deepEqual(calls, ['detail:v1', 'chapters:v1'], 'the queued job finds it already started');
});

test('visible prefetches are budgeted per minute; hover is not', async () => {
  const { api, calls, pending, clock, runIdle } = harness();
  const drain = async () => {
    for (let round = 0; round < 10; round++) {
      pending.forEach(entry => entry.gate.resolve(null));
      await settle();
      await runIdle();
    }
  };
  for (let i = 0; i < 12; i++) api.prefetchMangaTitle({ id: `v${i}` }, 'visible');
  await runIdle();
  await drain();
  assert.equal(calls.filter(call => call.startsWith('detail:v')).length, 8);
  api.prefetchMangaTitle({ id: 'hovered' }, 'intent');
  assert.ok(calls.includes('detail:hovered'));
  clock.now += 61_000;
  api.prefetchMangaTitle({ id: 'v11' }, 'visible');
  await runIdle();
  await drain();
  assert.ok(calls.includes('detail:v11'), 'budget refills after a minute');
});

test('a title prefetched recently is not prefetched again until the window passes', async () => {
  const { api, calls, pending, clock } = harness();
  api.prefetchMangaTitle({ id: 'm1' }, 'intent');
  pending.forEach(entry => entry.gate.resolve(null));
  await settle();
  api.prefetchMangaTitle({ id: 'm1' }, 'intent');
  assert.equal(calls.length, 2);
  clock.now += 5 * 60_000 + 1;
  api.prefetchMangaTitle({ id: 'm1' }, 'intent');
  assert.equal(calls.length, 4);
});

test('runWhenIdle falls back to a short timer where requestIdleCallback is missing', async () => {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Promise, Map, Set, WeakMap, Date, setTimeout, clearTimeout,
    require: name => (name === '@/lib/scraped-sources' ? { getScrapedAdapter: () => null } : {}),
  });
  let ran = 0;
  module.exports.runWhenIdle(() => { ran++; }, 5000);
  const cancelled = module.exports.runWhenIdle(() => { ran += 10; }, 5000);
  cancelled.cancel();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(ran, 1);
});

test('a load that has hung for 15 s is not joined; the next caller asks again', async () => {
  const { api, calls, pending, clock } = harness();
  const hung = api.loadMangaDetail('m1');
  clock.now += 14_000;
  assert.equal(api.loadMangaDetail('m1'), hung, 'still young enough to join');
  clock.now += 1_001;
  const next = api.loadMangaDetail('m1');
  assert.notEqual(next, hung);
  assert.deepEqual(calls, ['detail:m1', 'detail:m1']);
  pending[1].gate.resolve({ id: 'm1', title: 'Live' });
  assert.equal((await next).title, 'Live');
  // The hung one settling late must not clear the entry of the one after it.
  const again = api.loadMangaDetail('m1');
  pending[0].gate.resolve(null);
  await settle();
  assert.equal(api.loadMangaDetail('m1'), again);
});

test('a hung visible prefetch frees its slot instead of stalling the queue', async () => {
  // The module's own timers, run by hand: the slot is released by one.
  const scheduled = [];
  const timers = {
    setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimeout: id => { if (scheduled[id - 1]) scheduled[id - 1].fn = () => {}; },
  };
  const { api, calls, clock, runIdle } = harness({ timers });
  for (const id of ['v1', 'v2', 'v3']) api.prefetchMangaTitle({ id }, 'visible');
  await runIdle();
  assert.deepEqual(calls, ['detail:v1', 'detail:v2']);
  // Both hang: nothing settles. Their slot timers are what move the queue.
  await settle();
  const slotTimers = scheduled.filter(t => t.ms === 15_000);
  assert.equal(slotTimers.length, 2);
  clock.now += 15_001;
  slotTimers.forEach(t => t.fn());
  await settle();
  await runIdle();
  assert.deepEqual(calls, ['detail:v1', 'detail:v2', 'detail:v3']);
});

test('a hover counts only once the pointer rests on the card', async () => {
  const { api, calls } = harness();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Crossing cards on the way somewhere else: nothing.
  api.hoverMangaTitle({ id: 'a', title: 'A' });
  await wait(20);
  api.leaveMangaTitle({ id: 'a', title: 'A' });
  api.hoverMangaTitle({ id: 'b', title: 'B' });
  api.leaveMangaTitle({ id: 'b', title: 'B' });
  await wait(api.HOVER_INTENT_MS + 30);
  assert.deepEqual(calls, []);
  // Resting on one: detail and chapters, once.
  api.hoverMangaTitle({ id: 'c', title: 'C' });
  api.hoverMangaTitle({ id: 'c', title: 'C' });
  await wait(api.HOVER_INTENT_MS + 30);
  assert.deepEqual(calls, ['detail:c', 'chapters:c']);
  // Never for 18+ titles, however long the pointer rests.
  api.hoverMangaTitle({ id: 'h', source: 'hentai', title: 'H' });
  await wait(api.HOVER_INTENT_MS + 30);
  assert.deepEqual(calls, ['detail:c', 'chapters:c']);
});

test('visible cards of droplet-scraped sources are left to intent', async () => {
  const { api, calls, runIdle } = harness();
  api.prefetchMangaTitle({ id: 's1', source: 'manhwa', title: 'S' }, 'visible');
  await runIdle();
  assert.deepEqual(calls, []);
  assert.equal(api.getMangaPreview('s1', 'manhwa').title, 'S', 'the preview is still kept');
  api.prefetchMangaTitle({ id: 's1', source: 'manhwa' }, 'intent', { pressed: true });
  assert.deepEqual(calls, ['manhwa-detail:s1', 'manhwa-chapters:s1']);
});
