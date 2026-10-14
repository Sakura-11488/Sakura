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
    module, exports: module.exports, Date, JSON, Set, Map, Math, Object, Promise, Number, Array,
    setTimeout, clearTimeout, require: (name) => {
      if (!(name in deps)) throw new Error(`unexpected import ${name}`);
      return deps[name];
    },
    ...globals,
  });
  return module.exports;
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const chapterProgress = load('../lib/chapter-progress.ts');
const ADAPTERS = {
  manhwa: { key: 'manhwa', adult: false },
  comics: { key: 'comics', adult: false },
  hentai: { key: 'hentai', adult: true },
};

/**
 * The module with every dependency faked: chapter lists per `source:id`,
 * atsu counts per id, read marks and progress rows. `calls` records the
 * network-shaped calls.
 */
function setup({ lists = {}, counts = {}, progress = [], read = {} } = {}) {
  const files = new Map();
  const calls = { lists: [], counts: [] };
  const marks = new Map(Object.entries(read).map(([k, v]) => [k, new Set(v)]));
  const key = (source, id) => `${source && source !== 'manga' ? source : 'manga'}:${id}`;
  const deps = {
    '@/lib/kv-store': {
      readStore: async (name) => files.get(name) ?? null,
      writeStore: async (name, value) => { files.set(name, value); return true; },
    },
    '@/lib/chapter-read-state': {
      seriesReadKey: key,
      getReadChapterIds: async (source, id) => new Set(marks.get(key(source, id)) ?? []),
      setChaptersRead: async (source, id, ids) => {
        const set = marks.get(key(source, id)) ?? new Set();
        ids.forEach((i) => set.add(i));
        marks.set(key(source, id), set);
      },
    },
    '@/lib/reader-progress': { getAllMangaProgressEntries: async () => progress },
    '@/lib/manga': {
      fetchAtsuChapterCounts: async (ids) => {
        calls.counts.push([...ids]);
        return Object.fromEntries(ids.filter((id) => id in counts).map((id) => [id, counts[id]]));
      },
    },
    '@/lib/manga-prefetch': {
      loadMangaChapters: async (id, source) => {
        calls.lists.push(key(source, id));
        return lists[key(source, id)] ?? [];
      },
    },
    '@/lib/scraped-sources': { getScrapedAdapter: (value) => ADAPTERS[value] ?? null },
    '@/lib/chapter-progress': chapterProgress,
  };
  const api = load('../lib/library-updates.ts', deps, { navigator: { onLine: true } });
  return { api, calls, marks, files };
}

const chapters = (n, prefix = 'c', date = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, number: i + 1, title: `Chapter ${i + 1}`, pageCount: 10, createdAt: date ? date + i : '' }));
const saved = (id, extra = {}) => ({ id, title: id, cover: '', type: 'manga', savedAt: 1, ...extra });

test('first check is the baseline; a later check counts what arrived as new and unread', () => {
  const { api } = setup();
  const first = api.computeSeriesUpdate(undefined, chapters(10), new Set(['c1', 'c2']), 1000);
  assert.equal(first.total, 10);
  assert.equal(first.latestNumber, 10);
  assert.deepEqual(plain(first.newIds), [], 'nothing is "new" on the first look');
  assert.deepEqual(plain(api.countsFor(first, new Set(['c1', 'c2']))), { unread: 8, newCount: 0 });

  const later = api.computeSeriesUpdate(first, chapters(12), new Set(['c1', 'c2']), 2000);
  assert.deepEqual(plain(later.newIds), ['c11', 'c12']);
  assert.equal(later.newFoundAt, 2000);
  assert.deepEqual(plain(api.countsFor(later, new Set(['c1', 'c2', 'c11']))), { unread: 9, newCount: 1 });

  const seen = api.computeSeriesUpdate(later, chapters(12), new Set(), 3000, { seen: true });
  assert.deepEqual(plain(seen.newIds), [], 'opening the series clears NEW');
});

test('a long backlog is remembered as a number past the cap, and counts follow reading', () => {
  const { api } = setup();
  const entry = api.computeSeriesUpdate(undefined, chapters(500), new Set(), 1);
  assert.equal(entry.unreadIds.length, api.MAX_TRACKED_UNREAD);
  assert.equal(entry.unreadOverflow, 300);
  assert.equal(api.countsFor(entry, new Set(['c1', 'c2'])).unread, 498);
});

test('progress rows count their finished chapter as read', () => {
  const { api } = setup();
  const ids = api.readIdsWithProgress(new Set(['a']), { chapterId: 'b', page: 1, totalPages: 1, progress: 0.01, upNext: true, finishedChapterId: 'x' });
  assert.deepEqual([...ids].sort(), ['a', 'x']);
  assert.ok(api.readIdsWithProgress(new Set(), { chapterId: 'z', page: 9, totalPages: 9, progress: 0.97, caughtUp: true }).has('z'));
});

test('only SFW manga in the library is ever checked', () => {
  const { api } = setup();
  assert.equal(api.libraryUpdateKey(saved('a')), 'manga:a');
  assert.equal(api.libraryUpdateKey(saved('m', { source: 'manhwa' })), 'manhwa:m');
  assert.equal(api.libraryUpdateKey(saved('h', { source: 'hentai' })), null);
  assert.equal(api.libraryUpdateKey({ id: 'n', type: 'novel' }), null);
});

test('a run seeds marks from old progress, uses the atsu count to skip unchanged lists, and respects the throttle', async () => {
  const progress = [{ mangaId: 'atsu1', chapterId: 'c5', page: 3, totalPages: 10, progress: 0.3, updatedAt: 50 }];
  const env = setup({
    lists: { 'manga:atsu1': chapters(8), 'manhwa:mw': chapters(4, 'm') },
    counts: { atsu1: 8 },
    progress,
  });
  const items = [saved('atsu1'), saved('mw', { source: 'manhwa' }), saved('h', { source: 'hentai' })];
  await env.api.refreshLibraryUpdates(items);
  assert.deepEqual(env.calls.lists.sort(), ['manga:atsu1', 'manhwa:mw'], '18+ is never fetched');
  assert.deepEqual([...env.marks.get('manga:atsu1')].sort(), ['c1', 'c2', 'c3', 'c4'], 'chapters before your place are backfilled as read');
  let summary = plain(await env.api.getLibraryUpdateSummaries(items));
  assert.equal(summary['manga:atsu1'].unread, 4, 'c5 (in progress) to c8');
  assert.equal(summary['manhwa:mw'].unread, 4);
  assert.equal(summary['hentai:h'], undefined);

  // Within the throttle nothing is asked again, not even the count.
  await env.api.refreshLibraryUpdates(items);
  assert.equal(env.calls.lists.length, 2);
  assert.equal(env.calls.counts.length, 1);

  // A forced refresh well past the floor: atsu's count is unchanged, so its list is not downloaded.
  const realNow = Date.now;
  Date.now = () => realNow() + 60 * 60 * 1000;
  try {
    await env.api.refreshLibraryUpdates(items, { force: true });
  } finally {
    Date.now = realNow;
  }
  assert.equal(env.calls.counts.length, 2);
  assert.deepEqual(env.calls.lists.filter((k) => k === 'manga:atsu1').length, 1, 'unchanged atsu count: no list download');
  summary = plain(await env.api.getLibraryUpdateSummaries(items));
  assert.equal(summary['manga:atsu1'].unread, 4);
});

test('seeding happens once: a chapter marked unread later stays unread', async () => {
  const env = setup();
  const list = chapters(5);
  const progress = { chapterId: 'c4', page: 1, totalPages: 10, progress: 0.1 };
  assert.equal(await env.api.seedReadMarksFromProgress('manga', 's', list, progress), true);
  env.marks.get('manga:s').delete('c2');
  assert.equal(await env.api.seedReadMarksFromProgress('manga', 's', list, progress), false);
  assert.equal(env.marks.get('manga:s').has('c2'), false);
  assert.equal(await env.api.seedReadMarksFromProgress('hentai', 'x', list, progress), false);
});

test('the series page reports its list for free and clears NEW', async () => {
  const env = setup();
  const item = saved('s');
  await env.api.noteSeriesChapters('manga', 's', chapters(3));
  await env.api.noteSeriesChapters('manga', 's', chapters(5));
  let summary = plain(await env.api.getLibraryUpdateSummaries([item]));
  assert.equal(summary['manga:s'].newCount, 2);
  await env.api.noteSeriesChapters('manga', 's', chapters(5), { seen: true });
  summary = plain(await env.api.getLibraryUpdateSummaries([item]));
  assert.equal(summary['manga:s'].newCount, 0);
  assert.equal(summary['manga:s'].unread, 5);
  assert.equal(env.calls.lists.length, 0, 'no network');
});

test('a list that fails is not asked again on every visit, only after a backoff', async () => {
  // An empty list is how the fetchers report failure (atsu down, scraper down).
  const env = setup({ lists: { 'manhwa:down': [] } });
  const items = [saved('down', { source: 'manhwa' })];
  await env.api.refreshLibraryUpdates(items);
  assert.equal(env.calls.lists.length, 1);
  // The next library focus, and a pull to refresh straight after: no new request.
  await env.api.refreshLibraryUpdates(items);
  await env.api.refreshLibraryUpdates(items, { force: true });
  assert.equal(env.calls.lists.length, 1, 'a failed series is not re-fetched on every focus');
  const realNow = Date.now;
  try {
    // A pull to refresh past the force floor tries again...
    Date.now = () => realNow() + env.api.FORCE_RECHECK_MS + 1000;
    await env.api.refreshLibraryUpdates(items, { force: true });
    assert.equal(env.calls.lists.length, 2);
    // ...and an ordinary visit only once the failure backoff has passed.
    Date.now = () => realNow() + env.api.FORCE_RECHECK_MS + 2000;
    await env.api.refreshLibraryUpdates(items);
    assert.equal(env.calls.lists.length, 2);
    Date.now = () => realNow() + env.api.FORCE_RECHECK_MS + env.api.FAILED_RETRY_MS + 3000;
    await env.api.refreshLibraryUpdates(items);
    assert.equal(env.calls.lists.length, 3);
  } finally {
    Date.now = realNow;
  }
  assert.equal(env.api.isDue(undefined, 'manhwa', 10_000, false, 9_000), false);
  assert.equal(env.api.isDue(undefined, 'manhwa', 10_000 + env.api.FAILED_RETRY_MS, false, 9_000), true);
});

test('series removed from the library are forgotten on the next run', async () => {
  const env = setup({ lists: { 'manga:a': chapters(2), 'manga:b': chapters(3) }, counts: {} });
  await env.api.refreshLibraryUpdates([saved('a'), saved('b')]);
  assert.equal(Object.keys(plain(await env.api.getLibraryUpdateSummaries([saved('a'), saved('b')]))).length, 2);
  await env.api.refreshLibraryUpdates([saved('a')]);
  assert.deepEqual(Object.keys(plain(await env.api.getLibraryUpdateSummaries([saved('a'), saved('b')]))), ['manga:a']);
});

test('library sorts: most unread, latest update, recently read', () => {
  const { api } = setup();
  const items = [saved('a', { savedAt: 3 }), saved('b', { savedAt: 2 }), saved('c', { savedAt: 1 })];
  const updates = {
    'manga:a': { unread: 1, newCount: 0, total: 5, latestNumber: 5, latestTitle: '', latestAt: 100, newFoundAt: 0, checkedAt: 0 },
    'manga:b': { unread: 9, newCount: 0, total: 9, latestNumber: 9, latestTitle: '', latestAt: 300, newFoundAt: 0, checkedAt: 0 },
  };
  const ids = (list) => [...list].map((i) => i.id);
  assert.deepEqual(ids(api.sortLibraryItems(items, 'unread', {}, updates)), ['b', 'a', 'c']);
  assert.deepEqual(ids(api.sortLibraryItems(items, 'updated', {}, updates)), ['b', 'a', 'c']);
  assert.deepEqual(ids(api.sortLibraryItems(items, 'read', { 'manga:c': 50 }, updates)), ['c', 'a', 'b']);
  assert.deepEqual(ids(api.sortLibraryItems(items, 'saved', {}, updates)), ['a', 'b', 'c']);
  assert.equal(api.hasRecentUpdate(updates['manga:a'], 100 + 31 * 24 * 3600 * 1000), false);
  assert.equal(api.hasRecentUpdate({ ...updates['manga:a'], newCount: 1 }, 1e13), true);
  assert.equal(api.libraryProgressKey({ id: 'path/x/', type: 'novel' }), 'novel:path/x');
});
