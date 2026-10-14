import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../lib/watch-progress.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
const entry = (changes = {}) => ({
  animeId: '21', episodeId: 'mal-21-1', episodeNumber: 1, title: 'One Piece', cover: '',
  episodeTitle: 'Episode 1', progress: 0.005, positionSeconds: 7.25,
  durationSeconds: 1440, completed: false, updatedAt: 1, ...changes,
});
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness({ snapshot = { anime: {} }, read, write } = {}) {
  const writes = []; let reads = 0;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: id => {
      assert.equal(id, 'expo-file-system/legacy');
      return {
        documentDirectory: 'test://', getInfoAsync: async () => ({ exists: true }),
        readAsStringAsync: async () => { reads++; return read ? read() : JSON.stringify(snapshot); },
        writeAsStringAsync: (_path, contents) => { writes.push(JSON.parse(contents)); return write ? write(contents) : Promise.resolve(); },
      };
    },
  });
  return { api: module.exports, writes, get reads() { return reads; } };
}

test('exact early seconds resume while explicit zero restarts and legacy ratios still work', () => {
  const { api } = harness();
  assert.equal(api.canResumeWatchProgress(entry()), true);
  assert.equal(api.resumePosition(entry()), 7.25);
  assert.equal(api.resumePosition(entry({ positionSeconds: 0.25 })), 0.25);
  assert.equal(api.resumePosition(entry({ positionSeconds: 30 }), 20), 20);
  assert.equal(api.canResumeWatchProgress(entry({ positionSeconds: 0, progress: 0.3 })), false);
  assert.equal(api.resumePosition(entry({ positionSeconds: undefined, progress: 0.5 })), 720);
  assert.equal(api.resumePosition(entry({ positionSeconds: undefined, durationSeconds: undefined, progress: 0.5 })), 0);
  assert.equal(api.resumePosition(entry({ positionSeconds: undefined, durationSeconds: undefined, progress: 0.5 }), 1200), 600);
  assert.equal(api.canResumeWatchProgress(entry({ positionSeconds: Infinity, progress: 0 })), false);
});

test('concurrent initial reads share one load and cannot replace a newer mutation', async () => {
  const gate = deferred();
  const h = harness({ read: () => gate.promise });
  const first = h.api.getAnimeWatchProgress('21');
  const saving = h.api.setAnimeWatchProgress(entry({ positionSeconds: 15 }));
  const history = h.api.getAllWatchHistory();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.reads, 1);
  gate.resolve(JSON.stringify({ anime: { 21: entry({ positionSeconds: 2 }) } }));
  await Promise.all([first, saving, history]);
  assert.equal(h.reads, 1);
  assert.equal((await h.api.getAnimeWatchProgress('21')).positionSeconds, 15);
  assert.equal(h.writes.at(-1).anime['21'].positionSeconds, 15);
});

test('overlapping saves serialize snapshots; loaded idle checkpoints invoke storage immediately', async () => {
  const gates = [];
  const h = harness({ write: () => { const gate = deferred(); gates.push(gate); return gate.promise; } });
  await h.api.getAllWatchHistory();
  const older = h.api.setAnimeWatchProgress(entry({ positionSeconds: 10 }));
  assert.equal(h.writes.length, 1, 'pagehide hot path must call the web shim before returning');
  const newer = h.api.setAnimeWatchProgress(entry({ positionSeconds: 20 }));
  assert.equal(h.writes.length, 1, 'second native write waits for first');
  gates[0].resolve();
  await older;
  await Promise.resolve();
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].anime['21'].positionSeconds, 20);
  gates[1].resolve();
  await newer;
});

test('a failed write or subscriber does not poison subsequent saves', async () => {
  let count = 0;
  const h = harness({ write: () => ++count === 1 ? Promise.reject(new Error('storage unavailable')) : Promise.resolve() });
  h.api.subscribeWatchProgress(() => { throw new Error('broken subscriber'); });
  await h.api.setAnimeWatchProgress(entry());
  await h.api.setAnimeWatchProgress(entry({ positionSeconds: 25 }));
  assert.equal(h.writes.at(-1).anime['21'].positionSeconds, 25);
  assert.equal((await h.api.getAnimeWatchProgress('21')).positionSeconds, 25);
});

test('actual ended completion advances, late credits stay resumable, and legacy completion remains compatible', async () => {
  const h = harness();
  const episodes = [{ id: 'mal-21-1', number: 1, title: 'One' }, { id: 'mal-21-2', number: 2, title: 'Two' }];
  await h.api.setAnimeWatchProgressWithAdvance(entry({ progress: 0.995, positionSeconds: 1432.8 }), episodes);
  const credits = await h.api.getAnimeWatchProgress('21');
  assert.equal(credits.episodeId, 'mal-21-1');
  assert.equal(h.api.canResumeWatchProgress(credits), true);
  assert.equal((await h.api.getContinueWatching()).length, 1);
  await h.api.setAnimeWatchProgressWithAdvance(entry({ progress: 1, positionSeconds: 1440, completed: true }), episodes);
  const next = await h.api.getAnimeWatchProgress('21');
  assert.equal(next.episodeId, 'mal-21-2');
  assert.equal(next.progress, 0);
  assert.equal(next.positionSeconds, undefined);
  assert.equal(next.durationSeconds, undefined);
  assert.equal(next.completed, false);
  assert.equal(h.api.canResumeWatchProgress(next), false);
  await h.api.setAnimeWatchProgressWithAdvance(entry({ progress: 0.99, completed: undefined }), episodes);
  assert.equal((await h.api.getAnimeWatchProgress('21')).episodeId, 'mal-21-2');
  await h.api.setAnimeWatchProgressWithAdvance(entry({ completed: true }), [episodes[0]]);
  assert.equal((await h.api.getContinueWatching()).length, 0);
});

test('early playback is discoverable and a restart persists zero without discarding measured duration', async () => {
  const h = harness();
  await h.api.setAnimeWatchProgress(entry({ positionSeconds: 0.5, progress: 0.0003 }));
  assert.equal((await h.api.getContinueWatching()).length, 1);
  await h.api.setAnimeWatchProgress(entry({ positionSeconds: 0, progress: 0 }));
  assert.equal(h.writes.at(-1).anime['21'].positionSeconds, 0);
  assert.equal(h.writes.at(-1).anime['21'].durationSeconds, 1440);
});

test('disk/cloud data is validated, newer cloud records win, and callers cannot mutate the store', async () => {
  const h = harness({ snapshot: { anime: { 21: entry({ updatedAt: 20 }), invalid: { animeId: 'broken' }, proto: entry({ animeId: '__proto__' }) } } });
  await h.api.importWatchProgress([
    entry({ updatedAt: 10, positionSeconds: 1 }),
    entry({ updatedAt: 30, positionSeconds: 12.5, durationSeconds: 1300 }),
    { animeId: 'bad' },
    entry({ animeId: 'broken-clock', positionSeconds: Infinity, durationSeconds: NaN, progress: NaN }),
  ]);
  const loaded = await h.api.getAnimeWatchProgress('21');
  assert.equal(loaded.positionSeconds, 12.5);
  assert.equal(loaded.durationSeconds, 1300);
  loaded.positionSeconds = 999;
  assert.equal((await h.api.getAnimeWatchProgress('21')).positionSeconds, 12.5);
  assert.equal(await h.api.getAnimeWatchProgress('bad'), null);
  assert.equal((await h.api.getAnimeWatchProgress('broken-clock')).positionSeconds, undefined);
  assert.equal((await h.api.getAnimeWatchProgress('__proto__')).animeId, '__proto__');
  await h.api.clearAllWatchProgress();
  assert.deepEqual(plain(await h.api.getAllWatchHistory()), []);
});

const catalog = [1, 2, 3].map(number => ({ id: `mal-21-${number}`, number, title: `Episode ${number}` }));
const episode = (number, changes = {}) => entry({ episodeId: `mal-21-${number}`, episodeNumber: number, episodeTitle: `Episode ${number}`, ...changes });

test('legacy snapshots migrate to per-episode history and exact earlier clocks survive advancement', async () => {
  const h = harness({ snapshot: { anime: { 21: entry({ updatedAt: 20 }) } } });
  let record = await h.api.getAnimeWatchProgress('21');
  assert.equal(record.episodeHistory['mal-21-1'].positionSeconds, 7.25);
  await h.api.setAnimeWatchProgressWithAdvance(entry({ updatedAt: 21, completed: true, progress: 1, positionSeconds: 1440 }), catalog);
  record = await h.api.getAnimeWatchProgress('21');
  assert.equal(record.episodeId, 'mal-21-2');
  assert.equal(h.api.isEpisodeWatched(record, 'mal-21-1'), true);
  assert.equal(record.episodeHistory['mal-21-1'].positionSeconds, 1440);
  assert.deepEqual(plain(record.knownEpisodes), catalog.map(({ id, number }) => ({ id, number })));
  await h.api.setAnimeWatchProgress(episode(2, { updatedAt: 22, positionSeconds: 50 }));
  await h.api.setAnimeWatchProgress(episode(3, { updatedAt: 23, positionSeconds: 12 }));
  assert.equal((await h.api.getAnimeWatchProgress('21', 'mal-21-2', 2)).positionSeconds, 50);
  assert.equal((await h.api.getAnimeWatchProgress('21')).episodeId, 'mal-21-3');
  const reloaded = harness({ snapshot: h.writes.at(-1) });
  assert.equal(reloaded.api.isEpisodeWatched(await reloaded.api.getAnimeWatchProgress('21'), 'mal-21-1'), true);
});

test('rewatching preserves watched history and explicit unwatched beats a delayed completion', async () => {
  const h = harness();
  await h.api.setAnimeWatchProgressWithAdvance(entry({ completed: true, progress: 1, positionSeconds: 1440, updatedAt: 10 }), catalog);
  await h.api.setAnimeWatchProgress(entry({ updatedAt: 11, positionSeconds: 0, progress: 0, completed: false }));
  await h.api.setAnimeWatchProgress(entry({ updatedAt: 12, positionSeconds: 5, progress: 0.003 }));
  let record = await h.api.getAnimeWatchProgress('21');
  assert.equal(h.api.isEpisodeWatched(record, 'mal-21-1'), true);
  assert.equal(h.api.canResumeWatchProgress(record), true);
  await h.api.setAnimeEpisodeWatched(entry(), false, catalog);
  record = await h.api.getAnimeWatchProgress('21');
  const changed = record.updatedAt;
  assert.equal(h.api.isEpisodeWatched(record, 'mal-21-1'), false);
  assert.equal(record.positionSeconds, 0);
  await h.api.setAnimeWatchProgressWithAdvance(entry({ updatedAt: changed - 1, completed: true, progress: 1 }), catalog);
  assert.equal(h.api.isEpisodeWatched(await h.api.getAnimeWatchProgress('21'), 'mal-21-1'), false);
  await h.api.setAnimeWatchProgressWithAdvance(entry({ updatedAt: changed + 1, completed: true, progress: 1 }), catalog);
  assert.equal(h.api.isEpisodeWatched(await h.api.getAnimeWatchProgress('21'), 'mal-21-1'), true);
});

test('a delayed episode checkpoint cannot move the current title bookmark backwards', async () => {
  const h = harness();
  await h.api.setAnimeWatchProgress(episode(1, { updatedAt: 100, positionSeconds: 10 }));
  await h.api.setAnimeWatchProgress(episode(2, { updatedAt: 200, positionSeconds: 25 }));
  await h.api.setAnimeWatchProgress(episode(1, { updatedAt: 150, positionSeconds: 15 }));
  assert.equal((await h.api.getAnimeWatchProgress('21')).episodeId, 'mal-21-2');
  assert.equal((await h.api.getAnimeWatchProgress('21', 'mal-21-1', 1)).positionSeconds, 15);
  await h.api.setAnimeWatchProgress(episode(1, { updatedAt: 140, positionSeconds: 12 }));
  assert.equal((await h.api.getAnimeWatchProgress('21', 'mal-21-1', 1)).positionSeconds, 15);
});

test('removing Continue Watching survives reload and stale saves; fresh viewing restores it', async () => {
  const h = harness();
  await h.api.setAnimeWatchProgress(entry({ updatedAt: 100 }));
  await h.api.removeFromContinueWatching('21');
  const removed = await h.api.getAnimeWatchProgress('21');
  assert.equal((await h.api.getContinueWatching()).length, 0);
  assert.equal(removed.positionSeconds, 7.25);
  const reloaded = harness({ snapshot: h.writes.at(-1) });
  assert.equal((await reloaded.api.getContinueWatching()).length, 0);
  await reloaded.api.setAnimeWatchProgress(entry({ updatedAt: removed.continueDismissedAt - 1, positionSeconds: 8 }));
  assert.equal((await reloaded.api.getContinueWatching()).length, 0);
  await reloaded.api.setAnimeWatchProgress(entry({ updatedAt: removed.continueDismissedAt + 1, positionSeconds: 9 }));
  assert.equal((await reloaded.api.getContinueWatching()).length, 1);
  assert.equal((await reloaded.api.getAnimeWatchProgress('21')).positionSeconds, 9);
});

test('manual status alone does not create Continue Watching; known catalogs drive viewing status', async () => {
  const h = harness();
  assert.equal(h.api.getAnimeViewingStatus(null), 'not-started');
  await h.api.setAnimeEpisodeWatched(entry(), false, catalog);
  let record = await h.api.getAnimeWatchProgress('21');
  assert.equal(h.api.getAnimeViewingStatus(record), 'not-started');
  assert.equal(h.api.hasAnimeViewingHistory(record), false);
  assert.equal((await h.api.getContinueWatching()).length, 0);
  const reloaded = harness({ snapshot: h.writes.at(-1) });
  assert.equal((await reloaded.api.getContinueWatching()).length, 0);
  for (const row of catalog) await h.api.setAnimeEpisodeWatched(episode(row.number), true, catalog);
  record = await h.api.getAnimeWatchProgress('21');
  assert.equal(h.api.getAnimeViewingStatus(record), 'completed');
  assert.equal((await h.api.getContinueWatching()).length, 0);
  await h.api.registerAnimeEpisodeCatalog('21', [...catalog, { id: 'mal-21-4', number: 4 }]);
  record = await h.api.getAnimeWatchProgress('21');
  assert.equal(h.api.getAnimeViewingStatus(record), 'started');
  assert.equal(h.api.getAnimeViewingStatus({ ...record, knownEpisodes: undefined }), 'started');
  assert.equal(h.api.getAnimeViewingStatus(record, catalog), 'completed');
  assert.equal(h.api.hasAnimeViewingHistory(record), true);
  record.knownEpisodes[0].id = 'mutated';
  assert.equal((await h.api.getAnimeWatchProgress('21')).knownEpisodes[0].id, 'mal-21-1');
});

test('cloud roundtrips merge different episodes and explicit status/dismissal tombstones', async () => {
  const h = harness();
  await h.api.setAnimeWatchProgress(episode(1, { updatedAt: 100, positionSeconds: 50 }));
  await h.api.setAnimeEpisodeWatched(episode(1), false, catalog);
  await h.api.removeFromContinueWatching('21');
  const local = await h.api.getAnimeWatchProgress('21');
  const cloud = entry({ episodeId: 'mal-21-2', episodeNumber: 2, updatedAt: local.updatedAt - 5, positionSeconds: 30,
    episodeHistory: { 'mal-21-1': { ...entry(), watched: true, watchedUpdatedAt: 100, updatedAt: 100 },
      'mal-21-2': { ...episode(2), positionSeconds: 30, watched: false, watchedUpdatedAt: 101, updatedAt: 101 } } });
  await h.api.importWatchProgress([cloud]);
  let record = await h.api.getAnimeWatchProgress('21');
  assert.equal(record.episodeId, 'mal-21-1');
  assert.equal(h.api.isEpisodeWatched(record, 'mal-21-1'), false);
  assert.equal(h.api.getEpisodeWatchProgress(record, 'mal-21-2').positionSeconds, 30);
  assert.equal((await h.api.getContinueWatching()).length, 0);
  const other = harness();
  await other.api.importWatchProgress(await h.api.getAllWatchHistory());
  assert.deepEqual(plain(await other.api.getAnimeWatchProgress('21')), plain(record));
  // An older client only knows the latest bookmark; it must not erase other episodes.
  await other.api.importWatchProgress([episode(3, { updatedAt: record.updatedAt + 1, positionSeconds: 40 })]);
  record = await other.api.getAnimeWatchProgress('21');
  assert.equal(record.episodeId, 'mal-21-3');
  assert.equal(h.api.isEpisodeWatched(record, 'mal-21-1'), false);
  assert.equal(h.api.getEpisodeWatchProgress(record, 'mal-21-2').positionSeconds, 30);
  assert.equal(h.api.getEpisodeWatchProgress(record, 'mal-21-3').positionSeconds, 40);
  assert.equal((await other.api.getContinueWatching()).length, 1);
});

test('catalog aliases share watched and clock history without conflating creator episodes', async () => {
  const h = harness();
  await h.api.setAnimeEpisodeWatched(entry(), true, catalog);
  let record = await h.api.getAnimeWatchProgress('21');
  assert.equal(h.api.isEpisodeWatched(record, 'hi-1234-1', 1), true);
  await h.api.setAnimeEpisodeWatched(entry({ episodeId: 'hi-1234-1' }), false, catalog);
  record = await h.api.getAnimeWatchProgress('21');
  assert.equal(h.api.isEpisodeWatched(record, 'mal-21-1', 1), false);
  assert.equal(h.api.hasAnimeViewingHistory(record), false);
  assert.equal(h.api.getEpisodeWatchProgress(record, 'creator-episode', 1), null);
  const reloaded = harness({ snapshot: h.writes.at(-1) });
  assert.equal(reloaded.api.isEpisodeWatched(await reloaded.api.getAnimeWatchProgress('21'), 'mal-21-1', 1), false);
});

test('a cloud device flushing an older captured completion cannot erase a manual unwatched action', async () => {
  const h = harness();
  await h.api.setAnimeEpisodeWatched(entry(), false, catalog);
  const local = await h.api.getAnimeWatchProgress('21');
  const manual = local.episodeHistory['mal-21-1'].manualStatusAt;
  await h.api.importWatchProgress([entry({ updatedAt: manual - 1, episodeHistory: {
    'mal-21-1': { ...entry({ updatedAt: manual + 10, completed: true, progress: 1 }),
      watched: true, watchedUpdatedAt: manual + 10, observedAt: manual - 1 },
  } })]);
  const row = h.api.getEpisodeWatchProgress(await h.api.getAnimeWatchProgress('21'), 'mal-21-1');
  assert.equal(row.watched, false);
  assert.equal(row.positionSeconds, 0);
  assert.equal(row.completed, false);
});

test('an older zero checkpoint cannot undo a newer seek or episode navigation; a fresh restart still works', async () => {
  const h = harness();
  await h.api.setAnimeWatchProgress(episode(1, { updatedAt: 100, positionSeconds: 40 }));
  await h.api.setAnimeWatchProgress(episode(1, { updatedAt: 90, progress: 0, positionSeconds: 0 }));
  assert.equal((await h.api.getAnimeWatchProgress('21')).positionSeconds, 40);
  await h.api.setAnimeWatchProgress(episode(2, { updatedAt: 200, positionSeconds: 20 }));
  await h.api.setAnimeWatchProgress(episode(1, { updatedAt: 150, progress: 0, positionSeconds: 0 }));
  assert.equal((await h.api.getAnimeWatchProgress('21')).episodeId, 'mal-21-2');
  await h.api.setAnimeWatchProgress(episode(1, { updatedAt: 201, progress: 0, positionSeconds: 0 }));
  assert.equal((await h.api.getAnimeWatchProgress('21')).episodeId, 'mal-21-1');
  assert.equal((await h.api.getAnimeWatchProgress('21')).positionSeconds, 0);
});

test('queuing Next keeps its earlier watched state and exact clock instead of saving a synthetic zero history row', async () => {
  const h = harness();
  await h.api.setAnimeWatchProgressWithAdvance(episode(2, { updatedAt: 100, completed: true, progress: 1, positionSeconds: 1440 }), catalog);
  await h.api.setAnimeWatchProgressWithAdvance(episode(2, { updatedAt: 101, progress: 0, positionSeconds: undefined, completed: undefined }), catalog);
  let record = await h.api.getAnimeWatchProgress('21');
  assert.equal(record.episodeId, 'mal-21-2');
  assert.equal(record.progress, 0, 'title still queues next episode');
  assert.equal(h.api.isEpisodeWatched(record, 'mal-21-2'), true);
  assert.equal(h.api.getEpisodeWatchProgress(record, 'mal-21-2').positionSeconds, 1440);
  await h.api.setAnimeWatchProgress(episode(2, { updatedAt: 102, positionSeconds: 50, progress: 50 / 1440, completed: false }));
  await h.api.setAnimeWatchProgressWithAdvance(episode(2, { updatedAt: 103, progress: 0, positionSeconds: undefined, completed: undefined }), catalog);
  record = await h.api.getAnimeWatchProgress('21', 'mal-21-2', 2);
  assert.equal(record.positionSeconds, 50, 'revisiting this queued episode can restore its earlier clock');
  assert.equal(h.api.isEpisodeWatched(record, 'mal-21-2'), true, 'rewatching never clears a durable watched flag');
});

test('the first mark-watched on a title with no history is kept even when stamped in the same millisecond', async () => {
  // The screens stamp the entry with Date.now() and call straight in; a stamp
  // at or after the store's clock used to tie with the unwatched row built
  // from the entry itself, and the merge kept that row.
  for (const updatedAt of [Date.now(), Date.now() + 60_000]) {
    const h = harness({ snapshot: { anime: {} } });
    await h.api.getAnimeWatchProgress('32281');
    const fresh = entry({ animeId: '32281', episodeId: 'mal-32281-1', progress: 0, positionSeconds: undefined, updatedAt });
    await h.api.setAnimeEpisodeWatched(fresh, true, [{ id: 'mal-32281-1', number: 1 }]);
    const record = await h.api.getAnimeWatchProgress('32281');
    assert.equal(h.api.isEpisodeWatched(record, 'mal-32281-1', 1), true, `stamp ${updatedAt}`);
    assert.equal(h.api.getAnimeViewingStatus(record, [{ id: 'mal-32281-1', number: 1 }]), 'completed');
    assert.equal(h.writes.at(-1).anime['32281'].episodeHistory['mal-32281-1'].watched, true);
  }
});
