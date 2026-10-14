import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const plain = (value) => JSON.parse(JSON.stringify(value));
const transpile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function loadWatchlist(initial = null) {
  const files = new Map(initial ? [['sakura_anime_watchlist.json', initial]] : []);
  const writes = [];
  const module = { exports: {} };
  vm.runInNewContext(transpile('../lib/anime-watchlist.ts'), {
    module, exports: module.exports,
    require: (id) => {
      assert.equal(id, '@/lib/kv-store');
      return {
        readStore: async (name) => files.get(name) ?? null,
        writeStore: async (name, value) => { files.set(name, value); writes.push(JSON.parse(value)); return true; },
      };
    },
  });
  return { api: module.exports, files, writes };
}

test('statuses persist through kv-store, notify subscribers, and removing a title deletes it', async () => {
  const { api, writes } = loadWatchlist();
  let notified = 0;
  const unsubscribe = api.subscribeWatchlist(() => { notified++; });
  const title = { animeId: '52991', title: 'Frieren', cover: 'https://cdn.example/f.jpg' };
  await api.setWatchlistStatus(title, 'plan');
  assert.equal(await api.getWatchlistStatus('52991'), 'plan');
  await api.setWatchlistStatus(title, 'watching');
  assert.deepEqual(plain((await api.getWatchlist()).map((entry) => [entry.animeId, entry.status])), [['52991', 'watching']]);
  await api.setWatchlistStatus(title, null);
  assert.equal(await api.getWatchlistStatus('52991'), null);
  assert.equal(notified, 3);
  unsubscribe();
  await api.setWatchlistStatus(title, 'dropped');
  assert.equal(notified, 3);
  assert.deepEqual(plain(writes.at(-1).map((entry) => entry.status)), ['dropped']);
  await api.setWatchlistStatus(title, 'binge');
  assert.equal(await api.getWatchlistStatus('52991'), 'dropped', 'unknown statuses are ignored');
});

test('stored lists are validated: bad rows, statuses and cover URLs are dropped, newest duplicate wins', async () => {
  const stored = JSON.stringify([
    { animeId: '1', title: 'One', cover: 'javascript:alert(1)', status: 'completed', updatedAt: 5 },
    { animeId: '1', title: 'One newer', cover: 'https://x.test/1.jpg', status: 'on-hold', updatedAt: 9 },
    { animeId: '2', status: 'favourite', updatedAt: 1 },
    { title: 'missing id', status: 'plan' },
    null,
  ]);
  const { api } = loadWatchlist(stored);
  const list = await api.getWatchlist();
  assert.deepEqual(plain(list), [{ animeId: '1', title: 'One newer', cover: 'https://x.test/1.jpg', status: 'on-hold', updatedAt: 9 }]);
  assert.deepEqual(plain(api.normalizeWatchlist('not json')), []);
  assert.deepEqual(plain(await loadWatchlist('{corrupt').api.getWatchlist()), [], 'a corrupt store starts empty');
});

test('playback moves titles to Watching and a finished series to Completed without demoting Completed', async () => {
  const { api } = loadWatchlist();
  assert.equal(api.nextAutoStatus(null, 'started'), 'watching');
  assert.equal(api.nextAutoStatus('plan', 'started'), 'watching');
  assert.equal(api.nextAutoStatus('on-hold', 'started'), 'watching');
  assert.equal(api.nextAutoStatus('dropped', 'started'), 'watching');
  assert.equal(api.nextAutoStatus('watching', 'started'), null);
  assert.equal(api.nextAutoStatus('completed', 'started'), null, 'a rewatch keeps Completed');
  assert.equal(api.nextAutoStatus('watching', 'finished-series'), 'completed');
  assert.equal(api.nextAutoStatus('completed', 'finished-series'), null);
  const title = { animeId: '20', title: 'Naruto', cover: '' };
  await api.noteAnimePlayback(title, 'started');
  const [entry] = await api.getWatchlist();
  assert.equal(entry.status, 'watching');
  assert.equal(entry.auto, true);
  await api.noteAnimePlayback(title, 'finished-series');
  assert.equal(await api.getWatchlistStatus('20'), 'completed');
  assert.equal(api.watchlistStatusLabel('on-hold'), 'On hold');
  assert.equal(api.watchlistStatusLabel(null), 'Add to list');
});

test('highest watched episode reads per-episode history, falling back to a completed bookmark', () => {
  const { api } = loadWatchlist();
  assert.equal(api.highestWatchedEpisode({ episodeNumber: 5, progress: 0, episodeHistory: {
    a: { episodeNumber: 3, watched: true }, b: { episodeNumber: 4, watched: false }, c: { episodeNumber: 1, watched: true },
  } }), 3);
  assert.equal(api.highestWatchedEpisode({ episodeNumber: 7, progress: 1, completed: true }), 7);
  assert.equal(api.highestWatchedEpisode({ episodeNumber: 2, progress: 0.4 }), 0);
});

test('new episodes: airing shows the viewer keeps up with, newest release first; backlogs and finished shows excluded', () => {
  const { api } = loadWatchlist();
  const candidates = [
    { animeId: '1', title: 'Caught up', cover: '', highestWatched: 6, lastPlayedAt: 10 },
    { animeId: '2', title: 'Two behind', cover: 'https://x.test/2.jpg', highestWatched: 3, lastPlayedAt: 20 },
    { animeId: '3', title: 'Backlog', cover: '', highestWatched: 5, lastPlayedAt: 30 },
    { animeId: '4', title: 'Finished', cover: '', highestWatched: 10, lastPlayedAt: 40 },
    { animeId: '5', title: 'Up to date', cover: '', highestWatched: 8, lastPlayedAt: 50 },
    { animeId: '6', title: 'Never started', cover: '', highestWatched: 0, lastPlayedAt: 60 },
  ];
  const airing = [
    { id: '1', status: 'RELEASING', nextEpisode: 8, nextAiringAt: 1_000, image: 'https://x.test/1.jpg' },
    { id: '2', status: 'RELEASING', nextEpisode: 6, nextAiringAt: 5_000 },
    { id: '3', status: 'RELEASING', nextEpisode: 1100, nextAiringAt: 9_000 },
    { id: '4', status: 'FINISHED', nextEpisode: null, nextAiringAt: null },
    { id: '5', status: 'RELEASING', nextEpisode: 9, nextAiringAt: 2_000 },
    { id: '6', status: 'RELEASING', nextEpisode: 2, nextAiringAt: 3_000 },
  ];
  assert.deepEqual(plain(api.findNewEpisodes(candidates, airing)), [
    { animeId: '2', title: 'Two behind', cover: 'https://x.test/2.jpg', nextEpisode: 4, latestAired: 5, newCount: 2 },
    { animeId: '1', title: 'Caught up', cover: 'https://x.test/1.jpg', nextEpisode: 7, latestAired: 7, newCount: 1 },
  ]);
});
