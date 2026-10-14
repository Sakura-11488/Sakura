import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');

function load(path, deps = {}) {
  const module = { exports: {} };
  const output = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, {
    module, exports: module.exports, Promise, JSON, Date, Map, Set, Object, Array, AbortController,
    setTimeout, clearTimeout,
    require: (name) => deps[name] || {},
  });
  return module.exports;
}

const core = load('../lib/search-core.ts');
const plain = (value) => JSON.parse(JSON.stringify(value));
// Values from the vm realm have their own Array prototype; compare as plain data.
const eq = (actual, expected, ...message) => assert.deepEqual(plain(actual), expected, ...message);
const item = (source, id, title, extra = {}) => ({ key: `${source}-${id}`, title, cover: '', type: 'manga', source, meta: '', ...extra });
const answer = (items, full = false) => ({ items, full });
const ALL = core.enabledSources(false);

test('queries are cleaned and keyed case- and whitespace-insensitively', () => {
  assert.equal(core.cleanQuery('  Solo   Leveling \n'), 'Solo Leveling');
  assert.equal(core.queryKey('Solo  LEVELING '), 'solo leveling');
  assert.equal(core.cleanQuery('x'.repeat(300)).length, 100);
});

test('the 18+ source is only enabled behind the opt-in, and only as its own chip', () => {
  assert.equal(ALL.includes('hentai'), false);
  assert.equal(core.enabledSources(true).includes('hentai'), true);
  assert.equal(core.searchFilters(false).includes('18+'), false);
  eq(core.searchFilters(true), ['All', 'Manga', 'Manhwa', 'Anime', 'Novel', 'Comics', 'Users', '18+']);
  let map = core.prefillSections(core.emptySections(), 'q', core.enabledSources(true), null);
  map = core.applySourceOutcome(map, 'hentai', 'q', { ok: true, value: answer([item('hentai', 1, 'H')]) });
  const all = core.buildSectionViews(map, 'All', 'q', { allowAdult: true });
  assert.equal(all.some((v) => v.key === 'hentai'), false, 'never mixed into All');
  const adult = core.buildSectionViews(map, '18+', 'q', { allowAdult: true });
  eq(adult.map((v) => v.key), ['hentai']);
  eq(core.buildSectionViews(map, '18+', 'q', { allowAdult: false }), []);
});

test('sections render as each source answers, in a fixed order', () => {
  let map = core.prefillSections(core.emptySections(), 'naruto', ALL, null);
  let views = core.buildSectionViews(map, 'All', 'naruto', { allowAdult: false });
  eq(views.map((v) => v.key), ['manga', 'manhwa', 'anime', 'novel', 'comics', 'users']);
  assert.ok(views.every((v) => v.status === 'pending'));
  let summary = core.summarizeSections(views);
  assert.equal(summary.loading, true);
  assert.equal(summary.anyFresh, false);

  // Anime answers first: it shows while the others are still skeletons.
  map = core.applySourceOutcome(map, 'anime', 'naruto', { ok: true, value: answer([item('anime', 20, 'Naruto', { type: 'anime' })]) });
  views = core.buildSectionViews(map, 'All', 'naruto', { allowAdult: false });
  summary = core.summarizeSections(views);
  assert.equal(summary.anyFresh, true);
  assert.equal(summary.count, 1);
  assert.equal(summary.loading, true);
  assert.equal(views.find((v) => v.key === 'anime').status, 'done');
  assert.equal(views[0].key, 'manga', 'order does not depend on who answered first');

  // An empty answer drops that shelf from the overview but not from its chip.
  map = core.applySourceOutcome(map, 'comics', 'naruto', { ok: true, value: answer([]) });
  views = core.buildSectionViews(map, 'All', 'naruto', { allowAdult: false });
  assert.equal(views.some((v) => v.key === 'comics'), false);
  const comicsChip = core.buildSectionViews(map, 'Comics', 'naruto', { allowAdult: false });
  assert.equal(comicsChip.length, 1);
  assert.equal(comicsChip[0].status, 'done');
  assert.equal(comicsChip[0].items.length, 0);
});

test('a source that fails is reported as down, not as "no results"', () => {
  let map = core.prefillSections(core.emptySections(), 'q', ALL, null);
  for (const key of ALL) {
    map = core.applySourceOutcome(map, key, 'q', key === 'manhwa' ? { ok: false, error: new Error('502') } : { ok: true, value: answer([]) });
  }
  const views = core.buildSectionViews(map, 'All', 'q', { allowAdult: false });
  const summary = core.summarizeSections(views);
  eq(summary.failed, ['Manhwa']);
  assert.equal(summary.loading, false);
  eq(views.map((v) => v.key), ['manhwa']);
});

test('a slow source is marked after the timeout, and a late answer still lands', () => {
  let map = core.prefillSections(core.emptySections(), 'q', ALL, null);
  map = core.markSectionSlow(map, 'manhwa', 'q');
  assert.equal(map.manhwa.status, 'failed');
  assert.equal(map.manhwa.slow, true);
  map = core.applySourceOutcome(map, 'manhwa', 'q', { ok: true, value: answer([item('manhwa', 'cz:a', 'A')]) });
  assert.equal(map.manhwa.status, 'done');
  assert.equal(map.manhwa.slow, false);
  // Slow only applies to a section still waiting.
  assert.equal(core.markSectionSlow(map, 'manhwa', 'q'), map);
});

test('refining a query keeps the previous cards on screen, dimmed, until the new answer lands', () => {
  let map = core.prefillSections(core.emptySections(), 'nar', ALL, null);
  map = core.applySourceOutcome(map, 'manga', 'nar', { ok: true, value: answer([item('manga', 1, 'Naruto')]) });
  map = core.prefillSections(map, 'naruto', ALL, null);
  let views = core.buildSectionViews(map, 'All', 'naruto', { allowAdult: false });
  const manga = views.find((v) => v.key === 'manga');
  assert.equal(manga.status, 'pending');
  assert.equal(manga.stale, true);
  assert.equal(manga.items.length, 1);
  assert.equal(core.summarizeSections(views).anyFresh, false, 'stale cards do not count as results');
  map = core.applySourceOutcome(map, 'manga', 'naruto', { ok: true, value: answer([item('manga', 2, 'Naruto Shippuden')]) });
  views = core.buildSectionViews(map, 'All', 'naruto', { allowAdult: false });
  assert.equal(views.find((v) => v.key === 'manga').stale, false);
  assert.equal(views.find((v) => v.key === 'manga').items[0].title, 'Naruto Shippuden');
});

test('a cached query renders synchronously, and only stale sources are asked again', () => {
  const cache = new core.SearchSessionCache(3);
  const t0 = 1_000_000;
  for (const key of ALL) cache.put('one piece', key, answer([item(key, 1, `${key} hit`)]), t0);
  const map = core.prefillSections(core.emptySections(), 'one piece', ALL, cache.get('one piece'));
  assert.ok(ALL.every((key) => map[key].status === 'done'));
  assert.equal(core.summarizeSections(core.buildSectionViews(map, 'All', 'one piece', { allowAdult: false })).loading, false);
  eq(core.sourcesToRun(ALL, cache.get('one piece'), t0 + 30_000), []);
  eq(core.sourcesToRun(ALL, cache.get('one piece'), t0 + core.SEARCH_REVALIDATE_MS + 1), plain(ALL));
  eq(core.sourcesToRun(ALL, null, t0), plain(ALL));
  // A failed background refresh keeps the cached answer on screen.
  const after = core.applySourceOutcome(map, 'anime', 'one piece', { ok: false, error: new Error('down') });
  assert.equal(after.anime.status, 'done');
  assert.equal(after.anime.items.length, 1);
});

test('the session cache is a bounded LRU', () => {
  const cache = new core.SearchSessionCache(2);
  cache.put('a', 'manga', answer([]), 1);
  cache.put('b', 'manga', answer([]), 1);
  cache.get('a');
  cache.put('c', 'manga', answer([]), 1);
  assert.equal(cache.size, 2);
  assert.ok(cache.get('a'));
  assert.equal(cache.get('b'), null);
  cache.put('', 'manga', answer([]), 1);
  assert.equal(cache.size, 2);
});

test('the same series from atsu and the manhwa scraper shows once in All, but both under the Manhwa chip', () => {
  const key = core.titleMatchKey;
  let map = core.prefillSections(core.emptySections(), 'reaper', ALL, null);
  map = core.applySourceOutcome(map, 'manga', 'reaper', { ok: true, value: answer([
    item('manga', 1, 'The Reaper', { meta: 'Manhwa', matchKey: key('The Reaper') }),
    // A Japanese manga of the same name is a different work: no matchKey.
    item('manga', 2, 'Ghost Reaper Girl', { meta: 'Manga' }),
  ]) });
  map = core.applySourceOutcome(map, 'manhwa', 'reaper', { ok: true, value: answer([
    item('manhwa', 'cz:the-reaper', 'The  Reaper!', { matchKey: key('The  Reaper!') }),
    item('manhwa', 'mr:ghost', 'Ghost Reaper Girl', { matchKey: key('Ghost Reaper Girl') }),
    item('manhwa', 'mr:tax', 'The Tax Reaper', { matchKey: key('The Tax Reaper') }),
  ]) });
  const all = core.buildSectionViews(map, 'All', 'reaper', { allowAdult: false });
  eq(all.find((v) => v.key === 'manhwa').items.map((i) => i.title), ['Ghost Reaper Girl', 'The Tax Reaper']);
  const chip = core.buildSectionViews(map, 'Manhwa', 'reaper', { allowAdult: false });
  assert.equal(chip[0].items.length, 3);
});

test('webtoon formats are the only atsu types eligible for a cross-source merge', () => {
  assert.equal(core.isWebtoonFormat('Manwha'), true);
  assert.equal(core.isWebtoonFormat('Manhua'), true);
  assert.equal(core.isWebtoonFormat(undefined), true);
  assert.equal(core.isWebtoonFormat('Manga'), false);
  assert.equal(core.isWebtoonFormat('OEL'), false);
  assert.equal(core.formatLabel('Manwha'), 'Manhwa');
  assert.equal(core.formatLabel(''), 'Manga');
  assert.equal(core.formatLabel('Manhua'), 'Manhua');
  assert.equal(core.titleMatchKey('Return of the Reaper: Assassin'), core.titleMatchKey('return of the reaper — assassin'.replace('—', '-')));
  // Short generic titles merge only when atsu calls them webtoons; long specific ones always.
  assert.equal(core.atsuMatchKey('Hero', 'Manga'), undefined);
  assert.equal(core.atsuMatchKey('Hero', 'Manwha'), 'hero');
  assert.equal(core.atsuMatchKey('Return of the Reaper: Assassin', 'Manga'), 'return of the reaper assassin');
  assert.equal(core.atsuMatchKey('Ghost Reaper Girl', 'Manga'), 'ghost reaper girl');
  assert.equal(core.atsuMatchKey('', 'Manwha'), undefined);
});

test('people results never include the signed-in user, and duplicate keys are dropped', () => {
  let map = core.prefillSections(core.emptySections(), 'mi', ALL, null);
  const me = { wallet_address: 'ME', username: 'milla' };
  const other = { wallet_address: 'X', username: 'mila' };
  map = core.applySourceOutcome(map, 'users', 'mi', { ok: true, value: answer([
    item('users', 'ME', 'Milla', { type: 'user', user: me }),
    item('users', 'X', 'Mila', { type: 'user', user: other }),
  ]) });
  const views = core.buildSectionViews(map, 'Users', 'mi', { allowAdult: false, excludeWallet: 'ME' });
  eq(views[0].items.map((i) => i.user.wallet_address), ['X']);
  assert.equal(core.uniqueResults([item('manga', 1, 'A'), item('manga', 1, 'A again'), item('manga', 2, 'B')]).length, 2);
});

test('the runner reports each task as it settles and nothing after an abort', async () => {
  const seen = [];
  const controller = new AbortController();
  let resolveSlow;
  const slow = new Promise((resolve) => { resolveSlow = resolve; });
  const done = core.runProgressively([
    { key: 'fast', run: async () => 'f' },
    { key: 'broken', run: async () => { throw new Error('nope'); } },
    { key: 'sync-throw', run: () => { throw new Error('sync'); } },
    { key: 'slow', run: () => slow },
  ], (key, outcome) => seen.push([key, outcome.ok]), { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  eq(plain(seen).sort(), [['broken', false], ['fast', true], ['sync-throw', false]]);
  controller.abort();
  resolveSlow('s');
  await done;
  assert.equal(seen.length, 3, 'a superseded answer is never reported');
});

test('the runner flags a task that is still running after slowMs', async () => {
  const slowKeys = [];
  const controller = new AbortController();
  let resolve;
  const run = core.runProgressively([{ key: 'manhwa', run: () => new Promise((r) => { resolve = r; }) }], () => {}, {
    signal: controller.signal, slowMs: 5, onSlow: (key) => slowKeys.push(key),
  });
  await new Promise((r) => setTimeout(r, 20));
  eq(slowKeys, ['manhwa']);
  resolve('late');
  await run;
});

test('an empty answer stored as already stale renders at once but is asked again', () => {
  // The screen stores an empty anime answer at 0 (lib/anime.ts hides outages as []).
  const cache = new core.SearchSessionCache(4);
  const now = 5_000_000;
  cache.put('frieren', 'anime', answer([]), 0);
  cache.put('frieren', 'manga', answer([item('manga', '1', 'Frieren')]), now);
  const hit = cache.get('frieren');
  const map = core.prefillSections(core.emptySections(), 'frieren', ['manga', 'anime'], hit);
  eq([map.anime.status, map.manga.status], ['done', 'done']);
  eq(core.sourcesToRun(['manga', 'anime'], hit, now + 1_000), ['anime']);
});
