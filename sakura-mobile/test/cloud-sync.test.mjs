import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../lib/cloud-sync.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * cloud-sync with a fake clock, fake timers, a fake Supabase that records
 * every upsert, and in-memory stores the test mutates.
 */
function harness({ failTables = new Set(), withWindow = false, pullRows = {} } = {}) {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  const upserts = [];
  const inFlight = { count: 0, max: 0 };
  const stores = {
    library: [{ id: 'm1', title: 'Solo Leveling', type: 'manga', cover: '', savedAt: 1 }],
    watch: [{ animeId: '21', episodeId: 'mal-21-1', positionSeconds: 10, updatedAt: 1 }],
    reading: { novels: {}, manga: { m1: { chapterId: 'c1', page: 3, updatedAt: 1 } } },
  };
  const merged = { library: [], watch: [], reading: [] };
  let gate = null;
  const supabase = {
    from(table) {
      return {
        async upsert(row) {
          inFlight.count++;
          inFlight.max = Math.max(inFlight.max, inFlight.count);
          if (gate) await gate.promise;
          inFlight.count--;
          // Snapshot what was sent, as Supabase would store it.
          upserts.push({ table, row: JSON.parse(JSON.stringify(row)) });
          return failTables.has(table) ? { error: { message: 'offline' } } : { error: null };
        },
        select() {
          return { eq: () => ({ maybeSingle: async () => ({ data: pullRows[table] ?? null }) }) };
        },
      };
    },
  };
  const listeners = {};
  const window = withWindow ? { addEventListener: (type, fn) => { listeners[type] = fn; } } : undefined;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Promise, JSON, Math, Map, Set, Error, Array, Object,
    Date: FakeDate,
    window,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    require: (id) => ({
      './supabase': { supabase },
      './storage': {
        Library: {
          getAll: async () => JSON.parse(JSON.stringify(stores.library)),
          mergeAll: async (items) => { merged.library.push(...items); },
        },
      },
      './reader-progress': {
        exportReadingProgress: async () => JSON.parse(JSON.stringify(stores.reading)),
        importReadingProgress: async (store) => { merged.reading.push(store); },
      },
      './watch-progress': {
        getAllWatchHistory: async () => JSON.parse(JSON.stringify(stores.watch)),
        importWatchProgress: async (entries) => { merged.watch.push(...entries); },
      },
    })[id],
  });
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      for (let i = 0; i < 5; i++) await flush();
    }
    now = target;
    for (let i = 0; i < 5; i++) await flush();
  }
  function hold() {
    let release;
    gate = { promise: new Promise((resolve) => { release = resolve; }) };
    return () => { const g = gate; gate = null; release(); return g; };
  }
  return { api: module.exports, stores, upserts, merged, advance, timers, inFlight, listeners, hold, get now() { return now; } };
}

const tables = (upserts) => upserts.map((u) => u.table).sort();

test('a stream of progress changes becomes one push per 30 s window, not one per change', async () => {
  const h = harness();
  // The player saves a bookmark every 3 s; every save asks for a push.
  for (let t = 0; t < 60_000; t += 3_000) {
    h.stores.watch[0].positionSeconds = 10 + t / 1000;
    h.api.scheduleCloudPush('W');
    await h.advance(3_000);
  }
  // First push after the 2.5 s settle sends all three (nothing pushed yet),
  // then only anime_history, at most every 30 s.
  const watchPushes = h.upserts.filter((u) => u.table === 'anime_history');
  assert.ok(watchPushes.length >= 2 && watchPushes.length <= 3, `got ${watchPushes.length} watch pushes in 60 s`);
  assert.equal(h.upserts.filter((u) => u.table === 'user_library').length, 1);
  assert.equal(h.upserts.filter((u) => u.table === 'manga_progress').length, 1);
  // The last push carries a recent position, and a pending push still holds the latest.
  await h.advance(30_000);
  const last = h.upserts.filter((u) => u.table === 'anime_history').at(-1);
  assert.equal(last.row.data[0].positionSeconds, h.stores.watch[0].positionSeconds);
});

test('the first change after a quiet spell goes out after the short settle', async () => {
  const h = harness();
  h.api.scheduleCloudPush('W');
  h.api.scheduleCloudPush('W');
  h.api.scheduleCloudPush('W');
  await h.advance(2_499);
  assert.equal(h.upserts.length, 0);
  await h.advance(1);
  assert.deepEqual(tables(h.upserts), ['anime_history', 'manga_progress', 'user_library']);
  // A change long after the window settles again quickly.
  await h.advance(120_000);
  h.stores.reading.manga.m1.page = 9;
  h.api.scheduleCloudPush('W');
  await h.advance(2_500);
  assert.deepEqual(tables(h.upserts.slice(3)), ['manga_progress']);
});

test('nothing changed means no request, even for a background flush', async () => {
  const h = harness();
  await h.api.pushAllToCloud('W');
  assert.equal(h.upserts.length, 3);
  await h.api.pushAllToCloud('W');
  h.api.scheduleCloudPush('W');
  await h.advance(60_000);
  assert.equal(h.upserts.length, 3);
});

test('only the store that changed is sent', async () => {
  const h = harness();
  await h.api.pushAllToCloud('W');
  h.stores.library.push({ id: 'a9', title: 'Frieren', type: 'anime', cover: '', savedAt: 2 });
  await h.api.pushAllToCloud('W');
  assert.deepEqual(tables(h.upserts.slice(3)), ['user_library']);
  assert.equal(h.upserts.at(-1).row.data.length, 2);
  assert.equal(h.upserts.at(-1).row.wallet_address, 'W');
});

test('a failed push is not counted as sent and is retried in the next window', async () => {
  const failing = new Set(['anime_history']);
  const h = harness({ failTables: failing });
  await h.api.pushAllToCloud('W');
  assert.equal(h.upserts.filter((u) => u.table === 'anime_history').length, 1);
  // Supabase comes back; the retry was scheduled by the failure itself.
  failing.clear();
  await h.advance(29_000);
  assert.equal(h.upserts.filter((u) => u.table === 'anime_history').length, 1);
  await h.advance(1_000);
  const watch = h.upserts.filter((u) => u.table === 'anime_history');
  assert.equal(watch.length, 2);
  // The tables that succeeded the first time are not re-sent.
  assert.equal(h.upserts.filter((u) => u.table === 'user_library').length, 1);
  // And once accepted, it stops.
  await h.advance(120_000);
  assert.equal(h.upserts.filter((u) => u.table === 'anime_history').length, 2);
});

test('flushes never overlap, so an older snapshot cannot land after a newer one', async () => {
  const h = harness();
  const release = h.hold();
  const first = h.api.pushAllToCloud('W');
  await flush();
  h.stores.watch[0].positionSeconds = 999;
  const second = h.api.pushAllToCloud('W');
  await flush();
  release();
  await Promise.all([first, second]);
  assert.ok(h.inFlight.max <= 3, 'one flush at a time (its three tables in parallel)');
  const watch = h.upserts.filter((u) => u.table === 'anime_history');
  assert.equal(watch.at(-1).row.data[0].positionSeconds, 999);
});

test('a pull forgets what the cloud holds, so the next flush sends everything again', async () => {
  const h = harness({ pullRows: { user_library: { data: [{ id: 'x', title: 'X', type: 'manga' }, { bad: true }] } } });
  await h.api.pushAllToCloud('W');
  assert.equal(h.upserts.length, 3);
  await h.api.pullAllFromCloud('W');
  // Untrusted rows are still validated on the way in.
  assert.deepEqual(h.merged.library.map((i) => i.id), ['x']);
  await h.api.pushAllToCloud('W');
  assert.equal(h.upserts.length, 6);
});

test('switching wallets flushes the previous wallet before merging the new one', async () => {
  const h = harness({ pullRows: { user_library: { data: [{ id: 'b-only', title: 'B', type: 'manga' }] } } });
  h.api.scheduleCloudPush('A');
  h.stores.reading.manga.m1.page = 20;
  await h.api.pullAllFromCloud('B');
  const toA = h.upserts.filter((u) => u.row.wallet_address === 'A');
  assert.deepEqual(tables(toA), ['anime_history', 'manga_progress', 'user_library']);
  assert.equal(toA.find((u) => u.table === 'manga_progress').row.chapter_progress.manga.m1.page, 20);
  // A's timer is gone: nothing more is sent to A later.
  await h.advance(120_000);
  assert.equal(h.upserts.filter((u) => u.row.wallet_address === 'A').length, 3);
});

test('pagehide flushes a waiting push immediately on web', async () => {
  const h = harness({ withWindow: true });
  h.api.scheduleCloudPush('W');
  assert.equal(typeof h.listeners.pagehide, 'function');
  h.listeners.pagehide();
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(h.upserts.length, 3);
  // Nothing was waiting: pagehide sends nothing.
  h.listeners.pagehide();
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(h.upserts.length, 3);
});

test('without a DOM window (native) scheduling still works', async () => {
  const h = harness({ withWindow: false });
  h.api.scheduleCloudPush('W');
  await h.advance(2_500);
  assert.equal(h.upserts.length, 3);
});

test('fingerprints are stable for equal data and differ for changes', () => {
  const { api } = harness();
  const a = { manga: { m1: { page: 3 } } };
  assert.equal(api.syncFingerprint(a), api.syncFingerprint(JSON.parse(JSON.stringify(a))));
  assert.notEqual(api.syncFingerprint(a), api.syncFingerprint({ manga: { m1: { page: 4 } } }));
  assert.notEqual(api.syncFingerprint([]), api.syncFingerprint({}));
});

test('while pushes keep failing the retry window doubles up to a cap, and a success resets it', async () => {
  const failing = new Set(['anime_history']);
  const h = harness({ failTables: failing });
  h.api.scheduleCloudPush('W');
  await h.advance(2_500);
  const watchAttempts = () => h.upserts.filter((u) => u.table === 'anime_history').length;
  // Note when each retry happens (1 s resolution) over 20 minutes offline.
  const times = [h.now];
  let seen = watchAttempts();
  for (let elapsed = 0; elapsed < 20 * 60_000; elapsed += 1_000) {
    await h.advance(1_000);
    if (watchAttempts() > seen) { times.push(h.now); seen = watchAttempts(); }
  }
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  // 30 s, 1 min, 2 min, 4 min, then capped at 5 min — not 40 re-sends.
  assert.deepEqual(gaps.slice(0, 5), [30_000, 60_000, 120_000, 240_000, 300_000]);
  assert.ok(gaps.every((g) => g <= h.api.PUSH_MAX_BACKOFF_MS), `a gap exceeded the cap: ${gaps}`);
  // Back online: the pending retry lands, and the normal 30 s window applies again.
  failing.clear();
  await h.advance(h.api.PUSH_MAX_BACKOFF_MS);
  assert.equal(h.upserts.at(-1).table, 'anime_history');
  const before = h.upserts.length;
  h.stores.watch[0].positionSeconds = 4242;
  h.api.scheduleCloudPush('W');
  await h.advance(30_000);
  assert.equal(h.upserts.length, before + 1);
  assert.equal(h.upserts.at(-1).row.data[0].positionSeconds, 4242);
});

test('a failed flush of the previous wallet during a switch is not retried into its row', async () => {
  const failing = new Set(['user_library', 'anime_history', 'manga_progress']);
  const h = harness({ failTables: failing });
  h.api.scheduleCloudPush('A');
  await h.api.pullAllFromCloud('B');
  const toA = () => h.upserts.filter((u) => u.row.wallet_address === 'A').length;
  assert.equal(toA(), 3, 'the switch tried to flush A once (and Supabase refused it)');
  failing.clear();
  // B's cloud data is now merged into the shared local stores: none of it may follow to A.
  h.stores.library.push({ id: 'b-title', title: 'From B', type: 'manga', cover: '', savedAt: 3 });
  await h.advance(10 * 60_000);
  assert.equal(toA(), 3);
});
