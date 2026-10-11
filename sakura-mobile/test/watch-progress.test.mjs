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
