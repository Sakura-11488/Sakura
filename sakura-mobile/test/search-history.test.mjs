import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const historySource = ts.transpileModule(readFileSync(new URL('../lib/search-history.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const discoverySource = ts.transpileModule(readFileSync(new URL('../lib/ai-discovery.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const plain = (value) => JSON.parse(JSON.stringify(value));

/** search-history over a fake kv-store (and, for web, a fake localStorage). */
function history({ stored = null, legacy = null, writeFails = false } = {}) {
  const files = new Map(stored == null ? [] : [['sakura_recent_searches.json', stored]]);
  const local = new Map(legacy == null ? [] : [['sakura-searches-v1', legacy]]);
  const localStorage = {
    getItem: (k) => (local.has(k) ? local.get(k) : null),
    setItem: (k, v) => local.set(k, String(v)),
    removeItem: (k) => local.delete(k),
  };
  const module = { exports: {} };
  vm.runInNewContext(historySource, {
    module, exports: module.exports, Promise, JSON, Set, Map, Array,
    localStorage: legacy == null ? undefined : localStorage,
    require: (id) => {
      assert.equal(id, '@/lib/kv-store');
      return {
        readStore: async (name) => files.get(name) ?? null,
        writeStore: async (name, value) => { if (writeFails) return false; files.set(name, value); return true; },
      };
    },
  });
  return { api: module.exports, files, local };
}

test('recent searches put the newest first, ignore case repeats and cap the list', () => {
  const { api } = history();
  let list = [];
  for (const q of ['naruto', 'One Piece', 'NARUTO', '  solo   leveling ', 'x']) list = api.withRecentSearch(list, q);
  assert.deepEqual(plain(list), ['solo leveling', 'NARUTO', 'One Piece']);
  for (let i = 0; i < 20; i++) list = api.withRecentSearch(list, `query ${i}`);
  assert.equal(list.length, api.MAX_RECENT_SEARCHES);
  assert.equal(list[0], 'query 19');
});

test('remember, remove and clear persist through kv-store and notify listeners', async () => {
  const h = history();
  const seen = [];
  h.api.subscribeRecentSearches((list) => seen.push(plain(list)));
  await h.api.rememberSearch('Frieren');
  await h.api.rememberSearch('Dandadan');
  await h.api.rememberSearch('frieren');
  assert.deepEqual(JSON.parse(h.files.get('sakura_recent_searches.json')), ['frieren', 'Dandadan']);
  await h.api.removeRecentSearch('DANDADAN');
  assert.deepEqual(JSON.parse(h.files.get('sakura_recent_searches.json')), ['frieren']);
  await h.api.clearRecentSearches();
  assert.deepEqual(JSON.parse(h.files.get('sakura_recent_searches.json')), []);
  assert.deepEqual(seen.at(-1), []);
  assert.ok(seen.length >= 4);
  // One-character queries are not worth remembering.
  await h.api.rememberSearch('a');
  assert.deepEqual(plain(h.api.peekRecentSearches()), []);
});

test('a stored list is sanitised on load, and the old web key is migrated once', async () => {
  const stored = history({ stored: JSON.stringify(['Berserk', 42, 'berserk', '', 'Vagabond']) });
  assert.deepEqual(plain(await stored.api.loadRecentSearches()), ['Berserk', 'Vagabond']);

  const migrated = history({ legacy: JSON.stringify(['Monster', 'Pluto']) });
  assert.deepEqual(plain(await migrated.api.loadRecentSearches()), ['Monster', 'Pluto']);
  assert.equal(migrated.local.has('sakura-searches-v1'), false);
  assert.deepEqual(JSON.parse(migrated.files.get('sakura_recent_searches.json')), ['Monster', 'Pluto']);

  const corrupt = history({ stored: '{not json' });
  assert.deepEqual(plain(await corrupt.api.loadRecentSearches()), []);
});

test('a failed write keeps the list in memory for this session', async () => {
  const h = history({ writeFails: true });
  await h.api.rememberSearch('Vinland Saga');
  assert.deepEqual(plain(h.api.peekRecentSearches()), ['Vinland Saga']);
});

test('AI-recommended novels open the external novel page, not the originals screen', async () => {
  const module = { exports: {} };
  vm.runInNewContext(discoverySource, {
    module, exports: module.exports, Promise, JSON, Set, console,
    encodeURIComponent,
    require: (id) => ({
      './anime': { ANIME_GENRES: [] },
      './manga': {},
      './allnovel': {
        searchNovels: async () => [
          { path: 'sword-art-online.html', name: 'Sword Art Online' },
          { path: 'the-beginning-after-the-end.html', name: 'The Beginning After The End', cover: 'c.jpg' },
        ],
      },
    })[id] || {},
  });
  const result = await module.exports.findSimilarNovels('sao');
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].route, '/novel/ext?path=the-beginning-after-the-end.html');
  assert.equal(result.cards[0].id, 'the-beginning-after-the-end.html');
  assert.equal(module.exports.novelRoute('a b/c.html'), '/novel/ext?path=a%20b%2Fc.html');
});

test('two searches remembered in the same tick are both kept', async () => {
  const h = history({ stored: JSON.stringify(['Berserk']) });
  await h.api.loadRecentSearches();
  await Promise.all([h.api.rememberSearch('Monster'), h.api.rememberSearch('Pluto')]);
  assert.deepEqual(plain(h.api.peekRecentSearches()), ['Pluto', 'Monster', 'Berserk']);
  assert.deepEqual(JSON.parse(h.files.get('sakura_recent_searches.json')), ['Pluto', 'Monster', 'Berserk']);
});

test('the old web list is kept until the migrated copy is stored', async () => {
  const h = history({ legacy: JSON.stringify(['Monster']), writeFails: true });
  assert.deepEqual(plain(await h.api.loadRecentSearches()), ['Monster']);
  assert.equal(h.local.has('sakura-searches-v1'), true, 'a failed write must not delete the only copy');
});
